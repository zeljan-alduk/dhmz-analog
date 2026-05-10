"""Synthetic training data generator for the trace segmenter.

Takes an empty-chart reference scan (the bundled `barograph.png` template)
and draws plausible pen traces on top, producing (image, mask) pairs where
the mask is the EXACT pixel-level ground truth (we drew it, we know).

Usage:
    python -m ml.synthetic \
        --reference /Users/aldo/Desktop/tracks/reference/barograf_reference.png \
        --out /tmp/dhmz-synth \
        --n 200

Outputs:
    {out}/img_00000.png  - synthesized scan (RGB)
    {out}/mask_00000.png - binary mask, 255 where pen ink is

Trace model: a sum of low-frequency sinusoids (diurnal pressure swing) plus
optional weather-front discontinuities and pen-arm arc-sag. We render at the
reference image's full resolution so the model trains on real grid texture.

Key design choices:
- Multi-scale sinusoid sum mimics the slow drift + diurnal cycle real
  barographs record. Frequencies and amplitudes are randomised per sample.
- Random ink color (blue/red/black/brown) and slight hue jitter.
- Per-day variable line thickness (1-3 px) — Lambrecht pens wear unevenly.
- Realistic noise: Gaussian blur on the trace, paper-texture multiplicative
  noise, JPEG-style compression artifacts at 10 % chance.
- We DO NOT add the grid here — it's already in the reference image. Drawing
  the trace ON TOP preserves real grid color/spacing/imperfections.
"""
from __future__ import annotations

import argparse
import math
import os
import random
from pathlib import Path
from typing import Tuple

import cv2
import numpy as np
from tqdm import tqdm


# ─── Trace generation ──────────────────────────────────────────────────────


