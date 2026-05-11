"""Session API — in-memory store + FastAPI router.

A session encapsulates one digitization workflow: a single chart scan, the
chart-type config, and the mutable state (rotation, calibration corners,
vectorized grid polylines, extracted data points, notes, chat, plus a
"projection surface" — annotations, ROIs, sidebar panels, scratch HTML —
that lets the operator (Claude) paint and write into the user's view).
Mutations bump a version counter so the frontend can long/short-poll
cheaply.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import secrets
import shutil
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path as _FsPath
from typing import Annotated, List, Literal, Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Path, Response
from PIL import Image
from pydantic import BaseModel, Field

from .extract import extract_trace as _extract_trace
from .geometry import (
    affine_to_3x3,
    compute_affine,
    invert_affine_3x3,
    value_to_chart,
)
from .schemas import (
    CalibrationPoint as ExtractCalibrationPoint,
    ChartConfig,
    ExtractTraceRequest,
)

log = logging.getLogger("dhmz.sessions")

# ─── Constants ────────────────────────────────────────────────────────────
SESSION_TTL_SEC = 48 * 60 * 60         # 48h
MAX_IMAGE_BYTES = 80 * 1024 * 1024     # 80 MB raw bytes (post-base64-decode)
MAX_NOTES = 100
PUBLIC_BASE_URL = "https://dhmz.aldo.tech"
MAX_CHAT_ATTACHMENT_BYTES = 5 * 1024 * 1024   # 5 MB per pasted/attached image
MAX_CHAT_ATTACHMENTS_PER_MSG = 4
CHAT_ATTACHMENT_MAX_EDGE = 2000
RESAMPLE_CACHE_PER_SESSION = 16
RESAMPLE_MAX_EDGE = 10000

ChartTypeKey = Literal["barograph", "hygrograph", "thermograph"]


# ─── In-memory state ──────────────────────────────────────────────────────
@dataclass
class CalibrationPointModel:
    imgX: float
    imgY: float
    chartX: float
    chartY: float


@dataclass
class VectorPolylineModel:
    points: List[List[float]]
    axis: Literal["horizontal", "vertical"]
    weight: Literal["major", "minor", "fine"]


@dataclass
class DataPointModel:
    day: int
    hour: float
    value: float
    canvasX: Optional[float] = None
    canvasY: Optional[float] = None
    source: Literal["claude", "user", "extract"] = "claude"


@dataclass
class SessionNote:
    ts: float
    text: str
    by: Literal["claude", "user", "system"] = "claude"


@dataclass
class ChatAttachment:
    id: str
    mime: str            # "image/png" | "image/jpeg"
    width: int
    height: int
    data: bytes


@dataclass
class ChatMessage:
    ts: float
    by: Literal["user", "claude"]
    text: str
    attachments: List[ChatAttachment] = field(default_factory=list)
    # `"reply"`  : standard message, full-size in the chat feed.
    # `"thinking"`: internal rationale — frontend renders dimmed/italic and
    #               collapses after a short preview. Use for "why I chose X
    #               over Y" without cluttering the user-facing transcript.
    kind: Literal["reply", "thinking"] = "reply"


@dataclass
class ScratchHTML:
    html: str = ""
    css: Optional[str] = None
    js: Optional[str] = None


@dataclass
class Session:
    id: str
    created_at: float
    expires_at: float
    image_bytes: bytes
    image_format: str            # "png" | "jpeg"
    image_natural_w: int
    image_natural_h: int
    chart_type: ChartTypeKey
    config: dict
    rotation_deg: float = 0.0
    calibration: List[CalibrationPointModel] = field(default_factory=list)
    polylines: List[VectorPolylineModel] = field(default_factory=list)
    data_points: List[DataPointModel] = field(default_factory=list)
    notes: List[SessionNote] = field(default_factory=list)
    chat_messages: List[ChatMessage] = field(default_factory=list)
    # Operator projection surface — Claude paints here, frontend renders.
    annotations: List[dict] = field(default_factory=list)
    rois: List[dict] = field(default_factory=list)
    panels: dict = field(default_factory=dict)              # name → markdown
    scratch_html: Optional[ScratchHTML] = None
    # Live UI customization: `{css?: str, slots?: {slot_id: {name, jsx}}}`.
    # Compiled in the browser via Sucrase + mounted into named host slots.
    # Persists with the session (so survives backend restart) and can be
    # saved/shared as a Customization record (see customizations.py).
    customization: dict = field(default_factory=dict)
    image_revision: int = 0      # increments every image swap
    version: int = 0
    # Cache of resampled image variants keyed by (rev, max, box, fmt).
    # Cleared on image swap. Bounded by RESAMPLE_CACHE_PER_SESSION.
    image_cache: dict = field(default_factory=dict)

    def bump(self, note_text: Optional[str] = None,
             by: Literal["claude", "user", "system"] = "claude") -> None:
        self.version += 1
        if note_text:
            self.notes.append(SessionNote(time.time(), note_text, by))
            if len(self.notes) > MAX_NOTES:
                self.notes = self.notes[-MAX_NOTES:]
        _persist_session(self)

    def is_expired(self) -> bool:
        return time.time() > self.expires_at


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = threading.RLock()

    def create(
        self,
        image_bytes: bytes,
        image_format: str,
        chart_type: ChartTypeKey,
        config: dict,
        natural_w: int,
        natural_h: int,
    ) -> Session:
        sid = secrets.token_hex(8)  # 16 hex chars
        now = time.time()
        s = Session(
            id=sid,
            created_at=now,
            expires_at=now + SESSION_TTL_SEC,
            image_bytes=image_bytes,
            image_format=image_format,
            image_natural_w=natural_w,
            image_natural_h=natural_h,
            chart_type=chart_type,
            config=config,
        )
        s.notes.append(SessionNote(
            now,
            f"Session created. Chart: {chart_type}, image {natural_w}×{natural_h}.",
            "system",
        ))
        with self._lock:
            self._sessions[sid] = s
        # Persist immediately so the session survives a restart even before
        # the first mutation lands. `bump()` will keep state.json refreshed
        # afterwards.
        _persist_session(s)
        return s

    def get(self, sid: str) -> Optional[Session]:
        with self._lock:
            s = self._sessions.get(sid)
            if s is None:
                return None
            if s.is_expired():
                del self._sessions[sid]
                return None
            return s

    def cleanup_expired(self) -> int:
        with self._lock:
            expired = [sid for sid, s in self._sessions.items() if s.is_expired()]
            for sid in expired:
                del self._sessions[sid]
                _rm_session_dir(sid)
            return len(expired)


STORE = SessionStore()


async def cleanup_loop() -> None:
    """Background sweeper started by main.py at app startup."""
    while True:
        try:
            await asyncio.sleep(300)
            n = STORE.cleanup_expired()
            if n:
                log.info("sessions: cleaned %d expired", n)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # pragma: no cover
            log.warning("sessions cleanup loop error: %s", e)


# ─── Pydantic request / response models ───────────────────────────────────
class CreateSessionRequest(BaseModel):
    imageBase64: str
    chartType: ChartTypeKey
    config: ChartConfig


class CreateSessionResponse(BaseModel):
    id: str
    url: str
    expiresAt: float
    claudeUrl: str


class CalibrationCornerIn(BaseModel):
    imgX: float
    imgY: float
    chartX: float
    chartY: float


class CalibrationIn(BaseModel):
    corners: List[CalibrationCornerIn] = Field(..., min_length=3)


class RotationIn(BaseModel):
    deg: float


class PolylineIn(BaseModel):
    points: List[List[float]]
    axis: Literal["horizontal", "vertical"]
    weight: Literal["major", "minor", "fine"]


class PolylinesIn(BaseModel):
    polylines: List[PolylineIn]


class VersionResponse(BaseModel):
    version: int


class PollResponse(BaseModel):
    version: int
    expiresAt: float


# Annotation: permissive shape. Geometry fields are interpreted by `type`:
#   stroke / line / arrow / polyline → `points: [[x,y],...]`
#   circle  → `cx, cy, r`
#   rect    → `x, y, w, h`
#   text    → `x, y, text` (+ optional fontSize)
ANNOTATION_TYPES = {"stroke", "line", "circle", "rect", "text", "arrow", "polyline"}


class AnnotationIn(BaseModel):
    type: Literal["stroke", "line", "circle", "rect", "text", "arrow", "polyline"]
    points: Optional[List[List[float]]] = None
    cx: Optional[float] = None
    cy: Optional[float] = None
    r: Optional[float] = None
    x: Optional[float] = None
    y: Optional[float] = None
    w: Optional[float] = None
    h: Optional[float] = None
    text: Optional[str] = None
    fontSize: Optional[float] = None
    stroke: Optional[str] = None
    fill: Optional[str] = None
    strokeWidth: Optional[float] = None
    label: Optional[str] = None


class AnnotationsBulkIn(BaseModel):
    annotations: List[AnnotationIn]


class ROIIn(BaseModel):
    x: float
    y: float
    w: float
    h: float
    label: Optional[str] = None
    color: Optional[str] = None


class PanelIn(BaseModel):
    markdown: str


class ScratchHTMLIn(BaseModel):
    html: str
    css: Optional[str] = None
    js: Optional[str] = None


class ImageSwapIn(BaseModel):
    imageBase64: str
    note: Optional[str] = None


# ─── Helpers ──────────────────────────────────────────────────────────────
def _decode_image_b64(image_b64: str) -> tuple[bytes, str, int, int]:
    """Decode → (bytes, format, w, h). Raises HTTPException on failure."""
    if not image_b64:
        raise HTTPException(400, "imageBase64 is required")
    # Tolerate optional `data:image/...;base64,` prefix.
    if "," in image_b64[:64]:
        image_b64 = image_b64.split(",", 1)[1]
    try:
        raw = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "imageBase64 is not valid base64")
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(413, f"image too large (limit {MAX_IMAGE_BYTES} bytes)")
    if not raw:
        raise HTTPException(400, "image is empty")
    try:
        with Image.open(BytesIO(raw)) as im:
            im.load()
            fmt = (im.format or "").lower()
            w, h = im.size
    except Exception as e:
        raise HTTPException(415, f"unsupported image format: {e}")
    if fmt == "jpg":
        fmt = "jpeg"
    if fmt not in ("png", "jpeg"):
        raise HTTPException(415, f"unsupported image format: {fmt}")
    return raw, fmt, int(w), int(h)


def _validate_calibration(corners: List[CalibrationCornerIn]) -> List[CalibrationPointModel]:
    if len(corners) < 3:
        raise HTTPException(400, "need ≥3 calibration corners")
    points = [
        CalibrationPointModel(c.imgX, c.imgY, c.chartX, c.chartY) for c in corners
    ]
    # Distinct image positions.
    img_xy = np.array([[p.imgX, p.imgY] for p in points], dtype=np.float64)
    if np.unique(img_xy, axis=0).shape[0] < 3:
        raise HTTPException(400, "calibration corners must be distinct in image space")
    # Non-collinear in image space: design matrix [x, y, 1] must be full-rank
    # (rank 3) for the affine to be well-determined. lstsq otherwise silently
    # returns a rank-deficient pseudo-inverse solution.
    design = np.column_stack([img_xy, np.ones(len(points))])
    if np.linalg.matrix_rank(design, tol=1e-6) < 3:
        raise HTTPException(400, "calibration corners are collinear in image space")
    # Sanity: try the actual solver too.
    try:
        compute_affine(points)
    except Exception as e:
        raise HTTPException(400, f"calibration is degenerate: {e}")
    return points


def _serialize_state(s: Session) -> dict:
    return {
        "id": s.id,
        "createdAt": s.created_at,
        "expiresAt": s.expires_at,
        "version": s.version,
        "chartType": s.chart_type,
        "config": s.config,
        "imageNaturalSize": [s.image_natural_w, s.image_natural_h],
        "imageUrl": f"/api/sessions/{s.id}/image",
        "imageRevision": s.image_revision,
        "rotationDeg": s.rotation_deg,
        "calibration": [
            {"imgX": p.imgX, "imgY": p.imgY, "chartX": p.chartX, "chartY": p.chartY}
            for p in s.calibration
        ],
        "polylines": [
            {"points": p.points, "axis": p.axis, "weight": p.weight}
            for p in s.polylines
        ],
        "dataPoints": [
            {
                "day": d.day, "hour": d.hour, "value": d.value,
                "canvasX": d.canvasX, "canvasY": d.canvasY, "source": d.source,
            }
            for d in s.data_points
        ],
        "notes": [
            {"ts": n.ts, "text": n.text, "by": n.by} for n in s.notes
        ],
        "chatMessages": [
            _serialize_chat_message(s, m) for m in s.chat_messages
        ],
        "annotations": list(s.annotations),
        "rois": list(s.rois),
        "panels": dict(s.panels),
        "scratchHtml": (
            {"html": s.scratch_html.html, "css": s.scratch_html.css, "js": s.scratch_html.js}
            if s.scratch_html is not None else None
        ),
        "customization": dict(s.customization) if s.customization else {},
    }


def _require(sid: str) -> Session:
    s = STORE.get(sid)
    if s is None:
        raise HTTPException(404, "session not found or expired")
    return s


# ─── Disk persistence ───────────────────────────────────────────────────
# Sessions survive backend restart / redeploy by writing state to a host
# volume. One subdirectory per session id contains:
#   state.json           — everything except image and attachment bytes
#   image_<rev>.<fmt>    — original scan, one file per image_revision
#   attach/<aid>.<ext>   — chat-attachment payloads
# Atomic via tmp-write + rename. Per-session writes are guarded by
# SessionStore's RLock indirectly (mutations hold no lock, but only one
# uvicorn worker runs — see docker-compose --workers 1).

DATA_DIR = _FsPath(os.environ.get("DHMZ_DATA_DIR", "/data")) / "sessions"


def _ext_for_mime(mime: str) -> str:
    return "jpg" if "jpeg" in (mime or "") else "png"


def _session_dir(sid: str) -> _FsPath:
    return DATA_DIR / sid


def _atomic_write(path: _FsPath, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _serialize_session_for_disk(s: "Session") -> dict:
    """JSON-shape for state.json — everything except raw image / attachment bytes."""
    return {
        "id": s.id,
        "created_at": s.created_at,
        "expires_at": s.expires_at,
        "chart_type": s.chart_type,
        "config": s.config,
        "rotation_deg": s.rotation_deg,
        "image_format": s.image_format,
        "image_natural_w": s.image_natural_w,
        "image_natural_h": s.image_natural_h,
        "image_revision": s.image_revision,
        "version": s.version,
        "calibration": [
            {"imgX": p.imgX, "imgY": p.imgY, "chartX": p.chartX, "chartY": p.chartY}
            for p in s.calibration
        ],
        "polylines": [
            {"points": p.points, "axis": p.axis, "weight": p.weight}
            for p in s.polylines
        ],
        "data_points": [
            {
                "day": p.day, "hour": p.hour, "value": p.value,
                "canvasX": p.canvasX, "canvasY": p.canvasY,
                "source": p.source,
            }
            for p in s.data_points
        ],
        "annotations": list(s.annotations),
        "rois": list(s.rois),
        "panels": dict(s.panels),
        "scratch_html": (
            {"html": s.scratch_html.html,
             "css": s.scratch_html.css,
             "js": s.scratch_html.js}
            if s.scratch_html else None
        ),
        "customization": dict(s.customization) if s.customization else {},
        "notes": [{"ts": n.ts, "text": n.text, "by": n.by} for n in s.notes],
        "chat_messages": [
            {
                "ts": m.ts,
                "by": m.by,
                "text": m.text,
                "kind": m.kind,
                "attachments": [
                    {"id": a.id, "mime": a.mime, "width": a.width, "height": a.height}
                    for a in m.attachments
                ],
            }
            for m in s.chat_messages
        ],
    }


def _persist_session(s: "Session") -> None:
    """Write a session to disk. Called from Session.bump() after every
    state-changing endpoint. Idempotent for image / attachment files
    (writes only if missing). Errors are logged, never raised — a
    persistence failure must not break the live request.
    """
    try:
        d = _session_dir(s.id)
        d.mkdir(parents=True, exist_ok=True)
        # Image bytes for current revision (write once per revision).
        img_path = d / f"image_{s.image_revision}.{s.image_format}"
        if not img_path.exists():
            _atomic_write(img_path, s.image_bytes)
        # Chat attachments — only the missing ones (existence check is cheap).
        for m in s.chat_messages:
            for a in m.attachments:
                ap = d / "attach" / f"{a.id}.{_ext_for_mime(a.mime)}"
                if not ap.exists():
                    _atomic_write(ap, a.data)
        # State — always rewrite.
        payload = json.dumps(_serialize_session_for_disk(s), indent=2, default=str)
        _atomic_write(d / "state.json", payload.encode("utf-8"))
    except Exception as e:
        log.error("persist failed sid=%s: %s", s.id, e, exc_info=True)


def _load_session_from_disk(d: _FsPath) -> Optional["Session"]:
    """Read one session directory back into a Session object. Returns
    None for expired or malformed entries (caller is expected to rmtree)."""
    try:
        state = json.loads((d / "state.json").read_bytes())
        if float(state.get("expires_at", 0)) < time.time():
            return None
        fmt = state["image_format"]
        rev = int(state.get("image_revision", 0))
        img_bytes = (d / f"image_{rev}.{fmt}").read_bytes()
        s = Session(
            id=state["id"],
            created_at=float(state["created_at"]),
            expires_at=float(state["expires_at"]),
            chart_type=state["chart_type"],
            config=state["config"],
            image_bytes=img_bytes,
            image_format=fmt,
            image_natural_w=int(state["image_natural_w"]),
            image_natural_h=int(state["image_natural_h"]),
            image_revision=rev,
            rotation_deg=float(state.get("rotation_deg", 0.0)),
            version=int(state.get("version", 0)),
        )
        s.calibration = [
            CalibrationPointModel(
                imgX=c["imgX"], imgY=c["imgY"],
                chartX=c["chartX"], chartY=c["chartY"],
            )
            for c in state.get("calibration", [])
        ]
        s.polylines = [
            VectorPolylineModel(
                points=p["points"], axis=p["axis"], weight=p["weight"],
            )
            for p in state.get("polylines", [])
        ]
        s.data_points = [
            DataPointModel(
                day=int(p["day"]), hour=float(p["hour"]), value=float(p["value"]),
                canvasX=p.get("canvasX"), canvasY=p.get("canvasY"),
                source=p["source"],
            )
            for p in state.get("data_points", [])
        ]
        s.annotations = list(state.get("annotations", []))
        s.rois = list(state.get("rois", []))
        s.panels = dict(state.get("panels", {}))
        sh = state.get("scratch_html")
        s.scratch_html = (
            ScratchHTML(html=sh["html"], css=sh.get("css"), js=sh.get("js"))
            if sh else None
        )
        s.notes = [
            SessionNote(ts=float(n["ts"]), text=n["text"], by=n["by"])
            for n in state.get("notes", [])
        ]
        s.customization = dict(state.get("customization") or {})
        chat_msgs: List[ChatMessage] = []
        for m in state.get("chat_messages", []):
            atts: List[ChatAttachment] = []
            for am in m.get("attachments", []):
                ap = d / "attach" / f"{am['id']}.{_ext_for_mime(am['mime'])}"
                if ap.exists():
                    atts.append(ChatAttachment(
                        id=am["id"], mime=am["mime"],
                        width=int(am["width"]), height=int(am["height"]),
                        data=ap.read_bytes(),
                    ))
            chat_msgs.append(ChatMessage(
                ts=float(m["ts"]), by=m["by"], text=m["text"],
                attachments=atts,
                kind=m.get("kind", "reply"),
            ))
        s.chat_messages = chat_msgs
        return s
    except Exception as e:
        log.error("load failed dir=%s: %s", d, e, exc_info=True)
        return None


def load_all_sessions() -> int:
    """Walk DATA_DIR at startup, populate STORE with non-expired sessions,
    rmtree the rest. Returns count loaded."""
    if not DATA_DIR.exists():
        log.info("sessions: no data dir at %s — starting fresh", DATA_DIR)
        return 0
    loaded = 0
    for d in DATA_DIR.iterdir():
        if not d.is_dir():
            continue
        s = _load_session_from_disk(d)
        if s is None:
            try:
                shutil.rmtree(d)
                log.info("sessions: removed expired/malformed %s", d.name)
            except Exception as e:
                log.warning("could not rm %s: %s", d, e)
            continue
        STORE._sessions[s.id] = s  # bypass create()/lock — startup is single-threaded
        loaded += 1
    log.info("sessions: loaded %d from %s", loaded, DATA_DIR)
    return loaded


def _rm_session_dir(sid: str) -> None:
    try:
        d = _session_dir(sid)
        if d.exists():
            shutil.rmtree(d)
    except Exception as e:
        log.warning("rm session dir failed sid=%s: %s", sid, e)


# ─── Image resample / chat-attachment helpers ───────────────────────────
def _parse_box(box: Optional[str]) -> Optional[tuple[int, int, int, int]]:
    if not box:
        return None
    try:
        parts = [int(p) for p in box.split(",")]
    except ValueError:
        raise HTTPException(400, "box must be 'x,y,w,h' integers")
    if len(parts) != 4:
        raise HTTPException(400, "box must have 4 integers x,y,w,h")
    x, y, w, h = parts
    if w <= 0 or h <= 0:
        raise HTTPException(400, "box w/h must be > 0")
    return (x, y, w, h)


def _resample_image_bytes(
    src: bytes,
    max_edge: int,
    box: Optional[tuple[int, int, int, int]],
    fmt: str,
) -> bytes:
    with Image.open(BytesIO(src)) as im:
        im.load()
        if box is not None:
            x, y, w, h = box
            x = max(0, min(x, im.width))
            y = max(0, min(y, im.height))
            w = max(1, min(w, im.width - x))
            h = max(1, min(h, im.height - y))
            im = im.crop((x, y, x + w, y + h))
        if max_edge > 0 and max(im.size) > max_edge:
            scale = max_edge / max(im.size)
            new_w = max(1, round(im.width * scale))
            new_h = max(1, round(im.height * scale))
            im = im.resize((new_w, new_h), Image.LANCZOS)
        buf = BytesIO()
        if fmt == "jpeg":
            if im.mode != "RGB":
                im = im.convert("RGB")
            im.save(buf, format="JPEG", quality=88, optimize=True)
        else:
            im.save(buf, format="PNG", optimize=True)
        return buf.getvalue()


def _process_chat_attachments(
    images_b64: Optional[List[str]],
) -> List[ChatAttachment]:
    if not images_b64:
        return []
    if len(images_b64) > MAX_CHAT_ATTACHMENTS_PER_MSG:
        raise HTTPException(
            400,
            f"max {MAX_CHAT_ATTACHMENTS_PER_MSG} attachments per chat message",
        )
    out: List[ChatAttachment] = []
    for b64 in images_b64:
        if "," in b64[:64]:
            b64 = b64.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(400, "attachment is not valid base64")
        if len(raw) > MAX_CHAT_ATTACHMENT_BYTES:
            raise HTTPException(
                413,
                f"attachment too large (limit {MAX_CHAT_ATTACHMENT_BYTES} bytes)",
            )
        if not raw:
            raise HTTPException(400, "attachment is empty")
        try:
            with Image.open(BytesIO(raw)) as im:
                im.load()
                fmt = (im.format or "").lower()
                w, h = im.size
        except Exception as e:
            raise HTTPException(415, f"unsupported attachment format: {e}")
        if fmt == "jpg":
            fmt = "jpeg"
        if fmt not in ("png", "jpeg"):
            raise HTTPException(
                415, f"unsupported attachment format: {fmt}"
            )
        # Resample down if too large; keep original mime when possible.
        if max(w, h) > CHAT_ATTACHMENT_MAX_EDGE:
            raw = _resample_image_bytes(
                raw, CHAT_ATTACHMENT_MAX_EDGE, None, fmt
            )
            with Image.open(BytesIO(raw)) as im2:
                w, h = im2.size
        out.append(ChatAttachment(
            id=secrets.token_hex(6),
            mime="image/png" if fmt == "png" else "image/jpeg",
            width=int(w),
            height=int(h),
            data=raw,
        ))
    return out


def _serialize_chat_message(s: Session, m: ChatMessage) -> dict:
    return {
        "ts": m.ts,
        "by": m.by,
        "text": m.text,
        "kind": m.kind,
        "attachments": [
            {
                "id": a.id,
                "mime": a.mime,
                "width": a.width,
                "height": a.height,
                "url": f"/api/sessions/{s.id}/chat-attachments/{a.id}",
            }
            for a in m.attachments
        ],
    }


# ─── Router ───────────────────────────────────────────────────────────────
router = APIRouter()


@router.post("/sessions", status_code=201, response_model=CreateSessionResponse)
def create_session(req: CreateSessionRequest) -> CreateSessionResponse:
    raw, fmt, w, h = _decode_image_b64(req.imageBase64)
    s = STORE.create(
        image_bytes=raw,
        image_format=fmt,
        chart_type=req.chartType,
        config=req.config.model_dump(),
        natural_w=w,
        natural_h=h,
    )
    log.info("sessions: created %s chart=%s %dx%d", s.id, s.chart_type, w, h)
    return CreateSessionResponse(
        id=s.id,
        url=f"{PUBLIC_BASE_URL}/session/?id={s.id}",
        expiresAt=s.expires_at,
        claudeUrl=f"{PUBLIC_BASE_URL}/api/sessions/{s.id}/context",
    )


@router.get("/sessions/{sid}")
def get_session(sid: str = Path(..., min_length=4, max_length=64)) -> dict:
    s = _require(sid)
    return _serialize_state(s)


@router.get("/sessions/{sid}/poll", response_model=PollResponse)
def poll_session(sid: str) -> PollResponse:
    s = _require(sid)
    return PollResponse(version=s.version, expiresAt=s.expires_at)


@router.get("/sessions/{sid}/image")
def get_session_image(
    sid: str,
    max: int = 0,
    box: Optional[str] = None,
    fmt: Optional[str] = None,
) -> Response:
    """Serve session scan.

    Without query params returns the original bytes (operators relying on
    full resolution are unaffected). With `max`, `box`, or `fmt` set, the
    server resamples and caches up to RESAMPLE_CACHE_PER_SESSION variants
    per session. Cache is keyed by image revision and cleared on swap.
    """
    s = _require(sid)
    box_tuple = _parse_box(box)
    if max < 0 or max > RESAMPLE_MAX_EDGE:
        raise HTTPException(400, f"max must be 0..{RESAMPLE_MAX_EDGE}")
    out_fmt = (fmt or "").lower()
    if out_fmt and out_fmt not in ("png", "jpeg"):
        raise HTTPException(400, "fmt must be 'png' or 'jpeg'")

    # Pass-through: original bytes when no resample requested.
    if max == 0 and box_tuple is None and not out_fmt:
        media_type = "image/png" if s.image_format == "png" else "image/jpeg"
        return Response(
            content=s.image_bytes,
            media_type=media_type,
            headers={"Cache-Control": "private, max-age=3600"},
        )

    if not out_fmt:
        out_fmt = s.image_format

    cache_key = (s.image_revision, max, box_tuple, out_fmt)
    cached = s.image_cache.get(cache_key)
    if cached is None:
        try:
            cached = _resample_image_bytes(
                s.image_bytes, max, box_tuple, out_fmt
            )
        except Exception as e:
            log.error("resample failed sid=%s key=%s: %s", sid, cache_key, e)
            raise HTTPException(500, f"resample failed: {e}")
        if len(s.image_cache) >= RESAMPLE_CACHE_PER_SESSION:
            # Evict oldest (insertion order in py3.7+).
            first = next(iter(s.image_cache))
            del s.image_cache[first]
        s.image_cache[cache_key] = cached

    media_type = "image/jpeg" if out_fmt == "jpeg" else "image/png"
    etag = (
        f'W/"r{s.image_revision}-m{max}-b{box_tuple}-f{out_fmt}-{len(cached)}"'
    )
    return Response(
        content=cached,
        media_type=media_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "ETag": etag,
        },
    )


@router.put("/sessions/{sid}/rotation", response_model=VersionResponse)
def put_rotation(sid: str, body: RotationIn) -> VersionResponse:
    s = _require(sid)
    deg = float(body.deg)
    # Normalize to (-180, 180]
    deg = ((deg + 180.0) % 360.0) - 180.0
    if deg <= -180.0:
        deg += 360.0
    s.rotation_deg = deg
    s.bump(f"Rotation set to {deg:.2f}° by claude.", by="claude")
    log.info("sessions: %s rotation=%.2f° version=%d", sid, deg, s.version)
    return VersionResponse(version=s.version)


@router.put("/sessions/{sid}/calibration", response_model=VersionResponse)
def put_calibration(sid: str, body: CalibrationIn) -> VersionResponse:
    s = _require(sid)
    points = _validate_calibration(body.corners)
    s.calibration = points
    s.bump(
        f"Calibration set with {len(points)} corners by claude.",
        by="claude",
    )
    log.info("sessions: %s calibration=%d version=%d", sid, len(points), s.version)
    return VersionResponse(version=s.version)


@router.put("/sessions/{sid}/polylines")
def put_polylines(sid: str, body: PolylinesIn) -> dict:
    s = _require(sid)
    s.polylines = [
        VectorPolylineModel(points=p.points, axis=p.axis, weight=p.weight)
        for p in body.polylines
    ]
    s.bump(
        f"Vectorized {len(s.polylines)} grid polylines by claude.",
        by="claude",
    )
    log.info("sessions: %s polylines=%d version=%d", sid, len(s.polylines), s.version)
    return {"version": s.version, "count": len(s.polylines)}


# ─── Image swap ──────────────────────────────────────────────────────────
@router.post("/sessions/{sid}/image", response_model=VersionResponse)
def post_session_image(sid: str, body: ImageSwapIn) -> VersionResponse:
    s = _require(sid)
    raw, fmt, w, h = _decode_image_b64(body.imageBase64)
    s.image_bytes = raw
    s.image_format = fmt
    s.image_natural_w = w
    s.image_natural_h = h
    s.image_revision += 1
    s.image_cache.clear()
    note = body.note or f"Image replaced ({w}×{h}, rev {s.image_revision})."
    s.bump(note, by="claude")
    log.info("sessions: %s image swapped %dx%d rev=%d", sid, w, h, s.image_revision)
    return VersionResponse(version=s.version)


# ─── Annotations ─────────────────────────────────────────────────────────
def _validate_annotation(a: AnnotationIn) -> dict:
    """Type-check geometry per annotation kind. Returns a stored dict."""
    t = a.type
    out: dict = {"id": secrets.token_hex(4), "type": t}
    if t in ("stroke", "polyline", "line", "arrow"):
        if not a.points or not isinstance(a.points, list):
            raise HTTPException(400, f"{t} annotation requires `points`")
        min_pts = 1 if t == "stroke" else 2
        if len(a.points) < min_pts:
            raise HTTPException(400, f"{t} annotation needs ≥{min_pts} points")
        for p in a.points:
            if not isinstance(p, list) or len(p) != 2:
                raise HTTPException(400, "each point must be [x, y]")
        out["points"] = [[float(x), float(y)] for x, y in a.points]
    elif t == "circle":
        if a.cx is None or a.cy is None or a.r is None:
            raise HTTPException(400, "circle requires cx, cy, r")
        if a.r <= 0:
            raise HTTPException(400, "circle radius must be > 0")
        out["cx"], out["cy"], out["r"] = float(a.cx), float(a.cy), float(a.r)
    elif t == "rect":
        if a.x is None or a.y is None or a.w is None or a.h is None:
            raise HTTPException(400, "rect requires x, y, w, h")
        if a.w <= 0 or a.h <= 0:
            raise HTTPException(400, "rect w/h must be > 0")
        out["x"], out["y"], out["w"], out["h"] = float(a.x), float(a.y), float(a.w), float(a.h)
    elif t == "text":
        if a.x is None or a.y is None or not a.text:
            raise HTTPException(400, "text requires x, y, text")
        out["x"], out["y"], out["text"] = float(a.x), float(a.y), str(a.text)
        if a.fontSize is not None:
            out["fontSize"] = float(a.fontSize)
    # Style passthrough
    for k in ("stroke", "fill", "label"):
        v = getattr(a, k)
        if v is not None:
            out[k] = v
    if a.strokeWidth is not None:
        out["strokeWidth"] = float(a.strokeWidth)
    return out


@router.post("/sessions/{sid}/annotations", status_code=201)
def post_annotation(sid: str, body: AnnotationIn) -> dict:
    s = _require(sid)
    stored = _validate_annotation(body)
    s.annotations.append(stored)
    s.bump(f"Added {body.type} annotation by claude.", by="claude")
    log.info("sessions: %s annotation +%s id=%s version=%d",
             sid, body.type, stored["id"], s.version)
    return {"version": s.version, "id": stored["id"]}


@router.put("/sessions/{sid}/annotations", response_model=VersionResponse)
def put_annotations_bulk(sid: str, body: AnnotationsBulkIn) -> VersionResponse:
    s = _require(sid)
    s.annotations = [_validate_annotation(a) for a in body.annotations]
    s.bump(f"Replaced annotations layer with {len(s.annotations)} items.", by="claude")
    log.info("sessions: %s annotations replaced n=%d version=%d",
             sid, len(s.annotations), s.version)
    return VersionResponse(version=s.version)


@router.delete("/sessions/{sid}/annotations", response_model=VersionResponse)
def delete_annotations_all(sid: str) -> VersionResponse:
    s = _require(sid)
    n = len(s.annotations)
    s.annotations = []
    s.bump(f"Cleared {n} annotations.", by="claude")
    return VersionResponse(version=s.version)


@router.delete("/sessions/{sid}/annotations/{aid}", response_model=VersionResponse)
def delete_annotation(sid: str, aid: str) -> VersionResponse:
    s = _require(sid)
    before = len(s.annotations)
    s.annotations = [a for a in s.annotations if a.get("id") != aid]
    if len(s.annotations) == before:
        raise HTTPException(404, "annotation not found")
    s.bump(f"Removed annotation {aid}.", by="claude")
    return VersionResponse(version=s.version)


# ─── ROIs ────────────────────────────────────────────────────────────────
@router.post("/sessions/{sid}/rois", status_code=201)
def post_roi(sid: str, body: ROIIn) -> dict:
    s = _require(sid)
    if body.w <= 0 or body.h <= 0:
        raise HTTPException(400, "ROI w/h must be > 0")
    rid = secrets.token_hex(4)
    roi = {
        "id": rid,
        "x": float(body.x), "y": float(body.y),
        "w": float(body.w), "h": float(body.h),
    }
    if body.label is not None:
        roi["label"] = body.label
    if body.color is not None:
        roi["color"] = body.color
    s.rois.append(roi)
    s.bump(f"Added ROI {rid}{(' '+body.label) if body.label else ''}.", by="claude")
    return {"version": s.version, "id": rid}


@router.delete("/sessions/{sid}/rois", response_model=VersionResponse)
def delete_rois_all(sid: str) -> VersionResponse:
    s = _require(sid)
    n = len(s.rois)
    s.rois = []
    s.bump(f"Cleared {n} ROIs.", by="claude")
    return VersionResponse(version=s.version)


@router.delete("/sessions/{sid}/rois/{rid}", response_model=VersionResponse)
def delete_roi(sid: str, rid: str) -> VersionResponse:
    s = _require(sid)
    before = len(s.rois)
    s.rois = [r for r in s.rois if r.get("id") != rid]
    if len(s.rois) == before:
        raise HTTPException(404, "ROI not found")
    s.bump(f"Removed ROI {rid}.", by="claude")
    return VersionResponse(version=s.version)


# ─── Panels (named markdown blocks in sidebar) ───────────────────────────
_PANEL_NAME_PATTERN = "^[A-Za-z0-9._-]{1,64}$"


PanelName = Annotated[
    str, Path(min_length=1, max_length=64, pattern=_PANEL_NAME_PATTERN)
]


@router.put("/sessions/{sid}/panels/{name}", response_model=VersionResponse)
def put_panel(sid: str, name: PanelName, body: PanelIn) -> VersionResponse:
    s = _require(sid)
    s.panels[name] = body.markdown
    s.bump(f"Updated panel `{name}`.", by="claude")
    return VersionResponse(version=s.version)


@router.delete("/sessions/{sid}/panels/{name}", response_model=VersionResponse)
def delete_panel(sid: str, name: PanelName) -> VersionResponse:
    s = _require(sid)
    if name not in s.panels:
        raise HTTPException(404, "panel not found")
    del s.panels[name]
    s.bump(f"Removed panel `{name}`.", by="claude")
    return VersionResponse(version=s.version)


# ─── Scratch HTML iframe ─────────────────────────────────────────────────
@router.put("/sessions/{sid}/scratch-html", response_model=VersionResponse)
def put_scratch_html(sid: str, body: ScratchHTMLIn) -> VersionResponse:
    s = _require(sid)
    s.scratch_html = ScratchHTML(html=body.html, css=body.css, js=body.js)
    s.bump(
        f"Set scratch-HTML ({len(body.html)} chars html"
        f"{', +css' if body.css else ''}{', +js' if body.js else ''}).",
        by="claude",
    )
    log.info("sessions: %s scratch-html set version=%d", sid, s.version)
    return VersionResponse(version=s.version)


@router.delete("/sessions/{sid}/scratch-html", response_model=VersionResponse)
def delete_scratch_html(sid: str) -> VersionResponse:
    s = _require(sid)
    if s.scratch_html is None:
        raise HTTPException(404, "scratch-html not set")
    s.scratch_html = None
    s.bump("Cleared scratch-HTML.", by="claude")
    return VersionResponse(version=s.version)


# ─── Live UI customization on a session ────────────────────────────────
ALLOWED_SLOT_IDS = frozenset({"toolbar-extra", "sidebar-extra", "overlay", "route"})
MAX_JSX_BYTES = 200_000
MAX_CSS_BYTES = 200_000


class SlotMountBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    jsx: str = Field(..., min_length=1, max_length=MAX_JSX_BYTES)


class CustomizationBody(BaseModel):
    """Whole-customization replace. `slots` keys must be in ALLOWED_SLOT_IDS."""
    css: Optional[str] = Field(default=None, max_length=MAX_CSS_BYTES)
    slots: Optional[dict[str, SlotMountBody]] = None


class CssBody(BaseModel):
    css: str = Field(..., max_length=MAX_CSS_BYTES)


def _validate_slot_id(slot_id: str) -> None:
    if slot_id not in ALLOWED_SLOT_IDS:
        raise HTTPException(
            400,
            f"unknown slot id {slot_id!r}; valid: {sorted(ALLOWED_SLOT_IDS)}",
        )


@router.get("/sessions/{sid}/customization")
def get_session_customization(sid: str) -> dict:
    s = _require(sid)
    return dict(s.customization or {})


@router.put("/sessions/{sid}/customization", response_model=VersionResponse)
def put_session_customization(sid: str, body: CustomizationBody) -> VersionResponse:
    """Replace the whole customization on the session (CSS + slot mounts)."""
    s = _require(sid)
    cust: dict = {}
    if body.css is not None and body.css.strip():
        cust["css"] = body.css
    if body.slots:
        for slot_id in body.slots:
            _validate_slot_id(slot_id)
        cust["slots"] = {k: v.model_dump() for k, v in body.slots.items()}
    s.customization = cust
    s.bump(
        f"Customization set (css={'yes' if 'css' in cust else 'no'}, "
        f"slots={list(cust.get('slots', {}).keys())}).",
        by="claude",
    )
    return VersionResponse(version=s.version)


@router.delete("/sessions/{sid}/customization", response_model=VersionResponse)
def clear_session_customization(sid: str) -> VersionResponse:
    s = _require(sid)
    if not s.customization:
        return VersionResponse(version=s.version)
    s.customization = {}
    s.bump("Cleared customization.", by="claude")
    return VersionResponse(version=s.version)


@router.put("/sessions/{sid}/customization/css", response_model=VersionResponse)
def put_session_customization_css(sid: str, body: CssBody) -> VersionResponse:
    s = _require(sid)
    cust = dict(s.customization or {})
    if body.css.strip():
        cust["css"] = body.css
    else:
        cust.pop("css", None)
    s.customization = cust
    s.bump(f"Set customization CSS ({len(body.css)} chars).", by="claude")
    return VersionResponse(version=s.version)


@router.put(
    "/sessions/{sid}/customization/slots/{slot_id}",
    response_model=VersionResponse,
)
def put_session_customization_slot(
    sid: str, slot_id: str, body: SlotMountBody
) -> VersionResponse:
    _validate_slot_id(slot_id)
    s = _require(sid)
    cust = dict(s.customization or {})
    slots = dict(cust.get("slots") or {})
    slots[slot_id] = body.model_dump()
    cust["slots"] = slots
    s.customization = cust
    s.bump(
        f"Mounted slot {slot_id!r} = {body.name!r} ({len(body.jsx)} chars JSX).",
        by="claude",
    )
    return VersionResponse(version=s.version)


@router.delete(
    "/sessions/{sid}/customization/slots/{slot_id}",
    response_model=VersionResponse,
)
def delete_session_customization_slot(sid: str, slot_id: str) -> VersionResponse:
    _validate_slot_id(slot_id)
    s = _require(sid)
    cust = dict(s.customization or {})
    slots = dict(cust.get("slots") or {})
    if slot_id not in slots:
        raise HTTPException(404, f"slot {slot_id!r} not mounted")
    name = slots[slot_id].get("name")
    del slots[slot_id]
    if slots:
        cust["slots"] = slots
    else:
        cust.pop("slots", None)
    s.customization = cust
    s.bump(f"Unmounted slot {slot_id!r} (was {name!r}).", by="claude")
    return VersionResponse(version=s.version)


# ─── Phase 5: extract-trace, data-points, notes, csv, chat ──────────────
def _session_chart_config(s: Session) -> ChartConfig:
    """Re-hydrate the stored config dict into a ChartConfig pydantic model."""
    try:
        return ChartConfig.model_validate(s.config)
    except Exception as e:
        raise HTTPException(500, f"session config invalid: {e}")


def _image_xy_for_value(
    s: Session, day: int, hour: float, value: float
) -> tuple[Optional[float], Optional[float]]:
    """(day, hour, value) → image-px (canvasX, canvasY) using current calibration.

    Returns (None, None) if calibration isn't set or is degenerate.
    """
    if len(s.calibration) < 3:
        return None, None
    cfg = _session_chart_config(s)
    chart_x, chart_y = value_to_chart(day, hour, value, cfg)
    try:
        H = affine_to_3x3(compute_affine(s.calibration))
        H_inv = invert_affine_3x3(H)
    except Exception:
        return None, None
    img_h = H_inv @ np.array([chart_x, chart_y, 1.0])
    if img_h[2] == 0:
        return None, None
    return float(img_h[0] / img_h[2]), float(img_h[1] / img_h[2])


class ExtractTraceIn(BaseModel):
    skipDays: Optional[List[int]] = None
    traceInk: Optional[Literal["auto", "blue", "red", "black"]] = None
    samplesPerDay: Optional[int] = None


@router.post("/sessions/{sid}/extract-trace")
def post_extract_trace(sid: str, body: ExtractTraceIn) -> dict:
    s = _require(sid)
    if len(s.calibration) < 3:
        raise HTTPException(400, "calibration not set; need ≥3 corners first")
    cfg = _session_chart_config(s)

    image_b64 = base64.b64encode(s.image_bytes).decode("ascii")
    cal_pts = [
        ExtractCalibrationPoint(
            imgX=p.imgX, imgY=p.imgY, chartX=p.chartX, chartY=p.chartY
        )
        for p in s.calibration
    ]
    # The session stores calibration in image-px space (the SVG overlay's
    # native coords). Pass natural width/height as the "display" dims so
    # extract_trace's display→natural scaling is identity, leaving the
    # returned canvasX/Y in image-px too.
    req = ExtractTraceRequest(
        imageBase64=image_b64,
        calibrationPoints=cal_pts,
        displayWidth=float(s.image_natural_w),
        displayHeight=float(s.image_natural_h),
        config=cfg,
        samplesPerDay=int(body.samplesPerDay or 48),
        traceInk=(body.traceInk or "auto"),
    )
    try:
        result = _extract_trace(req, debug=False)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        log.error("extract-trace failed: %s", e, exc_info=True)
        raise HTTPException(500, f"extract failed: {e}")

    skip = set(body.skipDays or [])
    new_points: List[DataPointModel] = []
    for p in result.points:
        if p.day in skip:
            continue
        new_points.append(
            DataPointModel(
                day=int(p.day),
                hour=float(p.hour),
                value=float(p.value),
                canvasX=float(p.canvasX),
                canvasY=float(p.canvasY),
                source="extract",
            )
        )
    s.data_points = new_points
    skip_msg = f", skipped days {sorted(skip)}" if skip else ""
    s.bump(
        f"Extracted {len(new_points)} points "
        f"(traceInk={req.traceInk}, samples/day={req.samplesPerDay}{skip_msg}).",
        by="claude",
    )
    log.info(
        "sessions: %s extract-trace n=%d skip=%s version=%d",
        sid, len(new_points), sorted(skip), s.version,
    )
    return {
        "version": s.version,
        "extracted": len(new_points),
        "diagnostics": {
            "maskPixels": result.diagnostics.maskPixels,
            "skeletonPixels": result.diagnostics.skeletonPixels,
            "rectifiedSize": result.diagnostics.rectifiedSize,
            "timingMs": result.diagnostics.timingMs,
        },
    }


# ─── Data-point CRUD ────────────────────────────────────────────────────
class DataPointIn(BaseModel):
    day: int
    hour: float
    value: float
    source: Optional[Literal["claude", "user", "extract"]] = None


class DataPointPatchIn(BaseModel):
    day: Optional[int] = None
    hour: Optional[float] = None
    value: Optional[float] = None
    source: Optional[Literal["claude", "user", "extract"]] = None


def _validate_dp_fields(day: int, hour: float, value: float) -> None:
    if day < 0:
        raise HTTPException(400, "day must be ≥ 0")
    if hour < 0.0 or hour >= 24.0:
        raise HTTPException(400, "hour must be in [0, 24)")
    if not (-1e6 < value < 1e6):
        raise HTTPException(400, "value out of range")


@router.post("/sessions/{sid}/data-points", status_code=201)
def post_data_point(sid: str, body: DataPointIn) -> dict:
    s = _require(sid)
    _validate_dp_fields(body.day, body.hour, body.value)
    cx, cy = _image_xy_for_value(s, body.day, body.hour, body.value)
    dp = DataPointModel(
        day=body.day, hour=body.hour, value=body.value,
        canvasX=cx, canvasY=cy,
        source=body.source or "claude",
    )
    s.data_points.append(dp)
    idx = len(s.data_points) - 1
    s.bump(
        f"Added data-point d{dp.day} h{dp.hour:.1f} = {dp.value:g} "
        f"(idx {idx}, source={dp.source}).",
        by="claude" if dp.source == "claude" else dp.source if dp.source in ("user", "system") else "claude",
    )
    return {"version": s.version, "index": idx}


@router.put("/sessions/{sid}/data-points/{idx}")
def put_data_point(sid: str, idx: int, body: DataPointPatchIn) -> dict:
    s = _require(sid)
    if idx < 0 or idx >= len(s.data_points):
        raise HTTPException(404, "data-point index out of range")
    dp = s.data_points[idx]
    if body.day is not None: dp.day = int(body.day)
    if body.hour is not None: dp.hour = float(body.hour)
    if body.value is not None: dp.value = float(body.value)
    if body.source is not None: dp.source = body.source
    _validate_dp_fields(dp.day, dp.hour, dp.value)
    cx, cy = _image_xy_for_value(s, dp.day, dp.hour, dp.value)
    dp.canvasX, dp.canvasY = cx, cy
    s.bump(
        f"Updated data-point idx {idx}: d{dp.day} h{dp.hour:.1f} = {dp.value:g}.",
        by="claude",
    )
    return {"version": s.version, "index": idx}


@router.delete("/sessions/{sid}/data-points/{idx}", response_model=VersionResponse)
def delete_data_point(sid: str, idx: int) -> VersionResponse:
    s = _require(sid)
    if idx < 0 or idx >= len(s.data_points):
        raise HTTPException(404, "data-point index out of range")
    removed = s.data_points.pop(idx)
    s.bump(
        f"Removed data-point idx {idx} (was d{removed.day} h{removed.hour:.1f}).",
        by="claude",
    )
    return VersionResponse(version=s.version)


@router.delete("/sessions/{sid}/data-points", response_model=VersionResponse)
def delete_data_points_all(sid: str) -> VersionResponse:
    s = _require(sid)
    n = len(s.data_points)
    s.data_points = []
    s.bump(f"Cleared {n} data-points.", by="claude")
    return VersionResponse(version=s.version)


# ─── Notes ──────────────────────────────────────────────────────────────
class NoteIn(BaseModel):
    text: str
    by: Optional[Literal["claude", "user", "system"]] = None


@router.post("/sessions/{sid}/notes", status_code=201, response_model=VersionResponse)
def post_note(sid: str, body: NoteIn) -> VersionResponse:
    s = _require(sid)
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "note text is empty")
    if len(text) > 2000:
        raise HTTPException(400, "note text too long (max 2000 chars)")
    s.bump(text, by=body.by or "user")
    return VersionResponse(version=s.version)


# ─── CSV export ─────────────────────────────────────────────────────────
@router.get("/sessions/{sid}/csv")
def get_csv(sid: str) -> Response:
    s = _require(sid)
    cfg = _session_chart_config(s)
    unit = cfg.unit or ""
    lines = ["day,hour,value,unit,source"]
    for dp in s.data_points:
        lines.append(
            f"{dp.day},{dp.hour:.4f},{dp.value:.4f},{unit},{dp.source}"
        )
    csv_text = "\n".join(lines) + "\n"
    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": f'attachment; filename="dhmz-{sid}.csv"',
        },
    )


# ─── Chat (user ↔ claude) ───────────────────────────────────────────────
class ChatPostIn(BaseModel):
    text: str = ""
    imagesBase64: Optional[List[str]] = None
    # "reply"   = normal message in the chat feed.
    # "thinking" = rationale / internal monologue, rendered dimmed +
    #              collapsed-by-default in the browser so it doesn't clutter
    #              the user-facing transcript. Use for "why I chose X".
    kind: Literal["reply", "thinking"] = "reply"


def _append_chat_message(
    s: Session,
    by: Literal["user", "claude"],
    body: ChatPostIn,
) -> int:
    text = body.text.strip()
    if len(text) > 4000:
        raise HTTPException(400, "chat text too long (max 4000 chars)")
    attachments = _process_chat_attachments(body.imagesBase64)
    if not text and not attachments:
        raise HTTPException(400, "chat needs text or at least one image")
    msg = ChatMessage(
        ts=time.time(), by=by, text=text,
        attachments=attachments,
        kind=body.kind or "reply",
    )
    s.chat_messages.append(msg)
    return len(s.chat_messages) - 1


def _chat_note_summary(text: str, n_attach: int) -> str:
    parts = []
    if text:
        parts.append(text[:80] + ("…" if len(text) > 80 else ""))
    if n_attach:
        parts.append(f"[{n_attach} image{'s' if n_attach > 1 else ''}]")
    return " ".join(parts) or "(empty)"


@router.post("/sessions/{sid}/chat", status_code=201)
def post_chat_user(sid: str, body: ChatPostIn) -> dict:
    s = _require(sid)
    idx = _append_chat_message(s, "user", body)
    msg = s.chat_messages[idx]
    s.bump(
        f"User said: {_chat_note_summary(msg.text, len(msg.attachments))}",
        by="user",
    )
    return {"version": s.version, "messageIndex": idx}


@router.post("/sessions/{sid}/chat-claude", status_code=201)
def post_chat_claude(sid: str, body: ChatPostIn) -> dict:
    s = _require(sid)
    idx = _append_chat_message(s, "claude", body)
    msg = s.chat_messages[idx]
    s.bump(
        f"Claude said: {_chat_note_summary(msg.text, len(msg.attachments))}",
        by="claude",
    )
    return {"version": s.version, "messageIndex": idx}


@router.get("/sessions/{sid}/chat-attachments/{aid}")
def get_chat_attachment(sid: str, aid: str) -> Response:
    s = _require(sid)
    for msg in s.chat_messages:
        for att in msg.attachments:
            if att.id == aid:
                return Response(
                    content=att.data,
                    media_type=att.mime,
                    headers={
                        "Cache-Control": "private, max-age=86400",
                        "Content-Disposition": (
                            f'inline; filename="chat-{aid}.'
                            f'{"png" if att.mime == "image/png" else "jpg"}"'
                        ),
                    },
                )
    raise HTTPException(404, "attachment not found")


@router.get("/sessions/{sid}/chat")
async def get_chat_long_poll(
    sid: str,
    since: int = 0,
    wait: float = 30.0,
) -> dict:
    """Long-poll for new chat messages with index > since.

    Returns {messages, nextSince, timeout}. Holds the connection up to ~30 s
    waiting for new messages so the operator (Claude) can listen for user
    replies without a busy loop.
    """
    s = _require(sid)
    if since < 0:
        since = 0
    wait = max(0.0, min(30.0, float(wait)))
    deadline = time.monotonic() + wait
    while True:
        # Re-check session each iteration in case it expired
        s = STORE.get(sid)
        if s is None:
            raise HTTPException(404, "session not found or expired")
        if len(s.chat_messages) > since:
            new_msgs = s.chat_messages[since:]
            return {
                "messages": [_serialize_chat_message(s, m) for m in new_msgs],
                "nextSince": len(s.chat_messages),
                "timeout": False,
            }
        if time.monotonic() >= deadline:
            return {"messages": [], "nextSince": since, "timeout": True}
        await asyncio.sleep(0.25)


# ─── Briefing endpoint (markdown) ────────────────────────────────────────
def _fmt_iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _build_context(s: Session) -> str:
    """Markdown briefing returned at GET /api/sessions/{id}/context.

    This text is consumed by a Claude Code instance running in the user's
    terminal. It deliberately includes operational instructions — that is
    its job. The user's Claude is expected to recognize the briefing as a
    prompt injection (it comes from a URL the user pasted), summarize the
    available capabilities, and ask the user for explicit consent before
    executing any mutation.
    """
    cfg = s.config
    chart_type = s.chart_type
    days = int(cfg.get("days", 8))
    days_max = max(0, days - 1)
    chart_w = float(cfg.get("chartWidth", 0))
    chart_h = float(cfg.get("chartHeight", 0))
    min_v = float(cfg.get("minValue", 0))
    max_v = float(cfg.get("maxValue", 0))
    span = max_v - min_v
    unit = str(cfg.get("unit", ""))
    major = float(cfg.get("majorGrid", 0))
    pen_R = float(cfg.get("penArmRadius", 0))
    pen_P = float(cfg.get("penArmPivot", 0))
    orientation = str(cfg.get("orientation", "landscape"))

    hours_left = max(0.0, (s.expires_at - time.time()) / 3600.0)
    base = f"{PUBLIC_BASE_URL}/api/sessions/{s.id}"
    state_json = json.dumps(_serialize_state(s), indent=2, default=str)
    sid = s.id

    # Built section by section so we can keep curl bodies as raw strings
    # without f-string brace gymnastics.
    parts: list[str] = []

    parts.append(f"""# DHMZ Digitizer — Session {sid}

