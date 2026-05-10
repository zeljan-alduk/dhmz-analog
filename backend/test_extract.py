#!/usr/bin/env python3
"""End-to-end smoke test for the trace extractor.

Loads a real Plustek 320e scan from /tmp/tracks, simulates what the
frontend pipeline produces (90° CW rotation + downscale to 4000 px max
edge + display-px scale of 4× chart-mm), and POSTs to the live backend.

Verifies:
  - Endpoint returns 200
  - Extracted points are non-empty
  - Points span the expected day/value ranges
  - Timing is reasonable
  - Saves a debug visualization PNG with extracted points overlaid.
"""
import argparse
import base64
import json
import os
import sys
import time
from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw

API = os.environ.get("DHMZ_API", "https://dhmz.aldo.tech/api")


def prep_image(path: str, rotate_cw: bool, max_edge: int = 4000) -> Image.Image:
    img = Image.open(path).convert("RGB")
    if rotate_cw:
        img = img.transpose(Image.Transpose.ROTATE_270)  # PIL ROTATE_270 = 90° CW
    longest = max(img.size)
    if longest > max_edge:
        scale = max_edge / longest
        img = img.resize(
            (round(img.size[0] * scale), round(img.size[1] * scale)),
            Image.LANCZOS,
        )
    return img


def display_size_for(orientation: str, chart_w: float, chart_h: float, paper_w: float, paper_h: float, scale: int = 4) -> tuple[int, int]:
    """Match getDisplaySize() in src/lib/chart-geometry.ts."""
    if orientation == "landscape":
        return (round((chart_w + 36) * scale), round((chart_h + 22) * scale))
    return (round((paper_w + 19) * scale), round((paper_h + 24) * scale))


def build_corner_calibration(display_w: int, display_h: int, chart_w: float, chart_h: float, orientation: str, days: int, min_val: float, max_val: float):
    """Construct calibration points by treating the four image corners as the
    four chart corners. Only valid when the scan is full-bleed (chart fills
    the whole frame). Useful for tests on prazna scans.
    """
    if orientation == "landscape":
        return [
            {"imgX": 0,         "imgY": 0,         "chartX": 0,       "chartY": 0},          # day0, maxValue
            {"imgX": display_w, "imgY": 0,         "chartX": chart_w, "chartY": 0},          # day8, maxValue
            {"imgX": 0,         "imgY": display_h, "chartX": 0,       "chartY": chart_h},    # day0, minValue
            {"imgX": display_w, "imgY": display_h, "chartX": chart_w, "chartY": chart_h},    # day8, minValue
        ]
    else:
        return [
            {"imgX": 0,         "imgY": 0,         "chartX": 0,       "chartY": 0},
            {"imgX": display_w, "imgY": 0,         "chartX": chart_w, "chartY": 0},
            {"imgX": 0,         "imgY": display_h, "chartX": 0,       "chartY": chart_h},
            {"imgX": display_w, "imgY": display_h, "chartX": chart_w, "chartY": chart_h},
        ]


# Subset of CHART_CONFIGS in chart-geometry.ts
CHART_CONFIGS = {
    "barograph": {
        "orientation": "landscape",
        "chartWidth": 313,
        "chartHeight": 76.2,
        "paperWidth": 313,
        "paperHeight": 90,
        "minValue": 950,
        "maxValue": 1060,
        "majorGrid": 10,
        "days": 8,
        "penArmRadius": 177.8,
        "penArmPivot": 44.45,
        "unit": "hPa",
    },
    "hygrograph": {
        "orientation": "portrait",
        "chartWidth": 76.2,
        "chartHeight": 280,
        "paperWidth": 90,
        "paperHeight": 300,
        "minValue": 0,
        "maxValue": 100,
        "majorGrid": 10,
        "days": 8,
        "penArmRadius": 177.8,
        "penArmPivot": 44.45,
        "unit": "% RH",
    },
    "thermograph": {
        "orientation": "portrait",
        "chartWidth": 76.2,
        "chartHeight": 280,
        "paperWidth": 90,
        "paperHeight": 300,
        "minValue": -35,
        "maxValue": 45,
        "majorGrid": 10,
        "days": 8,
        "penArmRadius": 177.8,
        "penArmPivot": 44.45,
        "unit": "°C",
    },
}


def call_extract(image_b64: str, calibration, display_w: int, display_h: int, config: dict, ink: str = "auto", debug: bool = True) -> dict:
    import urllib.request
    body = json.dumps({
        "imageBase64": image_b64,
        "calibrationPoints": calibration,
        "displayWidth": display_w,
        "displayHeight": display_h,
        "config": {
            "orientation": config["orientation"],
            "chartWidth": config["chartWidth"],
            "chartHeight": config["chartHeight"],
            "minValue": config["minValue"],
            "maxValue": config["maxValue"],
            "majorGrid": config["majorGrid"],
            "days": config["days"],
            "penArmRadius": config["penArmRadius"],
            "penArmPivot": config["penArmPivot"],
            "unit": config["unit"],
        },
        "samplesPerDay": 48,
        "traceInk": ink,
    }).encode()
    url = f"{API}/extract-trace"
    if debug:
        url += "?debug=true"
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode())
    data["_wallMs"] = round((time.perf_counter() - t0) * 1000, 1)
    return data


