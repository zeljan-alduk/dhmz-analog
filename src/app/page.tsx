"use client";

import { useState, useCallback, useMemo } from "react";
import {
  ChartType,
  CalibrationPoint,
  DataPoint,
  WorkflowStep,
} from "@/lib/types";
import { CHART_CONFIGS, getDisplaySize } from "@/lib/chart-geometry";
import { computeAffineTransform } from "@/lib/transform";
import {
  runAutoCalibration,
  type AutoCalibrationResult,
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
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [calibrationPoints, setCalibrationPoints] = useState<CalibrationPoint[]>([]);
  const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
  const [svgOpacity, setSvgOpacity] = useState(0.6);

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

  const handleAutoCalibrate = useCallback(async () => {
    if (!imageUrl || !config) return;
    setAutoCalState({ kind: "running" });
    try {
      // Must match OverlayCanvas's display dimensions exactly — getDisplaySize
      // is the single source of truth for the (DISPLAY_SCALE × mm) sizing.
      const { w: baseW, h: baseH } = getDisplaySize(config);

      const result = await runAutoCalibration(imageUrl, config, baseW, baseH);
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
      setAutoCalState({
        kind: "fail",
        message: err instanceof Error ? err.message : "Auto-kalibracija nije uspjela.",
      });
    }
  }, [imageUrl, config]);

  const handleRotateImage = useCallback(
    async (degrees: 90 | -90 | 180) => {
      if (!imageUrl) return;
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = "anonymous";
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("load failed"));
        i.src = imageUrl;
      });
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const canvas = document.createElement("canvas");
      const isQuarter = degrees === 90 || degrees === -90;
      canvas.width = isQuarter ? h : w;
      canvas.height = isQuarter ? w : h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      if (degrees === 90) {
        ctx.translate(h, 0);
        ctx.rotate(Math.PI / 2);
      } else if (degrees === -90) {
        ctx.translate(0, w);
        ctx.rotate(-Math.PI / 2);
      } else {
        // 180°
        ctx.translate(w, h);
        ctx.rotate(Math.PI);
      }
      ctx.drawImage(img, 0, 0);
      const blob: Blob | null = await new Promise((r) =>
        canvas.toBlob(r, "image/png")
      );
      if (!blob) return;
      const newUrl = URL.createObjectURL(blob);
      const previousUrl = imageUrl;
      setImageUrl(newUrl);
      // Clear calibration — corners are no longer valid in the rotated image's
      // coordinate system.
      setCalibrationPoints([]);
      setAutoCalState({ kind: "idle" });
      if (previousUrl.startsWith("blob:")) URL.revokeObjectURL(previousUrl);
    },
    [imageUrl]
  );

  const handleChartSelect = (type: ChartType) => {
    setChartType(type);
    setStep("upload");
  };

  const handleImageSelected = (file: File) => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
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

  const handleReset = () => {
    setStep("select");
    setChartType(null);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(null);
    setCalibrationPoints([]);
    setDataPoints([]);
    setAutoCalState({ kind: "idle" });
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
                    onClick={() => handleRotateImage(-90)}
                    disabled={autoCalState.kind === "running"}
                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                    title="Zarotiraj 90° ulijevo"
                    type="button"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleRotateImage(180)}
                    disabled={autoCalState.kind === "running"}
                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                    title="Zarotiraj 180° (naopako)"
                    type="button"
                  >
                    <FlipVertical className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleRotateImage(90)}
                    disabled={autoCalState.kind === "running"}
                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                    title="Zarotiraj 90° udesno"
                    type="button"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Auto-detect button */}
                <button
                  onClick={handleAutoCalibrate}
                  disabled={autoCalState.kind === "running"}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gradient-to-r from-violet-500/15 to-fuchsia-500/15 border border-violet-500/30 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:from-violet-500/25 hover:to-fuchsia-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Automatska detekcija rešetke"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {autoCalState.kind === "running"
                    ? "Detektiranje..."
                    : "Auto-detect"}
                </button>

                {/* SVG opacity control */}
                <div className="flex items-center gap-2 bg-card border border-border/60 rounded-xl px-3 py-2">
                  <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    Predložak
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={svgOpacity}
                    onChange={(e) => setSvgOpacity(parseFloat(e.target.value))}
                    className="w-28 slider-emerald"
                  />
                  <span className="text-xs font-mono text-muted-foreground w-8 text-right">
                    {Math.round(svgOpacity * 100)}%
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
                svgOpacity={svgOpacity}
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
                    <div className="flex items-center gap-2 bg-card border border-border/60 rounded-xl px-3 py-1.5">
                      <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={svgOpacity}
                        onChange={(e) =>
                          setSvgOpacity(parseFloat(e.target.value))
                        }
                        className="w-24 slider-emerald"
                      />
                    </div>
                  </div>
                </div>

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
                    svgOpacity={svgOpacity}
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
