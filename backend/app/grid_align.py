"""Reference-template-based grid vectorization.

Pipeline:
  1. At module import: detect chart-area corners in the bundled empty-chart
     reference (`_TEMPLATES[chart_type]`) using HoughLinesP, then compute
     EVERY grid line (major / minor / fine horizontals + arc-sag time
     lines) ANALYTICALLY from chart geometry. Cache per chart type.
  2. Per request: align user's scan to the reference via ECC. Apply the
     inverse warp to every cached grid polyline → polylines in the user's
     image-pixel space, then scale to display coords.

Why this is better than client-side grid detection:
  - The reference HAS a perfect grid. We don't detect lines on the user's
    scan at all — we just align and warp KNOWN positions.
  - Major / minor / fine classifications are exact (every 10/5/1 hPa for
    barograph, every day/6h/1h for time).
  - Robust to scan distortion, paper aging, faded ink — ECC handles
    rotation + translation + scale + small shear.
  - Fall back to client-side vectorize when ECC fails (~10% of scans).
"""
from __future__ import annotations

import base64
import math
import time
from io import BytesIO
from typing import Literal, Optional

import cv2
import numpy as np
from PIL import Image
from pydantic import BaseModel

from .schemas import ChartConfig
from .calibrate import (
    _green_grid_mask,
    _detect_lines,
    _cluster_lines,
    _outermost,
    _fit_line_to_segment,
    _intersect,
)
# Force template loading by importing extract first (it populates _TEMPLATES
# at module import). Otherwise _populate_reference_grids() below sees an
# empty dict.
from . import extract as _extract  # noqa: F401


# ─── Reference-grid pre-computation (one-off at module import) ─────────────


def _arc_sag_mm(y_mm: float, R: float, P: float) -> float:
    """Pen-arm arc sag at chart-mm Y position. Mirror of the JS arcSag()
    in src/lib/chart-geometry.ts."""
    sag_at_pivot = R - math.sqrt(R * R - P * P)
    dx = y_mm - P
    sag_at_pos = R - math.sqrt(R * R - dx * dx)
    return sag_at_pos - sag_at_pivot


def _detect_chart_corners(
    template_bgr: np.ndarray,
) -> Optional[tuple[tuple[float, float], ...]]:
    """Return (tl, tr, bl, br) in reference-px, or None if detection fails."""
    grid = _green_grid_mask(template_bgr)
    lines = _detect_lines(grid)
    horiz, vert, _ = _cluster_lines(lines)
    top, bot = _outermost(horiz, "horizontal")
    left, right = _outermost(vert, "vertical")
    if any(x is None for x in (top, bot, left, right)):
        return None
    top_l = _fit_line_to_segment(top)
    bot_l = _fit_line_to_segment(bot)
    left_l = _fit_line_to_segment(left)
    right_l = _fit_line_to_segment(right)
    tl = _intersect(top_l, left_l)
    tr = _intersect(top_l, right_l)
    bl = _intersect(bot_l, left_l)
    br = _intersect(bot_l, right_l)
    if any(c is None for c in (tl, tr, bl, br)):
        return None
    return tl, tr, bl, br


def _generate_reference_grid(
    template_bgr: np.ndarray, config: ChartConfig
) -> Optional[dict]:
    """Detect corners + analytically compute all grid polylines in reference-px.

    Returns dict with keys:
      - "horizontals": list of {"points": [(x, y), ...], "weight": str}
      - "arcs":         list of {"points": [(x, y), ...], "weight": str}
      - "ref_size":    (w, h) in pixels
      - "corners":     (tl, tr, bl, br)
    """
    corners = _detect_chart_corners(template_bgr)
    if corners is None:
        return None
    tl, tr, bl, br = corners

    # 4-point perspective transform from chart-mm to reference-px
    src_pts = np.array(
        [
            [0.0, 0.0],
            [config.chartWidth, 0.0],
            [0.0, config.chartHeight],
            [config.chartWidth, config.chartHeight],
        ],
        dtype=np.float32,
    )
    dst_pts = np.array([tl, tr, bl, br], dtype=np.float32)
    H_chart_to_ref = cv2.getPerspectiveTransform(src_pts, dst_pts)

    def chart_to_ref(x_mm: float, y_mm: float) -> tuple[float, float]:
        pt = np.array([[[x_mm, y_mm]]], dtype=np.float32)
        out = cv2.perspectiveTransform(pt, H_chart_to_ref)
        return float(out[0, 0, 0]), float(out[0, 0, 1])

    R = config.penArmRadius
    P = config.penArmPivot
    days = config.days
    chart_w = config.chartWidth
    chart_h = config.chartHeight
    val_range = config.maxValue - config.minValue

    # Horizontal lines (value scale)
    # For barograph: every 1 hPa = fine, every 5 = minor, every 10 = major.
    # We iterate with integer step so the modulo-based classification is
    # exact even when minValue/maxValue aren't integer multiples.
    horizontals = []
    v_min = int(round(config.minValue))
    v_max = int(round(config.maxValue))
    for V in range(v_min, v_max + 1):
        chart_y = (config.maxValue - V) / val_range * chart_h
        p1 = chart_to_ref(0.0, chart_y)
        p2 = chart_to_ref(chart_w, chart_y)
        if V % 10 == 0:
            weight = "major"
        elif V % 5 == 0:
            weight = "minor"
        else:
            weight = "fine"
        horizontals.append({"points": [p1, p2], "weight": weight})

    # Arc time lines
    # Major: every day boundary (24 h)
    # Minor: every 6 h (4 per day)
    # Fine:  every 1 h (24 per day)
    fine_per_day = 24
    minor_step = fine_per_day // 4  # 6 hours
    arcs = []
    n_samples = 30
    day_width = chart_w / days
    for hour_total in range(days * fine_per_day + 1):
        T_days = hour_total / fine_per_day
        chart_x_true = T_days * day_width
        pts: list[tuple[float, float]] = []
        for i in range(n_samples):
            chart_y = chart_h * i / (n_samples - 1)
            sag = _arc_sag_mm(chart_y, R, P)
            displayed_x = chart_x_true - sag
            pts.append(chart_to_ref(displayed_x, chart_y))
        if hour_total % fine_per_day == 0:
            weight = "major"
        elif hour_total % minor_step == 0:
            weight = "minor"
        else:
            weight = "fine"
        arcs.append({"points": pts, "weight": weight})

    h_ref, w_ref = template_bgr.shape[:2]
    return {
        "horizontals": horizontals,
        "arcs": arcs,
        "ref_size": (w_ref, h_ref),
        "corners": corners,
    }