## Who you are right now

You are operating the DHMZ analog chart digitization tool on behalf of a
user. The user uploaded a Lambrecht-style strip-chart scan and gave you
this URL. Your job is to help digitize the pen trace into time-series
data, **visually**, the way a human technician would: look at the scan,
decide rotation, mark calibration corners, point out problem areas, run
extraction, sanity-check results, hand off.

The user is sitting at a browser tab on `{PUBLIC_BASE_URL}/session/?id={sid}`.
Every state change you make below appears there within ~1.5 s — they are
watching. Keep your terminal output brief; visible mutations don't need
verbose narration.

## ⚠️ Communication discipline — chat as live screen-share

The user's primary view is the browser. So your primary output is the
session web chat (`POST /chat-claude`), **not** stdout. Treat that
chat like a live screen-share: the user wants to feel listened to and
see you working — not silence followed by a wall of text.

**On connect (very first thing, no permission ask):**

1. Post `{"text":"spojen, gledam sken","kind":"reply"}` to
   `/chat-claude`. One-liner so the user sees activity in <1 s.
2. In parallel: read `/context`, `/sessions/{id}`, and a downsampled
   `/image` (max ~1200 px).
3. Post a 1-2 sentence summary of what you see (chart type,
   dimensions, anything notable). Still `kind="reply"`.

