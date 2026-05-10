"""Grid-intersection-based chart calibration.

Detects the four chart-grid corners in a scanned chart image by finding
the outermost grid-line intersections. The user sees clean grid line
crossovers — if we find those crossovers programmatically, their outermost
positions ARE the chart corners that map to (day0, maxValue) etc.

Pipeline:
  1. Build a green-grid mask (HSV gate matching the Lambrecht green/teal).
  2. Probabilistic Hough on the mask edges → all line segments.
  3. Cluster lines by angle into HORIZONTAL and VERTICAL groups (the chart
     paper is approximately axis-aligned in the image).
  4. Within each group, fit a 1D lattice to the line positions to find the
     four EXTREME lines (top + bottom horizontals, left + right verticals).
  5. Compute the four intersections of (top|bot) × (left|right).
  6. Return as calibration corners labelled with chart-mm coordinates per
     the chart's orientation.

Optional: detect the dominant grid angle and report it as a deskew hint —
the frontend can use this to apply a small image rotation BEFORE running
the actual auto-cal/extract pipeline.
"""
import base64
import math
import time
from io import BytesIO
from typing import Optional

import cv2
import numpy as np
from PIL import Image
from pydantic import BaseModel
from typing import List, Literal

from .schemas import ChartConfig, CalibrationPoint


class CalibrateGridRequest(BaseModel):
    imageBase64: str
    config: ChartConfig
    # Display dimensions the frontend wants the corners returned in.
    displayWidth: float
    displayHeight: float


class CalibrateGridDiagnostics(BaseModel):
    detectedHorizontals: int
    detectedVerticals: int
    dominantAngleDeg: float
    timingMs: dict


class CalibrateGridResponse(BaseModel):
    points: List[CalibrationPoint]
    diagnostics: CalibrateGridDiagnostics
    debugAnnotatedBase64: Optional[str] = None