# Cache: chart-type → grid dict. Populated lazily after _TEMPLATES exists.
_REFERENCE_GRIDS: dict[str, dict] = {}
_REFERENCE_CONFIGS: dict[str, ChartConfig] = {
    "barograph": ChartConfig(
        orientation="landscape",
        chartWidth=313.0,
        chartHeight=76.2,
        minValue=950.0,
        maxValue=1060.0,
        majorGrid=10.0,
        days=8,
        penArmRadius=177.8,
        penArmPivot=44.45,
        unit="hPa",
    ),
}


def _populate_reference_grids() -> None:
    """Detect corners + compute grids for every loaded template."""
    from .extract import _TEMPLATES

    for chart_key, template in _TEMPLATES.items():
        if chart_key not in _REFERENCE_CONFIGS:
            continue
        try:
            grid = _generate_reference_grid(
                template, _REFERENCE_CONFIGS[chart_key]
            )
            if grid is None:
                print(f"[grid] {chart_key}: corner detection failed, no grid cached")
                continue
            _REFERENCE_GRIDS[chart_key] = grid
            print(
                f"[grid] {chart_key}: cached "
                f"{len(grid['horizontals'])} horiz + {len(grid['arcs'])} arcs "
                f"(ref {grid['ref_size'][0]}x{grid['ref_size'][1]})"
            )
        except Exception as e:
            print(f"[grid] {chart_key}: precompute failed: {e}")


# Run at import time. Safe even if _TEMPLATES is empty (no-op).
_populate_reference_grids()


# ─── ECC alignment (per-request) ───────────────────────────────────────────