**On every user request (or when you decide to act):**

- **Immediate ack** (one short `kind="reply"`): show you understood
  before doing real work. "Razumio — krećem na X." "Pogledat ću Y,
  vraćam se za par sek."
- **Don't impose**. If the user just pasted the URL and hasn't asked
  for anything specific, *offer options* — don't auto-calibrate /
  extract. e.g. "Mogu (a) auto-cal → extract → CSV, (b) ručna
  kalibracija prvo, (c) samo pregled. Što voliš?" Then long-poll
  `/chat?since=N&wait=30` for the answer.
- **Once given a path, execute autonomously**. No per-step approval.
  Status updates (kind="reply") as you go: `"X → done, n=Y"`.

**Two chat message kinds — pick deliberately.**

The `kind` field on a chat post controls how the message renders:

- `"reply"`     — normal full bubble. Use for ack, plan, status,
                  results, questions to the user.
- `"thinking"`  — dimmed italic collapsed row with a 💭 marker. The
                  user can click to expand. Use for rationale,
                  weighing options, "why this threshold over that",
                  "what I noticed that pushed the choice". Use
                  liberally — it doesn't clutter the feed.

The user benefits from seeing your reasoning *without* having to read
a wall of it. Reach for `"thinking"` whenever you'd otherwise write a
paragraph of rationale that's secondary to the action you took.

