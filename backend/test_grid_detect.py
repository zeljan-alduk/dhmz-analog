"""Detect horizontal grid lines + vertical arc-sag separators on a chart scan.

Usage:
    python3 backend/test_grid_detect.py <scan.png> [--days 8] [--show]

Writes:
    /tmp/grid-detect-horizontals.png   — scan + red horizontal polylines
    /tmp/grid-detect-verticals.png     — scan + red vertical arc-sag polylines
    /tmp/grid-detect-both.png          — both overlaid

Quality reference on Lambrecht 8-day barograph scan (9992×3956 px):
    horizontals: 23 lines detected (3 header + 20 chart-grid major).
    verticals  : 9 day-separators, mean residual 0.58 px / max 0.79 px.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# Make backend.app importable
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app.grid_detect import (
    detect_horizontal_grid_lines,
    detect_vertical_arc_lines,
    bounds_from_horizontal_polylines,
    ChartBounds,
)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("image")
    p.add_argument("--days", type=int, default=8,
                   help="Number of vertical day-separators (default 8 + 1)")
    p.add_argument("--chart-top-row", type=int, default=3,
                   help="Index into detected horizontals that bounds the chart top "
                        "(skip header artefacts; default 3 for 8-day barograph)")
    p.add_argument("--chart-bot-row", type=int, default=-1,
                   help="Index into detected horizontals that bounds the chart bottom")
    args = p.parse_args()

    img = Image.open(args.image).convert("RGB")
    arr = np.array(img)
    H, W = arr.shape[:2]
    print(f"image: {W}×{H}")

    # 1) Horizontals — initial bounds = full image so we catch everything
    init_bounds = ChartBounds(
        x_left_top=10, x_right_top=W - 10,
        x_left_bot=10, x_right_bot=W - 10,
        y_top=10, y_bot=H - 10,
    )
    horizontals = detect_horizontal_grid_lines(arr, init_bounds)
    print(f"horizontals: {len(horizontals)}")

    # 2) Build chart-area bounds from a chosen pair of horizontals
    bounds = bounds_from_horizontal_polylines(
        horizontals, top_index=args.chart_top_row, bot_index=args.chart_bot_row,
    )
    print(f"chart bounds: y=[{bounds.y_top:.0f},{bounds.y_bot:.0f}]  "
          f"x_top=[{bounds.x_left_top:.0f},{bounds.x_right_top:.0f}]  "
          f"x_bot=[{bounds.x_left_bot:.0f},{bounds.x_right_bot:.0f}]")

    # 3) Verticals
    num_verticals = args.days + 1
    verticals = detect_vertical_arc_lines(arr, bounds, num_verticals)
    print(f"verticals: {sum(1 for v in verticals if v)}/{num_verticals}")

    # 4) Render previews (downsampled for size)
    scale = 1500 / max(W, H) if max(W, H) > 1500 else 1.0
    prev_w, prev_h = int(W * scale), int(H * scale)
    base = img.resize((prev_w, prev_h), Image.LANCZOS)

    def _render(out_path: str, polylines, color):
        canvas = base.copy()
        d = ImageDraw.Draw(canvas)
        for pts in polylines:
            if not pts: continue
            d.line([(x * scale, y * scale) for (x, y) in pts], fill=color, width=2)
        canvas.save(out_path, "PNG")
        print(f"  → {out_path}")

    _render("/tmp/grid-detect-horizontals.png", horizontals, (255, 0, 0))
    _render("/tmp/grid-detect-verticals.png", verticals, (255, 0, 0))

    # Combined
    combined = base.copy()
    d = ImageDraw.Draw(combined)
    for pts in horizontals:
        d.line([(x * scale, y * scale) for (x, y) in pts], fill=(255, 128, 128), width=1)
    for pts in verticals:
        if pts:
            d.line([(x * scale, y * scale) for (x, y) in pts], fill=(255, 0, 0), width=2)
    combined.save("/tmp/grid-detect-both.png", "PNG")
    print("  → /tmp/grid-detect-both.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
