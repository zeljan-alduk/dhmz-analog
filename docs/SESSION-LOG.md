# Session log — running notes for handoff

Last edited at the end of the session that built the OpenCV backend +
Kalibracija redesign. **Read CLAUDE.md first**, then this file for in-progress
work and the user's open requests.

## What we built this session (in order)

1. **OpenCV backend** (`backend/`) — FastAPI + opencv-python-headless +
   numpy + scikit-image, deployed to `/opt/dhmz-backend` on the VPS,
   accessible at `/api/*` through the existing edge nginx.

2. **`/api/extract-trace`** — warp the image to chart-mm via the user's
   calibration, mask the trace ink, per-time-bin median sampling,
   1D-median-filter outlier rejection, return dense (day, hour, value)
   points + display-px coords. Verified end-to-end on barograph,
   hygrograph, thermograph (puna). Verified prazna returns 0 points
   (no false positives from grid alone).

3. **`/api/calibrate-grid`** — HoughLinesP on the green-grid mask, cluster
   by angle (peak-of-mod-90 histogram), find outermost horizontals and
   verticals, intersect → 4 chart corners. Returns dominant grid angle as
   a deskew hint.

4. **`/api/rectify`** — warp image to a chart-mm preview canvas. Used by
   the new sidebar to show "what the calibration produces" thumbnail.

5. **Continuous polyline trace render** in `OverlayCanvas.tsx` — replaces
   the dot-swarm with an SVG `<polyline>` connecting points sorted by
   (day, hour). Per-point dots shrunk to 4 px, expand on hover.

6. **Backend frontend integration**:
   - "Auto-cal (sjecišta)" button calls `/api/calibrate-grid`.
   - "Auto-extract trag" button calls `/api/extract-trace`.
   - Tinta segmented control (auto/blue/red/black) for ink-color preset.

7. **Bundled template** — user copied
   `/Users/aldo/Desktop/tracks/reference/barograf_reference.png` to
   `/opt/dhmz-backend/templates/barograph.png`. Loaded once at module
   import. Wired into `extract-trace` as the default template subtraction
   when chart-type matches barograph value range.

8. **Template subtraction** — ECC alignment + residual mask, with green
   exclusion to filter grid-misalignment ghosts. ECC fails ~50 % of the
   time on real images — fallback uses direct subtract with bumped
   threshold + green-mask.

9. **Calibrate screen redesign** — two-column layout. Header has back,
   title, traffic-light quality badge, hero "Auto-kalibracija" (backend),
   "Alt: JS" fallback, Digitaliziraj. Right sidebar has:
   - Pregled rektifikacije (live `/api/rectify` preview, debounced 600 ms)
   - Pregled maske (mask opacity slider, always visible)
   - Rotacija slike (collapsible — coarse buttons + fine slider)
   - Postavke detekcije (collapsible — 10 sliders)
   - Log aktivnosti (collapsible — newest-first activity log with
     timestamped colored entries, hooked into auto-cal/auto-detect/rotate)

10. **Removed the "Primjer predloška" preview** from the instrument-pick
    screen and the upload step (all three instruments). User explicitly
    asked. `ChartSVG` import in `page.tsx` removed (orphaned).

## Open user requests (NOT YET DONE)

1. **Drag-to-move corners** — currently click-to-remove only. Sidebar
   redesign mentioned this; not implemented.

2. **Red-grid charts** — user uploaded a screenshot showing a barograph
   with RED/BROWN grid (not green). Current HSV gate (`H 35–95`) misses
   it entirely. Need either:
   - Configurable grid-color preset in Postavke detekcije (green / red /
     auto).
   - Auto-detect dominant grid hue per scan and adapt the gate.

3. **Train a tiny model** — user asked. We proposed:
   - **U-Net trace segmenter** (highest ROI, ~50 labeled scans + 1 day
     training). Run via ONNX Runtime in Python or browser.
   - Orientation classifier for upside-down detection.
   - Corner keypoint detector to replace HoughLinesP.
   No training started yet — would need labeled data.