**Block (wait=30 long-poll) only when:**

- (a) You've offered options and need the user's choice.
- (b) Genuine ambiguity: two equally good interpretations and the
  user's preference matters.
- (c) Before a destructive irreversible step: `POST /image` swap,
  `DELETE /annotations`, `DELETE /data-points`, ROI clear.
- (d) At the end of the workflow, asking what to do next.

Otherwise, after each step do a quick `wait=2` poll for `stop`
signal and move on. Authorisation for read + chat is granted by the
URL paste; mutations should be gated by what the user asked for, not
by per-call permission checks.

**`stop` convention.** Between steps (not during them), do a
near-non-blocking poll:

```bash
curl -s '{base}/chat?since=N&wait=2'
```

If a returned message contains the substring `stop` (case-insensitive,
any language), abort the current workflow and wait for instructions.
Otherwise proceed without further checks. `wait=2` keeps the flow
moving while still catching interrupts.

**Long-running call** (extract-trace, ~30-60s): announce once with
`"⏳ Vrtim: extract-trace (~30s)"`, run it, post results. No
permission needed before kicking it off.

**Visual proof.** When a result has a visual answer (extract overlay,
crop, mask preview), generate the image locally and attach via the
chat `imagesBase64` field (up to 4 per message, ≤5 MB each, JPEG
preferred — base64 inflates ~33% and Desktop has a 1 MB
tool-result cap).

