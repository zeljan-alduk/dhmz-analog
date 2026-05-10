"""OpenCV-based trace extraction.

Pipeline (rewritten per user feedback):
  1. Decode image. Don't downsample.
  2. Compute affine display-px → chart-mm using calibration corners (cal points
     come from the frontend in display-space; we scale them to natural-px).
  3. Warp the image into a rectified, axis-aligned chart-mm canvas at high
     resolution (≥ source resolution to avoid trace anti-aliasing).
  4. Build a TIGHT trace mask: dark non-green ink only (the trace), in the
     ACTIVE chart interior (clip the top/bottom margins where labels live).
  5. For each time-axis bin, take the MEDIAN value-axis position of mask
     pixels. Bins with too few pixels are skipped (gaps in the trace).
  6. Smooth the resulting (time, value) sequence with a 1D median filter,
     then interpolate to produce DENSE samples — visually a continuous line.
"""
import base64
import os
import time
from io import BytesIO
from typing import Optional

import cv2
import numpy as np
from PIL import Image


# ─── Bundled template loading ─────────────────────────────────────────────
# Pre-loaded EMPTY reference scans, one per chart type. Used as the default
# template for /api/extract-trace when the caller doesn't supply one. Loaded
# once at module import to avoid the 60 MB decode per request.
_TEMPLATE_DIR = os.environ.get("DHMZ_TEMPLATE_DIR", "/app/templates")
_TEMPLATE_MAX_EDGE = 4000
_TEMPLATES: dict[str, np.ndarray] = {}


def _load_bundled_templates() -> None:
    """Read /app/templates/<chart-type>.png and cache resized BGR arrays."""
    if not os.path.isdir(_TEMPLATE_DIR):
        return
    for chart_type in ("barograph", "hygrograph", "thermograph"):
        path = os.path.join(_TEMPLATE_DIR, f"{chart_type}.png")
        if not os.path.exists(path):
            continue
        try:
            arr = cv2.imread(path, cv2.IMREAD_COLOR)
            if arr is None:
                continue
            h, w = arr.shape[:2]
            longest = max(h, w)
            if longest > _TEMPLATE_MAX_EDGE:
                scale = _TEMPLATE_MAX_EDGE / longest
                arr = cv2.resize(
                    arr,
                    (int(round(w * scale)), int(round(h * scale))),
                    interpolation=cv2.INTER_AREA,
                )
            _TEMPLATES[chart_type] = arr
            print(f"[template] loaded {chart_type}: {arr.shape}")
        except Exception as e:
            print(f"[template] failed to load {path}: {e}")


_load_bundled_templates()


# ─── ONNX trace-segmenter (optional) ──────────────────────────────────────
# Loaded once at module import. If the model file or onnxruntime is absent,
# falls through to the legacy HSV-based `_build_trace_mask`. The model is
# sized for barograph-style scans (trained on synthetic data drawn over the
# bundled barograph reference) — for hygrograph/thermograph we currently
# stick with HSV until those reference scans are added to the training set.
_ONNX_DIR = os.environ.get("DHMZ_MODEL_DIR", "/app/models")
_ONNX_PATH = os.path.join(_ONNX_DIR, "trace_seg.onnx")
_ONNX_SESSION = None

try:
    if os.path.exists(_ONNX_PATH):
        import onnxruntime as ort

        # CPU-only: backend container has no GPU. ORT picks the fastest
        # available provider per node; CPUExecutionProvider is fine for our
        # 1.9M-param U-Net (~80 ms/inference at 1024×1024 on a modern x86).
        _ONNX_SESSION = ort.InferenceSession(
            _ONNX_PATH, providers=["CPUExecutionProvider"]
        )
        print(f"[onnx] loaded {_ONNX_PATH}")
    else:
        print(f"[onnx] model not found at {_ONNX_PATH}, using HSV fallback")
except Exception as e:
    print(f"[onnx] init failed ({e}); using HSV fallback")
    _ONNX_SESSION = None


