# Backend — API contracts + pipeline notes

FastAPI app at `backend/app/main.py`. Container `dhmz-backend` on the VPS,
internal port 8000, exposed publicly via `transit-nginx` at
`https://dhmz.aldo.tech/api/`.

## Endpoints

### `GET /api/health`
Returns `{"status": "ok"}`. Used as the liveness probe.

### `POST /api/calibrate-grid`
Detect the four chart-grid corners by Hough-line intersection.

**Request** (`CalibrateGridRequest`):
```json
{
  "imageBase64": "...",                    // PNG/JPEG (no data: prefix needed)
  "config": { ... ChartConfig },           // see schemas.py
  "displayWidth": 1396,                    // frontend's getDisplaySize().w
  "displayHeight": 393                     // .h — used to convert returned
                                           // corner pixel coords back to
                                           // display-space
}
```
Pass `?debug=true` to also get a base64 annotated preview (lines colored
green for horizontals, blue for verticals, red circles for the chosen
corners).

**Response** (`CalibrateGridResponse`):
```json
{
  "points": [
    {"imgX": 0, "imgY": 0, "chartX": 0, "chartY": 0},        // top-left
    {"imgX": 1382, "imgY": 0, "chartX": 313, "chartY": 0},    // top-right
    {"imgX": 0, "imgY": 383, "chartX": 0, "chartY": 76.2},    // bot-left
    {"imgX": 1382, "imgY": 383, "chartX": 313, "chartY": 76.2}// bot-right
  ],
  "diagnostics": {
    "detectedHorizontals": 670,
    "detectedVerticals": 64,
    "dominantAngleDeg": 0.0,        // rotation hint for deskew
    "timingMs": {"decode": 320, "mask": 50, "hough": 1050}
  },
  "debugAnnotatedBase64": "..."     // only when ?debug=true
}
```

**Pipeline** (`backend/app/calibrate.py:calibrate_grid`):
1. Decode image (BGR ndarray).
2. Build green-grid mask via HSV gate (H 35–95, S>25, V>60).
3. `cv2.HoughLinesP` on the mask with `min_len = min(h,w) // 8`,
   `threshold=80`, `maxLineGap=10`.
4. Cluster lines by angle (mod 90°): pick the histogram peak, anything
   within ±15° of it is "horizontal", ±15° of perpendicular is "vertical".
   The peak position itself is the dominant grid rotation (deskew hint).
5. For each group, find the line with min and max projection onto the
   perpendicular axis → outermost lines.
6. Fit `ax + by + c = 0` to each outermost segment, intersect
   (top|bottom) × (left|right) → 4 corners.
7. Map to chart-mm corners by chart orientation (landscape vs portrait
   labelling).
8. Scale natural-px coords back to display-px before returning.

Failure modes: returns 400 if fewer than 4 outer grid lines are found.

### `POST /api/rectify`
Warp the image to chart-mm canvas. Used by the frontend sidebar to render
a "this is what the calibration produces" preview.

**Request** (`RectifyRequest`):
```json
{
  "imageBase64": "...",
  "config": { ... },
  "calibrationPoints": [...],            // 3+ corners
  "displayWidth": ..., "displayHeight": ...,
  "previewMaxEdge": 800                  // optional, default 800
}
```

**Response**:
```json
{
  "rectifiedBase64": "iVBOR...",
  "width": 800, "height": 195
}
```

The frontend embeds this directly as `data:image/png;base64,...` in an
`<img>`. Debounced 600 ms in `page.tsx` so dragging corners doesn't spam
the backend.

### `POST /api/extract-trace`
Digitize the pen trace.

**Request** (`ExtractTraceRequest`):
```json
{
  "imageBase64": "...",
  "calibrationPoints": [...],            // 3+ corners
  "displayWidth": ..., "displayHeight": ...,
  "config": { ... },
  "samplesPerDay": 48,                   // ≥1 sample every 30 min
  "traceInk": "auto",                    // auto | blue | red | black
  "templateImageBase64": null            // optional empty-chart for subtract
}
```

If `templateImageBase64` is null AND the chart range matches a bundled
type, the bundled template at `/app/templates/<type>.png` is used.

**Response** (`ExtractTraceResponse`):
```json
{
  "points": [
    {"day": 0, "hour": 0.5, "value": 991.2,
     "canvasX": 12.3, "canvasY": 130.4},     // display-space px for direct
    ...                                       // overlay rendering
  ],
  "diagnostics": {
    "maskPixels": 4043,
    "skeletonPixels": 4043,
    "extractedPoints": 339,
    "rectifiedSize": [6506, 1584],
    "timingMs": {"decode": 280, "warp": 18, "template_align": 1200,
                 "mask": 0, "sample": 80}
  },
  "debugMaskBase64": null,                    // ?debug=true to populate
  "debugRectifiedBase64": null
}
```

**Pipeline** (`backend/app/extract.py:extract_trace`):
1. Decode at native resolution (no downsample).
2. Scale calibration corners from display-px → natural-px (`sx = nat_w / displayWidth`).
3. Compute affine (`compute_affine`) → 2x3 matrix → 3x3 homogeneous.
4. Pick `px_per_mm = max(8, nat_w / chartW, nat_h / chartH)`, capped at 24.
   Avoids downsampling the source.
5. Build full warp `scale @ H` and `cv2.warpPerspective` to (out_w, out_h)
   with white border fill.
6. **Trace mask** (two paths):
   - **Template path** (preferred when template is available): resize
     template to (out_w, out_h), call `_trace_mask_from_residual`. Tries
     ECC affine alignment first; falls back to direct subtract with a
     bumped threshold + green-mask exclusion (handles grid misalignment).
   - **No-template path**: `_build_trace_mask` — adaptive threshold on
     grayscale + green-hue exclusion + ink-color preset (blue/red/black).
7. Margin clip: 6 % top/bottom + 2 % left/right (kills label/date-stamp
   leakage in full-bleed cases).
8. Per-time-bin sampling: convert each mask pixel to (day, hour, value)
   via `chart_to_value` (handles arc-sag inverse), bin by
   `(day*24+hour) / (24/samplesPerDay)`. **Median value per bin** picks
   the trace and rejects scattered noise.
9. 1D-median-filter the resulting value sequence (window 7) to absorb
   single-bin outliers from text/dust.
10. Map (chart-mm) → display-px via inverse affine for `canvasX/Y`.

## Bundled templates

- Loaded once at module import in `extract.py:_load_bundled_templates`.
- Read from `/app/templates/<chart-type>.png` (env var
  `DHMZ_TEMPLATE_DIR` overrides). Resized to max-edge 4000.
- Currently bundled: `barograph.png` (the user's reference,
  9992×3956 → 4000×1584 in memory).
- Activated when `templateImageBase64` is null AND the request's
  `config.minValue/maxValue` matches a heuristic range:
  - 900 ≤ min, max ≤ 1100 → barograph
  - 0 ≤ min, max ≤ 100 → hygrograph
  - −50 ≤ min, max ≤ 50 → thermograph

## Common debug recipes

```bash
# Backend container logs (tail)
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 'sudo docker logs dhmz-backend --tail 50'

# Reachability from edge nginx
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \
  'sudo docker exec transit-nginx wget -qO- http://dhmz-backend:8000/api/health'

# Test pipeline locally (uses the live API)
python3 backend/test_pipeline.py /tmp/tracks/12-baro-puna-dolje.png \
  --chart barograph --rotate-cw --out /tmp/check.png
```
