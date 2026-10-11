# GeoInt Web UI

A local browser interface around the GeoInt CLI scripts — upload a photo, run the
recon pass, read the evidence, run the smaller lookups, and finish or score the
per-photo archive, all without touching a terminal.

Everything runs on this machine. The server is a single dependency-free Python
file (`app.py`, standard library only); every real pipeline still goes through the
existing `scripts/*.py` tools via `uv run`, so nothing about the GeoInt method is
changed. Reads/writes only touch the photo archive root (default
`~/geoint-photos`).

## Run

Requires Python 3.10+ and [uv](https://docs.astral.sh/uv/).

```bash
python3 web/app.py                      # → http://127.0.0.1:8787
python3 web/app.py --port 8788          # different port
python3 web/app.py --root /data/photos  # a different archive root
python3 web/app.py --open               # open the browser
```

Then drag a photo into the drop zone. **Quick recon** runs the fast first pass
(metadata, OCR + text→country, edge/corner crops, Yandex + Baidu reverse image
search) with no local models. **Full recon (ML)** also runs the world-prior models,
object detection and camera calibration; the first full run downloads several GB of
model weights into `~/.cache` (same downloads as `doctor.py --models`).

## What you can do

- **Upload** a photo → creates the timestamped archive via `photo_session.py start`.
- **Recon** → `recon.py`, streamed to a live log; the Overview tab renders the
  `recon.md` summary plus the structured outputs (metadata digest, OCR, text→country
  signals, world prior, calibration, detections).
- **Evidence** → every image the pipeline produced (edge crops, OCR boxes, reverse
  search screenshots, detector sheet, prior map, reference sheets) with a lightbox.
- **Tools** → parameterised, no-shell wrappers for `textgeo.py`, `geodata.py`,
  `board.py` (init / apply / clue / ingest / rank / next / check / report) and
  `refsheet.py`, plus a free-form `argv` runner for the other scripts.
- **Report** → edit `report.md` in place and **Finish archive**
  (`photo_session.py finish`, renames the folder with the answer) or
  **Record ground truth** (`photo_session.py truth`, scores the guess).

Up to `--max-jobs` GeoInt jobs run at once (default 3; a full recon is expensive),
so slow steps from different sessions run in parallel rather than blocking the tab;
oversubscribing returns `409` until a slot frees up.

## Layout

```
web/
  app.py          local HTTP server + job runner (stdlib only)
  static/         index.html / app.js / styles.css (no build step)
  README.md       this file
```

Job state lives in `<session>/.webui/jobs/` (git-invisible next to each archive),
so a restarted server still sees finished jobs.

## Notes

- Binds to `127.0.0.1` by default — a local-only tool, not for public hosting.
- The server never evaluates shell; all script invocations go through
  `subprocess` argument lists.
- `test_photo.jpg` and the `~/geoint-photos` archives are just your local test data,
  not part of the repo.