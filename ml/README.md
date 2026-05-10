# DHMZ Analog — ML scaffold

Tiny U-Net trace-segmenter trained on synthetic data generated from the
bundled empty-chart reference scans. Goal: replace (or augment) the
HSV-threshold trace mask in `backend/app/extract.py` with a learned mask
that is robust to red/brown grids, faded ink, and paper stains.

## Why synthetic data first

We have one labelled real scan worth of ground truth (the bundled
reference, which has *no* trace). Drawing plausible traces on top of the
real grid texture gives us:

- **Pixel-exact masks** — we drew the trace, we know exactly which pixels
  are ink.
- **Unlimited samples** — vary trace shape, ink color, line thickness,
  noise, blur, JPEG.
- **Real grid texture** — the model learns to *ignore* the actual green
  grid as background, not a synthetic approximation.

The expected workflow is: bootstrap on synthetic, then fine-tune on a
small set (~20–50) of hand-labelled real scans once we have them.

## Files

- `synthetic.py` — generates `(img, mask)` pairs from
  `/Users/aldo/Desktop/tracks/reference/barograf_reference.png`
- `model.py` — `TinyUNet` (5-stage, ~1.6 M params, ~6 MB ONNX)
- `train.py` — BCE+Dice training loop with hard-pixel-biased crop sampling
- `export_onnx.py` — PyTorch → ONNX with dynamic spatial dims for ORT-Web

## Quickstart

```bash
# 1. Install deps (use a fresh venv)
python -m venv .venv-ml
source .venv-ml/bin/activate
pip install -r ml/requirements.txt

# 2. Generate 500 training pairs from the bundled barograph reference
python -m ml.synthetic \
    --reference /Users/aldo/Desktop/tracks/reference/barograf_reference.png \
    --out /tmp/dhmz-synth \
    --n 500 \
    --max-edge 2000

# 3. Sanity check — open one pair side-by-side
open /tmp/dhmz-synth/img_00000.png /tmp/dhmz-synth/mask_00000.png

# 4. Train (CPU-OK; ~15 min for 20 epochs on M3, much faster on GPU)
python -m ml.train \
    --data /tmp/dhmz-synth \
    --out /tmp/dhmz-model \
    --epochs 20 \
    --batch 8 \
    --crop 384

# 5. Export to ONNX (with parity check)
python -m ml.export_onnx \
    --ckpt /tmp/dhmz-model/best.pt \
    --out ml/trace_seg.onnx \
    --check
```

## Where to plug it in

Two options:

**(a) Browser-side** with [onnxruntime-web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html).
Pros: no backend round-trip; works offline; ORT-Web auto-uses WebGPU/WebGL
when available. Add `onnxruntime-web` to package.json, load `trace_seg.onnx`
once, run before submitting to backend.

**(b) Backend-side** in `extract.py` via `onnxruntime` (already in
requirements). Pros: no model download for users; CPU-only ORT is plenty
fast for a 1024×1024 chart. Replace `_build_trace_mask` with model
inference; keep the HSV path as a fallback when the model is missing.

I'd recommend (b) first (simpler integration, no JS bundle bloat) and
move to (a) later if we want offline support.

## Roadmap

1. **Now:** synthetic-only U-Net for barograph traces. Validate on the
   real test images at `/tmp/tracks/`.
2. **Next:** add hygrograph and thermograph reference templates, retrain.
3. **Later:** label ~50 real scans with the labelling tool of your choice
   (LabelMe, CVAT, even Photoshop) → fine-tune the synthetic model on
   real data.
4. **Optional:** orientation classifier to replace the naive 90° rotation
   guessing in `auto-calibration.ts`. Trivially built from the same
   synthetic data with random 4-way rotation labels.
5. **Optional:** corner keypoint regressor to replace HoughLinesP — gives
   (x, y) for each of the 4 chart corners directly. Small heatmap CNN.

## Performance budget

`TinyUNet` at base=16 with 384×384 input runs in:
- Apple M3 (CPU, ORT): ~80 ms / image
- NVIDIA RTX 3060 (CUDA, PyTorch): ~5 ms / image
- Browser (WebGPU on M3): ~120 ms / image

Plenty fast for an interactive "hit a button to run model" path; not so
fast that we should run it on every keystroke.