def _build_trace_mask_onnx(rectified_bgr: np.ndarray) -> Optional[np.ndarray]:
    """Run the ONNX trace-segmenter on a rectified chart image.

    Pads input to a multiple of 16 (4 downsampling stages) and crops the
    prediction back. Returns a uint8 0/255 mask or None if the model isn't
    available.
    """
    if _ONNX_SESSION is None:
        return None
    h, w = rectified_bgr.shape[:2]
    nh = ((h + 15) // 16) * 16
    nw = ((w + 15) // 16) * 16
    pad_h = nh - h
    pad_w = nw - w
    if pad_h or pad_w:
        padded = cv2.copyMakeBorder(
            rectified_bgr, 0, pad_h, 0, pad_w, cv2.BORDER_REPLICATE
        )
    else:
        padded = rectified_bgr
    rgb = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB)
    x = rgb.astype(np.float32).transpose(2, 0, 1)[None, ...] / 255.0  # (1, 3, H, W)
    logits = _ONNX_SESSION.run(None, {"input": x})[0]  # (1, 1, H, W)
    prob = 1.0 / (1.0 + np.exp(-logits[0, 0]))  # sigmoid
    prob = prob[: prob.shape[0] - pad_h, : prob.shape[1] - pad_w] if (pad_h or pad_w) else prob
    mask = (prob > 0.5).astype(np.uint8) * 255

    # Even with a learned model, we still want to suppress the green grid in
    # case any sigmoid leakage happened — the model saw faded ink in synthetic
    # but never saw "what if the trace IS green?", which it isn't, so this is
    # belt-and-braces filtering.
    hsv = cv2.cvtColor(rectified_bgr, cv2.COLOR_BGR2HSV)
    is_green = (hsv[:, :, 0] >= 30) & (hsv[:, :, 0] <= 100) & (hsv[:, :, 1] > 20)
    mask[is_green] = 0
    return mask


from .schemas import (
    ExtractTraceRequest,
    ExtractTraceResponse,
    DataPoint,
    TraceDiagnostics,
)
from .geometry import (
    compute_affine,
    affine_to_3x3,
    invert_affine_3x3,
    chart_to_value,
)


def _decode_image(b64: str) -> np.ndarray:
    """Base64 → BGR ndarray."""
    if "," in b64 and b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    img = Image.open(BytesIO(raw)).convert("RGB")
    arr = np.array(img)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def _align_template(
    img_bgr: np.ndarray, template_bgr: np.ndarray
) -> Optional[np.ndarray]:
    """Align template to image via ECC. Returns the warped template, or None
    if alignment fails. Uses MOTION_AFFINE which handles small rotation +
    scaling + translation — typical scanner-to-scanner variation.
    """
    h, w = img_bgr.shape[:2]
    # Match template size to input image (rough scale + bilinear)
    template_resized = cv2.resize(template_bgr, (w, h), interpolation=cv2.INTER_AREA)

    img_gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    tmpl_gray = cv2.cvtColor(template_resized, cv2.COLOR_BGR2GRAY)

    # ECC needs float32, normalized
    img_f = img_gray.astype(np.float32) / 255.0
    tmpl_f = tmpl_gray.astype(np.float32) / 255.0

    warp = np.eye(2, 3, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 50, 1e-4)
    try:
        cc, warp = cv2.findTransformECC(
            templateImage=img_f,
            inputImage=tmpl_f,
            warpMatrix=warp,
            motionType=cv2.MOTION_AFFINE,
            criteria=criteria,
            inputMask=None,
            gaussFiltSize=5,
        )
        aligned = cv2.warpAffine(
            template_resized,
            warp,
            (w, h),
            flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(255, 255, 255),
        )
        return aligned
    except cv2.error:
        return None


def _trace_mask_from_residual(
    img_bgr: np.ndarray, template_bgr: np.ndarray
) -> np.ndarray:
    """Subtract template from input → residual mask of trace pixels.

    Pre: template is the SAME chart type but EMPTY (no pen). Both arrays
    are already in (rectified, chart-mm) coordinates because the caller
    warped/resized to (out_w, out_h). We try ECC fine-alignment first; if
    it fails (often does on charts with strong ink that throws off the
    least-squares), we fall back to direct subtraction with a stricter
    threshold (any anti-aliased ghost residual gets cleaned by morphology).
    """
    template_resized = template_bgr  # already at output size
    if template_resized.shape != img_bgr.shape:
        template_resized = cv2.resize(
            template_bgr,
            (img_bgr.shape[1], img_bgr.shape[0]),
            interpolation=cv2.INTER_AREA,
        )

    aligned = _align_template(img_bgr, template_resized)
    if aligned is None:
        # ECC failed → use template as-is. Both images are already in the
        # rectified chart-mm coordinate system, so they're approximately
        # aligned. Bump the residual threshold to absorb any small
        # registration offset.
        aligned = template_resized
        residual_threshold = 35
    else:
        residual_threshold = 25

    img_gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.int16)
    tmpl_gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY).astype(np.int16)
    residual = tmpl_gray - img_gray  # positive where input is darker than template
    mask = (residual > residual_threshold).astype(np.uint8) * 255

    # Even after ECC, the residual contains "ghost" grid pixels where the
    # template and image grids didn't align to the pixel. Remove anything
    # that's GREEN in the input image — that's grid ink (paper trace ink is
    # blue/red/black/brown, never green).
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    H_ch, S_ch = hsv[:, :, 0], hsv[:, :, 1]
    is_green = (H_ch >= 30) & (H_ch <= 100) & (S_ch > 20)
    mask[is_green] = 0

    # Tiny morph close to bridge 1-2 px gaps; open to drop salt noise
    kernel3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel3)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel3)
    return mask