def _align_user_to_reference(
    img_bgr: np.ndarray, template_bgr: np.ndarray
) -> Optional[np.ndarray]:
    """ECC alignment: returns 3x3 warp such that warp transforms USER coords
    to TEMPLATE coords (i.e. warpAffine(user, warp) ≈ template). None if
    ECC doesn't converge.

    Both images are resized to a common 1200-px-edge working size for
    speed; the resulting matrix is in working-size space — caller must
    rescale to original sizes.
    """
    target_max = 1200
    h_user, w_user = img_bgr.shape[:2]
    h_tmpl, w_tmpl = template_bgr.shape[:2]
    # Pick common working size matching the smaller dimension
    long_user = max(h_user, w_user)
    scale_user = target_max / long_user if long_user > target_max else 1.0
    work_w = int(round(w_user * scale_user))
    work_h = int(round(h_user * scale_user))
    user_work = cv2.resize(img_bgr, (work_w, work_h), interpolation=cv2.INTER_AREA)
    tmpl_work = cv2.resize(template_bgr, (work_w, work_h), interpolation=cv2.INTER_AREA)
    user_gray = cv2.cvtColor(user_work, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    tmpl_gray = cv2.cvtColor(tmpl_work, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    warp = np.eye(2, 3, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-5)
    try:
        _, warp = cv2.findTransformECC(
            templateImage=tmpl_gray,
            inputImage=user_gray,
            warpMatrix=warp,
            motionType=cv2.MOTION_AFFINE,
            criteria=criteria,
            inputMask=None,
            gaussFiltSize=5,
        )
    except cv2.error:
        return None

    # Warp is 2x3 affine in working-size space, mapping user-work → template-work.
    # Promote to 3x3 perspective.
    warp_3x3 = np.eye(3, dtype=np.float32)
    warp_3x3[:2] = warp
    # Convert from work-space to original-space:
    #   warp_orig(p_user_orig) = template_orig
    # In work space:
    #   warp_work(p_user_work) = template_work
    #   p_user_work = S_user @ p_user_orig
    #   template_orig = S_tmpl_inv @ template_work
    # Combine: warp_orig = S_tmpl_inv @ warp_work @ S_user
    s_user = np.array(
        [[scale_user, 0, 0], [0, scale_user, 0], [0, 0, 1]], dtype=np.float32
    )
    long_tmpl = max(h_tmpl, w_tmpl)
    scale_tmpl = target_max / long_tmpl if long_tmpl > target_max else 1.0
    s_tmpl_inv = np.array(
        [[1 / scale_tmpl, 0, 0], [0, 1 / scale_tmpl, 0], [0, 0, 1]],
        dtype=np.float32,
    )
    return s_tmpl_inv @ warp_3x3 @ s_user


def vectorize_via_reference(
    img_bgr: np.ndarray,
    config: ChartConfig,
    display_w: float,
    display_h: float,
) -> Optional[dict]:
    """Top-level: align user image to reference, transform every cached
    reference grid polyline back into user-image space, scale to display.

    Returns:
      {
        "polylines": [{"points": [[x,y]...], "axis": "horizontal"|"vertical",
                       "weight": "major"|"minor"|"fine"}, ...],
        "diagnostics": { ... timing, counts ... }
      }

    Returns None if no reference is available for this chart type or if
    ECC alignment fails (caller should fall back to client-side vectorize).
    """
    timing: dict[str, float] = {}

    # Pick chart-type key
    chart_key: Optional[str] = None
    if config.minValue >= 900 and config.maxValue <= 1100:
        chart_key = "barograph"
    if chart_key is None or chart_key not in _REFERENCE_GRIDS:
        return None
    grid = _REFERENCE_GRIDS[chart_key]

    from .extract import _TEMPLATES
    template = _TEMPLATES.get(chart_key)
    if template is None:
        return None

    h_user, w_user = img_bgr.shape[:2]

    # ECC align
    t0 = time.perf_counter()
    warp_user_to_tmpl = _align_user_to_reference(img_bgr, template)
    timing["ecc"] = (time.perf_counter() - t0) * 1000
    if warp_user_to_tmpl is None:
        return None

    # We want template → user, so invert
    warp_tmpl_to_user = np.linalg.inv(warp_user_to_tmpl)

    sx_disp = display_w / w_user
    sy_disp = display_h / h_user

    def transform_pts(pts: list[tuple[float, float]]) -> list[list[float]]:
        if len(pts) == 0:
            return []
        arr = np.array(
            [[x, y, 1.0] for (x, y) in pts], dtype=np.float64
        )  # (N, 3)
        out = arr @ warp_tmpl_to_user.T  # (N, 3)
        # Perspective divide
        denom = out[:, 2:3]
        denom = np.where(np.abs(denom) < 1e-9, 1.0, denom)
        xs = out[:, 0] / denom[:, 0]
        ys = out[:, 1] / denom[:, 0]
        return [[float(xs[i] * sx_disp), float(ys[i] * sy_disp)] for i in range(len(pts))]

    t0 = time.perf_counter()
    polylines: list[dict] = []
    for hline in grid["horizontals"]:
        polylines.append(
            {
                "points": transform_pts(hline["points"]),
                "axis": "horizontal",
                "weight": hline["weight"],
            }
        )
    for arc in grid["arcs"]:
        polylines.append(
            {
                "points": transform_pts(arc["points"]),
                "axis": "vertical",
                "weight": arc["weight"],
            }
        )
    timing["transform"] = (time.perf_counter() - t0) * 1000

    return {
        "polylines": polylines,
        "diagnostics": {
            "horizontalCount": len(grid["horizontals"]),
            "arcCount": len(grid["arcs"]),
            "timingMs": {k: round(v, 1) for k, v in timing.items()},
        },
    }


# ─── HTTP request/response models + endpoint helpers ───────────────────────


class VectorizeGridRequest(BaseModel):
    imageBase64: str
    config: ChartConfig
    displayWidth: float
    displayHeight: float


class VectorPolylineModel(BaseModel):
    points: list[list[float]]
    axis: Literal["horizontal", "vertical"]
    weight: Literal["major", "minor", "fine"]


class VectorizeGridResponse(BaseModel):
    polylines: list[VectorPolylineModel]
    diagnostics: dict


def _decode_image(b64: str) -> np.ndarray:
    if "," in b64 and b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    img = Image.open(BytesIO(raw)).convert("RGB")
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def vectorize_grid(req: VectorizeGridRequest) -> VectorizeGridResponse:
    img = _decode_image(req.imageBase64)
    result = vectorize_via_reference(
        img, req.config, req.displayWidth, req.displayHeight
    )
    if result is None:
        raise ValueError(
            "Reference vectorization unavailable for this chart type, "
            "or ECC alignment failed."
        )
    return VectorizeGridResponse(
        polylines=result["polylines"],
        diagnostics=result["diagnostics"],
    )
