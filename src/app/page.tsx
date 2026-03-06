"use client";

import { useState, useCallback } from "react";
import { ChartType, CalibrationPoint, DataPoint, WorkflowStep } from "@/lib/types";
import { CHART_CONFIGS } from "@/lib/chart-geometry";
import { ChartSVG } from "@/components/chart-template/ChartSVG";
import { ImageUpload } from "@/components/image-upload/ImageUpload";
import { OverlayCanvas } from "@/components/overlay-canvas/OverlayCanvas";
import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Gauge,
  Droplets,
  Thermometer,
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  Crosshair,
  MousePointerClick,
} from "lucide-react";

const CHART_OPTIONS: {
  type: ChartType;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    type: "barograph",
    label: "Barograf",
    description: "Tlak zraka (hPa)",
    icon: <Gauge className="w-8 h-8" />,
  },
  {
    type: "hygrograph",
    label: "Higrograf",
    description: "Relativna vlažnost (%)",
    icon: <Droplets className="w-8 h-8" />,
  },
  {
    type: "thermograph",
    label: "Termograf",
    description: "Temperatura (°C)",
    icon: <Thermometer className="w-8 h-8" />,
  },
];

const STEPS: { key: WorkflowStep; label: string; num: number }[] = [
  { key: "select", label: "Tip", num: 1 },
  { key: "upload", label: "Slika", num: 2 },
  { key: "calibrate", label: "Poravnanje", num: 3 },
  { key: "digitize", label: "Digitalizacija", num: 4 },
];

