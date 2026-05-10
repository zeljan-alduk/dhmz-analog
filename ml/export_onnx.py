"""Export a trained TinyUNet checkpoint to ONNX for ORT-Web inference.

Usage:
    python -m ml.export_onnx --ckpt /tmp/dhmz-model/best.pt --out ml/trace_seg.onnx

Verifies the exported model with onnxruntime by running the same input
through both PyTorch and ORT and comparing outputs.

The exported graph uses dynamic spatial dims (H, W) so the browser can feed
arbitrary input sizes (must be divisible by 16 due to 4 downsamples — caller
pads to multiple-of-16 and crops the result).
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from ml.model import TinyUNet


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--ckpt", required=True, help="PyTorch checkpoint path (best.pt)")
    p.add_argument("--out", required=True, help="Output ONNX path")
    p.add_argument("--opset", type=int, default=17)
    p.add_argument("--check", action="store_true", help="Run parity check vs PyTorch")
    args = p.parse_args()

    ckpt = torch.load(args.ckpt, map_location="cpu")
    model = TinyUNet()
    model.load_state_dict(ckpt["model"])
    model.eval()

    dummy = torch.randn(1, 3, 256, 256)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Use the legacy TorchScript-based exporter (dynamo=False) so weights stay
    # embedded in a SINGLE .onnx file. The new dynamo exporter splits weights
    # into a sidecar `.onnx.data` file, which is awkward for ORT-Web (caller
    # would have to fetch and pass both). For our 1.9M-param model the single
    # file is ~7.5 MB — fine for a browser bundle.
    torch.onnx.export(
        model,
        dummy,
        str(out_path),
        input_names=["input"],
        output_names=["logits"],
        opset_version=args.opset,
        dynamic_axes={
            "input": {0: "batch", 2: "height", 3: "width"},
            "logits": {0: "batch", 2: "height", 3: "width"},
        },
        dynamo=False,
    )
    print(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")

    if args.check:
        import onnxruntime as ort

        sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
        with torch.no_grad():
            ref = model(dummy).numpy()
        got = sess.run(None, {"input": dummy.numpy()})[0]
        diff = np.abs(ref - got).max()
        print(f"max abs diff (PyTorch vs ORT): {diff:.2e}")
        if diff > 1e-3:
            print("WARNING: large divergence; check for unsupported ops at opset", args.opset)


if __name__ == "__main__":
    main()
