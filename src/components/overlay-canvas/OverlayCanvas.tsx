"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { ChartConfig, CalibrationPoint, DataPoint } from "@/lib/types";
import { canvasToValue, formatHour, getDayName } from "@/lib/chart-geometry";
import { ChartSVG } from "@/components/chart-template/ChartSVG";

interface OverlayCanvasProps {
  config: ChartConfig;
  imageUrl: string;
  mode: "calibrate" | "digitize";
  calibrationPoints: CalibrationPoint[];
  onCalibrationPointAdd: (point: CalibrationPoint) => void;
  onCalibrationPointRemove: (id: string) => void;
  dataPoints: DataPoint[];
  onDataPointAdd: (point: DataPoint) => void;
  onDataPointRemove: (id: string) => void;
  svgOpacity: number;
}

export function OverlayCanvas({
  config,
  imageUrl,
  mode,
  calibrationPoints,
  onCalibrationPointAdd,
  onCalibrationPointRemove,
  dataPoints,
  onDataPointAdd,
  onDataPointRemove,
  svgOpacity,
}: OverlayCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [hoveredPoint, setHoveredPoint] = useState<string | null>(null);
  const [cursorInfo, setCursorInfo] = useState<{
    day: number;
    hour: number;
    value: number;
  } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = imageUrl;
  }, [imageUrl]);

  const isLandscape = config.orientation === "landscape";
  const svgW = isLandscape ? config.chartWidth + 36 : config.paperWidth + 19;
  const svgH = isLandscape ? config.chartHeight + 22 : config.paperHeight + 24;
  const baseW = svgW;
  const baseH = svgH;

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const oldZoom = zoom;
      const newZoom = Math.min(20, Math.max(0.5, zoom * (e.deltaY < 0 ? 1.15 : 0.87)));
      const scale = newZoom / oldZoom;
      setPan({
        x: mouseX - scale * (mouseX - pan.x),
        y: mouseY - scale * (mouseY - pan.y),
      });
      setZoom(newZoom);
    },
    [zoom, pan]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        setIsPanning(true);
        setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
        e.preventDefault();
      }
    },
    [pan]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning) {
        setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
        return;
      }
      if (mode === "digitize" && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const svgX = (e.clientX - rect.left - pan.x) / zoom;
        const svgY = (e.clientY - rect.top - pan.y) / zoom;
        const marginL = isLandscape ? 18 : 5;
        const marginT = isLandscape ? 14 : 12;
        const chartX = svgX - marginL - (isLandscape ? 0 : config.marginStart);
        const chartY =
          svgY - marginT - (isLandscape ? 0 : (config.paperHeight - config.chartHeight) / 2);
        if (chartX >= 0 && chartX <= config.chartWidth && chartY >= 0 && chartY <= config.chartHeight) {
          setCursorInfo(canvasToValue(chartX, chartY, config));
        } else {
          setCursorInfo(null);
        }
      }
    },
    [isPanning, panStart, mode, zoom, pan, config, isLandscape]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning || e.altKey) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const svgX = (e.clientX - rect.left - pan.x) / zoom;
      const svgY = (e.clientY - rect.top - pan.y) / zoom;

      if (mode === "calibrate") {
        onCalibrationPointAdd({
          id: `cal-${Date.now()}`,
          imgX: svgX,
          imgY: svgY,
          chartX: svgX,
          chartY: svgY,
        });
      } else if (mode === "digitize") {
        const marginL = isLandscape ? 18 : 5;
        const marginT = isLandscape ? 14 : 12;
        const chartX = svgX - marginL - (isLandscape ? 0 : config.marginStart);
        const chartY =
          svgY - marginT - (isLandscape ? 0 : (config.paperHeight - config.chartHeight) / 2);
        if (chartX >= 0 && chartX <= config.chartWidth && chartY >= 0 && chartY <= config.chartHeight) {
          const { day, hour, value } = canvasToValue(chartX, chartY, config);
          onDataPointAdd({
            id: `dp-${Date.now()}`,
            canvasX: svgX,
            canvasY: svgY,
            day,
            hour,
            value: Math.round(value * 10) / 10,
            dayLabel: getDayName(day),
            timeLabel: formatHour(hour),
          });
        }
      }
    },
    [mode, isPanning, pan, zoom, config, isLandscape, onCalibrationPointAdd, onDataPointAdd]
  );

  return (
    <div className="relative w-full h-full overflow-hidden bg-muted/30 rounded-2xl">
      {/* Live readout */}
      {mode === "digitize" && cursorInfo && (
        <div className="absolute top-3 left-3 z-20 glass rounded-lg px-3 py-1.5 animate-fade-in">
          <span className="text-[11px] font-mono font-medium text-foreground">
            {getDayName(cursorInfo.day)}{" "}
            <span className="text-primary">{formatHour(cursorInfo.hour)}</span>
            {" = "}
            <span className="text-primary font-bold">
              {cursorInfo.value.toFixed(1)}
            </span>{" "}
            <span className="text-muted-foreground">{config.unit}</span>
          </span>
        </div>
      )}

      {/* Zoom badge */}
      <div className="absolute top-3 right-3 z-20 glass rounded-lg px-2 py-1">
        <span className="text-[10px] font-mono font-medium text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
      </div>

      <div
        ref={containerRef}
        className="w-full h-full cursor-precise"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
            position: "relative",
            width: baseW,
            height: baseH,
          }}
        >
          {/* IMAGE LAYER — always fully visible */}
          {imgSize.w > 0 && (
            <img
              src={imageUrl}
              alt="Scan"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: baseW,
                height: baseH,
                objectFit: "fill",
                opacity: 1,
                pointerEvents: "none",
              }}
              draggable={false}
            />
          )}

          {/* SVG TEMPLATE LAYER — opacity is adjustable */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: baseW,
              height: baseH,
              pointerEvents: "none",
              opacity: svgOpacity,
              transition: "opacity 0.15s ease",
            }}
          >
            <ChartSVG config={config} />
          </div>

          {/* Calibration points */}
          {mode === "calibrate" &&
            calibrationPoints.map((p, i) => (
              <div
                key={p.id}
                className="absolute -ml-[7px] -mt-[7px] group"
                style={{ left: p.imgX, top: p.imgY }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCalibrationPointRemove(p.id);
                }}
              >
                {/* Outer ring */}
                <div className="w-[14px] h-[14px] rounded-full border-2 border-orange-400 bg-orange-400/20 cursor-pointer group-hover:bg-orange-400/50 transition-colors animate-pulse-glow" />
                {/* Label */}
                <span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[9px] font-mono font-bold text-orange-400 bg-background/80 px-1 rounded">
                  {i + 1}
                </span>
              </div>
            ))}

          {/* Data points */}
          {mode === "digitize" &&
            dataPoints.map((p) => (
              <div
                key={p.id}
                className="absolute -ml-[5px] -mt-[5px] cursor-pointer group"
                style={{ left: p.canvasX, top: p.canvasY }}
                onMouseEnter={() => setHoveredPoint(p.id)}
                onMouseLeave={() => setHoveredPoint(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  onDataPointRemove(p.id);
                }}
              >
                <div
                  className={`w-[10px] h-[10px] rounded-full border-2 transition-all duration-150 ${
                    hoveredPoint === p.id
                      ? "border-primary bg-primary scale-150 shadow-lg"
                      : "border-primary bg-primary/40"
                  }`}
                />
                {/* Hover tooltip */}
                {hoveredPoint === p.id && (
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap glass rounded-md px-2 py-0.5 text-[9px] font-mono text-foreground shadow-lg pointer-events-none">
                    {p.value.toFixed(1)} {config.unit}
                  </div>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