export default function Home() {
  const [step, setStep] = useState<WorkflowStep>("select");
  const [chartType, setChartType] = useState<ChartType | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [calibrationPoints, setCalibrationPoints] = useState<CalibrationPoint[]>([]);
  const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
  const [imageOpacity, setImageOpacity] = useState(0.5);

  const config = chartType ? CHART_CONFIGS[chartType] : null;

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
  };

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center">
              <Gauge className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-gray-900">
                DHMZ Analog Digitizer
              </h1>
              <p className="text-xs text-gray-500">
                Digitalizacija meteoroloških traka
              </p>
            </div>
          </div>
          {step !== "select" && (
            <Button variant="ghost" size="sm" onClick={handleReset}>
              <RotateCcw className="w-4 h-4 mr-1" />
              Početak
            </Button>
          )}
        </div>

        {/* Step indicator */}
        {step !== "select" && (
          <div className="max-w-7xl mx-auto px-4 pb-3">
            <div className="flex items-center gap-2">
              {STEPS.map((s, i) => (
                <div key={s.key} className="flex items-center gap-2">
                  <Badge
                    variant={
                      i === stepIndex
                        ? "default"
                        : i < stepIndex
                          ? "secondary"
                          : "outline"
                    }
                    className={`text-xs ${i === stepIndex ? "bg-green-600" : ""}`}
                  >
                    {s.num}. {s.label}
                  </Badge>
                  {i < STEPS.length - 1 && (
                    <ArrowRight className="w-3 h-3 text-gray-300" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Step 1: Chart type selection */}
        {step === "select" && (
          <div className="max-w-3xl mx-auto">
            <h2 className="text-2xl font-bold text-gray-900 mb-2 text-center">
              Odaberite tip instrumenta
            </h2>
            <p className="text-gray-500 text-center mb-8">
              Odaberite vrstu meteorološke trake koju želite digitalizirati
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {CHART_OPTIONS.map((opt) => (
                <Card
                  key={opt.type}
                  className="cursor-pointer hover:shadow-lg hover:border-green-400 transition-all group"
                  onClick={() => handleChartSelect(opt.type)}
                >
                  <CardContent className="flex flex-col items-center gap-3 py-8">
                    <div className="text-gray-400 group-hover:text-green-600 transition-colors">
                      {opt.icon}
                    </div>
                    <h3 className="text-lg font-semibold">{opt.label}</h3>
                    <p className="text-sm text-gray-500">{opt.description}</p>
                    <div className="mt-2">
                      <Badge variant="outline" className="text-xs">
                        {CHART_CONFIGS[opt.type].minValue}–
                        {CHART_CONFIGS[opt.type].maxValue} {CHART_CONFIGS[opt.type].unit}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Preview */}
            <div className="mt-12">
              <h3 className="text-sm font-medium text-gray-500 mb-3 text-center">
                Primjer predloška — Barograf
              </h3>
              <div className="bg-white rounded-xl p-4 shadow-sm border max-w-4xl mx-auto">
                <ChartSVG config={CHART_CONFIGS.barograph} />
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Image upload */}
        {step === "upload" && config && (
          <div className="max-w-2xl mx-auto">
            <div className="flex items-center gap-2 mb-6">
              <Button variant="ghost" size="sm" onClick={() => setStep("select")}>
                <ArrowLeft className="w-4 h-4 mr-1" />
                Natrag
              </Button>
              <h2 className="text-xl font-bold">
                Učitajte sliku — {config.label}
              </h2>
            </div>

            <div className="bg-white rounded-xl p-4 shadow-sm border mb-6">
              <p className="text-xs text-gray-500 mb-2">
                Predložak ({config.minValue}–{config.maxValue} {config.unit})
              </p>
              <div className={config.orientation === "landscape" ? "max-h-48" : "max-h-96 max-w-xs mx-auto"}>
                <ChartSVG config={config} />
              </div>
            </div>

            <ImageUpload onImageSelected={handleImageSelected} />
          </div>
        )}

        {/* Step 3: Calibration */}
        {step === "calibrate" && config && imageUrl && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setStep("upload")}>
                  <ArrowLeft className="w-4 h-4 mr-1" />
                  Natrag
                </Button>
                <h2 className="text-xl font-bold">Poravnanje slike</h2>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Crosshair className="w-4 h-4 text-red-500" />
                  <span className="text-sm text-gray-600">
                    Točke: {calibrationPoints.length}
                  </span>
                </div>
                <Button onClick={() => setStep("digitize")} disabled={calibrationPoints.length < 3}>
                  Nastavi na digitalizaciju
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>

            <p className="text-sm text-gray-500 mb-4">
              Kliknite na poznate točke (kutovi, presjeci linija) za poravnanje slike s predloškom.
              Min. 3 točke. Alt+klik za pomicanje, scroll za zoom.
            </p>

            <div className="flex items-center gap-3 mb-4">
              <span className="text-sm text-gray-600">Prozirnost slike:</span>
              <input
                type="range"
                min={0} max={1} step={0.05}
                value={imageOpacity}
                onChange={(e) => setImageOpacity(parseFloat(e.target.value))}
                className="w-48 accent-green-600"
              />
              <span className="text-sm text-gray-500 w-12">
                {Math.round(imageOpacity * 100)}%
              </span>
            </div>

            <div className="bg-white rounded-xl shadow-sm border" style={{ height: "70vh" }}>
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
                imageOpacity={imageOpacity}
              />
            </div>
          </div>
        )}

        {/* Step 4: Digitize */}
        {step === "digitize" && config && imageUrl && (
          <div className="flex gap-4 h-[calc(100vh-160px)]">
            <div className="flex-1 flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setStep("calibrate")}>
                    <ArrowLeft className="w-4 h-4 mr-1" />
                    Poravnanje
                  </Button>
                  <h2 className="text-xl font-bold">Digitalizacija</h2>
                  <Badge variant="outline" className="ml-2">{config.label}</Badge>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-600">Slika:</span>
                  <input
                    type="range"
                    min={0} max={1} step={0.05}
                    value={imageOpacity}
                    onChange={(e) => setImageOpacity(parseFloat(e.target.value))}
                    className="w-32 accent-green-600"
                  />
                </div>
              </div>

              <p className="text-sm text-gray-500 mb-3 flex items-center gap-1">
                <MousePointerClick className="w-4 h-4" />
                Kliknite na liniju traga za očitavanje vrijednosti. Alt+klik za pomicanje.
              </p>

              <div className="flex-1 bg-white rounded-xl shadow-sm border">
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
                  imageOpacity={imageOpacity}
                />
              </div>
            </div>

            <div className="w-80 flex-shrink-0">
              <DataTable
                dataPoints={dataPoints}
                config={config}
                onRemove={handleDataPointRemove}
                onUpdateValue={handleUpdateValue}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
