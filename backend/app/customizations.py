"""Customization share store — `/api/customizations`.

Standalone resource (not bound to a session): users save a customization
locally, then optionally upload it for a shareable short-id URL. Persisted
to disk under the same /data volume as sessions, in `customizations/<id>.json`.

Schema (matches the frontend `Customization` type):
    {
      "css": "<optional css string>",
      "slots": {
        "<slot-id>": {"name": "...", "jsx": "..."}
      }
    }

A POST returns `{id, expiresAt}`; the id is a 16-hex token used in the
share URL `?cv=<id>`. TTL is 30 days from upload. A short reaper task
sweeps expired entries.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path as _FsPath
from typing import Dict, Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

log = logging.getLogger("dhmz.customizations")

# 30 days.
CUSTOMIZATION_TTL_SEC = 30 * 24 * 60 * 60

# Hard cap so a malicious / careless caller can't fill the disk.
MAX_CUSTOMIZATION_BYTES = 256 * 1024  # 256 KB of JSON

# Mirrors sessions.DATA_DIR but in a sibling directory so cleanup logic
# can't accidentally cross-rmtree.
_DATA_DIR = (
    _FsPath(os.environ.get("DHMZ_DATA_DIR", "/data")) / "customizations"
)


def _path(cid: str) -> _FsPath:
    if not cid.isalnum() or len(cid) != 16:
        raise HTTPException(400, "invalid customization id format")
    return _DATA_DIR / f"{cid}.json"


def _atomic_write(path: _FsPath, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


# ─── Schemas ────────────────────────────────────────────────────────────
class SlotMountIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    jsx: str = Field(..., min_length=1, max_length=200_000)


class CustomizationIn(BaseModel):
    """Same shape as the frontend's `Customization` type."""
    css: Optional[str] = Field(default=None, max_length=200_000)
    slots: Optional[Dict[str, SlotMountIn]] = None
    # Optional human label saved alongside; helps the share recipient know
    # what they're importing.
    name: Optional[str] = Field(default=None, max_length=120)


class CustomizationCreated(BaseModel):
    id: str
    expiresAt: float


# ─── Persisted record ───────────────────────────────────────────────────
@dataclass
class CustomizationRecord:
    id: str
    created_at: float
    expires_at: float
    name: Optional[str] = None
    css: Optional[str] = None
    slots: Dict[str, dict] = field(default_factory=dict)

    def to_disk(self) -> dict:
        return {
            "id": self.id,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "name": self.name,
            "css": self.css,
            "slots": self.slots,
        }

    @classmethod
    def from_disk(cls, d: dict) -> "CustomizationRecord":
        return cls(
            id=d["id"],
            created_at=float(d["created_at"]),
            expires_at=float(d["expires_at"]),
            name=d.get("name"),
            css=d.get("css"),
            slots=dict(d.get("slots") or {}),
        )


# ─── Router ─────────────────────────────────────────────────────────────
router = APIRouter()


@router.post("/customizations", status_code=201, response_model=CustomizationCreated)
def create_customization(body: CustomizationIn) -> CustomizationCreated:
    cid = secrets.token_hex(8)  # 16 hex chars
    now = time.time()
    rec = CustomizationRecord(
        id=cid,
        created_at=now,
        expires_at=now + CUSTOMIZATION_TTL_SEC,
        name=body.name,
        css=body.css,
        slots={k: v.model_dump() for k, v in (body.slots or {}).items()},
    )
    payload = json.dumps(rec.to_disk(), indent=2).encode("utf-8")
    if len(payload) > MAX_CUSTOMIZATION_BYTES:
        raise HTTPException(
            413,
            f"customization too large ({len(payload)} > {MAX_CUSTOMIZATION_BYTES} bytes)",
        )
    _atomic_write(_path(cid), payload)
    log.info("customizations: created %s name=%r size=%d", cid, body.name, len(payload))
    return CustomizationCreated(id=cid, expiresAt=rec.expires_at)


@router.get("/customizations/{cid}")
def get_customization(cid: str) -> dict:
    p = _path(cid)
    if not p.exists():
        raise HTTPException(404, "customization not found or expired")
    try:
        rec = CustomizationRecord.from_disk(json.loads(p.read_bytes()))
    except Exception as e:
        log.error("customizations: read %s failed: %s", cid, e)
        raise HTTPException(500, "customization read failed")
    if rec.expires_at < time.time():
        try:
            p.unlink()
        except Exception:
            pass
        raise HTTPException(404, "customization not found or expired")
    return {
        "id": rec.id,
        "createdAt": rec.created_at,
        "expiresAt": rec.expires_at,
        "name": rec.name,
        "css": rec.css,
        "slots": rec.slots,
    }


@router.delete("/customizations/{cid}")
def delete_customization(cid: str) -> Response:
    p = _path(cid)
    if p.exists():
        try:
            p.unlink()
        except Exception as e:
            log.warning("customizations: rm %s failed: %s", cid, e)
    return Response(status_code=204)


# ─── Cleanup loop ───────────────────────────────────────────────────────
def _sweep_expired() -> int:
    """Remove expired files. Called periodically by the cleanup task."""
    if not _DATA_DIR.exists():
        return 0
    now = time.time()
    n = 0
    for p in _DATA_DIR.iterdir():
        if not p.is_file() or not p.name.endswith(".json"):
            continue
        try:
            rec = CustomizationRecord.from_disk(json.loads(p.read_bytes()))
        except Exception:
            # Malformed — drop it.
            try:
                p.unlink()
                n += 1
            except Exception:
                pass
            continue
        if rec.expires_at < now:
            try:
                p.unlink()
                n += 1
            except Exception:
                pass
    return n


async def cleanup_loop() -> None:
    """Sweep loop started from main.py at app startup. Runs hourly."""
    while True:
        try:
            await asyncio.sleep(3600)
            n = _sweep_expired()
            if n:
                log.info("customizations: cleaned %d expired", n)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # pragma: no cover
            log.warning("customizations cleanup loop error: %s", e)