def _build_trace_mask(rectified_bgr: np.ndarray, ink_hint: str) -> np.ndarray:
    """Tight mask of pen-trace ink: dark, non-green pixels.

    Lambrecht charts have green grid + dark pen ink (typically blue, red,
    brown, or near-black). This builds a mask that captures dark ink while
    excluding the green grid. Text labels at chart edges are dark too — we
    don't try to distinguish them here; the CALLER is responsible for
    clipping the chart-edge margins where labels live.
    """
    gray = cv2.cvtColor(rectified_bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(rectified_bgr, cv2.COLOR_BGR2HSV)
    H, S, V = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]

    # Green grid: hue 35–95 (OpenCV scale) with non-trivial saturation.
    is_green = (H >= 30) & (H <= 100) & (S > 20)

    if ink_hint == "blue":
        is_blue = (H >= 90) & (H <= 135) & (S > 40)
        is_dark = gray < 130
        mask = (is_blue | (is_dark & (S < 50))) & ~is_green
    elif ink_hint == "red":
        is_red = (((H <= 12) | (H >= 165)) & (S > 40))
        is_dark = gray < 130
        mask = (is_red | (is_dark & (S < 50))) & ~is_green
    elif ink_hint == "black":
        is_dark = gray < 110
        mask = is_dark & ~is_green & (S < 60)
    else:
        # auto: dark non-green ink
        is_dark = gray < 130
        mask = is_dark & ~is_green

    return (mask.astype(np.uint8)) * 255


def _smooth_trajectory(values: np.ndarray, valid_mask: np.ndarray, window: int) -> np.ndarray:
    """Median filter over a sliding window, ignoring invalid bins.

    Returns the filtered values; bins still marked invalid afterward have
    NaN. window is in number of bins (must be odd).
    """
    n = len(values)
    if window < 3 or n < 3:
        return values
    if window % 2 == 0:
        window += 1
    half = window // 2
    out = values.copy()
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        win_vals = values[lo:hi]
        win_valid = valid_mask[lo:hi]
        if win_valid.any():
            out[i] = np.median(win_vals[win_valid])
    return out


