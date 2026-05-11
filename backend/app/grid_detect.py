"""Direct-pixel detection of grid lines on user-scanned charts.

Complementary to `grid_align.py` (which warps a known reference template
onto the user scan via ECC). This module detects grid lines directly
from pixel data — useful when:

- We don't have a clean reference template (red-grid charts, foreign
  Lambrecht variants, hand-drawn).
- We want sub-pixel accuracy on the actual printed lines, not analytic
  positions from a template.

Methods:
- `detect_horizontal_grid_lines` — finds rows where green-pixel density
  spans the full chart width. Returns one polyline per detected line.
- `detect_vertical_arc_lines` — given expected day-separator positions
  (linearly interpolated between chart corners), traces each major
  green arc using an iterative centroid + polynomial fit refine
  (typical resid 0.5-0.8 px @ 9992×3956 scan).

Both functions take the chart-area corners in image-px coords and a
numpy RGB array, return polylines in image-px space.

Origin of vertical detection parameters: 8-day barograph scans,
9992×3956 px, mean residual 0.58 px / max 0.79 px across 9 arcs
(see backend/test_grid_detect.py).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence, Tuple

import numpy as np

try:
    from scipy import ndimage
except ImportError as e:
    raise ImportError(
        "scipy is required for grid_detect — add to requirements.txt"
    ) from e


# ─── data classes ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class ChartBounds:
    """Chart-area corners in image-px space, top-left origin.

    The four x extents allow for slight scan-induced tilt; if the scan is
    perfectly aligned, x_left_top == x_left_bot and x_right_top == x_right_bot.
    """
    x_left_top: float
    x_right_top: float
    x_left_bot: float
    x_right_bot: float
    y_top: float
    y_bot: float

    def base_x(self, tau: float, y: float) -> float:
        """Linear nominal x at fraction tau ∈ [0,1] of horizontal span,
        at image-y. Used to seed vertical-arc detection."""
        t_y = (y - self.y_top) / (self.y_bot - self.y_top)
        x_l = self.x_left_top + t_y * (self.x_left_bot - self.x_left_top)
        x_r = self.x_right_top + t_y * (self.x_right_bot - self.x_right_top)
        return x_l + tau * (x_r - x_l)


# ─── color masks ──────────────────────────────────────────────────────


def green_mask(rgb: np.ndarray,
               r_diff: int = 10, b_diff: int = 5, g_min: int = 90,
               ) -> np.ndarray:
    """Boolean mask of pre-printed green grid pixels.

    Tuned to:
    - exclude red annotations (G < R+r_diff)
    - exclude blue pen-trace (G > B+b_diff)
    - exclude white/cream background (G > g_min)
    """
    R = rgb[:, :, 0].astype(np.int16)
    G = rgb[:, :, 1].astype(np.int16)
    B = rgb[:, :, 2].astype(np.int16)
    return (G - R > r_diff) & (G - B > b_diff) & (G > g_min)


def greenness_weight(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Continuous greenness score (G − max(R,B)), zeroed outside `mask`.
    Used as centroid-weighting to get sub-pixel accuracy."""
    R = rgb[:, :, 0].astype(np.int16)
    G = rgb[:, :, 1].astype(np.int16)
    B = rgb[:, :, 2].astype(np.int16)
    return np.clip(G - np.maximum(R, B), 0, 255).astype(np.float32) * mask


# ─── horizontal grid detection ────────────────────────────────────────


