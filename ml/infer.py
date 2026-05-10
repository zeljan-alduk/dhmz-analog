"""Run a trained TinyUNet on a single image and visualize the predicted mask.

Usage:
    python -m ml.infer --ckpt /tmp/dhmz-model/best.pt --image path/to/scan.png \
        --out /tmp/dhmz-pred.png

Outputs a 3-row composite:
    - top: input image
    - mid: predicted mask (white-on-black)
    - bot: input with predicted mask overlaid in cyan

For evaluation on a held-out synthetic set use --eval-dir to compute mean IoU
and Dice across all (img, mask) pairs in a directory.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
import torch

from ml.model import TinyUNet


# ─── Inference helpers ─────────────────────────────────────────────────────


def _pad_to_multiple(img: np.ndarray, k: int = 16) -> tuple[np.ndarray, tuple[int, int]]:
    """Pad img (H, W, C) on bottom/right so H, W are divisible by k. Return
    padded array and (pad_h, pad_w) — caller crops these off the prediction."""
    h, w = img.shape[:2]
    nh = ((h + k - 1) // k) * k
    nw = ((w + k - 1) // k) * k
    pad_h, pad_w = nh - h, nw - w
    if pad_h or pad_w:
        img = cv2.copyMakeBorder(
            img, 0, pad_h, 0, pad_w, cv2.BORDER_REPLICATE
        )
    return img, (pad_h, pad_w)


def predict_mask(
    model: torch.nn.Module,
    img_bgr: np.ndarray,
    device: torch.device,
    threshold: float = 0.5,
) -> np.ndarray:
    """Run model on a BGR image, return binary mask (uint8 0/255)."""
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    padded, (ph, pw) = _pad_to_multiple(rgb, k=16)
    x = torch.from_numpy(padded).permute(2, 0, 1).float().unsqueeze(0) / 255.0
    x = x.to(device)
    with torch.no_grad():
        logits = model(x)
        prob = torch.sigmoid(logits).squeeze().cpu().numpy()
    if ph or pw:
        prob = prob[: prob.shape[0] - ph, : prob.shape[1] - pw]
    mask = (prob > threshold).astype(np.uint8) * 255
    return mask


# ─── Metrics ───────────────────────────────────────────────────────────────


def iou_dice(pred: np.ndarray, gt: np.ndarray) -> tuple[float, float]:
    pred_b = pred > 127
    gt_b = gt > 127
    inter = np.logical_and(pred_b, gt_b).sum()
    union = np.logical_or(pred_b, gt_b).sum()
    iou = inter / union if union else 1.0
    denom = pred_b.sum() + gt_b.sum()
    dice = 2 * inter / denom if denom else 1.0
    return float(iou), float(dice)


def evaluate_dir(
    model: torch.nn.Module, eval_dir: Path, device: torch.device, n_max: int = 0
) -> dict:
    img_paths = sorted(eval_dir.glob("img_*.png"))
    ious, dices = [], []
    if n_max > 0:
        img_paths = img_paths[:n_max]
    for ip in img_paths:
        idx = ip.name.replace("img_", "").replace(".png", "")
        mp = eval_dir / f"mask_{idx}.png"
        if not mp.exists():
            continue
        img = cv2.imread(str(ip), cv2.IMREAD_COLOR)
        gt = cv2.imread(str(mp), cv2.IMREAD_GRAYSCALE)
        pred = predict_mask(model, img, device)
        iou, dice = iou_dice(pred, gt)
        ious.append(iou)
        dices.append(dice)
    return {
        "n": len(ious),
        "iou_mean": float(np.mean(ious)) if ious else 0.0,
        "iou_median": float(np.median(ious)) if ious else 0.0,
        "iou_min": float(np.min(ious)) if ious else 0.0,
        "iou_max": float(np.max(ious)) if ious else 0.0,
        "dice_mean": float(np.mean(dices)) if dices else 0.0,
        "dice_median": float(np.median(dices)) if dices else 0.0,
    }


# ─── Visualization ─────────────────────────────────────────────────────────


def make_visualization(img_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    mask3 = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
    overlay = img_bgr.copy()
    overlay[mask > 0] = [0, 255, 255]  # cyan in BGR
    return np.vstack([img_bgr, mask3, overlay])


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--ckpt", required=True)
    p.add_argument("--image", help="Single image to run inference on")
    p.add_argument("--out", help="Where to write the visualization")
    p.add_argument("--eval-dir", help="Directory with img_*.png + mask_*.png pairs")
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--device", default=None)
    args = p.parse_args()

    if args.device:
        device = torch.device(args.device)
    else:
        device = torch.device(
            "cuda"
            if torch.cuda.is_available()
            else (
                "mps"
                if hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
                else "cpu"
            )
        )

    ckpt = torch.load(args.ckpt, map_location=device, weights_only=False)
    model = TinyUNet().to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()
    print(f"loaded ckpt from epoch {ckpt.get('epoch', '?')} on {device}")

    if args.eval_dir:
        metrics = evaluate_dir(model, Path(args.eval_dir), device)
        print(f"eval ({metrics['n']} samples):")
        print(f"  IoU  mean={metrics['iou_mean']:.4f}  median={metrics['iou_median']:.4f}  "
              f"min={metrics['iou_min']:.4f}  max={metrics['iou_max']:.4f}")
        print(f"  Dice mean={metrics['dice_mean']:.4f}  median={metrics['dice_median']:.4f}")

    if args.image:
        img = cv2.imread(args.image, cv2.IMREAD_COLOR)
        if img is None:
            raise SystemExit(f"could not read {args.image}")
        mask = predict_mask(model, img, device, threshold=args.threshold)
        ink_pct = 100 * (mask > 0).mean()
        print(f"predicted mask: {int((mask > 0).sum())} px ({ink_pct:.2f}% of image)")
        if args.out:
            out_path = Path(args.out)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(out_path), make_visualization(img, mask))
            print(f"viz → {out_path}")


if __name__ == "__main__":
    main()
