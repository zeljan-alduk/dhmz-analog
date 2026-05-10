"""Train the trace segmenter on synthetic (image, mask) pairs.

Usage:
    # 1. Generate data
    python -m ml.synthetic \
        --reference /Users/aldo/Desktop/tracks/reference/barograf_reference.png \
        --out /tmp/dhmz-synth --n 500

    # 2. Train (CPU works for the tiny model; GPU is faster)
    python -m ml.train --data /tmp/dhmz-synth --out /tmp/dhmz-model --epochs 20

Outputs `best.pt` (PyTorch checkpoint) and `latest.pt` to `--out`.

Loss: BCE-with-logits + Dice. Dice helps with the heavy class imbalance
(trace pixels are <1 % of the image).
"""
from __future__ import annotations

import argparse
import math
import random
from pathlib import Path
from typing import Tuple

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset
from tqdm import tqdm

from ml.model import TinyUNet, count_params


# ─── Data ──────────────────────────────────────────────────────────────────


class SynthDataset(Dataset):
    def __init__(self, root: Path, crop: int = 384, train: bool = True) -> None:
        self.root = Path(root)
        self.imgs = sorted(self.root.glob("img_*.png"))
        self.masks = sorted(self.root.glob("mask_*.png"))
        if len(self.imgs) != len(self.masks):
            raise ValueError(
                f"img/mask count mismatch: {len(self.imgs)} vs {len(self.masks)}"
            )
        self.crop = crop
        self.train = train

    def __len__(self) -> int:
        return len(self.imgs)

    def __getitem__(self, i: int) -> Tuple[torch.Tensor, torch.Tensor]:
        img = cv2.imread(str(self.imgs[i]), cv2.IMREAD_COLOR)
        msk = cv2.imread(str(self.masks[i]), cv2.IMREAD_GRAYSCALE)
        if img is None or msk is None:
            raise RuntimeError(f"failed to read pair {i}")
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

        h, w = msk.shape
        if h < self.crop or w < self.crop:
            # Resize up if synthetic image is smaller than crop
            scale = self.crop / min(h, w)
            img = cv2.resize(img, (int(w * scale + 1), int(h * scale + 1)))
            msk = cv2.resize(
                msk,
                (int(w * scale + 1), int(h * scale + 1)),
                interpolation=cv2.INTER_NEAREST,
            )
            h, w = msk.shape

        if self.train:
            # Bias the crop toward regions that contain trace pixels: half
            # the time, anchor on a random mask pixel; half the time, fully
            # random. Without this bias, most crops on a thin trace are
            # all-zero and the model collapses to "predict 0".
            if random.random() < 0.5:
                ys, xs = np.where(msk > 0)
                if len(ys) > 0:
                    k = random.randint(0, len(ys) - 1)
                    cy, cx = ys[k], xs[k]
                    y0 = int(np.clip(cy - self.crop // 2, 0, h - self.crop))
                    x0 = int(np.clip(cx - self.crop // 2, 0, w - self.crop))
                else:
                    y0 = random.randint(0, h - self.crop)
                    x0 = random.randint(0, w - self.crop)
            else:
                y0 = random.randint(0, h - self.crop)
                x0 = random.randint(0, w - self.crop)
        else:
            y0 = (h - self.crop) // 2
            x0 = (w - self.crop) // 2

        img_c = img[y0 : y0 + self.crop, x0 : x0 + self.crop]
        msk_c = msk[y0 : y0 + self.crop, x0 : x0 + self.crop]

        # Train-time flips
        if self.train and random.random() < 0.5:
            img_c = np.ascontiguousarray(img_c[:, ::-1])
            msk_c = np.ascontiguousarray(msk_c[:, ::-1])
        if self.train and random.random() < 0.5:
            img_c = np.ascontiguousarray(img_c[::-1, :])
            msk_c = np.ascontiguousarray(msk_c[::-1, :])

        x = torch.from_numpy(img_c).permute(2, 0, 1).float() / 255.0
        y = torch.from_numpy((msk_c > 127).astype(np.float32))[None, ...]
        return x, y


# ─── Loss ──────────────────────────────────────────────────────────────────


def dice_loss(logits: torch.Tensor, target: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    p = torch.sigmoid(logits)
    p = p.flatten(1)
    t = target.flatten(1)
    inter = (p * t).sum(dim=1)
    denom = p.sum(dim=1) + t.sum(dim=1) + eps
    return 1.0 - (2 * inter + eps) / denom


def combined_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    bce = F.binary_cross_entropy_with_logits(logits, target)
    dl = dice_loss(logits, target).mean()
    return bce + dl


# ─── Loop ──────────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True, help="Synthetic-data dir from ml.synthetic")
    p.add_argument("--out", required=True, help="Checkpoint output dir")
    p.add_argument("--epochs", type=int, default=20)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--crop", type=int, default=384)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--val-frac", type=float, default=0.1)
    # Device priority: CUDA > MPS (Apple Silicon Metal) > CPU. MPS is the
    # right default on macOS arm64 — meaningfully faster than CPU for tiny
    # convs even on a small U-Net.
    default_device = (
        "cuda"
        if torch.cuda.is_available()
        else (
            "mps"
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
            else "cpu"
        )
    )
    p.add_argument("--device", default=default_device)
    args = p.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # Build two dataset instances over the same files but with different
    # `train` modes, then split by INDEX so train/val see disjoint files
    # while preserving the train-time augmentation flag per-side.
    train_full = SynthDataset(Path(args.data), crop=args.crop, train=True)
    val_full = SynthDataset(Path(args.data), crop=args.crop, train=False)
    n = len(train_full)
    n_val = max(1, int(n * args.val_frac))
    rng = torch.Generator().manual_seed(42)
    perm = torch.randperm(n, generator=rng).tolist()
    val_idx = perm[:n_val]
    train_idx = perm[n_val:]
    train_ds = torch.utils.data.Subset(train_full, train_idx)
    val_ds = torch.utils.data.Subset(val_full, val_idx)

    pin = args.device == "cuda"  # MPS / CPU don't benefit from pinned memory
    train_dl = DataLoader(
        train_ds, batch_size=args.batch, shuffle=True, num_workers=2, pin_memory=pin
    )
    val_dl = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=2)

    device = torch.device(args.device)
    model = TinyUNet().to(device)
    print(f"model params: {count_params(model):,}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)

    best_val = math.inf
    for epoch in range(args.epochs):
        model.train()
        loss_sum = 0.0
        n_batches = 0
        for x, y in tqdm(train_dl, desc=f"epoch {epoch + 1}/{args.epochs}"):
            x, y = x.to(device), y.to(device)
            logits = model(x)
            loss = combined_loss(logits, y)
            opt.zero_grad()
            loss.backward()
            opt.step()
            loss_sum += loss.item()
            n_batches += 1
        sched.step()
        train_loss = loss_sum / max(1, n_batches)

        # Validation
        model.eval()
        v_loss = 0.0
        n_v = 0
        with torch.no_grad():
            for x, y in val_dl:
                x, y = x.to(device), y.to(device)
                logits = model(x)
                v_loss += combined_loss(logits, y).item()
                n_v += 1
        val_loss = v_loss / max(1, n_v)
        print(f"  epoch {epoch + 1}: train={train_loss:.4f} val={val_loss:.4f}")

        torch.save({"model": model.state_dict(), "epoch": epoch}, out / "latest.pt")
        if val_loss < best_val:
            best_val = val_loss
            torch.save({"model": model.state_dict(), "epoch": epoch}, out / "best.pt")
            print(f"  ✓ saved best (val={val_loss:.4f})")

    print(f"\nDone. Best val loss = {best_val:.4f}")
    print(f"Checkpoints in {out}/")


if __name__ == "__main__":
    main()