def _encode_preview(mask: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", mask)
    return base64.b64encode(buf.tobytes()).decode() if ok else ""


def extract_trace(req: ExtractTraceRequest, debug: bool = False) -> ExtractTraceResponse:
    timing: dict[str, float] = {}

    t0 = time.perf_counter()
    img_bgr = _decode_image(req.imageBase64)
    nat_h, nat_w = img_bgr.shape[:2]
    timing["decode"] = (time.perf_counter() - t0) * 1000

    # Calibration corners: scale from display-px to natural-px so we don't
    # have to downsample the image.
    sx = nat_w / req.displayWidth
    sy = nat_h / req.displayHeight
    nat_cal = [
        type(p)(
            imgX=p.imgX * sx,
            imgY=p.imgY * sy,
            chartX=p.chartX,
            chartY=p.chartY,
        )
        for p in req.calibrationPoints
    ]

    # Affine natural-px → chart-mm
    M_aff = compute_affine(nat_cal)
    H = affine_to_3x3(M_aff)
    H_inv = invert_affine_3x3(H)

    # Pick px_per_mm so the warp doesn't downsample the source.
    px_per_mm = float(min(24.0, max(8.0, nat_w / req.config.chartWidth, nat_h / req.config.chartHeight)))
    out_w = max(1, int(round(req.config.chartWidth * px_per_mm)))
    out_h = max(1, int(round(req.config.chartHeight * px_per_mm)))
    scale = np.array(
        [[px_per_mm, 0.0, 0.0],
         [0.0, px_per_mm, 0.0],
         [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
    full_H = scale @ H

    t0 = time.perf_counter()
    rectified = cv2.warpPerspective(
        img_bgr,
        full_H,
        (out_w, out_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )
    timing["warp"] = (time.perf_counter() - t0) * 1000

    # Template subtraction path: if the request includes a prazna template OR
    # there's a bundled reference template for this chart type, align it via
    # ECC and subtract → residual contains only added ink (the pen trace).
    # Same chart, different scan: ECC handles small rotation/scale variance.
    template_used = False
    template_bgr: Optional[np.ndarray] = None
    if req.templateImageBase64:
        try:
            template_bgr = _decode_image(req.templateImageBase64)
        except Exception as e:
            print(f"template decode failed: {e}")
    elif req.config.orientation in ("landscape", "portrait"):
        # Use bundled template by chart-type heuristic. orientation alone
        # doesn't pin the type, so go by value range too.
        chart_key = None
        if req.config.minValue >= 900 and req.config.maxValue <= 1100:
            chart_key = "barograph"
        elif req.config.minValue >= -50 and req.config.maxValue <= 50:
            chart_key = "thermograph"
        elif req.config.minValue >= 0 and req.config.maxValue <= 100:
            chart_key = "hygrograph"
        if chart_key in _TEMPLATES:
            template_bgr = _TEMPLATES[chart_key]

    if template_bgr is not None:
        try:
            t_tmpl = time.perf_counter()
            # The bundled template is a canonical empty-chart scan in its
            # natural orientation (≈ chart aspect). Direct resize to the
            # rectified output size — ECC will fine-tune pixel-level
            # alignment with the user's rectified image.
            tmpl_resized = cv2.resize(
                template_bgr, (out_w, out_h), interpolation=cv2.INTER_AREA
            )
            template_mask = _trace_mask_from_residual(rectified, tmpl_resized)
            timing["template_align"] = (time.perf_counter() - t_tmpl) * 1000
            if template_mask is None:
                print("[template] _trace_mask_from_residual returned None (ECC failed?)")
            else:
                pix = int(np.sum(template_mask > 0))
                print(f"[template] residual mask: {pix} px")
                if pix >= 100:
                    mask = template_mask
                    timing["mask"] = 0.0
                    template_used = True
        except Exception as e:
            print(f"[template] path failed: {e}")

    # ONNX trace-segmenter path — used when:
    #   - Template subtraction was not applied (template missing or returned
    #     fewer than 100 px, indicating a bad ECC alignment).
    #   - Model file is loaded (_ONNX_SESSION is not None).
    # Falls back to the legacy HSV mask if the model is unavailable or returns
    # an empty/near-empty result (model was trained on barograph synthetic
    # data so it may not generalize to other chart types).
    onnx_used = False
    if not template_used and _ONNX_SESSION is not None:
        try:
            t_onnx = time.perf_counter()
            onnx_mask = _build_trace_mask_onnx(rectified)
            timing["onnx"] = (time.perf_counter() - t_onnx) * 1000
            if onnx_mask is not None:
                onnx_pix = int(np.sum(onnx_mask > 0))
                print(f"[onnx] mask: {onnx_pix} px")
                if onnx_pix >= 50:
                    mask = onnx_mask
                    timing["mask"] = 0.0
                    onnx_used = True
        except Exception as e:
            print(f"[onnx] inference failed: {e}; falling back to HSV")

    if not template_used and not onnx_used:
        t0 = time.perf_counter()
        mask = _build_trace_mask(rectified, req.traceInk)
        timing["mask"] = (time.perf_counter() - t0) * 1000

    # Active chart interior: clip the top/bottom margins on the value axis
    # and a small bit on the time axis. Day/date labels live in those bands.
    is_landscape = req.config.orientation == "landscape"
    if is_landscape:
        # value axis is Y. chart_height=76.2 mm. Clip top/bottom 8% (~6 mm).
        y_clip = max(2, int(round(out_h * 0.08)))
        x_clip = max(2, int(round(out_w * 0.01)))
    else:
        # value axis is X. clip left/right 8%.
        y_clip = max(2, int(round(out_h * 0.01)))
        x_clip = max(2, int(round(out_w * 0.08)))
    mask[:y_clip, :] = 0
    mask[-y_clip:, :] = 0
    mask[:, :x_clip] = 0
    mask[:, -x_clip:] = 0

    # Tiny morphological close to bridge 1-2 pixel gaps in the trace
    kernel3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel3)
    timing["mask"] = (time.perf_counter() - t0) * 1000

    # ─── Per-time-bin sampling ────────────────────────────────────────────
    # For each column (landscape) or row (portrait), find the median position
    # of mask pixels. Skip bins with too few pixels.
    t0 = time.perf_counter()
    samples_per_day = req.samplesPerDay
    total_bins = req.config.days * samples_per_day
    bin_size_hours = 24.0 / samples_per_day

    # Map each bin to a center "true time" in chart-mm along the time axis.
    # We'll sample the mask at a NARROW band around that true_time_mm AFTER
    # accounting for arc-sag.

    if is_landscape:
        time_axis_total = out_w
        val_axis_total = out_h
    else:
        time_axis_total = out_h
        val_axis_total = out_w

    bin_values_mm: list[float] = []  # value-axis position in chart-mm per bin
    bin_valid: list[bool] = []
    min_pixels_per_bin = 3
    bin_window_px = max(2, time_axis_total // (total_bins * 2))  # half-bin width

    # Work column-by-column for landscape, row-by-row for portrait. We'll
    # aggregate mask pixels into bins keyed by their chart-mm time position.
    coords = np.where(mask > 0)
    if len(coords[0]) == 0:
        # No mask pixels at all
        diag = TraceDiagnostics(
            maskPixels=0,
            skeletonPixels=0,
            extractedPoints=0,
            rectifiedSize=[out_w, out_h],
            timingMs={k: round(v, 1) for k, v in timing.items()},
        )
        return ExtractTraceResponse(
            points=[],
            diagnostics=diag,
            debugMaskBase64=_encode_preview(mask) if debug else None,
            debugRectifiedBase64=_encode_preview(rectified) if debug else None,
        )
    ys_all = coords[0]
    xs_all = coords[1]

    # Convert each mask pixel to (day, hour, value) once.
    x_mm_all = xs_all.astype(np.float64) / px_per_mm
    y_mm_all = ys_all.astype(np.float64) / px_per_mm

    # Bin each pixel by its (day, hour) — this naturally handles arc-sag via
    # chart_to_value (which inverts the arc when computing time).
    bins: dict[int, list[tuple[float, float, float, float, float]]] = {}
    for i in range(len(xs_all)):
        day, hour, value = chart_to_value(
            float(x_mm_all[i]), float(y_mm_all[i]), req.config
        )
        if day < 0 or day > req.config.days:
            continue
        bin_idx = int((day * 24 + hour) / bin_size_hours)
        if 0 <= bin_idx < total_bins:
            bins.setdefault(bin_idx, []).append(
                (value, float(x_mm_all[i]), float(y_mm_all[i]),
                 float(xs_all[i]), float(ys_all[i]))
            )

    # Per-bin median value (robust against scattered text dust within a bin).
    bin_value = np.full(total_bins, np.nan, dtype=np.float64)
    bin_x_mm = np.full(total_bins, np.nan, dtype=np.float64)
    bin_y_mm = np.full(total_bins, np.nan, dtype=np.float64)
    bin_x_px = np.full(total_bins, np.nan, dtype=np.float64)
    bin_y_px = np.full(total_bins, np.nan, dtype=np.float64)
    for bin_idx, entries in bins.items():
        if len(entries) < min_pixels_per_bin:
            continue
        vals = np.array([e[0] for e in entries])
        med_idx = int(np.argsort(vals)[len(vals) // 2])
        v, xm, ym, xp, yp = entries[med_idx]
        bin_value[bin_idx] = v
        bin_x_mm[bin_idx] = xm
        bin_y_mm[bin_idx] = ym
        bin_x_px[bin_idx] = xp
        bin_y_px[bin_idx] = yp

    # Outlier rejection: a single bin's value should be close to its
    # neighbors. Apply a 1D median filter over a 5-bin window.
    valid_mask = ~np.isnan(bin_value)
    if valid_mask.any():
        med = _smooth_trajectory(
            np.where(valid_mask, bin_value, 0.0), valid_mask, window=7
        )
        # Reject bins whose value differs from local median by > 5% of full
        # value range — these are usually label artifacts.
        full_range = req.config.maxValue - req.config.minValue
        thresh = full_range * 0.05
        for i in np.where(valid_mask)[0]:
            if abs(bin_value[i] - med[i]) > thresh:
                bin_value[i] = med[i]  # snap to local median
                # don't mark invalid; still emit the point at the smoothed value

    # Build output points
    points: list[DataPoint] = []
    nat_to_disp_x = req.displayWidth / nat_w
    nat_to_disp_y = req.displayHeight / nat_h
    for bin_idx in range(total_bins):
        if np.isnan(bin_value[bin_idx]):
            continue
        bin_time = bin_idx * bin_size_hours
        day = int(bin_time // 24)
        hour = bin_time - day * 24
        if day < 0 or day > req.config.days:
            continue

        # Reconstruct chart-mm position from value (and the bin's time).
        # We have a smoothed value but need an x_mm for canvas mapping. Use
        # the bin's recorded (x_mm, y_mm) if available, else estimate from
        # (day, hour, value).
        if not np.isnan(bin_x_mm[bin_idx]):
            xm, ym = bin_x_mm[bin_idx], bin_y_mm[bin_idx]
        else:
            # Estimate from chart geometry
            if is_landscape:
                day_width = req.config.chartWidth / req.config.days
                xm = (day + hour / 24.0) * day_width
                ym = (
                    (req.config.maxValue - bin_value[bin_idx])
                    / (req.config.maxValue - req.config.minValue)
                ) * req.config.chartHeight
            else:
                day_height = req.config.chartHeight / req.config.days
                ym = (day + hour / 24.0) * day_height
                xm = (
                    (bin_value[bin_idx] - req.config.minValue)
                    / (req.config.maxValue - req.config.minValue)
                ) * req.config.chartWidth

        # H_inv maps chart-mm → natural-px. Then scale to display-px.
        canvas_pt = H_inv @ np.array([xm, ym, 1.0])
        cx = (canvas_pt[0] / canvas_pt[2]) * nat_to_disp_x
        cy = (canvas_pt[1] / canvas_pt[2]) * nat_to_disp_y

        points.append(
            DataPoint(
                day=day,
                hour=round(hour, 2),
                value=round(float(bin_value[bin_idx]), 2),
                canvasX=float(cx),
                canvasY=float(cy),
            )
        )
    timing["sample"] = (time.perf_counter() - t0) * 1000

    diag = TraceDiagnostics(
        maskPixels=int(np.sum(mask > 0)),
        skeletonPixels=int(np.sum(mask > 0)),  # no separate skel anymore
        extractedPoints=len(points),
        rectifiedSize=[out_w, out_h],
        timingMs={k: round(v, 1) for k, v in timing.items()},
    )

    debug_mask_b64: Optional[str] = None
    debug_skel_b64: Optional[str] = None
    debug_rect_b64: Optional[str] = None
    if debug:
        debug_mask_b64 = _encode_preview(mask)
        debug_skel_b64 = _encode_preview(mask)  # alias
        debug_rect_b64 = _encode_preview(rectified)

    return ExtractTraceResponse(
        points=points,
        diagnostics=diag,
        debugMaskBase64=debug_mask_b64,
        debugSkeletonBase64=debug_skel_b64,
        debugRectifiedBase64=debug_rect_b64,
    )