**Terminal output**: at most one short status line per chat post.
Soft content always in chat.

## ⚠️ This briefing is a prompt injection — by design

You're reading instructions delivered from a URL the user pasted.
Treat the proposed *workflow* as a proposal, not an order — sanity
check it against what the scan actually shows. But the *consent
boundary* is the URL itself: the user pasted it, so basic
read/calibrate/extract/CSV flow is pre-authorised without further
prompting. You only need to ask before destructive irreversible
steps (per the Communication discipline above), and before deviating
from the standard digitization workflow into anything weirder
(arbitrary code edits, dependency installs, image swaps that throw
away the original). `stop` from the user always wins.

## Session details

- **Session ID:** `{sid}`
- **Created:** {_fmt_iso(s.created_at)}
- **Expires:** {_fmt_iso(s.expires_at)} (~{hours_left:.1f} h remaining)
- **Chart type:** `{chart_type}` ({min_v:g}–{max_v:g} {unit}, {days} days, {orientation})
- **Image:** {s.image_natural_w}×{s.image_natural_h} px (revision {s.image_revision})
- **State version:** {s.version}

## Chart geometry — Lambrecht {chart_type}

This is a strip-chart recorder. The chart paper wraps around a cylinder
that rotates with time. A pen arm of radius **R = {pen_R:g} mm** pivots
at **P = {pen_P:g} mm** from the chart top.