def detect_horizontal_grid_lines(
    rgb: np.ndarray,
    bounds: ChartBounds,
    *,
    coverage_threshold: float = 0.6,
    min_row_gap: int = 25,
    sample_points: int = 256,
) -> List[List[Tuple[float, float]]]:
    """Find horizontal grid lines by green-pixel row density.

    Algorithm:
      1. Crop chart area + small padding.
      2. For each image-y row, compute fraction of green pixels in
         x-range [x_left(y), x_right(y)].
      3. Rows with density > `coverage_threshold` are candidate hits.
      4. Cluster consecutive hit-rows (gap < `min_row_gap`) into single
         lines; centroid-y is the line's y.
      5. For each line, sample `sample_points` x-positions linearly
         across the chart, take the row-centroid y at each (subpixel).

    Returns one polyline per detected line, with `sample_points` (x, y)
    pairs each.
    """
    H, W = rgb.shape[:2]
    mask = green_mask(rgb)

    x_min = int(min(bounds.x_left_top, bounds.x_left_bot))
    x_max = int(max(bounds.x_right_top, bounds.x_right_bot))
    y_min = int(bounds.y_top)
    y_max = int(bounds.y_bot)

    # Row-density profile in the chart-x band
    band = mask[y_min:y_max+1, x_min:x_max+1]
    row_density = band.sum(axis=1) / band.shape[1]
    hits = row_density > coverage_threshold

    # Cluster consecutive hits
    lines: List[int] = []
    in_run = False; run_start = 0
    for i, h in enumerate(hits):
        if h and not in_run:
            in_run = True; run_start = i
        elif not h and in_run:
            in_run = False
            center = (run_start + i - 1) / 2 + y_min
            lines.append(int(round(center)))
    if in_run:
        center = (run_start + len(hits) - 1) / 2 + y_min
        lines.append(int(round(center)))

    # Merge close-by lines
    merged: List[int] = []
    for y in lines:
        if merged and y - merged[-1] < min_row_gap:
            merged[-1] = (merged[-1] + y) // 2
        else:
            merged.append(y)

    # For each line, refine to per-x centroid + sample evenly
    weight = greenness_weight(rgb, mask)
    polylines: List[List[Tuple[float, float]]] = []
    xs_sample = np.linspace(x_min, x_max, sample_points)
    for y_line in merged:
        pts: List[Tuple[float, float]] = []
        for x_s in xs_sample:
            x_i = int(round(x_s))
            x0 = max(0, x_i - 6); x1 = min(W, x_i + 7)
            # Search ±15 y around y_line for densest green in this column
            y0 = max(0, y_line - 15); y1 = min(H, y_line + 16)
            col_mask = mask[y0:y1, x0:x1]
            col_w = weight[y0:y1, x0:x1]
            if col_mask.sum() < 1: continue
            # weighted centroid in y
            ys = np.arange(y0, y1)
            yw = col_w.sum(axis=1)
            if yw.sum() < 0.5: continue
            yc = (ys * yw).sum() / yw.sum()
            pts.append((float(x_s), float(yc)))
        if len(pts) >= sample_points * 0.5:
            polylines.append(pts)

    return polylines


# ─── vertical arc-sag detection ───────────────────────────────────────