4. **"Use prazna for mask building"** — partially done via template
   subtraction. To go further: precompute the grid-line positions from
   the bundled prazna template at startup, store as a "calibration model"
   that maps (chart-mm) → (template pixel) so we can subtract WITHOUT
   ECC alignment.

5. **Auto-orientation detection** — still naive. The backend
   `calibrate-grid` returns `dominantAngleDeg` which the frontend doesn't
   yet use to suggest a rotation. Easy follow-up: if `|angle| > 0.5°`,
   surface a "Apply detected rotation" button in the sidebar.

## Known bugs / known degraded behaviour

- **Backend cal corners look too "edgy"** on full-bleed test images.
  HoughLinesP picks up the very outer paper edge as a "line" because the
  green grid extends edge to edge. Result: corners at (0,0)–(W,H). This
  is correct for full-bleed scans; will produce slightly inset corners on
  scans with white margin. No action needed unless real scans show
  problems.

- **`/api/extract-trace` template path returns 4043 mask px on the
  barograph puna test** — same as no-template path (i.e., template
  doesn't help). The ECC fails, fallback subtract + green-mask filter
  yields the same result as the green-mask-alone path. Indicates the
  template grid positions don't match the user scan's grid positions
  closely enough. Fix: register template using ORB feature matching →
  ECC handoff for sub-pixel.

- **`samplesPerDay` defaults to 48** in extract-trace request — gives
  ~one point per 30 min × 8 days = 384 max. Frontend asks for 96 in the
  pipeline test (one per 15 min). Adjust as needed.

- **Quality badge** uses `confidence` from auto-cal state which is
  hard-coded to 0.9 for backend cal. Real confidence scoring would
  derive from `(cols_rms, rows_rms)` and detected vs expected line counts
  but the backend cal endpoint doesn't currently compute those. TODO.

## Reference scans on disk

`/Users/aldo/Desktop/tracks/reference/`:
- `barograf_reference.png` — empty barograph, 9992×3956, in-place
  on VPS at `/opt/dhmz-backend/templates/barograph.png`.

`/tmp/tracks/` (user's other scans, used for tests):
- `4-baro-dolje-prazna.png` — empty barograph (test for false-positive
  rejection).
- `12-baro-puna-dolje.png` — barograph with trace.
- `9-hygro-dolje-puna-autocrop.png` — hygrograph with trace.
- `11-termo-dolje-puna.png` — thermograph with trace.

To stage for `chrome-devtools__upload_file`, copy to `$TMPDIR/dhmz-tracks/`
(workspace root.)

## Recent commit list (newest first)

```
Live mask preview + calibrate-screen 2-column redesign
Backend grid-intersection calibration + connected-line trace render
Backend: OpenCV trace extraction (FastAPI + Python)
Fix 'Failed to load image' race during slider drags
Make angle rotation actually responsive
Live-tunable detection config panel
Add manual rotate buttons (90° CW/CCW + 180° flip)
Detect dense-grid charts: lower peak prominence, accept dark grid ink
Robustness: hue gate + relaxed RMS for noisy real scans
Auto-rotation in auto-calibration
Calibration overhaul + grid auto-detection
```

## How to resume next session

1. Read `CLAUDE.md` for the canonical project context.
2. Skim this file for what's pending.
3. The currently-deployed app at https://dhmz.aldo.tech reflects everything
   in `main` — verify with `git status` (should be clean).
4. To pick up where we left off, the highest-ROI items are:
   - Drag-to-move calibration corners (requested, easy)
   - Red-grid chart support (user has unsupported scans)
   - Apply-detected-rotation button in sidebar (free win — backend already
     returns the angle)
5. For ML work: would need labeled trace data. Synthetic generation
   pipeline could bootstrap.
