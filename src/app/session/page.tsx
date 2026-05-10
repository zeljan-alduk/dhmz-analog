"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────
type SessionAnnotation = {
  id: string;
  type: "stroke" | "polyline" | "line" | "arrow" | "circle" | "rect" | "text";
  points?: number[][];
  cx?: number; cy?: number; r?: number;
  x?: number; y?: number; w?: number; h?: number;
  text?: string; fontSize?: number;
  stroke?: string; fill?: string; strokeWidth?: number; label?: string;
};

type SessionROI = {
  id: string; x: number; y: number; w: number; h: number;
  label?: string; color?: string;
};

type SessionPolyline = {
  points: number[][];
  axis: "horizontal" | "vertical";
  weight: "major" | "minor" | "fine";
};

type SessionCalibration = {
  imgX: number; imgY: number; chartX: number; chartY: number;
};

type SessionDataPoint = {
  day: number; hour: number; value: number;
  canvasX: number | null; canvasY: number | null;
  source: string;
};

type SessionNote = {
  ts: number; text: string;
  by: "claude" | "user" | "system";
};

type SessionChatAttachment = {
  id: string;
  mime: string;
  width: number;
  height: number;
  url: string;
};

type SessionChatMessage = {
  ts: number;
  by: "claude" | "user";
  text: string;
  attachments?: SessionChatAttachment[];
};

type ScratchHTML = { html: string; css?: string | null; js?: string | null };

type SessionState = {
  id: string;
  createdAt: number;
  expiresAt: number;
  version: number;
  chartType: string;
  config: Record<string, unknown>;
  imageNaturalSize: [number, number];
  imageUrl: string;
  imageRevision: number;
  rotationDeg: number;
  calibration: SessionCalibration[];
  polylines: SessionPolyline[];
  dataPoints: SessionDataPoint[];
  notes: SessionNote[];
  chatMessages: SessionChatMessage[];
  annotations: SessionAnnotation[];
  rois: SessionROI[];
  panels: Record<string, string>;
  scratchHtml: ScratchHTML | null;
};

const POLL_INTERVAL_MS = 1500;
const ACTIVITY_TIMEOUT_MS = 5000;

// ─── Page ─────────────────────────────────────────────────────────────────
export default function SessionPage() {
  return (
    <Suspense fallback={<FullPageMessage>Loading session…</FullPageMessage>}>
      <SessionPageInner />
    </Suspense>
  );
}

function SessionPageInner() {
  const params = useSearchParams();
  const id = params?.get("id") ?? null;

  const [state, setState] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claudeActive, setClaudeActive] = useState(false);
  const versionRef = useRef<number>(-1);
  const lastBumpRef = useRef<number>(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const r = await fetch(`/api/sessions/${id}/poll`, { cache: "no-store" });
        if (cancelled) return;
        if (r.status === 404) {
          setError("Session expired or not found.");
          return;
        }
        if (!r.ok) throw new Error(`poll ${r.status}`);
        const { version } = (await r.json()) as { version: number };
        if (version !== versionRef.current) {
          const fr = await fetch(`/api/sessions/${id}`, { cache: "no-store" });
          if (cancelled) return;
          if (fr.status === 404) {
            setError("Session expired or not found.");
            return;
          }
          if (fr.ok) {
            const full = (await fr.json()) as SessionState;
            setState(full);
            versionRef.current = version;
            lastBumpRef.current = Date.now();
            setClaudeActive(true);
          }
        } else if (Date.now() - lastBumpRef.current > ACTIVITY_TIMEOUT_MS) {
          setClaudeActive(false);
        }
      } catch (e) {
        console.warn("session poll failed", e);
      }
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  if (!id) {
    return (
      <FullPageMessage>
        Missing <code>?id=</code> query parameter.
      </FullPageMessage>
    );
  }
  if (error) return <FullPageMessage variant="error">{error}</FullPageMessage>;
  if (!state) return <FullPageMessage>Loading session {id}…</FullPageMessage>;

  return <SessionView state={state} claudeActive={claudeActive} />;
}

function FullPageMessage({
  children,
  variant = "info",
}: {
  children: React.ReactNode;
  variant?: "info" | "error";
}) {
  return (
    <div
      className={cn(
        "min-h-screen flex items-center justify-center text-sm",
        variant === "error" ? "text-red-600" : "text-gray-600"
      )}
    >
      {children}
    </div>
  );
}