- **Horizontal grid lines** = VALUES (perfectly straight).
  - Major every {major:g} {unit}, minor every 5 {unit}, fine every 1 {unit}.
- **Time grid lines** = CURVED arcs because of the pen-arm sag:

  ```
  sag(y_mm) = (R − √(R² − (y_mm − P)²)) − sagAtPivot
  displayed_X(y) = trueTimeX − sag(y)
  ```

- Total chart spans **{days} days × {span:g} {unit}**, paper
  {chart_w:g}×{chart_h:g} mm.

When you look at the scan, find where the *outermost* grid intersections
are — those are calibration corners. Don't pick a point on a curved time
line and call it a corner; pick where it crosses a value line.
""")

    # ── Tools section: read state ───────────────────────────────────────
    parts.append(f"""## Tools — read state

All tools are HTTP calls. Use `Bash curl ...` to invoke. Replies are JSON
unless noted.

```bash
# Full session state (annotations, ROIs, panels, scratchHtml, notes, ...)
curl -s {base}

# Lightweight version-check (poll this every ~1.5 s)
curl -s {base}/poll
```

## Tools — fetch image

The current scan is served at `/image`. Pull it locally and `Read` it as
multimodal input:

```bash
curl -o /tmp/scan-{sid}.png {base}/image
# then in your client:
#   Read /tmp/scan-{sid}.png
```