def detect_vertical_arc_lines(
    rgb: np.ndarray,
    bounds: ChartBounds,
    num_arcs: int,
    *,
    seed_search_half: int = 80,
    seed_band_half: int = 30,
    walk_strip_half: int = 20,
    max_dev_per_row: float = 2.0,
    poly_deg: int = 8,
    sample_points: int = 80,
    bold_kernel: int = 2,
) -> List[List[Tuple[float, float]]]:
    """Trace `num_arcs` vertical arc-sag time-separator lines (one per
    integer day boundary on a Lambrecht-style chart).

    Algorithm (per arc τ = 0…num_arcs−1):
      1. Seed: at y_mid, find the bold-density-peak column in a wide
         search band around the linear-nominal x. This avoids latching
         onto frame edges (which dominate y_top / y_bot rows).
      2. Bidirectional tracker: walk up from y_mid → y_top and down
         from y_mid → y_bot. Per row, take weighted-greenness centroid
         in a narrow strip ±walk_strip_half around current x; clamp
         per-row migration to `max_dev_per_row` so the tracker can't
         jump to a neighboring hourly arc.
      3. Polyfit deg `poly_deg` (with sigma-clip outlier rejection)
         and sample at `sample_points` y-positions.

    The bold-mask (erode `green_mask` with horizontal kernel of width
    `bold_kernel`) removes 1-px-wide thin hourly arcs so only the
    ~3-5 px thick day-majors are followed.

    Default parameters tuned on 9992×3956 px barograph scans;
    achieved mean residual ~1.7 px (0.05 mm) across 9 day-major arcs
    with bulge of ~225 px (7.3 mm) per arc.
    """
    H, W = rgb.shape[:2]
    mask = green_mask(rgb)
    weight = greenness_weight(rgb, mask)
    bold = ndimage.binary_erosion(
        mask, structure=np.ones((1, bold_kernel + 1))
    ).astype(np.uint8)

    y_top = int(bounds.y_top); y_bot = int(bounds.y_bot)
    y_mid = (y_top + y_bot) // 2

    def _seed_at_mid(tau_frac: float) -> float:
        xc_e = bounds.base_x(tau_frac, y_mid)
        x0 = max(0, int(xc_e - seed_search_half))
        x1 = min(W, int(xc_e + seed_search_half))
        y0 = max(0, y_mid - seed_band_half)
        y1 = min(H, y_mid + seed_band_half)
        band = bold[y0:y1, x0:x1]
        if band.size == 0:
            return float(xc_e)
        col_density = band.sum(axis=0).astype(np.float32)
        if len(col_density) > 5:
            col_density = ndimage.uniform_filter1d(col_density, 5)
        if col_density.max() < 1:
            return float(xc_e)
        return float(np.argmax(col_density)) + x0

    def _walk(y_iter, x_init: float) -> List[Tuple[int, float]]:
        x = float(x_init); pts: List[Tuple[int, float]] = []
        for y in y_iter:
            x0 = max(0, int(x - walk_strip_half))
            x1 = min(W, int(x + walk_strip_half))
            idxs = np.where(bold[y, x0:x1])[0]
            if len(idxs) < 1:
                pts.append((int(y), x)); continue
            w = weight[y, x0:x1][idxs]
            if w.sum() < 0.5:
                pts.append((int(y), x)); continue
            xc = float((idxs * w).sum() / w.sum()) + x0
            dx = xc - x
            if abs(dx) > max_dev_per_row:
                dx = np.sign(dx) * max_dev_per_row
            x += dx
            pts.append((int(y), x))
        return pts

    out: List[List[Tuple[float, float]]] = []
    ys_sample = np.linspace(y_top, y_bot, sample_points)
    for tau_i in range(num_arcs):
        tau = tau_i / max(1, num_arcs - 1)
        seed = _seed_at_mid(tau)
        up = _walk(range(y_mid, y_top - 1, -1), seed); up.reverse()
        down = _walk(range(y_mid + 1, y_bot + 1), seed)
        pts = up + down
        if len(pts) < 50:
            out.append([])
            continue
        ys = np.array([p[0] for p in pts])
        xs = np.array([p[1] for p in pts])
        c = np.polyfit(ys, xs, poly_deg)
        for _ in range(2):
            resid = xs - np.polyval(c, ys)
            keep = np.abs(resid - np.median(resid)) < 2.5 * max(0.5, float(resid.std()))
            if int(keep.sum()) < poly_deg + 4:
                break
            c = np.polyfit(ys[keep], xs[keep], poly_deg)
        xs_sampled = np.polyval(c, ys_sample)
        out.append([(float(x), float(y)) for x, y in zip(xs_sampled, ys_sample)])
    return out


# ─── convenience: bounds from existing horizontal polylines ────────────


def bounds_from_horizontal_polylines(
    polylines: Sequence[Sequence[Tuple[float, float]]],
    *,
    top_index: int = 0,
    bot_index: int = -1,
) -> ChartBounds:
    """Build a `ChartBounds` from already-detected horizontal grid lines.

    `top_index` / `bot_index` pick which lines bound the chart vertically
    (e.g., top-most & bottom-most when all lines fall inside chart-grid;
    or index 3 / 22 if the first 3 lines are header artefacts).
    """
    top_pts = polylines[top_index]
    bot_pts = polylines[bot_index]
    return ChartBounds(
        x_left_top=top_pts[0][0],
        x_right_top=top_pts[-1][0],
        x_left_bot=bot_pts[0][0],
        x_right_bot=bot_pts[-1][0],
        y_top=sum(p[1] for p in top_pts) / len(top_pts),
        y_bot=sum(p[1] for p in bot_pts) / len(bot_pts),
    )