def _sample_pressure_curve(n_samples: int, days: int = 8) -> np.ndarray:
    """Return an array of `n_samples` values in [0, 1] representing a plausible
    barographic time series. 0 = bottom of chart (low pressure), 1 = top.

    Built as: base drift + diurnal sinusoid + occasional weather-front step +
    high-freq jitter. Shape mimics what real charts show: slowly varying
    means with ~12–24 h periodicity and sharp drops on weather changes.
    """
    t = np.linspace(0, days * 24.0, n_samples)  # hours

    # Base (multi-day drift). Random walk smoothed.
    drift = np.cumsum(np.random.randn(n_samples)) / math.sqrt(n_samples)
    drift = drift - drift.min()
    if drift.max() > 0:
        drift = drift / drift.max()
    drift_amp = random.uniform(0.15, 0.4)

    # Diurnal sinusoid: 24-hr period typical for atmospheric tide
    diurnal = np.sin(2 * np.pi * t / 24.0 + random.uniform(0, 2 * np.pi))
    diurnal_amp = random.uniform(0.05, 0.15)

    # Semi-diurnal harmonic (12-hr)
    semi = np.sin(2 * np.pi * t / 12.0 + random.uniform(0, 2 * np.pi))
    semi_amp = random.uniform(0.02, 0.08)

    # Weather front: a couple of sharp ramps over a few hours
    front = np.zeros(n_samples)
    n_fronts = random.randint(0, 2)
    for _ in range(n_fronts):
        center = random.randint(n_samples // 8, 7 * n_samples // 8)
        width = max(2, int(n_samples * random.uniform(0.01, 0.04)))
        amp = random.uniform(-0.25, 0.25)
        ramp = np.tanh(np.linspace(-3, 3, width * 2))
        s = center - width
        e = center + width
        s_clip = max(0, s)
        e_clip = min(n_samples, e)
        front[s_clip:e_clip] += amp * ramp[s_clip - s : e_clip - s]
    # Cumulative effect (weather fronts persist)
    front = np.cumsum(front) / max(1, n_fronts) if n_fronts > 0 else front

    # Jitter
    jitter = np.random.randn(n_samples) * 0.005

    raw = (
        0.5
        + drift_amp * (drift - 0.5)
        + diurnal_amp * diurnal
        + semi_amp * semi
        + front
        + jitter
    )

    # Clamp & rescale to leave 5 % margin on top/bottom
    raw = np.clip(raw, 0.05, 0.95)
    return raw


def _arc_sag(measurement_pos: float, R: float = 177.8, P: float = 44.45) -> float:
    """Pen-arm horizontal sag at measurement-axis position (mm).

    Matches src/lib/chart-geometry.ts arcSag(). Returns 0 at x = P and grows
    with |x − P|.
    """
    sag_at_pivot = R - math.sqrt(R * R - P * P)
    dx = measurement_pos - P
    sag_at_pos = R - math.sqrt(R * R - dx * dx)
    return sag_at_pos - sag_at_pivot


# ─── Rendering ─────────────────────────────────────────────────────────────


_INK_PRESETS = [
    # (B, G, R) base ink colors. Jittered at draw time. Mix of saturated
    # (fresh pen) and pale (faded / low-ink) presets — real Lambrecht charts
    # span the whole range from "just-replaced cartridge" to "running dry,
    # paper-ghost trace barely visible against grid". Without pale presets
    # the trained model never sees low-contrast input and fails on real
    # faded scans (the dominant failure mode in DHMZ archive scans).
    ("blue_dark", (160, 60, 30)),
    ("blue_mid", (180, 110, 80)),
    ("blue_pale", (200, 175, 150)),
    ("blue_faded", (220, 200, 180)),
    ("black", (35, 30, 30)),
    ("grey", (110, 110, 110)),
    ("red_dark", (40, 40, 180)),
    ("red_pale", (140, 140, 200)),
    ("brown", (50, 70, 110)),
    ("brown_pale", (130, 150, 180)),
    ("pencil", (160, 165, 170)),
]


def _draw_trace(
    canvas: np.ndarray,
    mask: np.ndarray,
    curve_y: np.ndarray,
    chart_box: Tuple[int, int, int, int],
) -> None:
    """Draw the pen trace onto `canvas` (BGR, mutated) and `mask` (uint8).

    Uses an alpha-compositing pass so faded traces (alpha < 1) blend with
    the underlying paper / grid texture — that's how real low-ink scans
    look. The mask is the pen-arm path regardless of alpha — it's the
    GROUND TRUTH "where the pen would have been" even if the resulting
    image is barely visible.

    `curve_y` is a 1D array of n_samples normalized [0, 1] values. We map
    them to pixel rows inside `chart_box = (x0, y0, x1, y1)` and rasterize
    a connected polyline with slight thickness jitter.
    """
    x0, y0, x1, y1 = chart_box
    chart_w = x1 - x0
    chart_h = y1 - y0
    n = len(curve_y)
    xs = np.linspace(x0, x1, n)
    ys = y1 - curve_y * chart_h  # 0 → bottom (low pressure), 1 → top

    # Sample a base ink color and jitter it per-sample slightly so it looks
    # like a real fading/loading pen.
    _, base_bgr = random.choice(_INK_PRESETS)

    # Variable line thickness, with significant variation across the trace
    # to simulate real pens (1 px at the start, 2-3 px after a few hours of
    # contact, occasional ink blots).
    raw_thick = np.random.uniform(1, 3, size=n)
    thick = np.convolve(raw_thick, np.ones(15) / 15, mode="same")

    # Apply arc-sag horizontally — barograph: trace shifts left at extremes
    # of the measurement axis. Translate ys → measurement-mm via 76.2 mm
    # chart height assumption (matches the bundled barograph template).
    chart_h_mm = 76.2  # barograph chart height (post-DISPLAY_SCALE neutral)
    px_per_mm = chart_h / chart_h_mm
    sag_px = np.array(
        [_arc_sag((y1 - y) / px_per_mm) * px_per_mm for y in ys]
    )
    xs_drawn = xs - sag_px

    # Sample a per-trace alpha (opacity). Skewed toward mid-low so the
    # model sees lots of faded examples — those are the hard ones.
    alpha_global = random.choices(
        population=[0.35, 0.55, 0.75, 0.95],
        weights=[2, 3, 3, 2],
        k=1,
    )[0]

    # Random gaps: simulate pen lift / running dry. ~30% of traces have
    # 1-3 short blank segments where the trace is invisible (mask still
    # records intended path? — actually NO, if the pen wasn't on paper the
    # mask should be zero too. Keep gap_in_mask=True for honesty).
    n_gaps = random.choices([0, 1, 2, 3], weights=[7, 2, 1, 0.5], k=1)[0]
    gap_ranges: list[tuple[int, int]] = []
    for _ in range(n_gaps):
        gap_center = random.randint(n // 10, 9 * n // 10)
        gap_width = random.randint(int(n * 0.005), int(n * 0.03))
        gap_ranges.append(
            (max(0, gap_center - gap_width), min(n, gap_center + gap_width))
        )

    def _in_gap(i: int) -> bool:
        for s, e in gap_ranges:
            if s <= i < e:
                return True
        return False

    # Render trace into a side buffer then alpha-composite onto canvas.
    # This is how we get faded-ink look: paper grid bleeds through.
    h, w = canvas.shape[:2]
    ink_layer = np.zeros((h, w, 3), dtype=np.float32)
    alpha_layer = np.zeros((h, w), dtype=np.float32)

    for i in range(n - 1):
        if _in_gap(i):
            continue
        # Per-segment color jitter (±20)
        bgr = tuple(
            int(np.clip(c + random.randint(-20, 20), 0, 255)) for c in base_bgr
        )
        # Per-segment alpha jitter on top of global alpha
        a = float(np.clip(alpha_global + random.uniform(-0.15, 0.15), 0.05, 1.0))
        t = max(1, int(round((thick[i] + thick[i + 1]) / 2)))
        p0 = (int(xs_drawn[i]), int(ys[i]))
        p1 = (int(xs_drawn[i + 1]), int(ys[i + 1]))
        cv2.line(ink_layer, p0, p1, bgr, t, lineType=cv2.LINE_AA)
        cv2.line(alpha_layer, p0, p1, a, t, lineType=cv2.LINE_AA)
        # Mask: solid wherever the pen was, regardless of alpha
        cv2.line(mask, p0, p1, 255, t, lineType=cv2.LINE_AA)

    # Alpha composite: out = canvas * (1 - α) + ink * α, only where ink_layer
    # has been written (avoid overwriting blank background with α * 0).
    nonzero = alpha_layer > 0
    if nonzero.any():
        a3 = np.repeat(alpha_layer[:, :, None], 3, axis=2)
        out = canvas.astype(np.float32) * (1.0 - a3) + ink_layer * a3
        canvas[nonzero] = np.clip(out[nonzero], 0, 255).astype(np.uint8)


def _augment(canvas: np.ndarray, mask: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Apply realistic image-acquisition augmentations: paper texture noise,
    Gaussian blur (out-of-focus scan), JPEG artifacts. Mask is unchanged.
    """
    out = canvas.copy()

    # Paper-grain multiplicative noise
    if random.random() < 0.7:
        noise = np.random.uniform(0.95, 1.05, out.shape).astype(np.float32)
        out = np.clip(out.astype(np.float32) * noise, 0, 255).astype(np.uint8)

    # Gaussian blur (mild)
    if random.random() < 0.5:
        k = random.choice([3, 5])
        out = cv2.GaussianBlur(out, (k, k), 0)

    # JPEG round-trip
    if random.random() < 0.2:
        q = random.randint(60, 95)
        ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, q])
        if ok:
            out = cv2.imdecode(buf, cv2.IMREAD_COLOR)

    return out, mask


# ─── Chart-region detection on the reference ───────────────────────────────


def _detect_chart_box(reference: np.ndarray) -> Tuple[int, int, int, int]:
    """Find the green-grid bounding box on the bundled reference scan.

    We threshold for "saturated green/teal" pixels, find the largest
    bounding box, and use that as the chart region. Falls back to a centered
    inset if detection fails.
    """
    h, w = reference.shape[:2]
    hsv = cv2.cvtColor(reference, cv2.COLOR_BGR2HSV)
    H, S, V = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    is_grid = (H >= 35) & (H <= 95) & (S > 30) & (V > 60)
    ys, xs = np.where(is_grid)
    if len(xs) < 1000:
        # Fallback: inset 5 %
        return (int(w * 0.05), int(h * 0.05), int(w * 0.95), int(h * 0.95))
    # Use 1st/99th percentiles to ignore stray pixels
    x0 = int(np.percentile(xs, 1))
    x1 = int(np.percentile(xs, 99))
    y0 = int(np.percentile(ys, 1))
    y1 = int(np.percentile(ys, 99))
    return (x0, y0, x1, y1)


# ─── Pipeline ──────────────────────────────────────────────────────────────


def generate_one(reference: np.ndarray, chart_box: Tuple[int, int, int, int]):
    """Produce one (image, mask) pair from the empty-chart reference."""
    canvas = reference.copy()
    h, w = canvas.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)

    # Sample a curve at high density so the rasterizer doesn't chunk.
    n_samples = random.randint(800, 2400)
    curve = _sample_pressure_curve(n_samples)

    _draw_trace(canvas, mask, curve, chart_box)
    canvas, mask = _augment(canvas, mask)
    return canvas, mask


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--reference", required=True, help="Path to empty-chart PNG")
    p.add_argument("--out", required=True, help="Output directory for pairs")
    p.add_argument("--n", type=int, default=100, help="Number of samples to generate")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument(
        "--max-edge",
        type=int,
        default=2000,
        help="Downscale reference if longer than this (training images don't need full res)",
    )
    args = p.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)

    ref = cv2.imread(args.reference, cv2.IMREAD_COLOR)
    if ref is None:
        raise SystemExit(f"Could not read reference image at {args.reference}")
    h, w = ref.shape[:2]
    longest = max(h, w)
    if longest > args.max_edge:
        scale = args.max_edge / longest
        ref = cv2.resize(
            ref,
            (int(round(w * scale)), int(round(h * scale))),
            interpolation=cv2.INTER_AREA,
        )

    chart_box = _detect_chart_box(ref)
    print(f"reference: {ref.shape}, chart_box={chart_box}")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    for i in tqdm(range(args.n), desc="synthesizing"):
        img, mask = generate_one(ref, chart_box)
        cv2.imwrite(str(out_dir / f"img_{i:05d}.png"), img)
        cv2.imwrite(str(out_dir / f"mask_{i:05d}.png"), mask)

    print(f"\nWrote {args.n} pairs to {out_dir}")
    print("Sanity check: open one of the (img, mask) pairs side-by-side in a viewer.")


if __name__ == "__main__":
    main()