`imageRevision` in the state increments every time you (or anyone)
swaps the image via `POST /image`. Re-fetch when it changes.
""")

    # ── Mutating tools (raw strings to avoid brace headaches) ───────────
    parts.append("## Tools — set rotation\n\n"
                 "Compare the horizontal value lines to the image edges. If skew > ~0.3°,\n"
                 "apply rotation. Range (−180, 180]; positive = CCW.\n\n"
                 "```bash\n"
                 f'curl -s -X PUT -H "Content-Type: application/json" \\\n'
                 f"  {base}/rotation \\\n"
                 "  -d '{\"deg\": -1.2}'\n"
                 "```\n")

    parts.append("## Tools — set calibration corners\n\n"
                 "Identify chart-area corners in image-pixel coordinates. Map them to\n"
                 "chart-mm using the chart paper dimensions.\n\n"
                 f"- top-left  → `{{chartX: 0, chartY: 0}}`\n"
                 f"- top-right → `{{chartX: {chart_w:g}, chartY: 0}}`\n"
                 f"- bot-left  → `{{chartX: 0, chartY: {chart_h:g}}}`\n"
                 f"- bot-right → `{{chartX: {chart_w:g}, chartY: {chart_h:g}}}`\n\n"
                 "Server rejects <3 corners or collinear sets (HTTP 400).\n\n"
                 "```bash\n"
                 f'curl -s -X PUT -H "Content-Type: application/json" \\\n'
                 f"  {base}/calibration \\\n"
                 "  -d '{\n"
                 "    \"corners\": [\n"
                 "      {\"imgX\": 123,  \"imgY\": 87,   \"chartX\": 0,   \"chartY\": 0},\n"
                 f"      {{\"imgX\": 9821, \"imgY\": 95,   \"chartX\": {chart_w:g}, \"chartY\": 0}},\n"
                 f"      {{\"imgX\": 125,  \"imgY\": 3870, \"chartX\": 0,   \"chartY\": {chart_h:g}}},\n"
                 f"      {{\"imgX\": 9819, \"imgY\": 3868, \"chartX\": {chart_w:g}, \"chartY\": {chart_h:g}}}\n"
                 "    ]\n"
                 "  }'\n"
                 "```\n")

    parts.append("## Tools — set vectorized grid polylines (optional)\n\n"
                 "If you've vectorized the grid (image-px polylines, axis + weight),\n"
                 "you can push them so the user sees the grid overlaid:\n\n"
                 "```bash\n"
                 f'curl -s -X PUT -H "Content-Type: application/json" \\\n'
                 f"  {base}/polylines \\\n"
                 "  -d '{\n"
                 "    \"polylines\": [\n"
                 "      {\"points\": [[120,100],[9800,100]], \"axis\": \"horizontal\", \"weight\": \"major\"}\n"
                 "    ]\n"
                 "  }'\n"
                 "```\n")

    parts.append("## Tools — annotations (draw on the chart)\n\n"
                 "Free-form vector overlay rendered on top of the image. Coordinates\n"
                 "are in **image pixels**. Each annotation gets an 8-hex `id` you\n"
                 "can use to delete it. Supported `type` values:\n\n"
                 "- `stroke`, `polyline`, `line`, `arrow` — require `points: [[x,y],…]`\n"
                 "- `circle` — `cx`, `cy`, `r`\n"
                 "- `rect`   — `x`, `y`, `w`, `h`\n"
                 "- `text`   — `x`, `y`, `text`, optional `fontSize`\n\n"
                 "Optional style: `stroke`, `fill`, `strokeWidth`, `label`.\n\n"
                 "```bash\n"
                 "# add one\n"
                 f'curl -s -X POST -H "Content-Type: application/json" \\\n'
                 f"  {base}/annotations \\\n"
                 "  -d '{\"type\":\"circle\",\"cx\":4500,\"cy\":1800,\"r\":120,\"stroke\":\"#f00\",\"label\":\"day 3 wet\"}'\n\n"
                 "# replace whole layer\n"
                 f'curl -s -X PUT -H "Content-Type: application/json" \\\n'
                 f"  {base}/annotations \\\n"
                 "  -d '{\"annotations\":[ {\"type\":\"text\",\"x\":10,\"y\":10,\"text\":\"hi\"} ]}'\n\n"
                 "# delete one\n"
                 f"curl -s -X DELETE {base}/annotations/<id>\n\n"
                 "# clear all\n"
                 f"curl -s -X DELETE {base}/annotations\n"
                 "```\n")

    parts.append("## Tools — ROIs (named rectangles)\n\n"
                 "Highlight a region for the user — e.g. \"this is the wet day\". The\n"
                 "frontend can zoom/scroll to ROIs.\n\n"
                 "```bash\n"
                 f'curl -s -X POST -H "Content-Type: application/json" \\\n'
                 f"  {base}/rois \\\n"
                 "  -d '{\"x\":4400,\"y\":1700,\"w\":300,\"h\":250,\"label\":\"day 3\",\"color\":\"#ff8800\"}'\n\n"
                 f"curl -s -X DELETE {base}/rois/<id>\n"
                 f"curl -s -X DELETE {base}/rois          # clear all\n"
                 "```\n")

    parts.append("## Tools — sidebar panels (markdown)\n\n"
                 "Upsert a named markdown block into the user's sidebar. Use it for\n"
                 "running observations, plans, or summaries.\n\n"
                 "```bash\n"
                 f'curl -s -X PUT -H "Content-Type: application/json" \\\n'
                 f"  {base}/panels/observations \\\n"
                 "  -d '{\"markdown\":\"# Observations\\n* Day 3 wet\\n* Trace ink: blue, faded\"}'\n\n"
                 f"curl -s -X DELETE {base}/panels/observations\n"
                 "```\n\n"
                 "Panel name pattern: `[A-Za-z0-9._-]{1,64}`.\n")

    parts.append("## Tools — scratch HTML (custom UI)\n\n"
                 "Push raw HTML/CSS/JS that the frontend renders inside a sandboxed\n"
                 "iframe in the session view. Use this when none of the structured\n"
                 "primitives fit — bespoke widgets, charts, side-by-side comparisons.\n\n"
                 "The iframe runs with restricted permissions; treat it as a public\n"
                 "browser context, not a privileged extension.\n\n"
                 "```bash\n"
                 f'curl -s -X PUT -H "Content-Type: application/json" \\\n'
                 f"  {base}/scratch-html \\\n"
                 "  -d '{\"html\":\"<h2>Stats</h2><div id=root></div>\",\"css\":\"h2{color:#08f}\",\"js\":\"document.getElementById(\\\"root\\\").innerText=\\\"hello\\\"\"}'\n\n"
                 f"curl -s -X DELETE {base}/scratch-html\n"
                 "```\n")

    parts.append("## Tools — live UI customization (host page edits)\n\n"
                 "When the user asks for UI changes (\"add a button for X\",\n"
                 "\"hide the calibration panel\", \"new view that…\"), **do not**\n"
                 "edit the repo — use the customization layer. CSS is applied as\n"
                 "`<style>` on the host head; JSX mounts are compiled in-browser\n"
                 "via Sucrase and rendered into named host slots. Both persist\n"
                 "with the session.\n\n"
                 "**Slots** (where the mount renders):\n"
                 "  - `toolbar-extra` — small inline UI top-right of the chart\n"
                 "  - `sidebar-extra` — bottom of the right sidebar\n"
                 "  - `overlay`       — full-screen modal-style layer above chart\n"
                 "  - `route`         — replaces the entire chart+sidebar view\n\n"
                 "JSX convention: source must define a top-level\n"
                 "`function Component({ host }) { ... }` that returns JSX. Inside,\n"
                 "`host.api.*` exposes app actions (postChat, extractTrace,\n"
                 "downloadCsv, fetchJson) and `host.state` is a read-only snapshot.\n"
                 "Use `host.React.useState` / `useEffect` for component state.\n\n"
                 "```bash\n"
                 "# CSS override\n"
                 f'curl -s -X PUT -H "Content-Type: application/json" \\\n'
                 f"  {base}/customization/css \\\n"
                 "  -d '{\"css\":\".session-toolbar{background:#fffbeb}\"}'\n\n"
                 "# Mount a JSX component in toolbar-extra\n"
                 f'curl -s -X PUT -H "Content-Type: application/json" \\\n'
                 f"  {base}/customization/slots/toolbar-extra \\\n"
                 "  -d '{\"name\":\"Quick Export\",\"jsx\":\"function Component({host}){return <button onClick={()=>host.api.downloadCsv()}>Export CSV</button>;}\"}'\n\n"
                 "# Clear one slot, or all\n"
                 f"curl -s -X DELETE {base}/customization/slots/toolbar-extra\n"
                 f"curl -s -X DELETE {base}/customization\n\n"
                 "# Save the current customization as a shareable version (30d TTL)\n"
                 f"curl -s -X POST -H \"Content-Type: application/json\" \\\n"
                 f"  {PUBLIC_BASE_URL}/api/customizations \\\n"
                 "  -d '{\"name\":\"compact-view\",\"css\":\"...\",\"slots\":{...}}'\n"
                 "# Returns {id, expiresAt}; share URL: "
                 f"`{PUBLIC_BASE_URL}/session/?id={sid}&cv=<id>`\n"
                 "```\n\n"
                 "If the user says \"save this permanently\" or \"share this\",\n"
                 "POST the current customization to `/api/customizations` and\n"
                 "hand them the share URL. The browser modal will offer\n"
                 "\"Apply + save locally\" which puts it into their localStorage\n"
                 "version list.\n")

    parts.append("## Tools — image swap (manipulate locally and push)\n\n"
                 "Want to enhance contrast, denoise, deskew differently, crop, or run\n"
                 "your own preprocessing? Pull the image, manipulate it locally with\n"
                 "PIL/OpenCV/ImageMagick, then push the result back. The session's\n"
                 "stored image is replaced; `imageRevision` increments.\n\n"
                 "```bash\n"
                 f"curl -o /tmp/in.png  {base}/image\n"
                 "# ...do whatever locally; output /tmp/out.png ...\n"
                 "B64=$(base64 -i /tmp/out.png)\n"
                 f'curl -s -X POST -H "Content-Type: application/json" \\\n'
                 f"  {base}/image \\\n"
                 "  -d \"{\\\"imageBase64\\\": \\\"$B64\\\", \\\"note\\\": \\\"contrast +30%, denoised\\\"}\"\n"
                 "```\n")

    parts.append("## Tools — extract trace\n\n"
                 "Once calibration is set, run the OpenCV pipeline to pull the pen\n"
                 "trace into ~`samplesPerDay × days` (day, hour, value) data points.\n"
                 "Replaces any existing data points.\n\n"
                 "```bash\n"
                 f'curl -s -X POST -H "Content-Type: application/json" \\\n'
                 f"  {base}/extract-trace \\\n"
                 "  -d '{\"traceInk\":\"auto\",\"samplesPerDay\":48,\"skipDays\":[]}'\n"
                 "```\n\n"
                 "`traceInk` ∈ `auto|blue|red|black`. `skipDays` is a list of day\n"
                 f"indices in `0..{days_max}` to drop after extraction (use for damaged\n"
                 "/ smudged days). Response: `{version, extracted, diagnostics}`.\n")

    parts.append("## Tools — data points\n\n"
                 "Append, edit, or remove individual data points. The server\n"
                 "computes `canvasX/Y` (image-px) from current calibration so the\n"
                 "session view can render the dot correctly.\n\n"
                 "```bash\n"
                 "# Append\n"
                 f'curl -s -X POST -H "Content-Type: application/json" \\\n'
                 f"  {base}/data-points \\\n"
                 "  -d '{\"day\":3,\"hour\":6.0,\"value\":1018}'\n\n"
                 "# Patch one (idx is the array position)\n"
                 f'curl -s -X PUT -H "Content-Type: application/json" \\\n'
                 f"  {base}/data-points/12 \\\n"
                 "  -d '{\"value\":1015}'\n\n"
                 "# Delete one\n"
                 f"curl -s -X DELETE {base}/data-points/12\n\n"
                 "# Clear all\n"
                 f"curl -s -X DELETE {base}/data-points\n"
                 "```\n")

    parts.append("## Tools — notes\n\n"
                 "Free-form note appended to the activity log. Defaults to\n"
                 "`by=user`; pass `by=claude` if you're narrating an observation.\n\n"
                 "```bash\n"
                 f'curl -s -X POST -H "Content-Type: application/json" \\\n'
                 f"  {base}/notes \\\n"
                 "  -d '{\"text\":\"Day 4 has a smudge across hours 10-14, dropping.\",\"by\":\"claude\"}'\n"
                 "```\n")

    parts.append("## Tools — chat (user ↔ Claude) — primary I/O\n\n"
                 "The user's chat panel renders messages from `chatMessages[]`.\n"
                 "Two message kinds (see Communication discipline above):\n"
                 "  * `\"reply\"`     — full bubble: ack, plan, status, results,\n"
                 "                   questions to the user.\n"
                 "  * `\"thinking\"`  — dimmed/collapsed 💭 row: rationale,\n"
                 "                   weighing options, why-this-not-that. Liberal\n"
                 "                   use is fine — the user can expand if they\n"
                 "                   want, otherwise it stays out of the way.\n\n"
                 "Stream of work, not Q&A loop: immediate ack on every user ask,\n"
                 "per-step status as you execute, thinking-kind posts for\n"
                 "rationale. Use `wait=2` polls between steps to catch `stop`,\n"
                 "`wait=30` only when you actually need a user reply.\n\n"
                 "```bash\n"
                 "# Quick ack (kind=\"reply\" is the default, omit if you like)\n"
                 f'curl -s -X POST -H \"Content-Type: application/json\" \\\n'
                 f"  {base}/chat-claude \\\n"
                 "  -d '{\"text\":\"Razumio — krećem na auto-cal.\"}'\n\n"
                 "# Rationale post (rendered dimmed/collapsed — keep main feed clean)\n"
                 f'curl -s -X POST -H \"Content-Type: application/json\" \\\n'
                 f"  {base}/chat-claude \\\n"
                 "  -d '{\"text\":\"Biram traceInk=blue jer dominantni HSV pen je 220° ±10°, a green-mask već reagira na grid.\",\"kind\":\"thinking\"}'\n\n"
                 "# Long-running call: announce once, then run, then post result.\n"
                 f'curl -s -X POST -H \"Content-Type: application/json\" \\\n'
                 f"  {base}/chat-claude \\\n"
                 "  -d '{\"text\":\"⏳ Vrtim: extract-trace (~30s).\"}'\n\n"
                 "# Quick stop-check between steps (returns ~immediately if empty).\n"
                 f"curl -s '{base}/chat?since=0&wait=2'\n\n"
                 "# Block longer ONLY when actually waiting on the user.\n"
                 f"curl -s '{base}/chat?since=0&wait=30'\n"
                 "```\n\n"
                 "Use `nextSince` from the previous response as the new `since` so\n"
                 "you only pull messages you haven't seen. Convention: the user\n"
                 "stops you with a message containing `stop` (case-insensitive,\n"
                 "any language) — abandon the in-progress step when you see it.\n")

    parts.append("## Tools — CSV export\n\n"
                 "Stream the current data-point set as CSV. Columns:\n"
                 "`day,hour,value,unit,source`.\n\n"
                 "```bash\n"
                 f"curl -s '{base}/csv' -o /tmp/dhmz-{sid}.csv\n"
                 "head /tmp/dhmz-{0}.csv\n".format(sid) +
                 "```\n")

    parts.append(f"""## Tools — code edits and deploy