def _decode(b64: str) -> np.ndarray:
    if "," in b64 and b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    img = Image.open(BytesIO(raw)).convert("RGB")
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def _green_grid_mask(bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    H, S, V = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    is_green = (H >= 35) & (H <= 95) & (S > 25) & (V > 60) & (V < 230)
    return (is_green.astype(np.uint8)) * 255


def _detect_lines(mask: np.ndarray) -> np.ndarray:
    """HoughLinesP on the grid mask. Returns shape (N, 4) with [x1,y1,x2,y2]."""
    h, w = mask.shape[:2]
    # Keep only lines spanning at least 1/8th of the relevant axis
    min_len = max(40, min(h, w) // 8)
    lines = cv2.HoughLinesP(
        mask,
        rho=1,
        theta=np.pi / 360,
        threshold=80,
        minLineLength=min_len,
        maxLineGap=10,
    )
    if lines is None:
        return np.empty((0, 4), dtype=np.int32)
    return lines.reshape(-1, 4)


def _angle_deg(line: np.ndarray) -> float:
    """Angle of a line in degrees, in (-90, 90]."""
    x1, y1, x2, y2 = line
    a = math.degrees(math.atan2(y2 - y1, x2 - x1))
    # Normalize to (-90, 90]
    while a > 90:
        a -= 180
    while a <= -90:
        a += 180
    return a


def _cluster_lines(lines: np.ndarray) -> tuple[list[np.ndarray], list[np.ndarray], float]:
    """Split lines into horizontal cluster, vertical cluster, and the
    dominant grid rotation (degrees, in [-45, 45] range).

    Strategy: compute angle of every line, find the two angle modes ~90°
    apart. The "horizontal" mode is whichever is closer to 0°; the other
    is "vertical". The dominant rotation is the average horizontal angle.
    """
    if len(lines) == 0:
        return [], [], 0.0
    angles = np.array([_angle_deg(l) for l in lines])
    # Build a histogram of angles modulo 90° (so lines and their
    # perpendiculars share a bin and shift the histogram together).
    mod_angles = np.mod(angles, 90.0)
    hist, edges = np.histogram(mod_angles, bins=90, range=(0, 90))
    peak = edges[np.argmax(hist)]
    # The dominant grid angle is `peak` mod 90; cast to (-45, 45]
    dom = peak
    if dom > 45:
        dom -= 90
    horiz: list[np.ndarray] = []
    vert: list[np.ndarray] = []
    for line, ang in zip(lines, angles):
        # Distance from the dominant horizontal direction
        d_horiz = min(abs(ang - dom), abs(ang - dom + 180), abs(ang - dom - 180))
        d_vert = min(abs(ang - dom - 90), abs(ang - dom + 90))
        if d_horiz < d_vert and d_horiz < 15:
            horiz.append(line)
        elif d_vert < 15:
            vert.append(line)
        # else: ambiguous, drop
    return horiz, vert, float(dom)


def _line_signed_distance(line: np.ndarray, axis: str) -> float:
    """Project a line onto the perpendicular axis. For horizontal lines we
    take the average y; for vertical lines we take the average x.
    """
    x1, y1, x2, y2 = line
    if axis == "horizontal":
        return (y1 + y2) / 2.0
    else:
        return (x1 + x2) / 2.0


def _outermost(group: list[np.ndarray], axis: str) -> tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    if not group:
        return None, None
    distances = [_line_signed_distance(l, axis) for l in group]
    min_idx = int(np.argmin(distances))
    max_idx = int(np.argmax(distances))
    return group[min_idx], group[max_idx]


def _fit_line_to_segment(seg: np.ndarray) -> tuple[float, float, float]:
    """Fit a line ax + by + c = 0 to a single segment. Direction-normalized."""
    x1, y1, x2, y2 = seg.astype(np.float64)
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1.0
    a = -dy / norm
    b = dx / norm
    c = -(a * x1 + b * y1)
    return a, b, c


def _intersect(line1: tuple[float, float, float], line2: tuple[float, float, float]) -> Optional[tuple[float, float]]:
    a1, b1, c1 = line1
    a2, b2, c2 = line2
    det = a1 * b2 - a2 * b1
    if abs(det) < 1e-9:
        return None
    x = (b1 * c2 - b2 * c1) / det
    y = (a2 * c1 - a1 * c2) / det
    return x, y


class RectifyRequest(BaseModel):
    imageBase64: str
    config: ChartConfig
    calibrationPoints: List[CalibrationPoint]
    displayWidth: float
    displayHeight: float
    # Output dimensions for the rectified preview (kept small for fast UI).
    previewMaxEdge: int = 800


class RectifyResponse(BaseModel):
    rectifiedBase64: str
    width: int
    height: int


def rectify(req: RectifyRequest) -> RectifyResponse:
    """Warp the input image to a rectified (axis-aligned chart-mm) preview.

    Used by the frontend to show a thumbnail of "what the chart looks like
    if we trust the current calibration corners". A correct calibration
    yields a perfectly rectangular grid; a wrong one leaves visible skew.
    """
    from .geometry import compute_affine, affine_to_3x3

    img = _decode(req.imageBase64)
    nat_h, nat_w = img.shape[:2]

    # Scale calibration corners from display-px to natural-px
    sx = nat_w / req.displayWidth
    sy = nat_h / req.displayHeight
    nat_cal = [
        type(p)(
            imgX=p.imgX * sx, imgY=p.imgY * sy,
            chartX=p.chartX, chartY=p.chartY,
        )
        for p in req.calibrationPoints
    ]
    M_aff = compute_affine(nat_cal)
    H = affine_to_3x3(M_aff)

    # Choose a preview resolution that's small enough for fast roundtrip but
    # readable. Cap longest edge at previewMaxEdge.
    cw, ch = req.config.chartWidth, req.config.chartHeight
    longest = max(cw, ch)
    px_per_mm = req.previewMaxEdge / longest
    out_w = int(round(cw * px_per_mm))
    out_h = int(round(ch * px_per_mm))
    scale = np.array(
        [[px_per_mm, 0.0, 0.0],
         [0.0, px_per_mm, 0.0],
         [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
    full_H = scale @ H

    rectified = cv2.warpPerspective(
        img,
        full_H,
        (out_w, out_h),
        flags=cv2.INTER_AREA,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )
    ok, buf = cv2.imencode(".png", rectified, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise ValueError("Could not encode rectified preview")
    return RectifyResponse(
        rectifiedBase64=base64.b64encode(buf.tobytes()).decode(),
        width=out_w,
        height=out_h,
    )


def calibrate_grid(req: CalibrateGridRequest, debug: bool = False) -> CalibrateGridResponse:
    timing: dict[str, float] = {}

    t0 = time.perf_counter()
    img = _decode(req.imageBase64)
    nat_h, nat_w = img.shape[:2]
    timing["decode"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    grid = _green_grid_mask(img)
    timing["mask"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    lines = _detect_lines(grid)
    timing["hough"] = (time.perf_counter() - t0) * 1000

    horiz, vert, dom_angle = _cluster_lines(lines)

    top, bot = _outermost(horiz, "horizontal")
    left, right = _outermost(vert, "vertical")
    if any(x is None for x in (top, bot, left, right)):
        raise ValueError(
            f"Could not find all four outer grid lines "
            f"(horizontals={len(horiz)}, verticals={len(vert)})"
        )

    top_l = _fit_line_to_segment(top)
    bot_l = _fit_line_to_segment(bot)
    left_l = _fit_line_to_segment(left)
    right_l = _fit_line_to_segment(right)

    # Four corners (in natural-px)
    tl = _intersect(top_l, left_l)
    tr = _intersect(top_l, right_l)
    bl = _intersect(bot_l, left_l)
    br = _intersect(bot_l, right_l)
    if any(c is None for c in (tl, tr, bl, br)):
        raise ValueError("Outer grid lines do not intersect (degenerate fit)")

    # Map (top-left, top-right, bot-left, bot-right) → chart-mm corners.
    # Same labelling as the JS auto-cal in src/lib/auto-calibration.ts.
    cfg = req.config
    if cfg.orientation == "landscape":
        chart_corners = [
            (0, 0, 0, 0, cfg.maxValue),                  # tl: day0, max
            (cfg.chartWidth, 0, cfg.days, 0, cfg.maxValue),  # tr: dayN, max
            (0, cfg.chartHeight, 0, 0, cfg.minValue),    # bl: day0, min
            (cfg.chartWidth, cfg.chartHeight, cfg.days, 0, cfg.minValue),  # br
        ]
    else:
        chart_corners = [
            (0, 0, 0, 0, cfg.minValue),                          # tl: day0, min
            (cfg.chartWidth, 0, 0, 0, cfg.maxValue),             # tr: day0, max
            (0, cfg.chartHeight, cfg.days, 0, cfg.minValue),     # bl: dayN, min
            (cfg.chartWidth, cfg.chartHeight, cfg.days, 0, cfg.maxValue),  # br
        ]
    natural_xy = [tl, tr, bl, br]
    points: list[CalibrationPoint] = []
    sx_disp = req.displayWidth / nat_w
    sy_disp = req.displayHeight / nat_h
    for (x_nat, y_nat), (chartX, chartY, day, hour, value) in zip(natural_xy, chart_corners):
        points.append(
            CalibrationPoint(
                imgX=float(x_nat) * sx_disp,
                imgY=float(y_nat) * sy_disp,
                chartX=float(chartX),
                chartY=float(chartY),
            )
        )

    # Optional debug visualization
    debug_img: Optional[str] = None
    if debug:
        annotated = img.copy()
        for line in horiz:
            x1, y1, x2, y2 = line
            cv2.line(annotated, (x1, y1), (x2, y2), (0, 255, 0), 1)
        for line in vert:
            x1, y1, x2, y2 = line
            cv2.line(annotated, (x1, y1), (x2, y2), (255, 0, 0), 1)
        for (x, y) in natural_xy:
            cv2.circle(annotated, (int(x), int(y)), 12, (0, 0, 255), 3)
        ok, buf = cv2.imencode(".png", annotated)
        if ok:
            debug_img = base64.b64encode(buf.tobytes()).decode()

    return CalibrateGridResponse(
        points=points,
        diagnostics=CalibrateGridDiagnostics(
            detectedHorizontals=len(horiz),
            detectedVerticals=len(vert),
            dominantAngleDeg=dom_angle,
            timingMs={k: round(v, 1) for k, v in timing.items()},
        ),
        debugAnnotatedBase64=debug_img,
    )