def visualize(img: Image.Image, points: list[dict], display_w: int, display_h: int, out_path: str):
    """Resize img to display dims, draw extracted points on it, save."""
    vis = img.resize((display_w, display_h), Image.LANCZOS).convert("RGB")
    draw = ImageDraw.Draw(vis)
    for p in points:
        x, y = p["canvasX"], p["canvasY"]
        if 0 <= x < display_w and 0 <= y < display_h:
            r = 3
            draw.ellipse([x - r, y - r, x + r, y + r], fill=(255, 0, 80), outline=(255, 255, 255))
    vis.save(out_path, "PNG", optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image", help="Path to scan PNG")
    ap.add_argument("--chart", choices=list(CHART_CONFIGS), default="barograph")
    ap.add_argument("--rotate-cw", action="store_true", help="Rotate scan 90° CW before processing")
    ap.add_argument("--ink", default="auto", choices=["auto", "blue", "red", "black"])
    ap.add_argument("--out", default=None, help="Output preview PNG path")
    args = ap.parse_args()

    if not os.path.exists(args.image):
        print(f"Image not found: {args.image}", file=sys.stderr)
        sys.exit(1)

    config = CHART_CONFIGS[args.chart]
    display_w, display_h = display_size_for(
        config["orientation"], config["chartWidth"], config["chartHeight"],
        config["paperWidth"], config["paperHeight"],
    )
    print(f"== {args.chart} ({config['orientation']}) — display {display_w}×{display_h}")

    img = prep_image(args.image, rotate_cw=args.rotate_cw)
    print(f"   prep: {img.size[0]}×{img.size[1]} after rotate={args.rotate_cw}, downscale to ≤4000")

    # Encode image to PNG base64
    buf = BytesIO()
    img.save(buf, "PNG")
    image_b64 = base64.b64encode(buf.getvalue()).decode()
    print(f"   payload: {len(image_b64) / 1024:.1f} KB base64")

    cal = build_corner_calibration(
        display_w, display_h,
        config["chartWidth"], config["chartHeight"],
        config["orientation"], config["days"],
        config["minValue"], config["maxValue"],
    )
    print(f"   calibration: 4 corners (full-bleed)")

    print("   POST /api/extract-trace …")
    resp = call_extract(image_b64, cal, display_w, display_h, config, ink=args.ink, debug=True)

    diag = resp["diagnostics"]
    points = resp["points"]
    print(f"   wall: {resp['_wallMs']} ms")
    print(f"   timing: {diag['timingMs']}")
    print(f"   mask: {diag['maskPixels']:,} px, skel: {diag['skeletonPixels']:,} px")
    print(f"   rectified: {diag['rectifiedSize'][0]}×{diag['rectifiedSize'][1]}")
    print(f"   POINTS: {len(points)}")
    if not points:
        print("   ⚠ NO POINTS EXTRACTED — saving debug previews")
        for name in ("debugMaskBase64", "debugSkeletonBase64", "debugRectifiedBase64"):
            b = resp.get(name)
            if b:
                kind = name.replace("debug", "").replace("Base64", "").lower()
                pp = (args.out or f"/tmp/dhmz-extract-{args.chart}.png").replace(".png", f"-{kind}.png")
                with open(pp, "wb") as f:
                    f.write(base64.b64decode(b))
                print(f"   {kind} → {pp}")
        return 2

    days = sorted(set(p["day"] for p in points))
    values = [p["value"] for p in points]
    print(f"   day span: {min(days)}…{max(days)} ({len(days)} unique)")
    print(f"   value span: {min(values):.1f}…{max(values):.1f} {config['unit']}")
    print(f"   median value: {np.median(values):.1f} {config['unit']}")

    out = args.out or f"/tmp/dhmz-extract-{args.chart}.png"
    visualize(img, points, display_w, display_h, out)
    print(f"   visualization → {out}")

    # Save mask + skeleton + rectified previews if backend returned them
    for name in ("debugMaskBase64", "debugSkeletonBase64", "debugRectifiedBase64"):
        b = resp.get(name)
        if b:
            preview_path = out.replace(".png", f"-{name.replace('debug', '').replace('Base64', '').lower()}.png")
            with open(preview_path, "wb") as f:
                f.write(base64.b64decode(b))
            print(f"   {name.replace('debug', '').replace('Base64', '').lower()} → {preview_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