// ─── View ─────────────────────────────────────────────────────────────────
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const ZOOM_PRESETS = [1, 2, 4] as const;
const PREVIEW_BASE_MAX = 2000;

function SessionView({
  state,
  claudeActive,
}: {
  state: SessionState;
  claudeActive: boolean;
}) {
  return (
    <div className="min-h-screen flex bg-neutral-50 text-neutral-900">
      <main className="flex-1 relative overflow-hidden bg-neutral-100">
        <ChartCanvas state={state} />
        {state.scratchHtml && <ScratchPanel scratch={state.scratchHtml} />}
      </main>
      <aside className="w-96 shrink-0 border-l bg-white overflow-y-auto">
        <Sidebar state={state} claudeActive={claudeActive} />
      </aside>
    </div>
  );
}

// ─── Canvas ───────────────────────────────────────────────────────────────
/**
 * Zoomable / pannable chart view.
 *
 *  - Default (zoom=1): low-res preview (~2.3 MB PNG) fits the container.
 *  - Cmd/Ctrl + wheel and macOS pinch (which fires `wheel` with ctrlKey)
 *    smooth-zoom around the cursor.
 *  - Plain wheel = native scroll (pan).
 *  - When zoom > 1 the user can also drag the chart with the mouse.
 *  - Image src `max=` is recomputed on zoom change (debounced) so the
 *    server hands us just enough resolution for the displayed device px.
 */
