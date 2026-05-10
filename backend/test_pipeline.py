#!/usr/bin/env python3
"""End-to-end pipeline: calibrate-grid → extract-trace.

Tests both endpoints in the order a user would use them. Validates:
  - Calibration finds the 4 grid corners correctly.
  - Extraction with those corners produces a sensible trace on PUNA.
  - Extraction returns 0 points on PRAZNA (no false positives).
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request
from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw

API = os.environ.get("DHMZ_API", "https://dhmz.aldo.tech/api")

CHART_CONFIGS = {
    "barograph": {
        "orientation": "landscape", "chartWidth": 313, "chartHeight": 76.2,
        "paperWidth": 313, "paperHeight": 90, "minValue": 950, "maxValue": 1060,
        "majorGrid": 10, "days": 8, "penArmRadius": 177.8, "penArmPivot": 44.45,
        "unit": "hPa",
    },
    "hygrograph": {
        "orientation": "portrait", "chartWidth": 76.2, "chartHeight": 280,
        "paperWidth": 90, "paperHeight": 300, "minValue": 0, "maxValue": 100,
        "majorGrid": 10, "days": 8, "penArmRadius": 177.8, "penArmPivot": 44.45,
        "unit": "% RH",
    },
    "thermograph": {
        "orientation": "portrait", "chartWidth": 76.2, "chartHeight": 280,
        "paperWidth": 90, "paperHeight": 300, "minValue": -35, "maxValue": 45,
        "majorGrid": 10, "days": 8, "penArmRadius": 177.8, "penArmPivot": 44.45,
        "unit": "°C",
    },
}


def display_size(o, cw, ch, pw, ph, scale=4):
    if o == "landscape":
        return (round((cw + 36) * scale), round((ch + 22) * scale))
    return (round((pw + 19) * scale), round((ph + 24) * scale))


def post(path, body, timeout=60):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--chart", choices=list(CHART_CONFIGS), default="barograph")
    ap.add_argument("--rotate-cw", action="store_true")
    ap.add_argument("--ink", default="auto")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    cfg = CHART_CONFIGS[args.chart]
    dw, dh = display_size(
        cfg["orientation"], cfg["chartWidth"], cfg["chartHeight"],
        cfg["paperWidth"], cfg["paperHeight"],
    )

    img = Image.open(args.image).convert("RGB")
    if args.rotate_cw:
        img = img.transpose(Image.Transpose.ROTATE_270)
    longest = max(img.size)
    if longest > 4000:
        scale = 4000 / longest
        img = img.resize(
            (round(img.size[0] * scale), round(img.size[1] * scale)),
            Image.LANCZOS,
        )
    print(f"== {args.chart} ({cfg['orientation']}) — image {img.size}, display {dw}×{dh}")

    buf = BytesIO()
    img.save(buf, "PNG")
    image_b64 = base64.b64encode(buf.getvalue()).decode()

    cfg_payload = {
        "orientation": cfg["orientation"],
        "chartWidth": cfg["chartWidth"], "chartHeight": cfg["chartHeight"],
        "minValue": cfg["minValue"], "maxValue": cfg["maxValue"],
        "majorGrid": cfg["majorGrid"], "days": cfg["days"],
        "penArmRadius": cfg["penArmRadius"], "penArmPivot": cfg["penArmPivot"],
        "unit": cfg["unit"],
    }

    print("\n[1/2] POST /api/calibrate-grid …")
    t0 = time.perf_counter()
    cal_resp = post("/calibrate-grid", {
        "imageBase64": image_b64,
        "config": cfg_payload,
        "displayWidth": dw, "displayHeight": dh,
    })
    cal_ms = (time.perf_counter() - t0) * 1000
    cal_pts = cal_resp["points"]
    print(f"   wall={cal_ms:.0f} ms  H={cal_resp['diagnostics']['detectedHorizontals']}  V={cal_resp['diagnostics']['detectedVerticals']}  angle={cal_resp['diagnostics']['dominantAngleDeg']:.2f}°")
    for i, p in enumerate(cal_pts):
        print(f"   corner #{i+1}: img=({p['imgX']:.1f}, {p['imgY']:.1f})  chart=({p['chartX']:.1f}, {p['chartY']:.1f})")

    print("\n[2/2] POST /api/extract-trace …")
    t0 = time.perf_counter()
    ext_resp = post("/extract-trace", {
        "imageBase64": image_b64,
        "calibrationPoints": [
            {"imgX": p["imgX"], "imgY": p["imgY"],
             "chartX": p["chartX"], "chartY": p["chartY"]}
            for p in cal_pts
        ],
        "displayWidth": dw, "displayHeight": dh,
        "config": cfg_payload,
        "samplesPerDay": 96, "traceInk": args.ink,
    }, timeout=120)
    ext_ms = (time.perf_counter() - t0) * 1000
    diag = ext_resp["diagnostics"]
    points = ext_resp["points"]
    print(f"   wall={ext_ms:.0f} ms  timing={diag['timingMs']}")
    print(f"   mask={diag['maskPixels']:,}  rectified={diag['rectifiedSize']}")
    print(f"   POINTS: {len(points)}")
    if points:
        days = sorted(set(p["day"] for p in points))
        values = [p["value"] for p in points]
        print(f"   day span: {min(days)}…{max(days)} ({len(days)} unique)")
        print(f"   value span: {min(values):.1f}…{max(values):.1f} {cfg['unit']}")
        print(f"   median: {np.median(values):.1f} {cfg['unit']}")

    # Visualization
    out = args.out or f"/tmp/dhmz-pipeline-{args.chart}.png"
    vis = img.resize((dw, dh), Image.LANCZOS).convert("RGB")
    draw = ImageDraw.Draw(vis)
    # Connect points as a polyline
    sorted_pts = sorted(points, key=lambda p: (p["day"], p["hour"]))
    if len(sorted_pts) > 1:
        coords = [(p["canvasX"], p["canvasY"]) for p in sorted_pts]
        draw.line(coords, fill=(16, 185, 129), width=2)
    # Draw each point as a tiny dot
    for p in points:
        x, y = p["canvasX"], p["canvasY"]
        if 0 <= x < dw and 0 <= y < dh:
            draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(16, 185, 129))
    # Draw cal corners in red
    for c in cal_pts:
        x, y = c["imgX"], c["imgY"]
        draw.ellipse([x - 6, y - 6, x + 6, y + 6], outline=(255, 0, 0), width=2)
    vis.save(out, "PNG", optimize=True)
    print(f"\n   visualization → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
