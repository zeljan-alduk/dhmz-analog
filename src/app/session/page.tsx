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

type SessionChatMessage = {
  ts: number; by: "claude" | "user"; text: string;
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
function SessionView({
  state,
  claudeActive,
}: {
  state: SessionState;
  claudeActive: boolean;
}) {
  const imageSrc = `/api/sessions/${state.id}/image?rev=${state.imageRevision}`;

  return (
    <div className="min-h-screen flex bg-neutral-50 text-neutral-900">
      <main className="flex-1 relative overflow-auto p-6">
        <ChartCanvas state={state} imageSrc={imageSrc} />
        {state.scratchHtml && <ScratchPanel scratch={state.scratchHtml} />}
      </main>
      <aside className="w-96 shrink-0 border-l bg-white overflow-y-auto">
        <Sidebar state={state} claudeActive={claudeActive} />
      </aside>
    </div>
  );
}

// ─── Canvas ───────────────────────────────────────────────────────────────
function ChartCanvas({
  state,
  imageSrc,
}: {
  state: SessionState;
  imageSrc: string;
}) {
  const [w, h] = state.imageNaturalSize;
  // Fit-to-width display while preserving aspect — rotation rendered via CSS.
  const wrapStyle: React.CSSProperties = {
    transform: `rotate(${state.rotationDeg}deg)`,
    transformOrigin: "center center",
  };

  return (
    <div className="inline-block w-full">
      <div
        className="relative mx-auto"
        style={{ ...wrapStyle, maxWidth: "100%" }}
      >
        <img
          src={imageSrc}
          alt="scan"
          width={w}
          height={h}
          draggable={false}
          className="block max-w-full h-auto"
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
      </div>
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
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setErr(null);
    try {
      const r = await fetch(`/api/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error(`chat failed (${r.status})`);
      setDraft("");
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

  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        Chat
      </h3>
      <div
        ref={scrollRef}
        className="border border-neutral-200 rounded bg-neutral-50 p-2 max-h-72 overflow-y-auto space-y-2"
      >
        {messages.length === 0 ? (
          <div className="text-[11px] text-neutral-400 italic px-1 py-2 text-center">
            no messages yet — Claude posts here when it has updates
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={cn(
                "flex",
                m.by === "user" ? "justify-end" : "justify-start"
              )}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words",
                  m.by === "user"
                    ? "bg-blue-500 text-white"
                    : "bg-white border border-neutral-200 text-neutral-900"
                )}
              >
                {m.text}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="flex gap-1">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder="Reply to Claude…"
          rows={2}
          className="flex-1 text-[12px] border border-neutral-200 rounded px-2 py-1.5 resize-none font-sans focus:outline-none focus:border-neutral-400"
          disabled={sending}
        />
        <button
          type="button"
          onClick={send}
          disabled={!draft.trim() || sending}
          className={cn(
            "shrink-0 px-3 rounded text-[12px] font-medium transition-colors",
            draft.trim() && !sending
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
