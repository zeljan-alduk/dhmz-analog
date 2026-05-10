# DHMZ Analog Chart Digitizer — context for Claude

## What this is

Web app that digitizes scanned **Lambrecht-style meteorological strip-chart
recorder** paper (barograph / hygrograph / thermograph) into time-series data.

User flow: pick instrument → upload scan → calibrate (grid corners) → extract
the pen trace → CSV.

Live at **https://dhmz.aldo.tech**.

## Architecture

- **Frontend** — Next.js 16 static export (`out/`) served by an nginx
  container (`dhmz-web`) on the VPS.
- **Backend** — FastAPI + OpenCV + numpy + Pillow + scikit-image in a Docker
  container (`dhmz-backend`) on the VPS.
- **Edge** — `transit-nginx` (in slovenia-transit project) terminates TLS
  and proxies:
  - `/api/*` → `dhmz-backend:8000`
  - `/_next/static/*` and `/` → `dhmz-web:80`
- All three containers share the `slovenia-transit_default` Docker network.
- VPS host is shared with two unrelated projects (aldo-ai, slovenia-transit) —
  **don't touch their containers**, see `/Users/aldo/Documents/ai/VPS_BRIEFING_FOR_NEW_APP.md`.

## Chart-type configs (canonical, mirrored frontend ↔ backend)

| Chart | orientation | chartW × chartH (mm) | range | days | pen arm |
|---|---|---|---|---|---|
| Barograph | landscape | 313 × 76.2 | 950–1060 hPa | 8 | R=177.8, P=44.45 |
| Hygrograph | portrait | 76.2 × 280 | 0–100 % RH | 8 | R=177.8, P=44.45 |
| Thermograph | portrait | 76.2 × 280 | −35–45 °C | 8 | R=177.8, P=44.45 |

Pen-arm geometry produces an **arc-sag** distortion on the time axis. Both
sides ship `arc_sag()` and `chart_to_value()` that invert this. **Don't
re-derive — copy from `src/lib/chart-geometry.ts` ↔ `backend/app/geometry.py`.**

## DISPLAY_SCALE = 4 — the most important number

`src/lib/chart-geometry.ts` defines `DISPLAY_SCALE = 4` and
`getDisplaySize(config)` which returns `(chartW + 36) × 4` for landscape,
`(paperW + 19) × 4` for portrait. **All calibration corner coordinates the
frontend sends to the backend are in this display-px space.** The backend
must scale them up to its natural image pixels before computing the affine
(`backend/app/extract.py` does this — don't change it).

## Key files

### Frontend
- `src/app/page.tsx` — single React component, all state + UI. Calibrate
  step was redesigned to a two-column layout (left canvas, right sidebar
  with rectified preview, log view, quality badge, collapsible tools).
- `src/lib/chart-geometry.ts` — chart configs, arc-sag, `getDisplaySize`,
  `DISPLAY_SCALE`.
- `src/lib/transform.ts` — affine least-squares (image px → chart mm).
- `src/lib/auto-calibration.ts` — JS-side auto-detect (1D projections);
  fallback when backend unavailable.
- `src/components/overlay-canvas/OverlayCanvas.tsx` — image + draggable
  corners + mask overlay + connected-line trace render.

### Backend
- `backend/app/main.py` — FastAPI routes (`/api/health`, `/api/calibrate-grid`,
  `/api/extract-trace`, `/api/rectify`).
- `backend/app/extract.py` — trace pipeline: warp → mask → skeleton-free
  per-time-bin median → smooth → dense points. Loads bundled template at
  module import.
- `backend/app/calibrate.py` — Hough/intersection calibration AND rectify
  endpoint.
- `backend/app/geometry.py` — Python port of arc-sag.
- `backend/app/schemas.py` — Pydantic models. **Must match frontend
  request/response shapes exactly.**
- `backend/templates/barograph.png` — bundled empty-chart reference
  (9992×3956, 60 MB → loaded once and resized to max-edge 4000).

### Tests (run locally, hit live API)
- `backend/test_extract.py <image>` — single extract call
- `backend/test_calibrate.py <image>` — single calibrate call
- `backend/test_pipeline.py <image>` — full calibrate→extract pipeline + viz

Each writes debug PNGs to `/tmp/dhmz-*.png`. Use `--rotate-cw` flag on
portrait scans of landscape charts.

## Critical gotchas

1. **Blob URL race**: rotated/mask/rectified blob URLs are **not revoked
   eagerly** (queued async consumers may still be loading them — would
   surface as "Failed to load image" yellow banners). They're tracked in
   `rotatedUrlsRef`, `maskUrlsRef`, `rectifiedUrlsRef` and revoked on
   Reset only.

2. **`handleAutoCalRef` ref pattern**: the auto-redetect debounced timer
   captures `handleAutoCalibrate` via a ref (not closure) so that when
   `imageUrl` changes mid-debounce, the timer fires the LATEST callback
   with current state.

3. **Test scripts use full-bleed corners**: `test_extract.py` and
   `test_pipeline.py` treat the four image corners as chart corners. This
   is unrealistic — real workflow has corners at the actual grid edges
   (auto-cal output). Full-bleed includes paper margins where day labels
   live; the algorithm has a 6–8 % margin clip to absorb that mismatch.

4. **ECC template alignment fails often** on real scans because the trace
   ink throws off least-squares. The fallback (direct subtract with
   green-mask exclusion) handles that. Keep both paths.

5. **Backend bind-mount**: `docker-compose.yml` mounts `./app:/app/app:ro`
   so most code changes only need `docker compose restart`, not rebuild.
   Rebuild only when `requirements.txt` or `Dockerfile` changes:
   `sudo docker compose up -d --build`.

6. **Chart-type detection on the backend** uses value-range heuristic
   (`950 ≤ min ≤ 1100 ≤ max` → barograph) to pick the bundled template.
   If we add chart types this will break.

## Pending / known-not-done

See `docs/SESSION-LOG.md` for the latest session's open threads. The big ones:

- Calibrate-screen redesign just shipped; **drag-to-move corners** still
  TODO (currently click-to-remove only).
- **Red-grid charts** not handled — the green-only HSV gate misses them.
  Need a configurable grid-color preset OR auto-detect grid hue per scan.
- **Template subtraction** is wired but underperforms vs. green-mask alone
  on the test puna scan because the bundled template's grid positions
  don't perfectly match every user scan. ECC alignment failure in 50 %+
  of cases. Improving with feature-matching (ORB) would help.
- **No ML model trained yet.** User asked about this — see
  `docs/SESSION-LOG.md` for the proposed U-Net plan.
- **Auto-orientation** still naive 90°-rotation guessing. Could be solved
  with a tiny CNN classifier or a vision-LLM call.
- **Reference scans on disk** at `/Users/aldo/Desktop/tracks/reference/`
  (currently barograph_reference.png) — copy to
  `/opt/dhmz-backend/templates/<chart>.png` to bundle.

## Doc index

- `docs/BACKEND.md` — API contracts, pipeline details, template loading
- `docs/DEPLOY.md` — VPS commands, paths, nginx config
- `docs/SESSION-LOG.md` — running notes from this session, in-progress work
