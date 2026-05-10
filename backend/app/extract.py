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
import time
from io import BytesIO
from typing import Optional

import cv2
import numpy as np
from PIL import Image

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

    t0 = time.perf_counter()
    mask = _build_trace_mask(rectified, req.traceInk)

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