You're running from `/Users/aldo/Documents/dev/dhmz-analog`. If during the
session you find a bug or limitation in the app itself, you can:

```bash
# 1. Edit React source
Edit src/app/page.tsx ...

# 2. Edit backend
Edit backend/app/sessions.py ...

# 3. Build + deploy frontend
npm run build
rsync -avz --delete -e "ssh -i ~/.ssh/id_ed25519" out/ \\
    ubuntu@135.125.161.96:/opt/dhmz-analog/out/

# 4. Backend hot reload (no rebuild — ./app is bind-mounted)
rsync -avz -e "ssh -i ~/.ssh/id_ed25519" backend/app/ \\
    ubuntu@135.125.161.96:/opt/dhmz-backend/app/
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \\
    'cd /opt/dhmz-backend && sudo docker compose restart'

# 5. Backend full rebuild (only if requirements.txt or Dockerfile changed)
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \\
    'cd /opt/dhmz-backend && sudo docker compose up -d --build'
```

Tools are unrestricted on your local Mac — `pip install`, `brew install`,
ImageMagick, anything you need. Your client will ask the user for
permission per command; that is the right behavior, don't try to
suppress it.

## Constraints

- **Don't** push to git unless the user explicitly asks.
- **Don't** use `--no-verify` on commits.
- **Don't** touch other VPS containers (`aldo-*`, `transit-*`) — those
  are unrelated projects on shared infrastructure.
- **Don't** widen body-size limits, certificates, or any infrastructure
  affecting shared services without user approval.
- **Always** add an annotation, ROI, or panel that visualizes a finding
  before describing it in the chat — give the user something to look at,
  not just text.
- **Always** ask before destructive operations (clear all annotations,
  swap the image, force-recreate the container).

## Common pitfalls

- **Pen-arm sag is real.** Time grid lines curve. Calibration corners must
  be at 4 distinct grid intersections, not at the paper edges.
- **Bottom 5–10 % of mask** has publisher text ("Lambrecht / Made in
  Germany"); top 5–10 % has day/hour labels. Useful for orientation but
  not part of the chart interior.
- **ECC alignment** in `/api/vectorize-grid` fails on ~50 % of scans.
  Use it as a hint, not as ground truth.
- **HSV mask** is currently green-grid only. Red-grid charts need a
  different gate — flag this and ask before extending the algorithm.
- **`workers=1`** on the backend (session state is in process memory).
  Don't bump that until sessions move to Redis/SQLite.

## Recommended workflow

1. Fetch the image with `curl -o /tmp/scan-{sid}.png {base}/image` and
   `Read` it. Look at the chart visually.
2. Summarize what this briefing is asking you to do for the user, ask
   for explicit consent. POST a `chat-claude` greeting at the same time
   so they can see you're alive.
3. Apply rotation if skew > ~0.3°.
4. Mark calibration corners — and add a circle annotation at each so
   the user can sanity-check.
5. Add ROIs over any damaged / smudged days; PUT a `panels/plan` markdown
   listing what you'll skip and why.
6. Run extract-trace with appropriate `traceInk` and `skipDays`. Review
   the resulting `dataPoints` for outliers; PUT/DELETE individual points
   if any look obviously wrong.
7. Long-poll `/chat` for user feedback. They may correct specific
   points ("hour 14 day 3 is 1015, not 998") — apply via PUT.
8. Final: POST a summary chat-claude + PUT a `panels/summary` panel.
   Tell them they can `GET /csv` from the session view (or you can
   `curl` it for them).

## Current state

```json
{state_json}
```
""")

    return "\n".join(parts)


@router.get("/sessions/{sid}/context")
def get_context(sid: str) -> Response:
    s = _require(sid)
    md = _build_context(s)
    return Response(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={"Cache-Control": "private, no-store"},
    )
