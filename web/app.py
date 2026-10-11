#!/usr/bin/env python3
"""GeoInt Web UI — a local browser interface around the GeoInt CLI scripts.

Run from the repository root:

    python3 web/app.py                    # http://127.0.0.1:8787
    python3 web/app.py --root /path/to/photos --port 8788 --open

All compute stays on this machine and every pipeline step runs the real GeoInt
scripts through `uv run`. No external packages are needed for the server itself;
upload a photo, run the recon pass, read the evidence and finish the archive.
"""
from __future__ import annotations

import argparse
import email
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "scripts"
STATIC = Path(__file__).resolve().parent / "static"
UV = os.environ.get("UV") or "uv"
PY = sys.executable
MAX_BODY = 150 * 1024 * 1024

SESSION_NAME = re.compile(r"^[0-9A-Za-z_.+\-]+$")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
FILE_EXTS = IMAGE_EXTS | {".pdf", ".json", ".md", ".txt", ".html", ".mp4", ".mov"}

# Recon steps in their natural order, with the output file that proves each one.
RECON_STEPS = [
    ("meta", "recon/meta/meta.json", "Metadata"),
    ("intake", "recon/intake/intake.json", "OCR + reverse search"),
    ("textgeo", "recon/textgeo.json", "Text → countries"),
    ("detect", "recon/detect/detect.json", "Object detection"),
    ("calib", "recon/calib.json", "Camera calibration"),
    ("prior", "recon/prior/prior.json", "World prior"),
]

_lock = threading.Lock()
_JOBS: dict[str, dict] = {}         # job id -> job info (proc, started, kind, slot, command, log)
_slots: dict[tuple, str] = {}       # lock key (kind-class × session [+ tool]) -> job id
MAX_JOBS = 3                        # global cap on concurrent jobs, overridable with --max-jobs


