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
import { ChartSVG } from "@/components/chart-template/ChartSVG";
import { ImageUpload } from "@/components/image-upload/ImageUpload";
import { OverlayCanvas } from "@/components/overlay-canvas/OverlayCanvas";
import { DataTable } from "@/components/data-table/DataTable";
import { useTheme } from "@/components/ThemeProvider";
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
  // Original (unrotated) blob URL — set once on upload, never changed by
  // rotation controls.
  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);
  // Rotation in degrees — combined coarse (90° buttons) and fine (slider).
  const [rotationAngle, setRotationAngle] = useState(0);
  // Derived: originalImageUrl rotated by rotationAngle. Updated by an effect.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [calibrationPoints, setCalibrationPoints] = useState<CalibrationPoint[]>([]);
  const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
  // Detection mask overlay opacity (replaces the old SVG-template overlay).
  const [maskOpacity, setMaskOpacity] = useState(0.5);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [isRotating, setIsRotating] = useState(false);

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

  const handleBackendCalibrate = useCallback(async () => {
    if (!imageUrl || !config) return;
    setAutoCalState({ kind: "running" });
    try {
      const blob = await (await fetch(imageUrl)).blob();
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
      setAutoCalState({
        kind: "success",
        result: {
          points: cal,
          confidence: 0.9,
          rotated: false,
          rotatedImageUrl: null,
          diagnostics: {
            detectedCols: data.diagnostics?.detectedVerticals ?? 0,
            detectedRows: data.diagnostics?.detectedHorizontals ?? 0,
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
      setAutoCalState({ kind: "fail", message: msg });
    }
  }, [imageUrl, config]);

  const handleAutoCalibrate = useCallback(async () => {
    if (!imageUrl || !config) return;
    hasRunAutoCalRef.current = true;
    setAutoCalState({ kind: "running" });
    try {
      // Must match OverlayCanvas's display dimensions exactly — getDisplaySize
      // is the single source of truth for the (DISPLAY_SCALE × mm) sizing.
      const { w: baseW, h: baseH } = getDisplaySize(config);

      const result = await runAutoCalibration(
        imageUrl,
        config,
        baseW,
        baseH,
        detectionConfig
      );
      if (!result) {
        setAutoCalState({
          kind: "fail",
          message:
            "Nije moguće pouzdano detektirati rešetku — kalibrirajte ručno.",
        });
        return;
      }
      // If detection rotated the image to match chart geometry, swap the
      // display source so subsequent clicks see the corrected orientation.
      // `result.points` are already in the rotated image's coordinate space.
      if (result.rotatedImageUrl) {
        const previousUrl = imageUrl;
        setImageUrl(result.rotatedImageUrl);
        // Release the previous blob URL — only safe because we just took a
        // snapshot above and React re-renders before the GC matters.
        if (previousUrl.startsWith("blob:")) {
          URL.revokeObjectURL(previousUrl);
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
  }, [imageUrl, config, detectionConfig]);

  // Track every blob URL we create so handleReset can revoke them all at
  // once. Avoids the race where a queued async consumer (auto-cal, mask
  // compute) is still loading a URL that was just revoked.
  const rotatedUrlsRef = useRef<string[]>([]);
  const maskUrlsRef = useRef<string[]>([]);

  // ─── Rotation: recompute imageUrl from originalImageUrl + rotationAngle ──
  // The rotation angle includes both coarse (90° buttons) and fine (slider)
  // adjustments. Always rotates the ORIGINAL image, so dragging the slider
  // doesn't accumulate compounding round-trips through PNG encoding.
  useEffect(() => {
    if (!originalImageUrl) {
      setImageUrl(null);
      return;
    }
    if (rotationAngle === 0) {
      setImageUrl(originalImageUrl);
      setIsRotating(false);
      return;
    }
    let cancelled = false;
    setIsRotating(true);
    (async () => {
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = () => reject(new Error("rotate: load failed"));
          i.src = originalImageUrl;
        });
        if (cancelled) return;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const rad = (rotationAngle * Math.PI) / 180;
        const cosA = Math.abs(Math.cos(rad));
        const sinA = Math.abs(Math.sin(rad));
        const newW = Math.round(w * cosA + h * sinA);
        const newH = Math.round(w * sinA + h * cosA);
        const canvas = document.createElement("canvas");
        canvas.width = newW;
        canvas.height = newH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, newW, newH);
        ctx.translate(newW / 2, newH / 2);
        ctx.rotate(rad);
        ctx.drawImage(img, -w / 2, -h / 2);
        const blob: Blob | null = await new Promise((r) =>
          canvas.toBlob(r, "image/png")
        );
        if (cancelled || !blob) return;
        const newUrl = URL.createObjectURL(blob);
        // Track the new URL for cleanup on Reset; do NOT revoke prev here —
        // queued auto-cal/mask compute callbacks may still be reading it, and
        // revoking would surface as "Failed to load image" while the user is
        // dragging the angle slider.
        rotatedUrlsRef.current.push(newUrl);
        setImageUrl(newUrl);
        // New rotation invalidates calibration corners
        setCalibrationPoints([]);
      } catch (e) {
        console.error("rotation failed", e);
      } finally {
        if (!cancelled) setIsRotating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [originalImageUrl, rotationAngle]);

  /** Coarse 90°/180° buttons: bump rotationAngle and let the effect recompute. */
  const handleRotateBy = useCallback((delta: 90 | -90 | 180) => {
    setRotationAngle((a) => {
      const next = a + delta;
      // Normalize to (-180, 180]
      let n = next % 360;
      if (n > 180) n -= 360;
      if (n <= -180) n += 360;
      return n;
    });
    setAutoCalState({ kind: "idle" });
  }, []);

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
    // Downscale on ingest. Plustek 320e scans land at ~50 MB / 9992 px long
    // edge — rotating that with canvas every slider tick is too slow. Cap the
    // working image at maxEdge=4000 px which is still far above the
    // detection downscale (1200 px) and gives plenty of zoom headroom for
    // clicking on the trace.
    const maxEdge = 4000;
    const objectUrl = URL.createObjectURL(file);
    let workingUrl = objectUrl;
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("load failed"));
        i.src = objectUrl;
      });
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      if (longest > maxEdge) {
        const scale = maxEdge / longest;
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
            workingUrl = URL.createObjectURL(blob);
            // The full-res object URL is no longer needed.
            URL.revokeObjectURL(objectUrl);
          }
        }
      }
    } catch (e) {
      console.error("downscale failed, using original", e);
    }
    setOriginalImageUrl(workingUrl);
    setRotationAngle(0);
    setStep("calibrate");
  };

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
      // Fetch the current (rotated, downscaled) blob and convert to base64
      const blob = await (await fetch(imageUrl)).blob();
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
  }, [imageUrl, config, calibrationPoints, traceInk]);

  const handleReset = () => {
    setStep("select");
    setChartType(null);
    // Revoke all blob URLs we created during the session.
    if (originalImageUrl && originalImageUrl.startsWith("blob:")) {
      URL.revokeObjectURL(originalImageUrl);
    }
    for (const u of rotatedUrlsRef.current) URL.revokeObjectURL(u);
    for (const u of maskUrlsRef.current) URL.revokeObjectURL(u);
    rotatedUrlsRef.current = [];
    maskUrlsRef.current = [];
    setImageUrl(null);
    setOriginalImageUrl(null);
    setRotationAngle(0);
    setMaskUrl(null);
    setCalibrationPoints([]);
    setDataPoints([]);
    setAutoCalState({ kind: "idle" });
    hasRunAutoCalRef.current = false;
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

            {/* Chart preview */}
            <div
              className="animate-fade-in-up"
              style={{ animationDelay: "300ms" }}
            >
              <p className="text-xs font-medium text-muted-foreground text-center mb-3 uppercase tracking-wider">
                Primjer predloška
              </p>
              <div className="bg-card border border-border/60 rounded-2xl p-5 shadow-sm max-w-5xl mx-auto">
                <ChartSVG config={CHART_CONFIGS.barograph} />
              </div>
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

            {/* Mini chart preview */}
            <div className="bg-card border border-border/60 rounded-xl p-4 mb-8">
              <div
                className={
                  config.orientation === "landscape"
                    ? "max-h-40"
                    : "max-h-64 max-w-[200px] mx-auto"
                }
              >
                <ChartSVG config={config} />
              </div>
            </div>

            <ImageUpload onImageSelected={handleImageSelected} />
          </div>
        )}

        {/* ═══ STEP 3: CALIBRATE ═══ */}
        {step === "calibrate" && config && imageUrl && (
          <div className="py-5 animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setStep("upload")}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Natrag
                </button>
                <div>
                  <h2 className="text-xl font-bold tracking-tight">
                    Kalibracija
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Poravnajte sliku s predloškom
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-4">
                {/* Rotate scan: clears calibration so user can re-run auto-detect */}
                <div className="flex items-center gap-1 bg-card border border-border/60 rounded-xl px-2 py-1">
                  <button
                    onClick={() => handleRotateBy(-90)}
                    disabled={autoCalState.kind === "running"}
                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                    title="Zarotiraj 90° ulijevo"
                    type="button"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleRotateBy(180)}
                    disabled={autoCalState.kind === "running"}
                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                    title="Zarotiraj 180° (naopako)"
                    type="button"
                  >
                    <FlipVertical className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleRotateBy(90)}
                    disabled={autoCalState.kind === "running"}
                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                    title="Zarotiraj 90° udesno"
                    type="button"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Fine angle slider — ~3 arc-minute precision */}
                <div className="flex items-center gap-2 bg-card border border-border/60 rounded-xl px-3 py-2">
                  <span
                    className={`text-xs whitespace-nowrap transition-colors ${
                      isRotating
                        ? "text-primary animate-pulse"
                        : "text-muted-foreground"
                    }`}
                  >
                    {isRotating ? "Rotiranje…" : "Kut"}
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
                    className="w-32 slider-emerald"
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
                    className="w-16 bg-muted/40 border border-border rounded-md px-1.5 py-0.5 text-xs font-mono font-medium text-right focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <span className="text-xs text-muted-foreground">°</span>
                  <button
                    onClick={() => setRotationAngle(0)}
                    className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    title="Resetiraj kut"
                    type="button"
                  >
                    0°
                  </button>
                </div>

                {/* Auto-detect (JS frontend) */}
                <button
                  onClick={handleAutoCalibrate}
                  disabled={autoCalState.kind === "running"}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gradient-to-r from-violet-500/15 to-fuchsia-500/15 border border-violet-500/30 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:from-violet-500/25 hover:to-fuchsia-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Automatska detekcija (JS, 1D projekcija)"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {autoCalState.kind === "running"
                    ? "Detektiranje..."
                    : "Auto-detect"}
                </button>
                {/* Auto-detect via backend (intersections) */}
                <button
                  onClick={handleBackendCalibrate}
                  disabled={autoCalState.kind === "running"}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gradient-to-r from-emerald-500/15 to-teal-500/15 border border-emerald-500/30 text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:from-emerald-500/25 hover:to-teal-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Backend kalibracija (sjecišta linija)"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Auto-cal (sjecišta)
                </button>

                {/* Detection mask overlay opacity (replaces old Predložak) */}
                <div className="flex items-center gap-2 bg-card border border-border/60 rounded-xl px-3 py-2">
                  <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    Detekcija
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={maskOpacity}
                    onChange={(e) => setMaskOpacity(parseFloat(e.target.value))}
                    className="w-28 slider-emerald"
                  />
                  <span className="text-xs font-mono text-muted-foreground w-8 text-right">
                    {Math.round(maskOpacity * 100)}%
                  </span>
                </div>

                {/* Calibration point counter */}
                <div className="flex items-center gap-2 bg-card border border-border/60 rounded-xl px-3 py-2">
                  <Crosshair className="w-3.5 h-3.5 text-orange-500" />
                  <span className="text-xs font-mono font-medium">
                    {calibrationPoints.length}
                  </span>
                  <span className="text-xs text-muted-foreground">točaka</span>
                </div>

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

            <p className="text-xs text-muted-foreground mb-3">
              Kliknite na poznate točke grafa (presjeci linija, kutovi). Min. 3.
              <span className="text-foreground/60 ml-1">
                Alt+klik pomicanje / Scroll zoom
              </span>
            </p>

            {/* Auto-calibration status banner */}
            {autoCalState.kind === "success" && (
              <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-700 dark:text-emerald-400 animate-fade-in">
                <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="flex-1">
                  Detektirano:{" "}
                  <span className="font-mono font-semibold">
                    {autoCalState.result.diagnostics.detectedCols}×
                    {autoCalState.result.diagnostics.detectedRows}
                  </span>{" "}
                  linija (očekivano{" "}
                  <span className="font-mono">
                    {autoCalState.result.diagnostics.expectedCols}×
                    {autoCalState.result.diagnostics.expectedRows}
                  </span>
                  ), RMS{" "}
                  <span className="font-mono">
                    {autoCalState.result.diagnostics.colsRms.toFixed(2)}/
                    {autoCalState.result.diagnostics.rowsRms.toFixed(2)} px
                  </span>
                  , povjerenje{" "}
                  <span className="font-mono font-semibold">
                    {(autoCalState.result.confidence * 100).toFixed(0)}%
                  </span>
                </span>
              </div>
            )}
            {autoCalState.kind === "fail" && (
              <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-700 dark:text-amber-400 animate-fade-in">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{autoCalState.message}</span>
              </div>
            )}

            {/* Advanced detection settings (collapsible) */}
            <div className="mb-3">
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                type="button"
              >
                <Settings2 className="w-3.5 h-3.5" />
                Napredne postavke detekcije
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform ${
                    settingsOpen ? "rotate-180" : ""
                  }`}
                />
              </button>
              {settingsOpen && (
                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 p-4 rounded-xl bg-card border border-border/60 animate-fade-in">
                  {(
                    [
                      ["minSaturation", "Min saturacija (zelena)", 0, 0.5, 0.01],
                      ["minValue", "Min svjetlina", 0, 0.5, 0.01],
                      ["maxValue", "Maks svjetlina", 0.5, 1, 0.01],
                      [
                        "greenDominance",
                        "Zelena dominacija (G/max)",
                        0.5,
                        1,
                        0.01,
                      ],
                      ["darkLineMaxV", "Tamne linije: maks v", 0, 0.6, 0.01],
                      ["darkLineMaxS", "Tamne linije: maks s", 0, 0.6, 0.01],
                      ["smoothRadius", "Zaglađivanje", 0, 5, 1],
                      ["peakProminence", "Prominencija vrha", 1, 2, 0.05],
                      ["minPeakSeparation", "Min razmak (px)", 1, 20, 1],
                      ["maxRelativeRms", "Maks rel. RMS", 0.05, 0.6, 0.01],
                    ] as const
                  ).map(([key, label, min, max, step]) => (
                    <div key={key} className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
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
                  <div className="md:col-span-2 lg:col-span-4 flex justify-end pt-1">
                    <button
                      onClick={() => setDetectionConfig(DETECTION_DEFAULTS)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
                      type="button"
                    >
                      Vrati zadane vrijednosti
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div
              className="bg-card border border-border/60 rounded-2xl overflow-hidden shadow-lg"
              style={{ height: "calc(100vh - 200px)" }}
            >
              <OverlayCanvas
                config={config}
                imageUrl={imageUrl}
                mode="calibrate"
                calibrationPoints={calibrationPoints}
                onCalibrationPointAdd={handleCalibrationPointAdd}
                onCalibrationPointRemove={handleCalibrationPointRemove}
                dataPoints={dataPoints}
                onDataPointAdd={handleDataPointAdd}
                onDataPointRemove={handleDataPointRemove}
                maskUrl={maskUrl}
                maskOpacity={maskOpacity}
                affineMatrix={affineMatrix}
              />
            </div>
          </div>
        )}

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
                    mode="digitize"
                    calibrationPoints={calibrationPoints}
                    onCalibrationPointAdd={handleCalibrationPointAdd}
                    onCalibrationPointRemove={handleCalibrationPointRemove}
                    dataPoints={dataPoints}
                    onDataPointAdd={handleDataPointAdd}
                    onDataPointRemove={handleDataPointRemove}
                    maskUrl={maskUrl}
                    maskOpacity={maskOpacity}
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
    </div>
  );
}
