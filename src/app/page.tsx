"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  ChartType,
  CalibrationPoint,
  DataPoint,
  WorkflowStep,
} from "@/lib/types";
import {
  CHART_CONFIGS,
  getDisplaySize,
  getDayName,
  formatHour,
} from "@/lib/chart-geometry";
import { computeAffineTransform } from "@/lib/transform";
import {
  runAutoCalibration,
  computeGridMaskUrl,
  type AutoCalibrationResult,
  type DetectionConfig,
  DETECTION_DEFAULTS,
} from "@/lib/auto-calibration";
import { vectorizeMaskFromUrl, type VectorPolyline } from "@/lib/vectorize";
import { ImageUpload } from "@/components/image-upload/ImageUpload";
import { OverlayCanvas } from "@/components/overlay-canvas/OverlayCanvas";
import { DataTable } from "@/components/data-table/DataTable";
import { useTheme } from "@/components/ThemeProvider";
import {
  SessionBanner,
  type SessionInfo,
} from "@/components/session-banner/SessionBanner";
import {
  Gauge,
  Droplets,
  Thermometer,
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  Crosshair,
  MousePointerClick,
  Sun,
  Moon,
  Monitor,
  Layers,
  Eye,
  Sparkles,
  AlertTriangle,
  RotateCw,
  FlipVertical,
  Settings2,
  ChevronDown,
  Spline,
  ImageOff,
} from "lucide-react";

const CHART_OPTIONS: {
  type: ChartType;
  label: string;
  sublabel: string;
  description: string;
  icon: React.ReactNode;
  gradient: string;
}[] = [
  {
    type: "barograph",
    label: "Barograf",
    sublabel: "Atmospheric Pressure",
    description: "Tlak zraka",
    icon: <Gauge className="w-7 h-7" />,
    gradient: "from-teal-500/20 to-cyan-500/20 dark:from-teal-500/10 dark:to-cyan-500/10",
  },
  {
    type: "hygrograph",
    label: "Higrograf",
    sublabel: "Relative Humidity",
    description: "Relativna vlažnost",
    icon: <Droplets className="w-7 h-7" />,
    gradient: "from-blue-500/20 to-indigo-500/20 dark:from-blue-500/10 dark:to-indigo-500/10",
  },
  {
    type: "thermograph",
    label: "Termograf",
    sublabel: "Temperature",
    description: "Temperatura zraka",
    icon: <Thermometer className="w-7 h-7" />,
    gradient: "from-orange-500/20 to-rose-500/20 dark:from-orange-500/10 dark:to-rose-500/10",
  },
];

const STEPS: { key: WorkflowStep; label: string }[] = [
  { key: "select", label: "Instrument" },
  { key: "upload", label: "Učitavanje" },
  { key: "calibrate", label: "Kalibracija" },
  { key: "digitize", label: "Digitalizacija" },
];

/**
 * Rotate the image at `srcUrl` by `degrees` and return a fresh blob URL of
 * the result. Caller is responsible for revoking the URL when no longer
 * needed (we track them in *UrlsRef arrays for handleReset).
 */