def log(msg: str) -> None:
    print(f"[webui] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def utcnow() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())


def _base_env() -> dict:
    return {**os.environ, "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1", "TOKENIZERS_PARALLELISM": "false"}


def run_cmd(cmd: list[str], cwd: Path) -> int:
    """Run a command with stdout+stderr merged and printed to our log (raw text)."""
    log("$ " + " ".join(str(c) for c in cmd))
    try:
        r = subprocess.run(cmd, cwd=str(cwd), text=True, encoding="utf-8", errors="replace",
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=None, env=_base_env())
        if r.stdout:
            print(r.stdout, end="", flush=True)
        if r.returncode != 0:
            log(f"exit code {r.returncode}")
        return r.returncode
    except FileNotFoundError as exc:
        log(f"command not found: {exc}")
        return 127


def run_capture(cmd: list[str], cwd: Path) -> tuple[int, str]:
    """Run a command, return (return code, combined stdout+stderr) captured for API use."""
    log("$ " + " ".join(str(c) for c in cmd))
    try:
        r = subprocess.run(cmd, cwd=str(cwd), text=True, encoding="utf-8", errors="replace",
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=None, env=_base_env())
        return r.returncode, (r.stdout or "")
    except FileNotFoundError as exc:
        log(f"command not found: {exc}")
        return 127, str(exc)


def parse_multipart(content_type: str, body: bytes) -> dict:
    if not content_type.startswith("multipart/form-data"):
        return {}
    raw = ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("utf-8") + body
    try:
        msg = email.message_from_bytes(raw)
    except Exception as exc:  # noqa: BLE001
        log(f"multipart parse error: {exc}")
        return {}
    fields: dict = {}
    if not msg.is_multipart():
        return fields
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        filename = part.get_filename()
        if filename:
            fields[name] = {"filename": os.path.basename(filename), "content": part.get_payload(decode=True) or b""}
        else:
            payload = part.get_payload(decode=True)
            fields[name] = payload.decode("utf-8", "replace").strip() if payload else (part.get_payload() or "")
    return fields


def session_folder(root: Path, name: str) -> Path:
    if not SESSION_NAME.fullmatch(name):
        raise ValueError("invalid session name")
    folder = (root / name).resolve()
    if not folder.is_relative_to(root.resolve()):
        raise ValueError("invalid session path")
    if not (folder / "session.json").is_file():
        raise ValueError("no such session")
    return folder


def session_meta(folder: Path) -> dict:
    try:
        return json.loads((folder / "session.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def list_sessions(root: Path) -> list[dict]:
    out = []
    if not root.exists():
        return out
    for folder in sorted(root.iterdir()):
        meta = session_meta(folder)
        if not meta:
            continue
        original = (folder / (meta.get("original") or {}).get("relative_path", "")) if meta.get("original") else None
        thumb = None
        if original and original.is_file():
            thumb = "files?path=" + _safe_rel(folder, original)
        out.append({
            "name": folder.name,
            "started_at": meta.get("started_at"),
            "completed_at": meta.get("completed_at"),
            "status": meta.get("status"),
            "result": meta.get("result"),
            "truth": (meta.get("truth") or {}).get("error_km"),
            "photo": (meta.get("original") or {}).get("relative_path"),
            "thumb": thumb,
            "jobs": job_status(folder),
        })
    out.sort(key=lambda s: s["started_at"] or "", reverse=True)
    return out


def _safe_rel(folder: Path, path: Path) -> str:
    return path.relative_to(folder).as_posix()


def files_index(folder: Path) -> dict:
    groups: dict[str, list[str]] = {}
    count = 0
    for p in sorted(folder.rglob("*")):
        if p.is_file() and p.suffix.lower() in FILE_EXTS and ".webui" not in p.parts:
            rel = _safe_rel(folder, p)
            parent = rel.rsplit("/", 1)[0] if "/" in rel else ""
            top = parent or "(root)"
            groups.setdefault(top, []).append(rel)
            count += 1
            if count >= 600:
                break
    return groups


def job_dir(folder: Path) -> Path:
    d = folder / ".webui" / "jobs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def job_status(folder: Path) -> list[dict]:
    out = []
    for p in sorted((job_dir(folder)).glob("*.json")):
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
            j["job_id"] = p.stem
            out.append(j)
        except (OSError, json.JSONDecodeError):
            continue
    with _lock:
        for j in _JOBS.values():
            if j["session"] == folder.name and j["proc"].poll() is None:
                out.append({"job_id": j["job"], "session": folder.name, "status": "running",
                            "kind": j.get("kind"), "command": j.get("command"),
                            "log": (folder / ".webui" / "jobs" / (j["job"] + ".log")).name,
                            "started": j.get("started")})
    out.sort(key=lambda j: j.get("started") or "")
    return out


def global_running() -> int:
    with _lock:
        return sum(1 for j in _JOBS.values() if j["proc"].poll() is None)


def flow_len() -> int:
    with _lock:
        return len(_JOBS)


def _step_digest(key: str, d: dict | None) -> str:
    """One-line, human-readable summary of a step's artifact, for the live tracker."""
    if not d:
        return ""
    if key == "meta":
        dg = d.get("digest") or {}
        im = dg.get("image") or {}
        size = f"{im.get('size',[0,0])[0]}×{im.get('size',[0,0])[1]}" if im.get("size") else ""
        gps = dg.get("gps") or {}
        cam = dg.get("camera") or {}
        parts = [p for p in [size, cam.get("model") if isinstance(cam, dict) else None, "GPS ✓" if gps.get("lat") is not None else "no GPS"] if p]
        return " · ".join(parts)
    if key == "intake":
        ocr_n = len((d.get("ocr") or {}).get("items", []))
        rev = d.get("rev") or []
        if isinstance(rev, list):
            statuses = sorted({str(r.get("engine", "")) + (" " + r.get("error") if r.get("error") else "") for r in rev})
            done_n = sum(1 for r in rev if r.get("error") is None and not r.get("refused") and r.get("shot"))
            rev_tip = f" · reverse {done_n}/{len(rev)} sheets" + ((", " + ", ".join(statuses)) if statuses else "")
        else:
            rev_tip = ""
        return f"OCR {ocr_n} text item(s){rev_tip}"
    if key == "textgeo":
        sl = (d.get("shortlist") or [])[:3]
        top = ", ".join(f"{s.get('name')} ({s.get('log_lr')})" for s in sl if s.get("name"))
        sig = len(d.get("signals") or [])
        return (f"signals {sig} · top: {top}" if top else f"no text signals ({sig} candidates)")
    if key == "detect":
        return f"{len(d.get('detections', []))} detection(s), {d.get('model') or 'model'}"
    if key == "calib":
        return (f"hfov {d.get('hfov_deg')}°, 35 mm eq {d.get('focal_35mm_equiv')} mm"
                if d.get("hfov_deg") is not None else "calibration inconclusive")
    if key == "prior":
        def _top(blob):
            if isinstance(blob, dict):
                for k in ("top", "countries"):
                    v = blob.get(k)
                    if isinstance(v, list) and v and isinstance(v[0], dict):
                        return v[0].get("name")
                return None
            if isinstance(blob, list) and blob and isinstance(blob[0], dict):
                return blob[0].get("name")
            return None
        gc = d.get("geoclip")
        cc = d.get("combined")
        n = d.get("crops")
        parts = [f"{n} crop(s)" if isinstance(n, int) else ""]
        for blob, tag in ((gc, "geo"), (cc, "combined")):
            t = _top(blob)
            if t:
                parts.append(f"{tag}: {t}")
        return " · ".join(p for p in parts if p)
    return ""


def recon_live(folder: Path) -> dict:
    """Per-step progress for a recon, inferred from the files it writes.

    Works for a job that is still running (files appear as each step finishes)
    and after completion (recon/recon.json carries the real exit codes).
    """
    steps = []
    done = 0
    with _lock:
        jid = _slots.get(("recon", str(folder)))
        j = _JOBS.get(jid) if jid else None
        alive = j is not None and j["proc"].poll() is None
    recon_json = {}
    try:
        recon_json = json.loads((folder / "recon" / "recon.json").read_text(encoding="utf-8")).get("steps", {})
    except (OSError, json.JSONDecodeError):
        pass
    for key, artifact, label in RECON_STEPS:
        present = (folder / artifact).is_file()
        entry = recon_json.get(key)
        if entry and entry.get("rc") == 0:
            state = "done"
        elif entry and entry.get("rc"):
            state = "failed"
        elif present:
            state = "done"
        elif alive:
            state = "running"
        else:
            state = "pending"
        if state == "done":
            done += 1
        digest = ""
        if state == "done":
            try:
                digest = _step_digest(key, json.loads((folder / artifact).read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError, TypeError, AttributeError, KeyError):
                digest = ""
        steps.append({"key": key, "label": label, "state": state, "digest": digest})
    return {
        "steps": steps,
        "done": done,
        "total": len(RECON_STEPS),
        "alive": alive,
        "started": j.get("started") if alive else None,
        "finished": (folder / "recon" / "recon.md").is_file(),
    }


def start_pipeline(folder: Path, command: list[str], kind: str, slot: tuple) -> dict:
    if not command[0].startswith(os.sep):
        command = [shutil.which(command[0]) or command[0]] + command[1:]
    with _lock:
        jid = _slots.get(slot)
        existing = _JOBS.get(jid) if jid else None
        if existing is not None and existing["proc"].poll() is None:
            raise RuntimeError(f"a job is already running for this session")
        busy = sum(1 for j in _JOBS.values() if j["proc"].poll() is None)
        if busy >= MAX_JOBS:
            raise JobBusyError(f"{busy} GeoInt job(s) already running (max {MAX_JOBS})")
        jl = job_dir(folder) / (uuid.uuid4().hex[:12] + ".log")
        out = open(jl, "a", encoding="utf-8")
        log(f"starting {kind} job for {folder.name}: $ {' '.join(str(c) for c in command)}")
        proc = subprocess.Popen(command, cwd=str(folder), stdout=out, stderr=subprocess.STDOUT,
                                text=True, env=_base_env())
        job_id = jl.stem
        info_started = utcnow()
        info = {"job": job_id, "session": folder.name, "proc": proc, "started": info_started,
                "kind": kind, "slot": slot, "command": [str(c) for c in command]}
        _JOBS[job_id] = info
        _slots[slot] = job_id

    def wait() -> None:
        try:
            rc = proc.wait()
        except Exception as exc:  # noqa: BLE001
            rc = 127
            log(f"job {job_id} wait error: {exc}")
        finally:
            out.close()
        result = {"job": job_id, "session": folder.name, "status": "done" if rc == 0 else "failed",
                  "rc": rc, "kind": kind, "command": [str(c) for c in command],
                  "started": info_started, "ended": utcnow(), "log": jl.name}
        try:
            (job_dir(folder) / (job_id + ".json")).write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
        except OSError:
            pass  # session folder may have been deleted while the job ran
        with _lock:
            _JOBS.pop(job_id, None)
            if _slots.get(slot) == job_id:
                _slots.pop(slot, None)
        log(f"job {job_id} finished rc={rc}")

    threading.Thread(target=wait, daemon=True).start()
    return {"job": job_id, "session": folder.name, "status": "running", "kind": kind,
            "started": info_started, "log": jl.name}


class JobBusyError(RuntimeError):
    """Raised when the global job cap is reached."""


# --------------------------------------------------------------------------- #
# Tool registry (curated, parameterised script invocations)
# --------------------------------------------------------------------------- #

def _arr(*parts: str) -> list[str]:
    return [p for p in parts if p]


def tool_textgeo(k: str) -> tuple[list[str], str]:
    text = k.get("text", "").strip()
    if not text:
        raise ValueError("text is required")
    return [UV, "run", "-q", str(SCRIPTS / "textgeo.py"), "--text", text], "textgeo"


def tool_geodata(k: str) -> tuple[list[str], str]:
    cmd = k.get("cmd", "").strip()
    q = k.get("query", "").strip()
    cc = k.get("cc", "").strip().upper()
    region = k.get("admin1", "").strip()
    if cmd == "search" and q:
        return [UV, "run", "-q", str(SCRIPTS / "geodata.py"), "search", q], "geodata"
    if cmd == "towns" and cc:
        return [UV, "run", "-q", str(SCRIPTS / "geodata.py"), "towns", cc] + _arr("--admin1", region), "geodata"
    raise ValueError("geodata: use cmd=search with query, or cmd=towns with cc [and admin1]")


def tool_board(k: str, folder: Path) -> tuple[list[str], str]:
    cmd = k.get("cmd", "").strip()
    script = str(SCRIPTS / "board.py")
    meta = session_meta(folder)
    rel_photo = (meta.get("original") or {}).get("relative_path") or "original"
    if cmd == "init":
        return [UV, "run", "-q", script, "init", "--photo", rel_photo], "board"
    if cmd == "apply":
        kind = k.get("kind", "").strip()
        value = k.get("value", "").strip()
        status = " observed" if k.get("observed") else ""
        if not kind or not value:
            raise ValueError("board apply needs kind and value")
        return [UV, "run", "-q", script, "apply", "--kind", kind, "--value", value + status], "board"
    if cmd == "clue":
        clue = k.get("clue", "").strip()
        kind = k.get("kind", "").strip()
        if not clue:
            raise ValueError("board clue needs the clue text")
        args = [UV, "run", "-q", script, "clue", clue] + _arr("--kind", kind or "observed")
        if k.get("status"):
            args += ["--status", k["status"]]
        return args, "board"
    if cmd == "ingest":
        src = k.get("source", "").strip()
        if src == "textgeo":
            return [UV, "run", "-q", script, "ingest", "recon/textgeo.json"], "board"
        if src == "prior":
            return [UV, "run", "-q", script, "ingest", "recon/prior/prior.json"], "board"
        raise ValueError("board ingest: source=textgeo|prior")
    single = {"rank": ["rank"], "next": ["next"]}
    if cmd in single:
        return [UV, "run", "-q", script, single[cmd][0]], "board"
    if cmd == "report":
        return [UV, "run", "-q", script, "report"], "board"
    if cmd == "check":
        return [UV, "run", "-q", script, "check"], "board"
    raise ValueError("unsupported board command")


def tool_refsheet(k: str, folder: Path) -> tuple[list[str], str]:
    where = k.get("where", "").strip().replace(" ", "")
    n = k.get("n", "").strip() or "6"
    if not where:
        raise ValueError("refsheet needs a target (e.g. countries=PT,ES,MA or regions=ES:Andalusia,ES:Galicia)")
    kind, _, values = where.partition("=")
    if kind not in ("countries", "regions") or not values:
        raise ValueError("use countries=CC,CC… or regions=CC:Region,CC:Region…")
    return [UV, "run", "-q", str(SCRIPTS / "refsheet.py"), kind, values, "--n", n,
            "--out", f"refsheet_{kind}_{values.replace(',', '_')}.jpg"], "refsheet"


def build_tool(folder: Path, body: dict) -> tuple[list[str], str, str] | None:
    tool = (body.get("tool") or "").strip()
    k = body.get("args") or {}
    if tool == "textgeo":
        cmd, kind = tool_textgeo(k)
        return cmd, kind, "textgeo"
    if tool == "geodata":
        cmd, kind = tool_geodata(k)
        return cmd, kind, "geodata"
    if tool == "board":
        cmd, kind = tool_board(k, folder)
        return cmd, kind, "board"
    if tool == "refsheet":
        cmd, kind = tool_refsheet(k, folder)
        return cmd, kind, "refsheet"
    if tool == "custom":
        parts = body.get("argv")
        if not isinstance(parts, list) or not parts:
            raise ValueError("custom needs an argv list")
        safe = []
        for p in parts:
            if not isinstance(p, str) or not re.fullmatch(r"[A-Za-z0-9_./,+:@\[\]{}()=# -]+", p) or ".." in p:
                raise ValueError("unsafe custom argv element")
            safe.append(p)
        script = Path(safe[0]).name
        if script.endswith(".py") and (SCRIPTS / script).is_file():
            return [UV, "run", "-q", str(SCRIPTS / script)] + safe[1:], "custom", "custom"
        raise ValueError("custom argv must start with a GeoInt script name (… .py)")
    return None


TOOLS_INFO = [
    {"name": "textgeo", "label": "Text → countries / phones / brands / places",
     "fields": [{"key": "text", "label": "Text to analyse", "type": "text", "placeholder": "…"}]},
    {"name": "geodata", "label": "GeoNames lookup",
     "fields": [
         {"key": "cmd", "label": "Command", "type": "select",
          "options": [{"value": "search", "label": "search a place name"}, {"value": "towns", "label": "towns of a country"}]},
         {"key": "query", "label": "Place name (for search)", "type": "text", "placeholder": "…"},
         {"key": "cc", "label": "Country code (for towns)", "type": "text", "placeholder": "PT"},
         {"key": "admin1", "label": "Region / admin1 (optional)", "type": "text", "placeholder": "…"}]},
    {"name": "board", "label": "Reasoning board",
     "fields": [
         {"key": "cmd", "label": "Command", "type": "select",
          "options": [
              {"value": "init", "label": "init (start the board)"},
              {"value": "apply", "label": "apply a whole-category clue (driving side…)"},
              {"value": "clue", "label": "record an observed clue"},
              {"value": "ingest", "label": "ingest recon signals (textgeo / prior)"},
              {"value": "rank", "label": "rank candidates"},
              {"value": "next", "label": "next discriminating test"},
              {"value": "check", "label": "check the board for consistency"},
              {"value": "report", "label": "report"}]},
         {"key": "kind", "label": "Kind", "type": "text", "placeholder": "e.g. driving-side, vegetation, architecture"},
         {"key": "value", "label": "Value", "type": "text", "placeholder": "e.g. left, right"},
         {"key": "clue", "label": "Clue text", "type": "text", "placeholder": "red laterite soil, eucalyptus"},
         {"key": "source", "label": "Ingest source", "type": "select",
          "options": [{"value": "textgeo", "label": "textgeo.json"}, {"value": "prior", "label": "prior.json"}]}]},
    {"name": "refsheet", "label": "Street View reference sheets",
     "fields": [
         {"key": "where", "label": "Target", "type": "text", "placeholder": "countries=PT,ES,MA or regions=ES:Andalusia,ES:Galicia"},
         {"key": "n", "label": "Rows per target", "type": "text", "placeholder": "6"}]},
]

# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    server_version = "GeoIntWeb/0.1"
    root: Path = Path.home() / "geoint-photos"

    # -- plumbing ----------------------------------------------------------- #
    def log_message(self, fmt: str, *args: object) -> None:
        log("[http] " + (fmt % args))

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self.send_error(413, "upload too large")
            return b""
        return self.rfile.read(length)

    def send_json(self, data: object, status: int = 200) -> None:
        payload = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def send_file(self, path: Path) -> None:
        if not path.is_file():
            self.send_json({"error": f"no such file: {path}"}, 404)
            return
        mime = mimetypes.guess_type(path.as_posix())[0] or "application/octet-stream"
        with path.open("rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _route(self) -> dict:
        parsed = urlparse(self.path)
        return {"path": unquote(parsed.path), "query": {k: v[-1] for k, v in parse_qs(parsed.query).items()}}

    # -- GET ---------------------------------------------------------------- #
    def do_GET(self) -> None:  # noqa: N802
        route = self._route()
        path, q = route["path"], route["query"]
        try:
            if path == "/" or path == "/index.html":
                self._static_file("index.html")
            elif path.startswith("/static/"):
                rel = os.path.basename(path[len("/static/"):])
                self._static_file(rel)
            elif path == "/api/sessions":
                self.send_json({"root": str(self.root), "sessions": list_sessions(self.root)})
            elif path.startswith("/api/session/"):
                self._session_get(path, q)
            elif path == "/api/health":
                self.send_json({"ok": True, "repo": str(REPO), "uv": shutil.which(UV)})
            else:
                self.send_json({"error": "not found"}, 404)
        except (ValueError, KeyError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001
            log(f"GET {path} error: {exc!r}")
            self.send_json({"error": f"internal error: {exc}"}, 500)

    def _static_file(self, rel: str) -> None:
        safe = os.path.basename(rel)
        self.send_file(STATIC / safe)

    def _session_get(self, path: str, q: dict) -> None:
        rest = path[len("/api/session/"):].strip("/")
        parts = rest.split("/")
        name = parts[0]
        folder = session_folder(self.root, name)
        sub = parts[1] if len(parts) > 1 else ""
        if not sub:
            meta = session_meta(folder)
            self.send_json({
                "name": name,
                "folder": str(folder),
                "meta": meta,
                "result": meta.get("result"),
                "truth": meta.get("truth"),
                "files": files_index(folder),
                "jobs": job_status(folder),
                "report": (folder / "report.md").read_text(encoding="utf-8") if (folder / "report.md").is_file() else "",
            })
        elif sub == "recon" and len(parts) == 2:
            self.send_json(recon_payload(folder))
        elif sub == "recon" and len(parts) == 3 and parts[2] == "status":
            running = None
            log_tail = ""
            with _lock:
                for j in _JOBS.values():
                    if j["session"] == folder.name and j["kind"] == "recon" and j["proc"].poll() is None:
                        running = {"job": j["job"], "kind": j.get("kind"), "started": j.get("started")}
            if running:
                lf = job_dir(folder) / (running["job"] + ".log")
                if lf.is_file():
                    raw = lf.read_text(encoding="utf-8", errors="replace")
                    log_tail = raw[-4000:]
            self.send_json({
                "running": running,
                "jobs": job_status(folder),
                "log_tail": log_tail,
                "live": recon_live(folder),
                "global_running": global_running(),
                "max_jobs": MAX_JOBS,
                "now": utcnow(),
            })
        elif sub == "files":
            rel = unquote(q.get("path", ""))
            target = (folder / rel).resolve()
            if not target.is_relative_to(folder.resolve()):
                raise ValueError("invalid path")
            self.send_file(target)
        elif sub == "report":
            self.send_json({"content": (folder / "report.md").read_text(encoding="utf-8") if (folder / "report.md").is_file() else ""})
        elif sub == "tools":
            self.send_json({"tools": TOOLS_INFO})
        elif sub == "job" and len(parts) == 3:
            lf = job_dir(folder) / (parts[2] + ".log")
            if not lf.is_file():
                self.send_json({"error": "no such job log"}, 404)
                return
            self.send_json({"content": lf.read_text(encoding="utf-8", errors="replace")[-20000:]})
        else:
            self.send_json({"error": "unknown session endpoint"}, 404)

    # -- POST --------------------------------------------------------------- #
    def do_POST(self) -> None:  # noqa: N802
        route = self._route()
        path = route["path"]
        body = self._read_body()
        if not body and "multipart" in self.headers.get("Content-Type", ""):
            return
        try:
            ctype = self.headers.get("Content-Type", "")
            if "application/json" in ctype or "text/plain" in ctype:
                data = json.loads(body.decode("utf-8") or "{}")
            elif "multipart" in ctype:
                data = parse_multipart(ctype, body)
            else:
                data = {"error": "unsupported content type"}
            if path == "/api/sessions":
                self._api_create_session(data)
            elif path.startswith("/api/session/"):
                self._session_post(path, data)
            else:
                self.send_json({"error": "not found"}, 404)
        except json.JSONDecodeError:
            self.send_json({"error": "invalid JSON body"}, 400)
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, 409)
        except JobBusyError as exc:
            self.send_json({"error": str(exc)}, 429)
        except (ValueError, KeyError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001
            log(f"POST {path} error: {exc!r}")
            self.send_json({"error": f"internal error: {exc}"}, 500)

    def do_DELETE(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        try:
            if not path.startswith("/api/session/"):
                self.send_json({"error": "not found"}, 404)
                return
            name = path[len("/api/session/"):].strip("/")
            if "/" in name:
                self.send_json({"error": "not found"}, 404)
                return
            folder = session_folder(self.root, name)
            if not folder.is_dir():
                self.send_json({"error": "no such session"}, 404)
                return
            self._delete_session(folder)
        except Exception as exc:  # noqa: BLE001
            log(f"DELETE {path} error: {exc!r}")
            self.send_json({"error": f"internal error: {exc}"}, 500)

    def _api_create_session(self, data: dict) -> None:
        photo = data.get("photo")
        if not photo or not isinstance(photo, dict) or not photo.get("content"):
            raise ValueError("upload a photo (field 'photo')")
        suffix = Path(photo["filename"]).suffix or ".jpg"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(photo["content"])
            tmp_path = Path(tmp.name)
        try:
            cmd = [PY, str(SCRIPTS / "photo_session.py"), "start", "--image", str(tmp_path), "--root", str(self.root)]
            if run_cmd(cmd, cwd=REPO) != 0:
                raise RuntimeError("photo_session.py start failed; see server log")
            joined = [d for d in self.root.iterdir() if d.is_dir()
                      and (d / "session.json").is_file() and json.loads((d / "session.json").read_text(encoding="utf-8")).get("status") == "pending"]
            if not joined:
                raise RuntimeError("session not found after start")
            name = max(joined, key=lambda d: d.stat().st_mtime)
            meta = json.loads((name / "session.json").read_text(encoding="utf-8"))
            self.send_json({"name": name.name, "folder": str(name), "meta": meta}, 201)
        finally:
            tmp_path.unlink(missing_ok=True)

    def _session_post(self, path: str, data: dict) -> None:
        rest = path[len("/api/session/"):].strip("/")
        parts = rest.split("/")
        name = parts[0]
        folder = session_folder(self.root, name)
        sub = parts[1] if len(parts) > 1 else ""

        if not sub:
            raise ValueError("missing action")
        if sub == "recon" and len(parts) == 2:
            self._start_recon(folder, name, data)
        elif sub == "report":
            content = data.get("content")
            if content is None:
                raise ValueError("report content is required")
            (folder / "report.md").write_text(str(content), encoding="utf-8")
            self.send_json({"ok": True})
        elif sub == "tools":
            cmd, kind, slot_tool = build_tool(folder, data)
            if cmd is None:
                raise ValueError("unknown tool")
            info = start_pipeline(folder, cmd, kind, ("tool", str(folder), slot_tool))
            self.send_json(info, 202)
        elif sub == "rename":
            self._rename_session(folder, data)
        elif sub == "delete":
            self._delete_session(folder)
        elif sub == "job" and len(parts) == 4 and parts[3] == "stop":
            self._stop_job(parts[2])
        elif sub == "recon" and len(parts) == 3 and parts[2] == "stop":
            with _lock:
                jid = _slots.get(("recon", str(folder)))
            if not jid:
                raise ValueError("no recon running for this session")
            self._stop_job(jid)
        elif sub == "finish":
            self._finish(folder, data)
        elif sub == "truth":
            self._truth(folder, data)
        else:
            raise ValueError("unknown action")

    def _start_recon(self, folder: Path, name: str, data: dict) -> None:
        meta = session_meta(folder)
        rel = (meta.get("original") or {}).get("relative_path")
        if not rel:
            raise ValueError("session has no original image")
        script = str(SCRIPTS / "recon.py")
        cmd = [UV, "run", "-q", script, rel, "--out-dir", "recon"]
        if data.get("no_ml"):
            cmd.append("--no-ml")
        if data.get("no_rev"):
            cmd.append("--no-rev")
        skip = data.get("skip")
        if skip:
            cmd += ["--skip", ",".join(skip)]
        info = start_pipeline(folder, cmd, "recon", ("recon", str(folder)))
        self.send_json(info, 202)

    def _stop_job(self, jid: str) -> None:
        with _lock:
            j = _JOBS.get(jid)
            if j is None or j["proc"].poll() is not None:
                self.send_json({"error": f"job {jid} is not running"}, 404)
                return
            proc = j["proc"]
        log(f"stopping job {jid} ({j.get('kind')})")
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)
        self.send_json({"ok": True, "stopped": jid})

    def _rename_session(self, folder: Path, data: dict) -> None:
        new = str(data.get("name") or "").strip()
        if not re.fullmatch(SESSION_NAME, new) or new == folder.name:
            raise ValueError("invalid session name")
        newfolder = folder.with_name(new)
        if newfolder.exists():
            raise ValueError("a session with that name already exists")
        old_abs, old_name = str(folder), folder.name
        folder.rename(newfolder)
        for p in sorted(newfolder.rglob("*")):
            if not p.is_file() or p.stat().st_size > 5_000_000:
                continue
            if p.suffix.lower() not in (".json", ".md", ".txt", ".log", ".tsv", ".csv", ".yml", ".yaml", ".cfg", ".ini"):
                continue
            try:
                raw = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if old_abs in raw or old_name in raw:
                try:
                    p.write_text(raw.replace(old_abs, str(newfolder)).replace(old_name, new), encoding="utf-8", errors="replace")
                except OSError:
                    pass
        self.send_json({"ok": True, "name": new, "folder": str(newfolder)})

    def _delete_session(self, folder: Path) -> None:
        with _lock:
            running = [j for j in _JOBS.values() if j["session"] == folder.name and j["proc"].poll() is None]
            procs = [j["proc"] for j in running]
            for j in running:
                _JOBS.pop(j["job"], None)
                if _slots.get(j["slot"]) == j["job"]:
                    _slots.pop(j["slot"], None)
        log(f"deleting session {folder.name} ({len(procs)} running job(s) killed)")
        for p in procs:
            p.terminate()
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=3)
        shutil.rmtree(folder, ignore_errors=True)
        self.send_json({"ok": True, "deleted": folder.name})

    def _finish(self, folder: Path, data: dict) -> None:
        country = str(data.get("country") or "").strip()
        region = str(data.get("region") or "").strip()
        city = str(data.get("city") or "").strip()
        try:
            lat = float(data.get("lat"))
            lon = float(data.get("lon"))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"bad coordinates: {exc}") from exc
        conf = str(data.get("confidence") or "").strip()
        if conf not in ("high", "medium", "low"):
            raise ValueError("confidence must be high|medium|low")
        report_path = folder / "report.md"
        report = report_path.read_text(encoding="utf-8") if report_path.is_file() else ""
        gut_placeholder = "## Gut call (before tools)\n<!-- fill:"
        if gut_placeholder in report:
            report = report.replace(gut_placeholder, "## Gut call (before tools)\nRecorded in the web UI.")
        answer_placeholder = "## Answer\n<!-- fill:"
        if answer_placeholder in report:
            report = report.replace(
                answer_placeholder,
                f"## Answer\nCountry: {country}\nRegion: {region or '—'}\nCity / nearest locality: {city}\n"
                f"Coordinates: {lat:.6f}, {lon:.6f}\nConfidence: {conf}",
            )
        report_path.write_text(report, encoding="utf-8")
        cmd = [PY, str(SCRIPTS / "photo_session.py"), "finish", str(folder), "--country", country,
               "--region", region, "--city", city, "--latitude", f"{lat}", "--longitude", f"{lon}",
               "--confidence", conf]
        rc, out = run_capture(cmd, cwd=REPO)
        if rc != 0:
            raise RuntimeError(f"finish failed: {out.strip()[-500:]}")
        final = None
        for d in folder.parent.iterdir():
            if d.is_dir() and (d / "session.json").is_file() and d != folder:
                try:
                    if json.loads((d / "session.json").read_text(encoding="utf-8")).get("status") == "completed":
                        final = d
                        break
                except (OSError, json.JSONDecodeError):
                    continue
        if final is None:
            final = folder
        self.send_json({"ok": True, "name": final.name, "folder": str(final)}, 201)

    def _truth(self, folder: Path, data: dict) -> None:
        try:
            lat = float(data.get("lat"))
            lon = float(data.get("lon"))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"bad coordinates: {exc}") from exc
        cmd = [PY, str(SCRIPTS / "photo_session.py"), "truth", str(folder), "--latitude", f"{lat}", "--longitude", f"{lon}"] + \
            _arr("--country", str(data.get("country") or "")) + _arr("--region", str(data.get("region") or "")) + \
            _arr("--city", str(data.get("city") or "")) + _arr("--source", str(data.get("source") or ""))
        rc, out = run_capture(cmd, cwd=REPO)
        if rc != 0:
            raise RuntimeError(f"truth failed: {out.strip()[-500:]}")
        try:
            truth = json.loads(out)
        except json.JSONDecodeError:
            truth = {"error": "unparseable output"}
        self.send_json({"ok": True, "truth": truth})


def recon_payload(folder: Path) -> dict:
    def jl(rel: str) -> dict:
        try:
            return json.loads((folder / rel).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    recon_md = folder / "recon" / "recon.md"
    return {
        "name": folder.name,
        "has": recon_md.is_file(),
        "md": recon_md.read_text(encoding="utf-8") if recon_md.is_file() else "",
        "steps": jl("recon/recon.json").get("steps", {}),
        "meta": (jl("recon/meta/meta.json").get("digest") if jl("recon/meta/meta.json") else None),
        "ocr": jl("recon/intake/ocr.json"),
        "textgeo": jl("recon/textgeo.json") or {"error": "recon has no textgeo.json (run recon first)"},
        "prior": jl("recon/prior/prior.json"),
        "calib": jl("recon/calib.json"),
        "detect": jl("recon/detect/detect.json"),
        "intake": jl("recon/intake/intake.json"),
    }


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def cleanup_orphans(root: Path) -> None:
    """Mark jobs left behind by a crashed server so they don't linger as 'running'.

    A job's `.log` with no matching `.json` means the server died before the job
    completed. The child process may still be running; we record it as orphaned
    (rc=None) so the UI stops waiting and history stays truthful.
    """
    for session in sorted(root.iterdir()) if root.is_dir() else []:
        if not session.is_dir():
            continue
        jdir = session / ".webui" / "jobs"
        if not jdir.is_dir():
            continue
        # every stray .log without a .json becomes an orphan record
        for logf in jdir.glob("*.log"):
            if (jdir / (logf.stem + ".json")).exists():
                continue
            payload = {
                "job": logf.stem, "session": session.name, "status": "orphaned",
                "rc": None, "kind": "orphan", "command": None,
                "started": None, "ended": utcnow(), "log": logf.name,
            }
            (jdir / (logf.stem + ".json")).write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
            log(f"orphaned job {logf.stem} in {session.name}: orphaned")
        # reconcile: an orphan whose recon actually finished should read as `done`
        reconj = session / "recon" / "recon.json"
        if reconj.is_file():
            try:
                steps = json.loads(reconj.read_text(encoding="utf-8")).get("steps", {})
            except (OSError, json.JSONDecodeError):
                steps = {}
            if steps and all((st.get("rc") or 0) == 0 for st in steps.values()):
                for rj in jdir.glob("*.json"):
                    try:
                        rec = json.loads(rj.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        continue
                    if rec.get("status") == "orphaned":
                        rec["status"] = "done"
                        rec["rc"] = 0
                        rec["kind"] = rec.get("kind") or "recon"
                        rj.write_text(json.dumps(rec, ensure_ascii=False) + "\n", encoding="utf-8")
                        log(f"reconciled orphan {rec['job']} in {session.name}: done")


def main() -> None:
    ap = argparse.ArgumentParser(description="GeoInt Web UI.")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8787, help="port (default 8787)")
    ap.add_argument("--max-jobs", type=int, default=3, help="max concurrent GeoInt jobs (default 3)")
    ap.add_argument("--root", default=str(Path.home() / "geoint-photos"),
                    help="Photo archive root (default ~/geoint-photos)")
    ap.add_argument("--open", action="store_true", help="open the browser after starting")
    args = ap.parse_args()
    global MAX_JOBS
    MAX_JOBS = max(1, args.max_jobs)
    Handler.root = Path(args.root).expanduser().resolve()
    Handler.root.mkdir(parents=True, exist_ok=True)
    cleanup_orphans(Handler.root)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    log(f"GeoInt Web UI listening on {url}  (archive root: {Handler.root}, max jobs: {MAX_JOBS})")
    log(f"Try: {url}  |  press Ctrl+C to stop")
    if args.open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
        httpd.shutdown()


if __name__ == "__main__":
    main()