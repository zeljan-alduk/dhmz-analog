"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { ChartConfig, CalibrationPoint, DataPoint } from "@/lib/types";
import { canvasToValue, formatHour, getDayName } from "@/lib/chart-geometry";
import { computeAffineTransform, imageToChart } from "@/lib/transform";
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
  imageOpacity: number;
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
  imageOpacity,
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

  // Load image dimensions
  useEffect(() => {
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = imageUrl;
  }, [imageUrl]);

  // Compute the transform from calibration points
  const transform = computeAffineTransform(calibrationPoints);

  // Chart dimensions for the SVG overlay
  const isLandscape = config.orientation === "landscape";
  const svgW = isLandscape
    ? config.chartWidth + 36
    : config.paperWidth + 19;
  const svgH = isLandscape
    ? config.chartHeight + 22
    : config.paperHeight + 24;

  // Use SVG dimensions as the base coordinate system
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
      const newZoom = Math.min(
        20,
        Math.max(0.5, zoom * (e.deltaY < 0 ? 1.15 : 0.87))
      );

      // Zoom toward cursor
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
        // Middle click or Alt+click to pan
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
        setPan({
          x: e.clientX - panStart.x,
          y: e.clientY - panStart.y,
        });
        return;
      }

      // Show cursor info in digitize mode
      if (mode === "digitize" && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const svgX = (e.clientX - rect.left - pan.x) / zoom;
        const svgY = (e.clientY - rect.top - pan.y) / zoom;

        // Convert SVG coords to chart coords (approximate)
        const marginL = isLandscape ? 18 : 5;
        const marginT = isLandscape ? 14 : 12;
        const chartX = svgX - marginL - (isLandscape ? 0 : config.marginStart);
        const chartY = svgY - marginT - (isLandscape ? 0 : (config.paperHeight - config.chartHeight) / 2);

        if (
          chartX >= 0 && chartX <= config.chartWidth &&
          chartY >= 0 && chartY <= config.chartHeight
        ) {
          const info = canvasToValue(chartX, chartY, config);
          setCursorInfo(info);
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

      // Position in SVG coordinate space
      const svgX = (e.clientX - rect.left - pan.x) / zoom;
      const svgY = (e.clientY - rect.top - pan.y) / zoom;

      if (mode === "calibrate") {
        // In calibration mode, clicking sets a point on the image
        // User will need to specify the chart coordinate separately
        const point: CalibrationPoint = {
          id: `cal-${Date.now()}`,
          imgX: svgX,
          imgY: svgY,
          chartX: svgX, // Will be adjusted via UI
          chartY: svgY,
        };
        onCalibrationPointAdd(point);
      } else if (mode === "digitize") {
        // Convert click position to chart value
        const marginL = isLandscape ? 18 : 5;
        const marginT = isLandscape ? 14 : 12;
        const chartX = svgX - marginL - (isLandscape ? 0 : config.marginStart);
        const chartY = svgY - marginT - (isLandscape ? 0 : (config.paperHeight - config.chartHeight) / 2);

        if (
          chartX >= 0 && chartX <= config.chartWidth &&
          chartY >= 0 && chartY <= config.chartHeight
        ) {
          const { day, hour, value } = canvasToValue(chartX, chartY, config);
          const point: DataPoint = {
            id: `dp-${Date.now()}`,
            canvasX: svgX,
            canvasY: svgY,
            day,
            hour,
            value: Math.round(value * 10) / 10,
            dayLabel: getDayName(day),
            timeLabel: formatHour(hour),
          };
          onDataPointAdd(point);
        }
      }
    },
    [
      mode,
      isPanning,
      pan,
      zoom,
      config,
      isLandscape,
      onCalibrationPointAdd,
      onDataPointAdd,
    ]
  );

  return (
    <div className="relative w-full h-full overflow-hidden bg-gray-100 rounded-lg">
      {/* Cursor info bar */}
      {mode === "digitize" && cursorInfo && (
        <div className="absolute top-2 left-2 z-20 bg-black/70 text-white text-xs px-3 py-1.5 rounded-md font-mono">
          {getDayName(cursorInfo.day)} {formatHour(cursorInfo.hour)} ={" "}
          {cursorInfo.value.toFixed(1)} {config.unit}
        </div>
      )}

      {/* Zoom indicator */}
      <div className="absolute top-2 right-2 z-20 bg-black/70 text-white text-xs px-2 py-1 rounded">
        {Math.round(zoom * 100)}%
      </div>

      <div
        ref={containerRef}
        className="w-full h-full cursor-crosshair"
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
          {/* Image layer */}
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
                opacity: imageOpacity,
                pointerEvents: "none",
              }}
              draggable={false}
            />
          )}

          {/* Chart template SVG layer */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: baseW,
              height: baseH,
              pointerEvents: "none",
              opacity: 0.85,
            }}
          >
            <ChartSVG config={config} />
          </div>

          {/* Calibration points */}
          {mode === "calibrate" &&
            calibrationPoints.map((p) => (
              <div
                key={p.id}
                className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-red-500 bg-red-500/30 cursor-pointer hover:bg-red-500/60"
                style={{ left: p.imgX, top: p.imgY }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCalibrationPointRemove(p.id);
                }}
                title="Kliknite za uklanjanje"
              />
            ))}

          {/* Data points */}
          {mode === "digitize" &&
            dataPoints.map((p) => (
              <div
                key={p.id}
                className={`absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full border border-blue-600 cursor-pointer
                  ${hoveredPoint === p.id ? "bg-blue-600 scale-150" : "bg-blue-500/60"}`}
                style={{ left: p.canvasX, top: p.canvasY, transition: "transform 0.1s" }}
                onMouseEnter={() => setHoveredPoint(p.id)}
                onMouseLeave={() => setHoveredPoint(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  onDataPointRemove(p.id);
                }}
                title={`${p.dayLabel} ${p.timeLabel} = ${p.value} ${config.unit} (klik za brisanje)`}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