async function rotateUrlToBlob(
  srcUrl: string,
  degrees: number
): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("rotate: load failed"));
    i.src = srcUrl;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const rad = (degrees * Math.PI) / 180;
  const cosA = Math.abs(Math.cos(rad));
  const sinA = Math.abs(Math.sin(rad));
  const newW = Math.round(w * cosA + h * sinA);
  const newH = Math.round(w * sinA + h * cosA);
  const canvas = document.createElement("canvas");
  canvas.width = newW;
  canvas.height = newH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("rotate: no canvas ctx");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, newW, newH);
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -h / 2);
  const blob: Blob | null = await new Promise((r) =>
    canvas.toBlob(r, "image/png")
  );
  if (!blob) throw new Error("rotate: toBlob null");
  return URL.createObjectURL(blob);
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const items: { value: "light" | "dark" | "system"; icon: React.ReactNode }[] = [
    { value: "light", icon: <Sun className="w-3.5 h-3.5" /> },
    { value: "system", icon: <Monitor className="w-3.5 h-3.5" /> },
    { value: "dark", icon: <Moon className="w-3.5 h-3.5" /> },
  ];
  return (
    <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
      {items.map((it) => (
        <button
          key={it.value}
          onClick={() => setTheme(it.value)}
          className={`p-1.5 rounded-md transition-all duration-200 ${
            theme === it.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {it.icon}
        </button>
      ))}
    </div>
  );
}

export default function Home() {
  const [step, setStep] = useState<WorkflowStep>("select");
  const [chartType, setChartType] = useState<ChartType | null>(null);
  // Two-tier image storage:
  //   - originalImageUrl: untouched full-res upload blob. Rotated lazily for
  //     backend calls and high-zoom canvas display.
  //   - previewSourceUrl: ≤PREVIEW_MAX_EDGE downscale of the upload. Rotated
  //     eagerly on every angle change for snappy UI.
  // Both are set once on upload. The rotated derivatives are imageUrl and
  // fullResUrl below.
  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);
  const [previewSourceUrl, setPreviewSourceUrl] = useState<string | null>(null);
  // Session created against /api/sessions after upload. When set, the
  // SessionBanner modal is shown so the user can hand the URL to Claude.
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [sessionBannerOpen, setSessionBannerOpen] = useState(false);
  // True from the moment we start POST /api/sessions until we get a
  // response (or fail). Drives the small "preparing session" pill so the
  // user has visible feedback during the multi-second base64 upload.
  const [sessionCreating, setSessionCreating] = useState(false);
  // Rotation in degrees — combined coarse (90° buttons) and fine (slider).
  const [rotationAngle, setRotationAngle] = useState(0);
  // Derived: previewSourceUrl rotated by rotationAngle. Used for display in
  // the canvas, JS-side mask compute, and JS-side auto-cal (which all
  // downscale internally anyway).
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Derived: originalImageUrl rotated by rotationAngle. Used for backend
  // calls and high-zoom canvas display. Computed with a debounce so that
  // dragging the angle slider doesn't queue 60 MB rotations on every tick.
  const [fullResUrl, setFullResUrl] = useState<string | null>(null);
  const [calibrationPoints, setCalibrationPoints] = useState<CalibrationPoint[]>([]);
  const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
  // Detection mask overlay opacity (replaces the old SVG-template overlay).
  const [maskOpacity, setMaskOpacity] = useState(0.5);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  // Underlying image opacity. 1 = normal; 0 = mask-only inspection mode.
  const [imageOpacity, setImageOpacity] = useState(1);
  // Vectorized polylines (display-px) — populated by handleVectorize.
  const [tracePolylines, setTracePolylines] = useState<VectorPolyline[] | null>(
    null
  );
  const [vectorizing, setVectorizing] = useState(false);
  // Per-category visibility flags. The vectorizer tags each polyline with
  // axis (horizontal/vertical) and grid weight (major/minor/fine), so we
  // can filter the rendered set without re-running detection.
  const [lineVisibility, setLineVisibility] = useState({
    hMajor: true,
    hMinor: true,
    hFine: true,
    vMajor: true,
    vMinor: true,
    vFine: true,
  });
  // Horizontal baseline reference for rotation alignment.
  const [showBaseline, setShowBaseline] = useState(false);
  const [isRotating, setIsRotating] = useState(false);

  // Rectified preview — backend warps the image to chart-mm space using the
  // current calibration. If the preview looks like a perfectly axis-aligned
  // grid, calibration is correct.
  const [rectifiedUrl, setRectifiedUrl] = useState<string | null>(null);
  const [rectifiedLoading, setRectifiedLoading] = useState(false);

  // Activity log — captures every auto-detect / auto-cal / rotate / etc.
  // event so the user can see what happened. Newest first.
  type LogEntry = {
    t: number;
    kind: "info" | "success" | "warn" | "error";
    text: string;
  };
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const appendLog = useCallback(
    (kind: LogEntry["kind"], text: string) => {
      setLogs((prev) =>
        [{ t: Date.now(), kind, text }, ...prev].slice(0, 50)
      );
    },
    []
  );

  // Collapsible advanced sections
  const [showRotation, setShowRotation] = useState(false);
  const [showDetectionParams, setShowDetectionParams] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const config = chartType ? CHART_CONFIGS[chartType] : null;

  // Compute the affine transform whenever calibration points change.
  // Needs ≥3 non-collinear correspondences. Returns null otherwise.
  const affine = useMemo(() => {
    if (calibrationPoints.length < 3) return null;
    return computeAffineTransform(calibrationPoints);
  }, [calibrationPoints]);
  const affineMatrix = affine?.matrix ?? null;

  // ─── Auto-calibration state ───────────────────────────────────────
  const [autoCalState, setAutoCalState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success"; result: AutoCalibrationResult }
    | { kind: "fail"; message: string }
  >({ kind: "idle" });
  const hasRunAutoCalRef = useRef(false);

  // ─── Detection config (live-tunable thresholds) ───────────────────
  const [detectionConfig, setDetectionConfig] = useState<DetectionConfig>(
    DETECTION_DEFAULTS
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Track every blob URL we create so handleReset can revoke them all at
  // once. Avoids the race where a queued async consumer (auto-cal, mask
  // compute) is still loading a URL that was just revoked.
  const rotatedUrlsRef = useRef<string[]>([]);
  const fullResRotatedUrlsRef = useRef<string[]>([]);
  const maskUrlsRef = useRef<string[]>([]);
  const rectifiedUrlsRef = useRef<string[]>([]);
  // Promise gate: backend handlers await this to ensure fullResUrl matches
  // the current rotationAngle. Resolves with the URL or null.
  const fullResReadyRef = useRef<{
    angle: number;
    promise: Promise<string | null>;
  } | null>(null);

  /** Wait for the full-res rotated blob URL to be ready for the CURRENT
   *  rotation angle, or 5 s, whichever comes first. Backend callers use this
   *  so they don't fire against a stale rotation while the debounced full-res
   *  rotation is still running. Falls back to the un-rotated original (or
   *  preview, last resort) if everything times out. */
  const awaitFullRes = useCallback(async (): Promise<string | null> => {
    const ready = fullResReadyRef.current;
    if (ready && ready.angle === rotationAngle) {
      const url = await Promise.race([
        ready.promise,
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (url) return url;
    }
    return fullResUrl ?? originalImageUrl ?? imageUrl;
  }, [rotationAngle, fullResUrl, originalImageUrl, imageUrl]);

  const handleBackendCalibrate = useCallback(async () => {
    if (!imageUrl || !config) return;
    appendLog("info", "Auto-cal (backend, sjecišta): pokretanje…");
    setAutoCalState({ kind: "running" });
    try {
      const srcUrl = (await awaitFullRes()) ?? imageUrl;
      const blob = await (await fetch(srcUrl)).blob();
      const imageBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const r = reader.result as string;
          resolve(r.includes(",") ? r.split(",", 2)[1] : r);
        };
        reader.onerror = () => reject(new Error("read blob failed"));
        reader.readAsDataURL(blob);
      });
      const { w: baseW, h: baseH } = getDisplaySize(config);
      const body = {
        imageBase64,
        config: {
          orientation: config.orientation,
          chartWidth: config.chartWidth,
          chartHeight: config.chartHeight,
          minValue: config.minValue,
          maxValue: config.maxValue,
          majorGrid: config.majorGrid,
          days: config.days,
          penArmRadius: config.penArmRadius,
          penArmPivot: config.penArmPivot,
          unit: config.unit,
        },
        displayWidth: baseW,
        displayHeight: baseH,
      };
      const resp = await fetch("/api/calibrate-grid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      }
      const data = await resp.json();
      type BackendCal = {
        imgX: number;
        imgY: number;
        chartX: number;
        chartY: number;
      };
      const cal: CalibrationPoint[] = (data.points as BackendCal[]).map(
        (p, i) => ({
          id: `bg-cal-${Date.now()}-${i}`,
          imgX: p.imgX,
          imgY: p.imgY,
          chartX: p.chartX,
          chartY: p.chartY,
          meta: { day: 0, hour: 0, value: 0 },
        })
      );
      setCalibrationPoints(cal);
      const horiz = data.diagnostics?.detectedHorizontals ?? 0;
      const vert = data.diagnostics?.detectedVerticals ?? 0;
      const angle = data.diagnostics?.dominantAngleDeg ?? 0;
      appendLog(
        "success",
        `Backend cal: ${cal.length} kutova, ${horiz}H × ${vert}V linija, kut ${angle.toFixed(2)}°`
      );
      setAutoCalState({
        kind: "success",
        result: {
          points: cal,
          confidence: 0.9,
          rotated: false,
          rotatedImageUrl: null,
          diagnostics: {
            detectedCols: vert,
            detectedRows: horiz,
            expectedCols: 0,
            expectedRows: 0,
            colsRms: 0,
            rowsRms: 0,
            imageWidth: 0,
            imageHeight: 0,
          },
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Backend calibration failed";
      appendLog("error", `Backend cal failed: ${msg}`);
      setAutoCalState({ kind: "fail", message: msg });
    }
  }, [imageUrl, config, appendLog, awaitFullRes]);

  const handleAutoCalibrate = useCallback(async () => {
    if (!imageUrl || !config) return;
    hasRunAutoCalRef.current = true;
    setAutoCalState({ kind: "running" });
    try {
      // Must match OverlayCanvas's display dimensions exactly — getDisplaySize
      // is the single source of truth for the (DISPLAY_SCALE × mm) sizing.
      const { w: baseW, h: baseH } = getDisplaySize(config);

      appendLog("info", "Auto-detect (JS): pokretanje…");
      const result = await runAutoCalibration(
        imageUrl,
        config,
        baseW,
        baseH,
        detectionConfig
      );
      if (!result) {
        appendLog("error", "Auto-detect: rešetka nije detektirana");
        setAutoCalState({
          kind: "fail",
          message:
            "Nije moguće pouzdano detektirati rešetku — kalibrirajte ručno.",
        });
        return;
      }
      appendLog(
        "success",
        `Auto-detect: ${result.points.length} točaka, povjerenje ${(result.confidence * 100).toFixed(0)}%, RMS ${result.diagnostics.colsRms.toFixed(2)}/${result.diagnostics.rowsRms.toFixed(2)} px`
      );
      // If detection rotated the image to match chart geometry, swap the
      // display source so subsequent clicks see the corrected orientation.
      // `result.points` are already in the rotated image's coordinate space.
      // We rotate BOTH the preview source AND the full-res original so the
      // backend calls (which use full-res) stay consistent with what the user
      // sees on the canvas.
      if (result.rotatedImageUrl) {
        // The detection step already produced a rotated PREVIEW blob — adopt
        // it as the new previewSourceUrl. We don't know whether it was 90 CW
        // or CCW from the result type, but runAutoCalibration tries CW first
        // and falls back to CCW; we replicate the same rotation on the
        // full-res by trying CW first.
        const newPreview = result.rotatedImageUrl;
        rotatedUrlsRef.current.push(newPreview);
        setPreviewSourceUrl(newPreview);
        if (originalImageUrl) {
          try {
            const rotatedFull = await rotateUrlToBlob(originalImageUrl, 90);
            fullResRotatedUrlsRef.current.push(rotatedFull);
            setOriginalImageUrl(rotatedFull);
          } catch (e) {
            console.warn("could not rotate original to match auto-cal", e);
          }
        }
      }
      // Replace existing calibration points with the four detected corners.
      setCalibrationPoints(result.points);
      setAutoCalState({ kind: "success", result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      // Stale blob URL — happens when the user is mid-drag on the angle
      // slider and a queued auto-cal points at a URL we already replaced.
      // Don't surface as an error; the next config/image change will retry.
      if (msg.includes("Failed to load image")) {
        setAutoCalState({ kind: "idle" });
        return;
      }
      setAutoCalState({
        kind: "fail",
        message: err instanceof Error ? err.message : "Auto-kalibracija nije uspjela.",
      });
    }
  }, [imageUrl, config, detectionConfig, originalImageUrl]);

  // ─── Rotation: recompute imageUrl (preview) eagerly from previewSourceUrl ──
  // The rotation angle includes both coarse (90° buttons) and fine (slider)
  // adjustments. Always rotates the ORIGINAL preview source, so dragging the
  // slider doesn't accumulate compounding round-trips through PNG encoding.
  // The full-res rotation lives in a separate debounced effect below.
  useEffect(() => {
    if (!previewSourceUrl) {
      setImageUrl(null);
      return;
    }
    if (rotationAngle === 0) {
      setImageUrl(previewSourceUrl);
      setIsRotating(false);
      // New rotation invalidates calibration corners
      setCalibrationPoints((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let cancelled = false;
    setIsRotating(true);
    (async () => {
      try {
        const newUrl = await rotateUrlToBlob(previewSourceUrl, rotationAngle);
        if (cancelled) return;
        rotatedUrlsRef.current.push(newUrl);
        setImageUrl(newUrl);
        setCalibrationPoints([]);
      } catch (e) {
        console.error("preview rotation failed", e);
      } finally {
        if (!cancelled) setIsRotating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewSourceUrl, rotationAngle]);

  // ─── Rotation (full-res): debounced rotation of the original blob ───────
  // Triggered ~250 ms after the user stops dragging the angle slider. Sets
  // fullResUrl which backend callers and the high-zoom canvas branch consume.
  // We expose the current generation as a promise via fullResReadyRef so that
  // a backend handler clicked DURING the debounce window can await the result
  // rather than firing with a stale rotation.
  useEffect(() => {
    if (!originalImageUrl) {
      setFullResUrl(null);
      fullResReadyRef.current = null;
      return;
    }
    let cancelled = false;
    let resolveExternal: (v: string | null) => void = () => {};
    const promise = new Promise<string | null>((res) => {
      resolveExternal = res;
    });
    fullResReadyRef.current = { angle: rotationAngle, promise };

    const t = setTimeout(async () => {
      try {
        if (rotationAngle === 0) {
          if (cancelled) {
            resolveExternal(null);
            return;
          }
          setFullResUrl(originalImageUrl);
          resolveExternal(originalImageUrl);
          return;
        }
        const newUrl = await rotateUrlToBlob(originalImageUrl, rotationAngle);
        if (cancelled) {
          URL.revokeObjectURL(newUrl);
          resolveExternal(null);
          return;
        }
        fullResRotatedUrlsRef.current.push(newUrl);
        setFullResUrl(newUrl);
        resolveExternal(newUrl);
      } catch (e) {
        console.error("full-res rotation failed", e);
        resolveExternal(null);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(t);
      // Don't resolve here — the promise stays pending until either the next
      // generation supersedes it or the component unmounts. Awaiters that
      // chained on a stale generation will just see fullResReadyRef updated.
    };
  }, [originalImageUrl, rotationAngle]);

  /** Coarse 90°/180° buttons: bump rotationAngle and let the effect recompute. */
  const handleRotateBy = useCallback(
    (delta: 90 | -90 | 180) => {
      setRotationAngle((a) => {
        const next = a + delta;
        // Normalize to (-180, 180]
        let n = next % 360;
        if (n > 180) n -= 360;
        if (n <= -180) n += 360;
        appendLog(
          "info",
          `Rotacija ${delta > 0 ? "+" : ""}${delta}° → ${n.toFixed(0)}°`
        );
        return n;
      });
      setAutoCalState({ kind: "idle" });
    },
    [appendLog]
  );

  // ─── Mask overlay: recompute whenever the image or detection config change ──
  // Don't revoke previous URLs eagerly — queued auto-cal/mask consumers may
  // still be reading them. Track instead and revoke on Reset.
  useEffect(() => {
    if (!imageUrl || step !== "calibrate") {
      setMaskUrl(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      computeGridMaskUrl(imageUrl, detectionConfig)
        .then((url) => {
          if (cancelled) return;
          maskUrlsRef.current.push(url);
          setMaskUrl(url);
        })
        .catch((e) => {
          // Stale URL revoked while we were loading — common during fast
          // slider drags, ignore silently.
          if (typeof e?.message === "string" && e.message.includes("Failed to load image")) return;
          console.error("mask compute failed", e);
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, JSON.stringify(detectionConfig), step]);

  // ─── Rectified preview (calls /api/rectify) ──────────────────────────────
  // Backend warps the image into chart-mm space using the current calibration
  // corners. Result is shown in the sidebar — a perfect axis-aligned grid
  // means calibration is correct; visible skew means it's off.
  useEffect(() => {
    if (!imageUrl || !config || step !== "calibrate") {
      setRectifiedUrl(null);
      return;
    }
    if (calibrationPoints.length < 3) {
      setRectifiedUrl(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setRectifiedLoading(true);
      try {
        const srcUrl = (await awaitFullRes()) ?? imageUrl;
        const blob = await (await fetch(srcUrl)).blob();
        const imageBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const r = reader.result as string;
            resolve(r.includes(",") ? r.split(",", 2)[1] : r);
          };
          reader.onerror = () => reject(new Error("read blob failed"));
          reader.readAsDataURL(blob);
        });
        const { w: baseW, h: baseH } = getDisplaySize(config);
        const resp = await fetch("/api/rectify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64,
            config: {
              orientation: config.orientation,
              chartWidth: config.chartWidth,
              chartHeight: config.chartHeight,
              minValue: config.minValue,
              maxValue: config.maxValue,
              majorGrid: config.majorGrid,
              days: config.days,
              penArmRadius: config.penArmRadius,
              penArmPivot: config.penArmPivot,
              unit: config.unit,
            },
            calibrationPoints: calibrationPoints.map((p) => ({
              imgX: p.imgX,
              imgY: p.imgY,
              chartX: p.chartX,
              chartY: p.chartY,
            })),
            displayWidth: baseW,
            displayHeight: baseH,
            previewMaxEdge: 800,
          }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (cancelled) return;
        setRectifiedUrl(`data:image/png;base64,${data.rectifiedBase64}`);
      } catch (e) {
        if (!cancelled) {
          appendLog("warn", `Rectify failed: ${e instanceof Error ? e.message : "?"}`);
          setRectifiedUrl(null);
        }
      } finally {
        if (!cancelled) setRectifiedLoading(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    imageUrl,
    JSON.stringify(
      calibrationPoints.map((p) => [p.imgX, p.imgY, p.chartX, p.chartY])
    ),
    step,
  ]);

  // ─── Calibration quality indicator (derived) ─────────────────────────────
  const calibrationQuality = useMemo<{
    level: "none" | "poor" | "ok" | "good" | "excellent";
    label: string;
    color: "rose" | "amber" | "emerald";
  }>(() => {
    const n = calibrationPoints.length;
    if (n === 0) return { level: "none", label: "Bez kalibracije", color: "rose" };
    if (n < 3) return { level: "poor", label: "Nedovoljno (≥3)", color: "amber" };
    const conf =
      autoCalState.kind === "success"
        ? autoCalState.result.confidence ?? 0.5
        : 0.6;
    if (n >= 4 && conf >= 0.7)
      return { level: "excellent", label: "Odlično", color: "emerald" };
    if (n >= 4 && conf >= 0.4)
      return { level: "good", label: "Dobro", color: "emerald" };
    return { level: "ok", label: "Prihvatljivo", color: "amber" };
  }, [calibrationPoints.length, autoCalState]);

  // ─── Auto-redetect on detection-config changes (debounced) ───────────────
  // Only fires AFTER the user has run auto-detect at least once — until then,
  // sliders just update the live mask preview.
  // Use a ref so the queued timer always calls the LATEST handleAutoCalibrate
  // (which closes over the latest imageUrl/config). Otherwise the timer fires
  // a stale callback referencing a blob URL that has since been replaced.
  const handleAutoCalRef = useRef(handleAutoCalibrate);
  useEffect(() => {
    handleAutoCalRef.current = handleAutoCalibrate;
  }, [handleAutoCalibrate]);

  useEffect(() => {
    if (!hasRunAutoCalRef.current) return;
    if (!imageUrl || !config || step !== "calibrate") return;
    const t = setTimeout(() => {
      handleAutoCalRef.current();
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(detectionConfig)]);

  const handleChartSelect = (type: ChartType) => {
    setChartType(type);
    setStep("upload");
  };

  const handleImageSelected = async (file: File) => {
    // Two-tier ingest:
    //   - originalImageUrl: full-res, untouched. Used by backend calls and
    //     high-zoom canvas display so the user gets actual pixel detail when
    //     calibrating sub-mm grid intersections.
    //   - previewSourceUrl: ≤PREVIEW_MAX_EDGE downscale, used for the always-on
    //     canvas display + JS auto-cal + mask compute (which downscale to
    //     1200 px internally anyway). Rotating a ~1500-px image is fast enough
    //     to keep the angle slider responsive on every tick.
    const PREVIEW_MAX_EDGE = 1500;
    const originalUrl = URL.createObjectURL(file);
    let previewUrl = originalUrl;
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("load failed"));
        i.src = originalUrl;
      });
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      if (longest > PREVIEW_MAX_EDGE) {
        const scale = PREVIEW_MAX_EDGE / longest;
        const dw = Math.round(img.naturalWidth * scale);
        const dh = Math.round(img.naturalHeight * scale);
        const c = document.createElement("canvas");
        c.width = dw;
        c.height = dh;
        const ctx = c.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, dw, dh);
          const blob: Blob | null = await new Promise((r) =>
            c.toBlob(r, "image/png")
          );
          if (blob) {
            previewUrl = URL.createObjectURL(blob);
          }
        }
      }
    } catch (e) {
      console.error("preview downscale failed, falling back to original", e);
    }
    setOriginalImageUrl(originalUrl);
    setPreviewSourceUrl(previewUrl);
    setRotationAngle(0);
    setStep("calibrate");
    // Fire session creation in the background so the banner can pop up
    // as soon as the backend responds. Failure is silent — user can still
    // calibrate locally.
    if (chartType) {
      void createSessionForUpload(file, chartType);
    }
  };

  const createSessionForUpload = async (file: File, type: ChartType) => {
    setSessionCreating(true);
    try {
      const cfg = CHART_CONFIGS[type];
      const blob = file;
      const imageBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const r = reader.result as string;
          resolve(r.includes(",") ? r.split(",", 2)[1] : r);
        };
        reader.onerror = () => reject(new Error("read blob failed"));
        reader.readAsDataURL(blob);
      });
      const resp = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64,
          chartType: type,
          config: {
            orientation: cfg.orientation,
            chartWidth: cfg.chartWidth,
            chartHeight: cfg.chartHeight,
            minValue: cfg.minValue,
            maxValue: cfg.maxValue,
            majorGrid: cfg.majorGrid,
            days: cfg.days,
            penArmRadius: cfg.penArmRadius,
            penArmPivot: cfg.penArmPivot,
            unit: cfg.unit,
          },
        }),
      });
      if (!resp.ok) {
        console.warn("session create failed", resp.status);
        return;
      }
      const info = (await resp.json()) as SessionInfo;
      setSessionInfo(info);
      setSessionBannerOpen(true);
    } catch (e) {
      console.warn("session create error", e);
    } finally {
      setSessionCreating(false);
    }
  };

  const handleVectorize = useCallback(async () => {
    if (!config) return;
    setVectorizing(true);
    try {
      const { w, h } = getDisplaySize(config);

      // PRIMARY: backend reference-template alignment. Backend has the
      // empty-chart reference loaded with all major/minor/fine grid lines
      // pre-computed analytically. We align user image to reference via
      // ECC and warp those polylines back. Robust to scan distortion,
      // gives correct major/minor/fine classification for free.
      try {
        const srcUrl = (await awaitFullRes()) ?? imageUrl;
        if (srcUrl) {
          const blob = await (await fetch(srcUrl)).blob();
          const imageBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const r = reader.result as string;
              resolve(r.includes(",") ? r.split(",", 2)[1] : r);
            };
            reader.onerror = () => reject(new Error("read blob failed"));
            reader.readAsDataURL(blob);
          });
          const resp = await fetch("/api/vectorize-grid", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              imageBase64,
              config: {
                orientation: config.orientation,
                chartWidth: config.chartWidth,
                chartHeight: config.chartHeight,
                minValue: config.minValue,
                maxValue: config.maxValue,
                majorGrid: config.majorGrid,
                days: config.days,
                penArmRadius: config.penArmRadius,
                penArmPivot: config.penArmPivot,
                unit: config.unit,
              },
              displayWidth: w,
              displayHeight: h,
            }),
          });
          if (resp.ok) {
            const data = await resp.json();
            const polys: VectorPolyline[] = data.polylines.map(
              (p: { points: number[][]; axis: string; weight: string }) => ({
                points: p.points,
                axis: p.axis as "horizontal" | "vertical",
                weight: p.weight as "major" | "minor" | "fine",
              })
            );
            setTracePolylines(polys);
            appendLog(
              "success",
              `Reference vectorize: ${polys.length} polylines (${data.diagnostics.horizontalCount}H + ${data.diagnostics.arcCount}V), ECC ${Math.round(data.diagnostics.timingMs?.ecc ?? 0)}ms`
            );
            return;
          }
          const txt = await resp.text();
          appendLog(
            "warn",
            `Backend vectorize ${resp.status}, fallback na klijent: ${txt.slice(0, 120)}`
          );
        }
      } catch (e) {
        appendLog(
          "warn",
          `Backend vectorize error, fallback na klijent: ${e instanceof Error ? e.message : "?"}`
        );
      }

      // FALLBACK: client-side mask-based vectorizer.
      if (!maskUrl) return;
      const isLandscape = config.orientation === "landscape";
      const valueLines =
        Math.round((config.maxValue - config.minValue) / config.minorGrid) + 1;
      const timeLines = config.days + 1;
      const valueMajorEvery = Math.max(
        1,
        Math.round(config.majorGrid / config.minorGrid)
      );
      const timeMajorEvery = 1;
      const polys = await vectorizeMaskFromUrl(maskUrl, {
        displayWidth: w,
        displayHeight: h,
        simplifyTolerance: 1.5,
        maxHorizontalLines: isLandscape ? valueLines : timeLines,
        maxVerticalLines: isLandscape ? timeLines : valueLines,
        horizontalMajorEvery: isLandscape ? valueMajorEvery : timeMajorEvery,
        verticalMajorEvery: isLandscape ? timeMajorEvery : valueMajorEvery,
      });
      setTracePolylines(polys);
      const totalPts = polys.reduce((s, p) => s + p.points.length, 0);
      appendLog(
        "success",
        `Vektorizirano (klijent): ${polys.length} linija, ${totalPts} točaka`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Vektorizacija nije uspjela";
      appendLog("error", `Vektorizacija: ${msg}`);
    } finally {
      setVectorizing(false);
    }
  }, [maskUrl, imageUrl, config, appendLog, awaitFullRes]);

  // Invalidate vectorized polylines whenever the mask source changes — old
  // paths would no longer correspond to the current detection.
  useEffect(() => {
    setTracePolylines(null);
  }, [maskUrl]);

  // Apply per-category visibility filter to the vectorized polylines before
  // passing them down. Each polyline is tagged with axis × weight; the user
  // toggles control which groups render.
  const visibleTracePolylines = useMemo(() => {
    if (!tracePolylines) return null;
    return tracePolylines.filter((p) => {
      if (p.axis === "horizontal") {
        if (p.weight === "major") return lineVisibility.hMajor;
        if (p.weight === "minor") return lineVisibility.hMinor;
        return lineVisibility.hFine;
      }
      if (p.weight === "major") return lineVisibility.vMajor;
      if (p.weight === "minor") return lineVisibility.vMinor;
      return lineVisibility.vFine;
    });
  }, [tracePolylines, lineVisibility]);

  const handleCalibrationPointAdd = useCallback((point: CalibrationPoint) => {
    setCalibrationPoints((prev) => [...prev, point]);
  }, []);

  const handleCalibrationPointRemove = useCallback((id: string) => {
    setCalibrationPoints((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleDataPointAdd = useCallback((point: DataPoint) => {
    setDataPoints((prev) => [...prev, point]);
  }, []);

  const handleDataPointRemove = useCallback((id: string) => {
    setDataPoints((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleUpdateValue = useCallback((id: string, value: number) => {
    setDataPoints((prev) =>
      prev.map((p) => (p.id === id ? { ...p, value } : p))
    );
  }, []);

  // ─── Backend trace extraction (OpenCV-based autotrace) ───────────────────
  const [extractState, setExtractState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success"; count: number; timingMs: Record<string, number> }
    | { kind: "fail"; message: string }
  >({ kind: "idle" });
  const [traceInk, setTraceInk] = useState<"auto" | "blue" | "red" | "black">(
    "auto"
  );

  const handleExtractTrace = useCallback(async () => {
    if (!imageUrl || !config) return;
    if (calibrationPoints.length < 3) {
      setExtractState({
        kind: "fail",
        message: "Treba bar 3 kalibracijske točke prije ekstrakcije.",
      });
      return;
    }
    setExtractState({ kind: "running" });
    try {
      // Fetch the current (rotated) full-res blob and convert to base64
      const srcUrl = (await awaitFullRes()) ?? imageUrl;
      const blob = await (await fetch(srcUrl)).blob();
      const imageBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const r = reader.result as string;
          // Strip "data:image/png;base64," prefix
          resolve(r.includes(",") ? r.split(",", 2)[1] : r);
        };
        reader.onerror = () => reject(new Error("read blob failed"));
        reader.readAsDataURL(blob);
      });

      const { w: baseW, h: baseH } = getDisplaySize(config);

      const body = {
        imageBase64,
        calibrationPoints: calibrationPoints.map((p) => ({
          imgX: p.imgX,
          imgY: p.imgY,
          chartX: p.chartX,
          chartY: p.chartY,
        })),
        displayWidth: baseW,
        displayHeight: baseH,
        config: {
          orientation: config.orientation,
          chartWidth: config.chartWidth,
          chartHeight: config.chartHeight,
          minValue: config.minValue,
          maxValue: config.maxValue,
          majorGrid: config.majorGrid,
          days: config.days,
          penArmRadius: config.penArmRadius,
          penArmPivot: config.penArmPivot,
          unit: config.unit,
        },
        samplesPerDay: 48,
        traceInk,
      };

      const resp = await fetch("/api/extract-trace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      }
      const data = await resp.json();
      type BackendPoint = {
        day: number;
        hour: number;
        value: number;
        canvasX: number;
        canvasY: number;
      };
      const incoming: DataPoint[] = (data.points as BackendPoint[]).map(
        (p, i) => ({
          id: `auto-${Date.now()}-${i}`,
          canvasX: p.canvasX,
          canvasY: p.canvasY,
          day: p.day,
          hour: p.hour,
          value: p.value,
          dayLabel: getDayName(p.day),
          timeLabel: formatHour(p.hour),
        })
      );
      // Replace existing data points with the auto-extracted set
      setDataPoints(incoming);
      setExtractState({
        kind: "success",
        count: incoming.length,
        timingMs: data.diagnostics?.timingMs ?? {},
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Ekstrakcija nije uspjela.";
      setExtractState({ kind: "fail", message: msg });
    }
  }, [imageUrl, config, calibrationPoints, traceInk, awaitFullRes]);

  const handleReset = () => {
    setStep("select");
    setChartType(null);
    // Revoke all blob URLs we created during the session.
    if (originalImageUrl && originalImageUrl.startsWith("blob:")) {
      URL.revokeObjectURL(originalImageUrl);
    }
    if (previewSourceUrl && previewSourceUrl.startsWith("blob:")) {
      URL.revokeObjectURL(previewSourceUrl);
    }
    for (const u of rotatedUrlsRef.current) URL.revokeObjectURL(u);
    for (const u of fullResRotatedUrlsRef.current) URL.revokeObjectURL(u);
    for (const u of maskUrlsRef.current) URL.revokeObjectURL(u);
    rotatedUrlsRef.current = [];
    fullResRotatedUrlsRef.current = [];
    maskUrlsRef.current = [];
    fullResReadyRef.current = null;
    setImageUrl(null);
    setFullResUrl(null);
    setOriginalImageUrl(null);
    setPreviewSourceUrl(null);
    setRotationAngle(0);
    setMaskUrl(null);
    setCalibrationPoints([]);
    setDataPoints([]);
    setAutoCalState({ kind: "idle" });
    hasRunAutoCalRef.current = false;
    setSessionInfo(null);
    setSessionBannerOpen(false);
  };

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="min-h-screen bg-background transition-colors duration-300">
      {/* ═══ HEADER ═══ */}
      <header className="sticky top-0 z-50 glass border-b border-border/50">
        <div className="max-w-[1600px] mx-auto px-5 h-14 flex items-center justify-between">
          {/* Logo & title */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md">
                <Gauge className="w-4.5 h-4.5 text-white" strokeWidth={2.5} />
              </div>
              <div className="absolute -inset-1 rounded-xl bg-emerald-500/20 blur-md -z-10" />
            </div>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold tracking-tight text-foreground">
                DHMZ Digitizer
              </h1>
              <p className="text-[10px] font-medium text-muted-foreground tracking-wider uppercase">
                Analog Chart Reader
              </p>
            </div>
          </div>

          {/* Step progress */}
          {step !== "select" && (
            <div className="hidden md:flex items-center gap-1">
              {STEPS.map((s, i) => {
                const isActive = i === stepIndex;
                const isDone = i < stepIndex;
                return (
                  <div key={s.key} className="flex items-center">
                    <button
                      onClick={() => {
                        if (isDone) {
                          setStep(s.key);
                        }
                      }}
                      disabled={!isDone && !isActive}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-300 ${
                        isActive
                          ? "bg-primary text-primary-foreground shadow-md glow-emerald"
                          : isDone
                            ? "bg-primary/10 text-primary cursor-pointer hover:bg-primary/20"
                            : "text-muted-foreground/50"
                      }`}
                    >
                      <span
                        className={`w-4.5 h-4.5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                          isActive
                            ? "bg-primary-foreground/20"
                            : isDone
                              ? "bg-primary/20"
                              : "bg-muted"
                        }`}
                      >
                        {isDone ? "✓" : i + 1}
                      </span>
                      {s.label}
                    </button>
                    {i < STEPS.length - 1 && (
                      <div
                        className={`w-6 h-px mx-1 transition-colors duration-300 ${
                          isDone ? "bg-primary/40" : "bg-border"
                        }`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {step !== "select" && (
              <button
                onClick={handleReset}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Nova traka
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-5">
        {/* ═══ STEP 1: SELECT ═══ */}
        {step === "select" && (
          <div className="py-16 max-w-4xl mx-auto">
            {/* Hero */}
            <div className="text-center mb-14 animate-fade-in-up">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium mb-5">
                <Layers className="w-3.5 h-3.5" />
                Meteorološka digitalizacija
              </div>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight text-foreground mb-4">
                Odaberite
                <span className="bg-gradient-to-r from-emerald-500 to-teal-500 bg-clip-text text-transparent">
                  {" "}instrument
                </span>
              </h2>
              <p className="text-muted-foreground text-lg max-w-lg mx-auto leading-relaxed">
                Pretvorite analogne meteorološke trake u digitalne podatke
                s preciznošću instrumenta
              </p>
            </div>

            {/* Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-16">
              {CHART_OPTIONS.map((opt, i) => (
                <button
                  key={opt.type}
                  onClick={() => handleChartSelect(opt.type)}
                  className="group relative text-left animate-fade-in-up"
                  style={{ animationDelay: `${i * 80}ms` }}
                >
                  <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-6 transition-all duration-300 hover:border-primary/30 hover:shadow-xl hover:-translate-y-1">
                    {/* Gradient bg */}
                    <div
                      className={`absolute inset-0 bg-gradient-to-br ${opt.gradient} opacity-0 group-hover:opacity-100 transition-opacity duration-500`}
                    />

                    <div className="relative">
                      {/* Icon */}
                      <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center text-muted-foreground group-hover:text-primary group-hover:bg-primary/10 transition-all duration-300 mb-5">
                        {opt.icon}
                      </div>

                      {/* Text */}
                      <h3 className="text-xl font-semibold text-foreground mb-1 tracking-tight">
                        {opt.label}
                      </h3>
                      <p className="text-xs font-medium text-muted-foreground tracking-wider uppercase mb-3">
                        {opt.sublabel}
                      </p>
                      <p className="text-sm text-muted-foreground mb-4">
                        {opt.description}
                      </p>

                      {/* Range badge */}
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-muted text-xs font-mono font-medium text-muted-foreground">
                          {CHART_CONFIGS[opt.type].minValue}–
                          {CHART_CONFIGS[opt.type].maxValue}{" "}
                          {CHART_CONFIGS[opt.type].unit}
                        </span>
                        <ArrowRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-primary group-hover:translate-x-1 transition-all duration-300" />
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>

          </div>
        )}

        {/* ═══ STEP 2: UPLOAD ═══ */}
        {step === "upload" && config && (
          <div className="py-12 max-w-2xl mx-auto animate-fade-in-up">
            <button
              onClick={() => setStep("select")}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
            >
              <ArrowLeft className="w-4 h-4" />
              Natrag
            </button>

            <h2 className="text-3xl font-bold tracking-tight mb-2">
              Učitajte traku
            </h2>
            <p className="text-muted-foreground mb-8">
              Fotografija ili sken za{" "}
              <span className="font-semibold text-foreground">
                {config.label}
              </span>{" "}
              ({config.minValue}–{config.maxValue} {config.unit})
            </p>

            <ImageUpload onImageSelected={handleImageSelected} />
          </div>
        )}

        {/* ═══ STEP 3: CALIBRATE ═══ */}
        {step === "calibrate" && config && imageUrl && (
          <div className="py-5 animate-fade-in">
            {/* ═══ HEADER: minimal — back, title, quality badge, primary actions ═══ */}
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div className="flex items-center gap-4 min-w-0">
                <button
                  onClick={() => setStep("upload")}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Natrag
                </button>
                <div className="min-w-0">
                  <h2 className="text-xl font-bold tracking-tight">
                    Kalibracija
                  </h2>
                  <p className="text-xs text-muted-foreground truncate">
                    {config.label} · {config.minValue}–{config.maxValue} {config.unit}
                  </p>
                </div>
                {/* Quality badge */}
                <div
                  className={`hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border whitespace-nowrap ${
                    calibrationQuality.color === "emerald"
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
                      : calibrationQuality.color === "amber"
                      ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400"
                      : "bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-400"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      calibrationQuality.color === "emerald"
                        ? "bg-emerald-500"
                        : calibrationQuality.color === "amber"
                        ? "bg-amber-500"
                        : "bg-rose-500"
                    }`}
                  />
                  {calibrationQuality.label} · {calibrationPoints.length} točaka
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={handleBackendCalibrate}
                  disabled={autoCalState.kind === "running"}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-xs font-semibold shadow-md hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Backend kalibracija — Hough na sjecišta linija"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {autoCalState.kind === "running"
                    ? "Detektiranje…"
                    : "Auto-kalibracija"}
                </button>
                <button
                  onClick={handleAutoCalibrate}
                  disabled={autoCalState.kind === "running"}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-card border border-border/60 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-all disabled:opacity-40"
                  title="JS auto-detect (1D projekcija)"
                >
                  Alt: JS
                </button>
                <button
                  onClick={() => setStep("digitize")}
                  disabled={calibrationPoints.length < 3}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 disabled:opacity-30 disabled:cursor-not-allowed bg-primary text-primary-foreground hover:opacity-90 shadow-md glow-emerald"
                >
                  Digitaliziraj
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* ═══ TWO-COLUMN MAIN AREA ═══ */}
            <div className="flex gap-4 items-stretch">
              {/* ───── LEFT: canvas + status banners ───── */}
              <div className="flex-1 min-w-0 flex flex-col gap-2">
                {autoCalState.kind === "success" && (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-700 dark:text-emerald-400 animate-fade-in">
                    <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1 truncate">
                      Detektirano:{" "}
                      <span className="font-mono font-semibold">
                        {autoCalState.result.diagnostics.detectedCols}×
                        {autoCalState.result.diagnostics.detectedRows}
                      </span>{" "}
                      linija, povjerenje{" "}
                      <span className="font-mono font-semibold">
                        {(autoCalState.result.confidence * 100).toFixed(0)}%
                      </span>
                    </span>
                  </div>
                )}
                {autoCalState.kind === "fail" && (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{autoCalState.message}</span>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <MousePointerClick className="w-3 h-3" />
                  Kliknite na sjecišta linija. Alt+klik pomicanje, scroll zoom.
                </p>
                <div
                  className="bg-card border border-border/60 rounded-2xl overflow-hidden shadow-lg flex-1"
                  style={{ minHeight: "calc(100vh - 110px)" }}
                >
                  <OverlayCanvas
                    config={config}
                    imageUrl={imageUrl}
                    fullResImageUrl={fullResUrl}
                    mode="calibrate"
                    calibrationPoints={calibrationPoints}
                    onCalibrationPointAdd={handleCalibrationPointAdd}
                    onCalibrationPointRemove={handleCalibrationPointRemove}
                    dataPoints={dataPoints}
                    onDataPointAdd={handleDataPointAdd}
                    onDataPointRemove={handleDataPointRemove}
                    maskUrl={maskUrl}
                    maskOpacity={maskOpacity}
                    imageOpacity={imageOpacity}
                    tracePolylines={visibleTracePolylines}
                    showBaseline={showBaseline}
                    affineMatrix={affineMatrix}
                  />
                </div>
              </div>

              {/* ───── RIGHT: sidebar ───── */}
              <aside
                className="w-[360px] flex-shrink-0 flex flex-col gap-3 overflow-y-auto pr-1"
                style={{ maxHeight: "calc(100vh - 110px)" }}
              >
                {/* Rectified preview */}
                <div className="bg-card border border-border/60 rounded-xl overflow-hidden">
                  <div className="px-3 py-2 border-b border-border/60 flex items-center justify-between">
                    <span className="text-xs font-semibold">
                      Pregled rektifikacije
                    </span>
                    {rectifiedLoading && (
                      <span className="text-[10px] text-muted-foreground animate-pulse">
                        učitavanje…
                      </span>
                    )}
                  </div>
                  <div className="bg-muted/30 flex items-center justify-center min-h-[120px]">
                    {rectifiedUrl ? (
                      <img
                        src={rectifiedUrl}
                        alt="Rektifikacija"
                        className="max-w-full max-h-[200px] object-contain"
                      />
                    ) : (
                      <p className="text-[11px] text-muted-foreground p-4 text-center">
                        Postavi ≥3 kalibracijske točke za pregled
                        rektifikacije.
                      </p>
                    )}
                  </div>
                </div>

                {/* View controls: image opacity, mask opacity, and one-click
                    presets to switch between original-only / mask-only / both */}
                <div className="bg-card border border-border/60 rounded-xl px-3 py-2 space-y-2">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setImageOpacity(1);
                        setMaskOpacity(0);
                      }}
                      className={`flex-1 text-[10px] py-1 rounded-md font-medium transition-colors ${
                        imageOpacity === 1 && maskOpacity === 0
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted/40 text-muted-foreground hover:bg-muted"
                      }`}
                      type="button"
                    >
                      Slika
                    </button>
                    <button
                      onClick={() => {
                        setImageOpacity(0);
                        setMaskOpacity(1);
                      }}
                      className={`flex-1 text-[10px] py-1 rounded-md font-medium transition-colors ${
                        imageOpacity === 0 && maskOpacity === 1
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted/40 text-muted-foreground hover:bg-muted"
                      }`}
                      type="button"
                    >
                      Maska
                    </button>
                    <button
                      onClick={() => {
                        setImageOpacity(1);
                        setMaskOpacity(0.5);
                      }}
                      className={`flex-1 text-[10px] py-1 rounded-md font-medium transition-colors ${
                        imageOpacity === 1 && maskOpacity === 0.5
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted/40 text-muted-foreground hover:bg-muted"
                      }`}
                      type="button"
                    >
                      Obje
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <ImageOff className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground flex-1">
                      Slika
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {Math.round(imageOpacity * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={imageOpacity}
                    onChange={(e) =>
                      setImageOpacity(parseFloat(e.target.value))
                    }
                    className="w-full slider-emerald"
                  />
                  <div className="flex items-center gap-2">
                    <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground flex-1">
                      Maska
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {Math.round(maskOpacity * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={maskOpacity}
                    onChange={(e) =>
                      setMaskOpacity(parseFloat(e.target.value))
                    }
                    className="w-full slider-emerald"
                  />
                  {/* Vectorize: turn dotty mask into smooth polylines */}
                  <div className="pt-1 border-t border-border/40 space-y-1.5">
                    <button
                      onClick={handleVectorize}
                      disabled={!maskUrl || vectorizing}
                      className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-gradient-to-r from-pink-500/15 to-rose-500/15 border border-pink-500/30 text-[11px] font-semibold text-pink-700 dark:text-pink-300 hover:from-pink-500/25 hover:to-rose-500/25 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      type="button"
                      title="Pretvori maskirane točke u glatke vektorske linije"
                    >
                      <Spline className="w-3.5 h-3.5" />
                      {vectorizing
                        ? "Vektoriziranje…"
                        : tracePolylines
                          ? `Re-vektoriziraj (${tracePolylines.length})`
                          : "Vektoriziraj masku"}
                    </button>
                    {tracePolylines && (
                      <button
                        onClick={() => setTracePolylines(null)}
                        className="w-full text-[10px] text-muted-foreground hover:text-foreground"
                        type="button"
                      >
                        Ukloni linije
                      </button>
                    )}
                  </div>
                  {/* Per-category visibility toggles. Two columns: horizontal
                      grid (value axis) on left, vertical/arc (time axis) on
                      right. Each row is a weight class: major / minor / fine. */}
                  {tracePolylines && (
                    <div className="pt-2 border-t border-border/40 space-y-1.5">
                      <div className="flex items-center text-[10px] text-muted-foreground">
                        <span className="flex-1">Prikaz linija</span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <div className="text-[10px] font-semibold text-muted-foreground">
                          Horizontal
                        </div>
                        <div className="text-[10px] font-semibold text-muted-foreground">
                          Vertical
                        </div>
                        {(
                          [
                            ["Major", "hMajor", "vMajor"],
                            ["Minor", "hMinor", "vMinor"],
                            ["Fine", "hFine", "vFine"],
                          ] as const
                        ).map(([label, hKey, vKey]) => (
                          <>
                            <label
                              key={hKey}
                              className="flex items-center gap-1.5 text-[10px] cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={lineVisibility[hKey]}
                                onChange={(e) =>
                                  setLineVisibility((v) => ({
                                    ...v,
                                    [hKey]: e.target.checked,
                                  }))
                                }
                                className="accent-pink-500"
                              />
                              {label}
                            </label>
                            <label
                              key={vKey}
                              className="flex items-center gap-1.5 text-[10px] cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={lineVisibility[vKey]}
                                onChange={(e) =>
                                  setLineVisibility((v) => ({
                                    ...v,
                                    [vKey]: e.target.checked,
                                  }))
                                }
                                className="accent-pink-500"
                              />
                              {label}
                            </label>
                          </>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Rotation collapsible */}
                <div className="bg-card border border-border/60 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setShowRotation((v) => !v)}
                    className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold hover:bg-muted/40 transition-colors"
                    type="button"
                  >
                    <span className="flex items-center gap-2">
                      <RotateCw className="w-3.5 h-3.5" />
                      Rotacija slike
                      {rotationAngle !== 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-mono">
                          {rotationAngle.toFixed(1)}°
                        </span>
                      )}
                      {isRotating && (
                        <span className="text-[10px] text-primary animate-pulse">
                          rotira…
                        </span>
                      )}
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform ${
                        showRotation ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {showRotation && (
                    <div className="px-3 pb-3 space-y-2 border-t border-border/60 pt-3">
                      {/* Baseline toggle — visual reference for alignment.
                          User rotates until detected grid horizontals run
                          parallel to this black dashed line. */}
                      <button
                        onClick={() => setShowBaseline((v) => !v)}
                        className={`w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                          showBaseline
                            ? "bg-foreground text-background"
                            : "bg-muted/40 text-muted-foreground hover:bg-muted"
                        }`}
                        type="button"
                        title="Crna isprekidana referenca na sredini chart-a — koristi za poravnanje rotacije"
                      >
                        {showBaseline ? "Sakrij osnovicu" : "Pokaži osnovicu"}
                      </button>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleRotateBy(-90)}
                          disabled={isRotating}
                          className="flex-1 p-1.5 rounded-md bg-muted/40 hover:bg-muted text-foreground transition-colors disabled:opacity-40 flex items-center justify-center gap-1 text-[11px]"
                          type="button"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          −90°
                        </button>
                        <button
                          onClick={() => handleRotateBy(180)}
                          disabled={isRotating}
                          className="flex-1 p-1.5 rounded-md bg-muted/40 hover:bg-muted text-foreground transition-colors disabled:opacity-40 flex items-center justify-center gap-1 text-[11px]"
                          type="button"
                        >
                          <FlipVertical className="w-3.5 h-3.5" />
                          180°
                        </button>
                        <button
                          onClick={() => handleRotateBy(90)}
                          disabled={isRotating}
                          className="flex-1 p-1.5 rounded-md bg-muted/40 hover:bg-muted text-foreground transition-colors disabled:opacity-40 flex items-center justify-center gap-1 text-[11px]"
                          type="button"
                        >
                          <RotateCw className="w-3.5 h-3.5" />
                          +90°
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground w-8">
                          Kut
                        </span>
                        <input
                          type="range"
                          min={-180}
                          max={180}
                          step={0.05}
                          value={rotationAngle}
                          onChange={(e) =>
                            setRotationAngle(parseFloat(e.target.value))
                          }
                          className="flex-1 slider-emerald"
                        />
                        <input
                          type="number"
                          min={-180}
                          max={180}
                          step={0.01}
                          value={rotationAngle.toFixed(2)}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!Number.isNaN(v)) setRotationAngle(v);
                          }}
                          className="w-14 bg-muted/40 border border-border rounded px-1 py-0.5 text-[10px] font-mono text-right focus:outline-none"
                        />
                        <button
                          onClick={() => setRotationAngle(0)}
                          className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted"
                          type="button"
                        >
                          0°
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Detection params collapsible */}
                <div className="bg-card border border-border/60 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setShowDetectionParams((v) => !v)}
                    className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold hover:bg-muted/40 transition-colors"
                    type="button"
                  >
                    <span className="flex items-center gap-2">
                      <Settings2 className="w-3.5 h-3.5" />
                      Postavke detekcije
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform ${
                        showDetectionParams ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {showDetectionParams && (
                    <div className="px-3 pb-3 space-y-2 border-t border-border/60 pt-3">
                      {(
                        [
                          ["minSaturation", "Min saturacija", 0, 0.5, 0.01],
                          ["minValue", "Min svjetlina", 0, 0.5, 0.01],
                          ["maxValue", "Maks svjetlina", 0.5, 1, 0.01],
                          ["greenDominance", "Zelena G/max", 0.5, 1, 0.01],
                          ["darkLineMaxV", "Tamne linije v", 0, 0.6, 0.01],
                          ["darkLineMaxS", "Tamne linije s", 0, 0.6, 0.01],
                          ["smoothRadius", "Zaglađivanje", 0, 5, 1],
                          ["peakProminence", "Prominencija", 1, 2, 0.05],
                          ["minPeakSeparation", "Min razmak", 1, 20, 1],
                          ["maxRelativeRms", "Maks rel. RMS", 0.05, 0.6, 0.01],
                        ] as const
                      ).map(([key, label, min, max, step]) => (
                        <div key={key} className="space-y-0.5">
                          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                            <span>{label}</span>
                            <span className="font-mono font-medium text-foreground">
                              {Number.isInteger(step)
                                ? detectionConfig[key].toFixed(0)
                                : detectionConfig[key].toFixed(2)}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={min}
                            max={max}
                            step={step}
                            value={detectionConfig[key]}
                            onChange={(e) =>
                              setDetectionConfig((c) => ({
                                ...c,
                                [key]: parseFloat(e.target.value),
                              }))
                            }
                            className="w-full slider-emerald"
                          />
                        </div>
                      ))}
                      <button
                        onClick={() => setDetectionConfig(DETECTION_DEFAULTS)}
                        className="w-full mt-2 px-3 py-1.5 rounded-lg text-[10px] font-medium text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted transition-all"
                        type="button"
                      >
                        Vrati zadane vrijednosti
                      </button>
                    </div>
                  )}
                </div>

                {/* Activity log collapsible */}
                <div className="bg-card border border-border/60 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setShowLog((v) => !v)}
                    className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold hover:bg-muted/40 transition-colors"
                    type="button"
                  >
                    <span className="flex items-center gap-2">
                      <Layers className="w-3.5 h-3.5" />
                      Log aktivnosti
                      <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground">
                        {logs.length}
                      </span>
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform ${
                        showLog ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {showLog && (
                    <div className="border-t border-border/60 max-h-[260px] overflow-y-auto">
                      {logs.length === 0 ? (
                        <p className="text-[10px] text-muted-foreground p-3 text-center">
                          Pokrenite auto-kalibraciju za prikaz aktivnosti.
                        </p>
                      ) : (
                        <ul className="divide-y divide-border/40">
                          {logs.map((entry, i) => (
                            <li
                              key={`${entry.t}-${i}`}
                              className="px-3 py-1.5 flex items-start gap-2 text-[10px]"
                            >
                              <span
                                className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                  entry.kind === "success"
                                    ? "bg-emerald-500"
                                    : entry.kind === "warn"
                                    ? "bg-amber-500"
                                    : entry.kind === "error"
                                    ? "bg-rose-500"
                                    : "bg-muted-foreground/50"
                                }`}
                              />
                              <span className="font-mono text-muted-foreground tabular-nums">
                                {new Date(entry.t).toLocaleTimeString("hr-HR", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  second: "2-digit",
                                })}
                              </span>
                              <span
                                className={`flex-1 break-words ${
                                  entry.kind === "error"
                                    ? "text-rose-600 dark:text-rose-400"
                                    : entry.kind === "warn"
                                    ? "text-amber-600 dark:text-amber-400"
                                    : "text-foreground"
                                }`}
                              >
                                {entry.text}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {logs.length > 0 && (
                        <div className="border-t border-border/60 px-3 py-1.5 flex justify-end">
                          <button
                            onClick={() => setLogs([])}
                            className="text-[10px] text-muted-foreground hover:text-foreground"
                            type="button"
                          >
                            Očisti
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </aside>
            </div>
          </div>
        )}

        {/* OLD calibrate UI removed below */}

        {/* ═══ STEP 4: DIGITIZE ═══ */}
        {step === "digitize" && config && imageUrl && (
          <div className="py-5 animate-fade-in">
            <div className="flex gap-5 h-[calc(100vh-100px)]">
              {/* Main canvas */}
              <div className="flex-1 flex flex-col min-w-0">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => setStep("calibrate")}
                      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ArrowLeft className="w-4 h-4" />
                    </button>
                    <h2 className="text-xl font-bold tracking-tight">
                      Digitalizacija
                    </h2>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-primary/10 text-primary text-xs font-semibold">
                      {config.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    {/* Trace ink color picker — affects backend mask */}
                    <div className="flex items-center gap-1 bg-card border border-border/60 rounded-xl px-2 py-1">
                      <span className="text-xs text-muted-foreground px-1">
                        Tinta
                      </span>
                      {(["auto", "blue", "red", "black"] as const).map((k) => (
                        <button
                          key={k}
                          onClick={() => setTraceInk(k)}
                          className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                            traceInk === k
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground hover:bg-muted"
                          }`}
                          type="button"
                        >
                          {k === "auto"
                            ? "auto"
                            : k === "blue"
                            ? "plava"
                            : k === "red"
                            ? "crvena"
                            : "crna"}
                        </button>
                      ))}
                    </div>
                    {/* Backend extract trace */}
                    <button
                      onClick={handleExtractTrace}
                      disabled={
                        extractState.kind === "running" ||
                        calibrationPoints.length < 3
                      }
                      className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gradient-to-r from-violet-500/15 to-fuchsia-500/15 border border-violet-500/30 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:from-violet-500/25 hover:to-fuchsia-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      title="OpenCV-bazirana ekstrakcija traga"
                      type="button"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {extractState.kind === "running"
                        ? "Ekstrakcija…"
                        : "Auto-extract trag"}
                    </button>
                    <div className="flex items-center gap-2 bg-card border border-border/60 rounded-xl px-3 py-1.5">
                      <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">
                        Detekcija
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={maskOpacity}
                        onChange={(e) =>
                          setMaskOpacity(parseFloat(e.target.value))
                        }
                        className="w-24 slider-emerald"
                      />
                    </div>
                  </div>
                </div>

                {/* Extract status banner */}
                {extractState.kind === "success" && (
                  <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-700 dark:text-emerald-400 animate-fade-in">
                    <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>
                      Ekstrahirano{" "}
                      <span className="font-mono font-semibold">
                        {extractState.count}
                      </span>{" "}
                      točaka iz traga
                      {extractState.timingMs?.warp != null && (
                        <span className="ml-2 text-emerald-600/70 dark:text-emerald-500/70 font-mono text-[11px]">
                          (warp {extractState.timingMs.warp}ms · skel{" "}
                          {extractState.timingMs.skeletonize}ms · sample{" "}
                          {extractState.timingMs.sample}ms)
                        </span>
                      )}
                    </span>
                  </div>
                )}
                {extractState.kind === "fail" && (
                  <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{extractState.message}</span>
                  </div>
                )}

                <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                  <MousePointerClick className="w-3.5 h-3.5" />
                  Kliknite na trag za očitavanje. Alt+klik pomicanje.
                </div>

                <div className="flex-1 bg-card border border-border/60 rounded-2xl overflow-hidden shadow-lg">
                  <OverlayCanvas
                    config={config}
                    imageUrl={imageUrl}
                    fullResImageUrl={fullResUrl}
                    mode="digitize"
                    calibrationPoints={calibrationPoints}
                    onCalibrationPointAdd={handleCalibrationPointAdd}
                    onCalibrationPointRemove={handleCalibrationPointRemove}
                    dataPoints={dataPoints}
                    onDataPointAdd={handleDataPointAdd}
                    onDataPointRemove={handleDataPointRemove}
                    maskUrl={maskUrl}
                    maskOpacity={maskOpacity}
                    imageOpacity={imageOpacity}
                    tracePolylines={visibleTracePolylines}
                    showBaseline={showBaseline}
                    affineMatrix={affineMatrix}
                  />
                </div>
              </div>

              {/* Data panel */}
              <div className="w-[340px] flex-shrink-0 animate-slide-in-right">
                <DataTable
                  dataPoints={dataPoints}
                  config={config}
                  onRemove={handleDataPointRemove}
                  onUpdateValue={handleUpdateValue}
                />
              </div>
            </div>
          </div>
        )}
      </main>
      {sessionInfo && sessionBannerOpen && (
        <SessionBanner
          info={sessionInfo}
          onDismiss={() => setSessionBannerOpen(false)}
        />
      )}
      {(sessionCreating || (sessionInfo && !sessionBannerOpen)) && (
        <button
          type="button"
          onClick={() => {
            if (sessionInfo) setSessionBannerOpen(true);
          }}
          disabled={sessionCreating}
          aria-live="polite"
          className="fixed top-3 right-3 z-40 flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/95 backdrop-blur shadow-lg border border-neutral-200 text-xs font-medium text-neutral-800 hover:bg-white transition-colors disabled:cursor-default"
          title={
            sessionCreating
              ? "Pripremam Claude session URL…"
              : "Otvori session URL za Claude"
          }
        >
          {sessionCreating ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-neutral-300 border-t-neutral-700 rounded-full animate-spin" />
              <span>Pripremam Claude session…</span>
            </>
          ) : (
            <>
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]" />
              <span>Sesija spremna ↗</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}