function ChartCanvas({ state }: { state: SessionState }) {
  const [w, h] = state.imageNaturalSize;
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [zoom, setZoom] = useState<number>(1);
  const [imgMax, setImgMax] = useState<number>(PREVIEW_BASE_MAX);

  // Track container width (drives base display size).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pick a server max-edge based on zoom × container × DPR.
  // Clamped to PREVIEW_BASE_MAX min and natural width (no upscaling).
  useEffect(() => {
    if (containerW === 0) return;
    const dpr =
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const wanted = Math.round(containerW * zoom * dpr);
    const naturalMax = Math.max(w, h);
    const clamped = Math.min(naturalMax, Math.max(PREVIEW_BASE_MAX, wanted));
    // Snap to coarse buckets so wheel-zoom doesn't fire 60 distinct fetches.
    const snap = (v: number) => {
      if (v <= 2000) return 2000;
      if (v <= 3000) return 3000;
      if (v <= 4000) return 4000;
      if (v <= 6000) return 6000;
      if (v <= 8000) return 8000;
      return naturalMax;
    };
    const next = snap(clamped);
    const t = window.setTimeout(() => setImgMax(next), 180);
    return () => window.clearTimeout(t);
  }, [zoom, containerW, w, h]);

  const imageSrc = `/api/sessions/${state.id}/image?rev=${state.imageRevision}&max=${imgMax}&fmt=png`;

  // Display geometry (CSS px). Width drives everything; SVG uses image-px viewBox.
  const dispW = containerW * zoom;
  const dispH = containerW > 0 ? (containerW * zoom * h) / w : 0;

  // ── Zoom interaction ───────────────────────────────────────────────────
  // Ref mirrors zoom so the once-bound native wheel listener can read fresh.
  const zoomRefMirror = useRef(zoom);
  zoomRefMirror.current = zoom;
  const zoomAround = (newZoom: number, anchorX: number, anchorY: number) => {
    const el = containerRef.current;
    if (!el) {
      setZoom(newZoom);
      return;
    }
    const z0 = zoomRefMirror.current;
    const z1 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
    if (z1 === z0) return;
    const sl0 = el.scrollLeft;
    const st0 = el.scrollTop;
    const cx = sl0 + anchorX;
    const cy = st0 + anchorY;
    const ratio = z1 / z0;
    zoomRefMirror.current = z1;
    setZoom(z1);
    requestAnimationFrame(() => {
      const e2 = containerRef.current;
      if (!e2) return;
      e2.scrollLeft = Math.max(0, cx * ratio - anchorX);
      e2.scrollTop = Math.max(0, cy * ratio - anchorY);
    });
  };

  // React's onWheel is registered as passive (preventDefault no-op). Bind a
  // non-passive native listener instead so we can suppress browser zoom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ax = e.clientX - rect.left;
      const ay = e.clientY - rect.top;
      const step = Math.exp(-e.deltaY * 0.0025);
      zoomAround(zoomRefMirror.current * step, ax, ay);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Safari iOS / iPadOS pinch fires gesturestart/change/end (not wheel).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let baseZoom = 1;
    let baseX = 0,
      baseY = 0;
    const onGS = (e: Event) => {
      const ge = e as Event & { scale?: number; clientX?: number; clientY?: number };
      e.preventDefault();
      baseZoom = zoomRefMirror.current;
      const rect = el.getBoundingClientRect();
      baseX = (ge.clientX ?? rect.left + rect.width / 2) - rect.left;
      baseY = (ge.clientY ?? rect.top + rect.height / 2) - rect.top;
    };
    const onGC = (e: Event) => {
      const ge = e as Event & { scale?: number };
      if (typeof ge.scale !== "number") return;
      e.preventDefault();
      zoomAround(baseZoom * ge.scale, baseX, baseY);
    };
    el.addEventListener("gesturestart", onGS as EventListener, { passive: false });
    el.addEventListener("gesturechange", onGC as EventListener, { passive: false });
    return () => {
      el.removeEventListener("gesturestart", onGS as EventListener);
      el.removeEventListener("gesturechange", onGC as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mouse drag pan (when zoomed) ───────────────────────────────────────
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(
    null
  );
  const [dragging, setDragging] = useState(false);
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (zoom <= 1.0001) return;
    const el = containerRef.current;
    if (!el) return;
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      sl: el.scrollLeft,
      st: el.scrollTop,
    };
    setDragging(true);
  };
  useEffect(() => {
    if (!dragging) return;
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      const el = containerRef.current;
      if (!d || !el) return;
      el.scrollLeft = d.sl - (ev.clientX - d.x);
      el.scrollTop = d.st - (ev.clientY - d.y);
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const setPreset = (z: number) => {
    const el = containerRef.current;
    if (!el) {
      setZoom(z);
      return;
    }
    const ax = el.clientWidth / 2;
    const ay = el.clientHeight / 2;
    zoomAround(z, ax, ay);
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={onMouseDown}
      className={cn(
        "absolute inset-0 overflow-auto select-none",
        zoom > 1.0001
          ? dragging
            ? "cursor-grabbing"
            : "cursor-grab"
          : "cursor-default"
      )}
      style={{ overscrollBehavior: "contain" }}
    >
      <div
        ref={contentRef}
        className="relative"
        style={{
          width: dispW || "100%",
          height: dispH || "auto",
          margin: zoom <= 1.0001 ? "0 auto" : "0",
          transform: `rotate(${state.rotationDeg}deg)`,
          transformOrigin: "center center",
        }}
      >
        {dispW > 0 && (
          <>
            <img
              src={imageSrc}
              alt="scan"
              draggable={false}
              className="block w-full h-auto pointer-events-none"
              style={{ aspectRatio: `${w} / ${h}` }}
            />
            <svg
              viewBox={`0 0 ${w} ${h}`}
              preserveAspectRatio="xMidYMid meet"
              className="absolute inset-0 w-full h-full pointer-events-none"
            >
              <defs>
                <marker
                  id="arrowhead"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                </marker>
              </defs>
              <PolylinesLayer polylines={state.polylines} />
              <ROIsLayer rois={state.rois} />
              <AnnotationsLayer annotations={state.annotations} />
              <CalibrationLayer corners={state.calibration} />
              <DataPointsLayer points={state.dataPoints} />
            </svg>
          </>
        )}
      </div>
      <ZoomToolbar zoom={zoom} setPreset={setPreset} imgMax={imgMax} />
    </div>
  );
}

function ZoomToolbar({
  zoom,
  setPreset,
  imgMax,
}: {
  zoom: number;
  setPreset: (z: number) => void;
  imgMax: number;
}) {
  return (
    <div className="absolute bottom-3 left-3 z-20 flex items-center gap-1 rounded-md border border-neutral-200 bg-white/95 backdrop-blur-sm shadow-sm px-1 py-1 text-[11px] font-mono">
      <button
        type="button"
        onClick={() => setPreset(1)}
        className={cn(
          "px-2 py-0.5 rounded hover:bg-neutral-100",
          Math.abs(zoom - 1) < 0.01 && "bg-neutral-200 text-neutral-900"
        )}
        title="Fit"
      >
        Fit
      </button>
      {ZOOM_PRESETS.map((z) => (
        <button
          key={z}
          type="button"
          onClick={() => setPreset(z)}
          className={cn(
            "px-2 py-0.5 rounded hover:bg-neutral-100",
            Math.abs(zoom - z) < 0.01 && "bg-neutral-200 text-neutral-900"
          )}
          title={`${z}× zoom`}
        >
          {z}×
        </button>
      ))}
      <span className="ml-1 text-neutral-400 text-[10px]">
        {zoom.toFixed(2)}× · {imgMax}px
      </span>
    </div>
  );
}

function PolylinesLayer({ polylines }: { polylines: SessionPolyline[] }) {
  return (
    <g>
      {polylines.map((p, i) => {
        const stroke =
          p.weight === "major"
            ? "#0066cc"
            : p.weight === "minor"
            ? "#66aadd"
            : "#aaccee";
        const sw = p.weight === "major" ? 3 : p.weight === "minor" ? 1.5 : 0.8;
        return (
          <polyline
            key={i}
            points={p.points.map(([x, y]) => `${x},${y}`).join(" ")}
            stroke={stroke}
            strokeWidth={sw}
            fill="none"
            opacity={0.55}
          />
        );
      })}
    </g>
  );
}

function ROIsLayer({ rois }: { rois: SessionROI[] }) {
  return (
    <g>
      {rois.map((r) => {
        const color = r.color || "#ff8800";
        return (
          <g key={r.id}>
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              stroke={color}
              strokeWidth={3}
              strokeDasharray="8 4"
              fill="rgba(255,136,0,0.06)"
            />
            {r.label && (
              <text
                x={r.x + 6}
                y={r.y - 6}
                fill={color}
                fontSize={Math.max(11, r.h * 0.06)}
                fontWeight={600}
                stroke="white"
                strokeWidth={2}
                paintOrder="stroke"
              >
                {r.label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function AnnotationsLayer({
  annotations,
}: {
  annotations: SessionAnnotation[];
}) {
  return (
    <g>
      {annotations.map((a) => (
        <Annotation key={a.id} a={a} />
      ))}
    </g>
  );
}

function Annotation({ a }: { a: SessionAnnotation }) {
  const stroke = a.stroke || "#ff0000";
  const fill = a.fill ?? "none";
  const sw = a.strokeWidth ?? 2;

  switch (a.type) {
    case "stroke":
    case "polyline": {
      const pts = (a.points || []).map(([x, y]) => `${x},${y}`).join(" ");
      return (
        <polyline points={pts} stroke={stroke} strokeWidth={sw} fill={fill} />
      );
    }
    case "line": {
      const pts = a.points || [];
      if (pts.length < 2) return null;
      const [p1, p2] = pts;
      return (
        <line
          x1={p1[0]}
          y1={p1[1]}
          x2={p2[0]}
          y2={p2[1]}
          stroke={stroke}
          strokeWidth={sw}
        />
      );
    }
    case "arrow": {
      const pts = a.points || [];
      if (pts.length < 2) return null;
      const [p1, p2] = pts;
      return (
        <line
          x1={p1[0]}
          y1={p1[1]}
          x2={p2[0]}
          y2={p2[1]}
          stroke={stroke}
          strokeWidth={sw}
          markerEnd="url(#arrowhead)"
        />
      );
    }
    case "circle":
      if (a.cx == null || a.cy == null || a.r == null) return null;
      return (
        <circle
          cx={a.cx}
          cy={a.cy}
          r={a.r}
          stroke={stroke}
          strokeWidth={sw}
          fill={fill}
        />
      );
    case "rect":
      if (a.x == null || a.y == null || a.w == null || a.h == null) return null;
      return (
        <rect
          x={a.x}
          y={a.y}
          width={a.w}
          height={a.h}
          stroke={stroke}
          strokeWidth={sw}
          fill={fill}
        />
      );
    case "text":
      if (a.x == null || a.y == null || !a.text) return null;
      return (
        <text
          x={a.x}
          y={a.y}
          fill={fill === "none" ? stroke : fill}
          fontSize={a.fontSize ?? 14}
          fontWeight={600}
          stroke="white"
          strokeWidth={2.5}
          paintOrder="stroke"
        >
          {a.text}
        </text>
      );
    default:
      return null;
  }
}

function CalibrationLayer({ corners }: { corners: SessionCalibration[] }) {
  return (
    <g>
      {corners.map((c, i) => (
        <g key={i}>
          <circle
            cx={c.imgX}
            cy={c.imgY}
            r={9}
            fill="#16a34a"
            stroke="white"
            strokeWidth={2}
          />
          <text
            x={c.imgX + 12}
            y={c.imgY - 8}
            fill="#15803d"
            fontSize={12}
            fontWeight={600}
            stroke="white"
            strokeWidth={2}
            paintOrder="stroke"
          >
            ({c.chartX.toFixed(0)}, {c.chartY.toFixed(0)})
          </text>
        </g>
      ))}
    </g>
  );
}

function DataPointsLayer({ points }: { points: SessionDataPoint[] }) {
  const visible = points.filter(
    (p) => p.canvasX != null && p.canvasY != null
  );
  return (
    <g>
      {visible.map((p, i) => (
        <circle
          key={i}
          cx={p.canvasX!}
          cy={p.canvasY!}
          r={3}
          fill="#0080ff"
          opacity={0.85}
        />
      ))}
    </g>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────
function Sidebar({
  state,
  claudeActive,
}: {
  state: SessionState;
  claudeActive: boolean;
}) {
  const minutesLeft = Math.max(
    0,
    Math.floor((state.expiresAt - Date.now() / 1000) / 60)
  );

  return (
    <div className="p-4 space-y-5 text-sm">
      <header className="space-y-2">
        <div className="flex items-center justify-between">
          <code className="text-[11px] font-mono text-neutral-500">
            {state.id}
          </code>
          <span className="text-[11px] uppercase tracking-wide text-neutral-500">
            {state.chartType}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block w-2 h-2 rounded-full transition-colors",
              claudeActive
                ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"
                : "bg-neutral-300"
            )}
          />
          <span className="text-xs text-neutral-700">
            {claudeActive ? "Claude active" : "Idle"}
          </span>
          <span className="ml-auto text-[11px] text-neutral-500">
            v{state.version} · {minutesLeft} min left
          </span>
        </div>
      </header>

      <StatGrid state={state} />

      <ChatSection
        sessionId={state.id}
        messages={state.chatMessages}
      />

      <PanelsSection panels={state.panels} />

      <NotesSection notes={state.notes} />
    </div>
  );
}

function StatGrid({ state }: { state: SessionState }) {
  const [w, h] = state.imageNaturalSize;
  const cells: { label: string; value: string }[] = [
    { label: "image", value: `${w}×${h}` },
    { label: "rotation", value: `${state.rotationDeg.toFixed(2)}°` },
    { label: "corners", value: String(state.calibration.length) },
    { label: "annotations", value: String(state.annotations.length) },
    { label: "ROIs", value: String(state.rois.length) },
    { label: "data pts", value: String(state.dataPoints.length) },
  ];
  return (
    <div className="grid grid-cols-3 gap-1 text-[11px]">
      {cells.map((c) => (
        <div
          key={c.label}
          className="border border-neutral-200 rounded px-2 py-1.5 bg-neutral-50"
        >
          <div className="uppercase text-neutral-500 tracking-wide text-[10px]">
            {c.label}
          </div>
          <div className="font-mono text-neutral-900 text-xs">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function PanelsSection({ panels }: { panels: Record<string, string> }) {
  const entries = Object.entries(panels);
  if (entries.length === 0) return null;
  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        Panels
      </h3>
      {entries.map(([name, md]) => (
        <details
          key={name}
          open
          className="border border-neutral-200 rounded bg-neutral-50"
        >
          <summary className="cursor-pointer px-3 py-2 text-xs font-mono text-neutral-700 hover:bg-neutral-100">
            {name}
          </summary>
          <pre className="px-3 py-2 text-xs whitespace-pre-wrap font-mono text-neutral-800 border-t border-neutral-200 max-h-64 overflow-auto">
            {md}
          </pre>
        </details>
      ))}
    </section>
  );
}

// ─── Chat ─────────────────────────────────────────────────────────────────
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

type PendingAttachment = {
  key: string;
  file: File;
  previewUrl: string;
};

function ChatSection({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: SessionChatMessage[];
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // Auto-scroll to bottom when messages arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Revoke object URLs when pending list changes/unmounts
  useEffect(() => {
    return () => {
      pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    };
  }, [pending]);

  const acceptFiles = (files: FileList | File[]) => {
    setErr(null);
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (arr.length === 0) return;
    const tooBig = arr.find((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (tooBig) {
      setErr(`Image too large (max 5 MB): ${tooBig.name}`);
      return;
    }
    setPending((prev) => {
      const room = MAX_ATTACHMENTS - prev.length;
      if (room <= 0) {
        setErr(`Max ${MAX_ATTACHMENTS} attachments per message`);
        return prev;
      }
      const add = arr.slice(0, room).map((f) => ({
        key: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`,
        file: f,
        previewUrl: URL.createObjectURL(f),
      }));
      return [...prev, ...add];
    });
  };

  const removePending = (key: string) => {
    setPending((prev) => {
      const out = prev.filter((p) => p.key !== key);
      const removed = prev.find((p) => p.key === key);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return out;
    });
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f && f.type.startsWith("image/")) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      acceptFiles(files);
    }
  };

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
      e.preventDefault();
      dragDepth.current += 1;
      setDragOver(true);
    }
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
      e.preventDefault();
    }
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files?.length) acceptFiles(files);
  };

  const fileToBase64 = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.onload = () => {
        const r = reader.result;
        if (typeof r !== "string") return reject(new Error("not a string"));
        const i = r.indexOf(",");
        resolve(i >= 0 ? r.slice(i + 1) : r);
      };
      reader.readAsDataURL(f);
    });

  const send = async () => {
    const text = draft.trim();
    if ((!text && pending.length === 0) || sending) return;
    setSending(true);
    setErr(null);
    try {
      const imagesBase64 = pending.length
        ? await Promise.all(pending.map((p) => fileToBase64(p.file)))
        : undefined;
      const r = await fetch(`/api/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, imagesBase64 }),
      });
      if (!r.ok) {
        let detail = `chat failed (${r.status})`;
        try {
          const j = await r.json();
          if (j.detail) detail = String(j.detail);
        } catch {}
        throw new Error(detail);
      }
      setDraft("");
      pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setPending([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "chat failed");
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const canSend = (draft.trim().length > 0 || pending.length > 0) && !sending;

  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        Chat
      </h3>
      <div
        ref={scrollRef}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "relative border rounded-lg p-3 max-h-80 overflow-y-auto space-y-3 transition-colors",
          dragOver
            ? "border-blue-400 bg-blue-50/60"
            : "border-neutral-200 bg-gradient-to-b from-neutral-50 to-white"
        )}
      >
        {messages.length === 0 ? (
          <div className="text-[11px] text-neutral-400 italic px-1 py-3 text-center">
            no messages yet — Claude posts here when it has updates
          </div>
        ) : (
          messages.map((m, i) => (
            <ChatBubble key={i} m={m} />
          ))
        )}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] font-medium text-blue-700 bg-blue-100/40">
            drop image to attach
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1">
          {pending.map((p) => (
            <PendingThumb
              key={p.key}
              p={p}
              onRemove={() => removePending(p.key)}
            />
          ))}
        </div>
      )}

      <div className="flex gap-1 items-end">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending || pending.length >= MAX_ATTACHMENTS}
          title="Attach image"
          className={cn(
            "shrink-0 h-[36px] w-9 rounded text-neutral-600 hover:bg-neutral-100 transition-colors flex items-center justify-center",
            (sending || pending.length >= MAX_ATTACHMENTS) &&
              "opacity-40 cursor-not-allowed"
          )}
        >
          <PaperclipIcon />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) acceptFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder="Reply to Claude…   (paste / drop / attach images)"
          rows={2}
          className="flex-1 text-[12px] border border-neutral-200 rounded px-2 py-1.5 resize-none font-sans focus:outline-none focus:border-neutral-400"
          disabled={sending}
        />
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          className={cn(
            "shrink-0 h-[36px] px-3 rounded text-[12px] font-medium transition-colors",
            canSend
              ? "bg-neutral-900 text-white hover:bg-neutral-700"
              : "bg-neutral-200 text-neutral-400 cursor-not-allowed"
          )}
        >
          {sending ? "…" : "Send"}
        </button>
      </div>
      {err && <div className="text-[11px] text-red-600">{err}</div>}
    </section>
  );
}

function PaperclipIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.99 8.83l-8.57 8.57a2 2 0 0 1-2.83-2.83l7.86-7.86" />
    </svg>
  );
}

function PendingThumb({
  p,
  onRemove,
}: {
  p: PendingAttachment;
  onRemove: () => void;
}) {
  return (
    <div className="relative group">
      <img
        src={p.previewUrl}
        alt="pending attachment"
        className="h-14 w-14 object-cover rounded border border-neutral-300"
      />
      <button
        type="button"
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-neutral-900 text-white text-[11px] leading-[18px] text-center shadow opacity-90 hover:opacity-100"
        title="Remove"
      >
        ×
      </button>
    </div>
  );
}

// ─── Tiny markdown renderer (chat-scoped) ─────────────────────────────────
// Handles inline **bold**, *italic*, `code`, [label](url), bulleted/numbered
// lists, and paragraphs. No nesting, no headings, no code-blocks — chat
// messages don't need them. Plain text only ⇒ no XSS surface.
function renderInline(text: string, dark: boolean): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re =
    /(\*\*([^*]+?)\*\*|(?<![A-Za-z0-9])\*([^*\n]+?)\*(?![A-Za-z0-9])|`([^`]+?)`|\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null) {
      out.push(<strong key={`b${key++}`}>{m[2]}</strong>);
    } else if (m[3] != null) {
      out.push(<em key={`i${key++}`}>{m[3]}</em>);
    } else if (m[4] != null) {
      out.push(
        <code
          key={`c${key++}`}
          className={cn(
            "px-1 py-px rounded font-mono text-[11px]",
            dark ? "bg-white/15 text-white" : "bg-neutral-100 text-neutral-800"
          )}
        >
          {m[4]}
        </code>
      );
    } else if (m[5] != null && m[6] != null) {
      out.push(
        <a
          key={`a${key++}`}
          href={m[6]}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "underline underline-offset-2 hover:no-underline",
            dark ? "text-white" : "text-blue-600"
          )}
        >
          {m[5]}
        </a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function MarkdownText({ text, dark }: { text: string; dark: boolean }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  return (
    <div className="space-y-1.5">
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter((l) => l.trim().length > 0);
        if (lines.length === 0) return null;
        const isUL = lines.every((l) => /^\s*[-*]\s+/.test(l));
        const isOL = lines.every((l) => /^\s*\d+\.\s+/.test(l));
        if (isUL) {
          return (
            <ul key={bi} className="list-disc pl-4 space-y-0.5 marker:text-current/60">
              {lines.map((l, li) => (
                <li key={li}>{renderInline(l.replace(/^\s*[-*]\s+/, ""), dark)}</li>
              ))}
            </ul>
          );
        }
        if (isOL) {
          return (
            <ol key={bi} className="list-decimal pl-5 space-y-0.5 marker:text-current/60">
              {lines.map((l, li) => (
                <li key={li}>{renderInline(l.replace(/^\s*\d+\.\s+/, ""), dark)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={bi} className="whitespace-pre-line break-words">
            {renderInline(block, dark)}
          </p>
        );
      })}
    </div>
  );
}

function fmtChatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mo}. ${hh}:${mm}`;
}

function ChatBubble({ m }: { m: SessionChatMessage }) {
  const [lightbox, setLightbox] = useState<SessionChatAttachment | null>(null);
  const isUser = m.by === "user";
  const isClaude = m.by === "claude";
  const senderLabel = isUser ? "You" : isClaude ? "Claude" : "System";
  const initial = isUser ? "U" : isClaude ? "C" : "S";
  return (
    <>
      <div
        className={cn(
          "flex gap-2 items-end",
          isUser ? "flex-row-reverse" : "flex-row"
        )}
      >
        <div
          className={cn(
            "shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold tracking-wide",
            isUser
              ? "bg-blue-500 text-white shadow-sm"
              : isClaude
              ? "bg-gradient-to-br from-purple-500 to-fuchsia-500 text-white shadow-sm"
              : "bg-neutral-300 text-neutral-700"
          )}
          aria-hidden
        >
          {initial}
        </div>
        <div
          className={cn(
            "flex flex-col min-w-0 max-w-[85%]",
            isUser ? "items-end" : "items-start"
          )}
        >
          <div
            className={cn(
              "flex items-baseline gap-1.5 mb-0.5 px-0.5",
              isUser ? "flex-row-reverse" : "flex-row"
            )}
          >
            <span
              className={cn(
                "text-[10px] font-semibold tracking-wide",
                isUser
                  ? "text-blue-700"
                  : isClaude
                  ? "text-purple-700"
                  : "text-neutral-600"
              )}
            >
              {senderLabel}
            </span>
            <span className="text-[10px] text-neutral-400 tabular-nums">
              {fmtChatTime(m.ts)}
            </span>
          </div>
          <div
            className={cn(
              "rounded-2xl px-3 py-2 text-[12px] leading-relaxed break-words space-y-1.5 shadow-sm",
              isUser
                ? "bg-blue-500 text-white rounded-br-md"
                : isClaude
                ? "bg-white border border-neutral-200 text-neutral-900 rounded-bl-md"
                : "bg-neutral-100 border border-neutral-200 text-neutral-700 rounded-bl-md italic"
            )}
          >
            {m.text && <MarkdownText text={m.text} dark={isUser} />}
            {m.attachments && m.attachments.length > 0 && (
              <div className="grid grid-cols-2 gap-1 max-w-[260px]">
                {m.attachments.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setLightbox(a)}
                    className="block overflow-hidden rounded-md border border-black/10 bg-black/5 hover:opacity-90 transition-opacity"
                  >
                    <img
                      src={a.url}
                      alt="attachment"
                      className="block w-full h-auto max-h-32 object-cover"
                      loading="lazy"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox.url}
            alt="attachment full"
            className="max-w-full max-h-full object-contain shadow-2xl"
          />
          <button
            type="button"
            className="absolute top-3 right-3 text-white/80 hover:text-white text-2xl leading-none"
            onClick={() => setLightbox(null)}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

function NotesSection({ notes }: { notes: SessionNote[] }) {
  if (notes.length === 0) return null;
  const recent = notes.slice(-30).reverse();
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        Activity
      </h3>
      <div className="space-y-1 max-h-96 overflow-y-auto pr-1">
        {recent.map((n, i) => (
          <div key={i} className="text-[12px] flex gap-2">
            <span
              className={cn(
                "shrink-0 px-1.5 rounded text-[10px] font-mono uppercase tracking-wide text-white leading-relaxed h-fit mt-0.5",
                n.by === "claude"
                  ? "bg-purple-500"
                  : n.by === "user"
                  ? "bg-blue-500"
                  : "bg-neutral-400"
              )}
            >
              {n.by}
            </span>
            <span className="text-neutral-700 leading-relaxed">{n.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Scratch panel (sandboxed iframe) ─────────────────────────────────────
function ScratchPanel({ scratch }: { scratch: ScratchHTML }) {
  const srcDoc = useMemo(() => {
    const css = scratch.css ? `<style>${scratch.css}</style>` : "";
    const js = scratch.js ? `<script>${scratch.js}</script>` : "";
    return `<!doctype html>
<html>
<head><meta charset="utf-8" />${css}</head>
<body style="margin:0;font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#111;padding:8px">
${scratch.html}
${js}
</body>
</html>`;
  }, [scratch]);

  return (
    <div className="fixed bottom-3 left-3 right-[25rem] z-30 rounded-lg border border-neutral-200 bg-white shadow-xl overflow-hidden">
      <div className="h-7 px-3 flex items-center justify-between bg-neutral-100 border-b border-neutral-200 text-[11px] font-mono text-neutral-600">
        <span>scratch.html</span>
        <span className="text-neutral-400">sandbox=allow-scripts</span>
      </div>
      <iframe
        title="scratch"
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        className="w-full bg-white"
        style={{ height: 240 }}
      />
    </div>
  );
}
