#!/usr/bin/env python3
"""Smoke test for /api/calibrate-grid (intersection-based calibration)."""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request
from io import BytesIO

from PIL import Image

API = os.environ.get("DHMZ_API", "https://dhmz.aldo.tech/api")

CHART_CONFIGS = {
    "barograph": {
        "orientation": "landscape",
        "chartWidth": 313, "chartHeight": 76.2,
        "paperWidth": 313, "paperHeight": 90,
        "minValue": 950, "maxValue": 1060,
        "majorGrid": 10, "days": 8,
        "penArmRadius": 177.8, "penArmPivot": 44.45,
        "unit": "hPa",
    },
    "hygrograph": {
        "orientation": "portrait",
        "chartWidth": 76.2, "chartHeight": 280,
        "paperWidth": 90, "paperHeight": 300,
        "minValue": 0, "maxValue": 100,
        "majorGrid": 10, "days": 8,
        "penArmRadius": 177.8, "penArmPivot": 44.45,
        "unit": "% RH",
    },
    "thermograph": {
        "orientation": "portrait",
        "chartWidth": 76.2, "chartHeight": 280,
        "paperWidth": 90, "paperHeight": 300,
        "minValue": -35, "maxValue": 45,
        "majorGrid": 10, "days": 8,
        "penArmRadius": 177.8, "penArmPivot": 44.45,
        "unit": "°C",
    },
}


def display_size(orientation, cw, ch, pw, ph, scale=4):
    if orientation == "landscape":
        return (round((cw + 36) * scale), round((ch + 22) * scale))
    return (round((pw + 19) * scale), round((ph + 24) * scale))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--chart", choices=list(CHART_CONFIGS), default="barograph")
    ap.add_argument("--rotate-cw", action="store_true")
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

    body = json.dumps({
        "imageBase64": image_b64,
        "config": {
            "orientation": cfg["orientation"],
            "chartWidth": cfg["chartWidth"],
            "chartHeight": cfg["chartHeight"],
            "minValue": cfg["minValue"], "maxValue": cfg["maxValue"],
            "majorGrid": cfg["majorGrid"], "days": cfg["days"],
            "penArmRadius": cfg["penArmRadius"], "penArmPivot": cfg["penArmPivot"],
            "unit": cfg["unit"],
        },
        "displayWidth": dw, "displayHeight": dh,
    }).encode()
    req = urllib.request.Request(
        f"{API}/calibrate-grid?debug=true",
        data=body, headers={"Content-Type": "application/json"},
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f"   HTTP {e.code}: {e.read().decode()}")
        return 1
    print(f"   wall: {(time.perf_counter() - t0) * 1000:.0f} ms")
    diag = data["diagnostics"]
    print(f"   timing: {diag['timingMs']}")
    print(f"   horizontals: {diag['detectedHorizontals']}, verticals: {diag['detectedVerticals']}")
    print(f"   dominant angle: {diag['dominantAngleDeg']:.2f}°")
    for i, p in enumerate(data["points"]):
        print(f"   corner #{i+1}: img=({p['imgX']:.1f}, {p['imgY']:.1f})  chart=({p['chartX']:.1f}, {p['chartY']:.1f})")

    if data.get("debugAnnotatedBase64"):
        out = args.out or f"/tmp/dhmz-calibrate-{args.chart}.png"
        with open(out, "wb") as f:
            f.write(base64.b64decode(data["debugAnnotatedBase64"]))
        print(f"   annotated → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
