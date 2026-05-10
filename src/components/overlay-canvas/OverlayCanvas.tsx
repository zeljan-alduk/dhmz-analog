"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { ChartConfig, CalibrationPoint, DataPoint } from "@/lib/types";
import {
  canvasToValue,
  formatHour,
  getDayName,
  getDisplaySize,
  valueToChart,
} from "@/lib/chart-geometry";
import { imageToChart } from "@/lib/transform";
import { CalibrationDialog } from "@/components/calibration-dialog/CalibrationDialog";
import type { VectorPolyline } from "@/lib/vectorize";

interface OverlayCanvasProps {
  config: ChartConfig;
  /** Always-available preview image (rotated, ≤1500 px). Used at low zoom and
   *  as a fallback while the high-res rotation is still computing. */
  imageUrl: string;
  /** Optional full-res rotated image. Swapped in when zoom ≥ HIGH_RES_ZOOM
   *  threshold so the user gets actual pixel detail when calibrating sub-mm
   *  grid intersections or examining the trace. */
  fullResImageUrl?: string | null;
  mode: "calibrate" | "digitize";
  calibrationPoints: CalibrationPoint[];
  onCalibrationPointAdd: (point: CalibrationPoint) => void;
  onCalibrationPointRemove: (id: string) => void;
  dataPoints: DataPoint[];
  onDataPointAdd: (point: DataPoint) => void;
  onDataPointRemove: (id: string) => void;
  /** Detection mask blob URL (highlights detected grid pixels). */
  maskUrl?: string | null;
  /** Mask overlay opacity 0–1. */
  maskOpacity?: number;
  /** Underlying image opacity 0–1. Set to 0 for "mask only" inspection mode
   *  so users can see exactly which pixels the detector accepted, without
   *  the original muddying the view. Defaults to 1. */
  imageOpacity?: number;
  /** Optional vectorized polylines (display-px coords) tagged with grid
   *  weight. Major lines are drawn thicker than minor. */
  tracePolylines?: VectorPolyline[] | null;
  /** Show a black horizontal reference line at the chart's middle Y. Used
   *  as a visual aid for rotation alignment — user adjusts the rotation
   *  slider until detected grid horizontals are parallel to the baseline. */
  showBaseline?: boolean;
  /** Forward affine matrix (image-px → chart-mm). 6 numbers: [a,b,c,d,e,f]. */
  affineMatrix?: number[] | null;
}

/** Zoom level at which we swap the displayed `<img>` src from the preview
 *  blob to the full-res blob. At 100 % the preview is sharper than the
 *  display canvas resolution, so the swap only matters when zoomed in. */
const HIGH_RES_ZOOM = 1.8;

/**
 * Convert a sequence of points into an SVG path string, using Catmull-Rom
 * splines for smoothness. Each interior segment becomes a cubic Bezier whose
 * control points are derived from the neighbours (tension 0.5 → standard
 * Catmull-Rom). Endpoints duplicate themselves so the curve passes through
 * the first and last points exactly.
 */
function catmullRomToBezierPath(points: number[][]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M ${x} ${y}`;
  }
  const cmds: string[] = [`M ${points[0][0]} ${points[0][1]}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    cmds.push(
      `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`
    );
  }
  return cmds.join(" ");
}

export function OverlayCanvas({
  config,
  imageUrl,
  fullResImageUrl,
  mode,
  calibrationPoints,
  onCalibrationPointAdd,
  onCalibrationPointRemove,
  dataPoints,
  onDataPointAdd,
  onDataPointRemove,
  maskUrl,
  maskOpacity = 0,
  imageOpacity = 1,
  tracePolylines = null,
  showBaseline = false,
  affineMatrix,
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

  // Calibration dialog state — holds the click while user enters chart coords
  const [pendingCalibration, setPendingCalibration] = useState<{
    imgX: number;
    imgY: number;
  } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = imageUrl;
  }, [imageUrl]);

  const isLandscape = config.orientation === "landscape";
  const { w: baseW, h: baseH } = getDisplaySize(config);

  // Layout offsets used by the FALLBACK chart-mm mapping (when no calibration
  // has been set yet). Authored in chart-mm but multiplied up to display
  // pixels so the comparison with svgX/svgY (also display pixels) is correct.
  // After calibration, the affine matrix takes over and these are unused.
  const DISPLAY_SCALE = baseW / (isLandscape
    ? config.chartWidth + 36
    : config.paperWidth + 19);
  const marginL = (isLandscape ? 18 : 5) * DISPLAY_SCALE;
  const marginT = (isLandscape ? 14 : 12) * DISPLAY_SCALE;
  const portraitMarginX = (isLandscape ? 0 : config.marginStart) * DISPLAY_SCALE;
  const portraitMarginY =
    (isLandscape ? 0 : (config.paperHeight - config.chartHeight) / 2) *
    DISPLAY_SCALE;

  /** Map a click on the canvas (svgX, svgY in display pixels) to chart-mm. */
  const canvasToChartMm = useCallback(
    (svgX: number, svgY: number): { chartX: number; chartY: number } | null => {
      if (affineMatrix) {
        // Affine maps display-pixel → chart-mm directly (calibration corners
        // are stored in display-pixel space, so the matrix accounts for any
        // DISPLAY_SCALE used at that time).
        const { chartX, chartY } = imageToChart(svgX, svgY, affineMatrix);
        return { chartX, chartY };
      }
      // Fallback: assume the image is roughly aligned with the SVG template.
      // Subtract margins (already in display pixels) and divide by scale to
      // recover chart-mm.
      const chartX = (svgX - marginL - portraitMarginX) / DISPLAY_SCALE;
      const chartY = (svgY - marginT - portraitMarginY) / DISPLAY_SCALE;
      return { chartX, chartY };
    },
    [affineMatrix, marginL, marginT, portraitMarginX, portraitMarginY, DISPLAY_SCALE]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      // Distinguish ZOOM (pinch / Ctrl-wheel / mouse wheel) from PAN
      // (trackpad two-finger drag).
      //
      //   - Pinch on macOS trackpad = Ctrl+wheel (browsers synthesize this)
      //   - Cmd+wheel on Mac, Ctrl+wheel on Windows/Linux = explicit zoom
      //   - Trackpad two-finger drag = wheel with horizontal delta and/or
      //     fractional / small vertical delta
      //   - Traditional mouse wheel = large integer-valued vertical delta
      //
      // Heuristic: zoom on Ctrl/Meta or "mouse-shaped" wheel events;
      // otherwise pan. This gives correct behaviour on Mac trackpads
      // (drag-to-pan) while preserving wheel-zoom for users on a mouse.
      const isModifierZoom = e.ctrlKey || e.metaKey;
      const hasHorizontal = Math.abs(e.deltaX) > 0;
      const isFractional = !Number.isInteger(e.deltaY);
      const looksLikeTrackpad =
        hasHorizontal || isFractional || Math.abs(e.deltaY) < 40;

      if (isModifierZoom || !looksLikeTrackpad) {
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const oldZoom = zoom;
        // Smoother zoom factor for pinch (small delta) and a snappier one
        // for mouse wheel (large delta).
        const factor = isModifierZoom
          ? Math.exp(-e.deltaY * 0.01)
          : e.deltaY < 0
            ? 1.15
            : 0.87;
        const newZoom = Math.min(20, Math.max(0.5, zoom * factor));
        const scale = newZoom / oldZoom;
        setPan({
          x: mouseX - scale * (mouseX - pan.x),
          y: mouseY - scale * (mouseY - pan.y),
        });
        setZoom(newZoom);
      } else {
        // Two-finger trackpad drag → pan in both axes
        setPan({
          x: pan.x - e.deltaX,
          y: pan.y - e.deltaY,
        });
      }
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
        const mm = canvasToChartMm(svgX, svgY);
        if (
          mm &&
          mm.chartX >= 0 &&
          mm.chartX <= config.chartWidth &&
          mm.chartY >= 0 &&
          mm.chartY <= config.chartHeight
        ) {
          setCursorInfo(canvasToValue(mm.chartX, mm.chartY, config));
        } else {
          setCursorInfo(null);
        }
      }
    },
    [isPanning, panStart, mode, zoom, pan, config, canvasToChartMm]
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
        // Defer adding the point until the user identifies it via the dialog.
        setPendingCalibration({ imgX: svgX, imgY: svgY });
      } else if (mode === "digitize") {
        const mm = canvasToChartMm(svgX, svgY);
        if (
          mm &&
          mm.chartX >= 0 &&
          mm.chartX <= config.chartWidth &&
          mm.chartY >= 0 &&
          mm.chartY <= config.chartHeight
        ) {
          const { day, hour, value } = canvasToValue(mm.chartX, mm.chartY, config);
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
    [mode, isPanning, pan, zoom, config, canvasToChartMm, onDataPointAdd]
  );

  const handleConfirmCalibration = useCallback(
    (data: { day: number; hour: number; value: number }) => {
      if (!pendingCalibration) return;
      const { chartX, chartY } = valueToChart(
        data.day,
        data.hour,
        data.value,
        config
      );
      onCalibrationPointAdd({
        id: `cal-${Date.now()}`,
        imgX: pendingCalibration.imgX,
        imgY: pendingCalibration.imgY,
        chartX,
        chartY,
        meta: data,
      });
      setPendingCalibration(null);
    },
    [pendingCalibration, config, onCalibrationPointAdd]
  );

  // Suggested defaults for the dialog: snap the click to the nearest grid
  // intersection in the (untransformed) template space.
  const dialogInitial = pendingCalibration
    ? (() => {
        const mm = canvasToChartMm(
          pendingCalibration.imgX,
          pendingCalibration.imgY
        );
        if (!mm) return undefined;
        const guess = canvasToValue(mm.chartX, mm.chartY, config);
        return {
          day: Math.max(0, Math.min(7, Math.round(guess.day))),
          hour: Math.round(guess.hour),
          value:
            Math.round(guess.value / config.minorGrid) * config.minorGrid,
        };
      })()
    : undefined;

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

      {/* Affine status badge */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
        {mode === "digitize" && (
          <div
            className={`glass rounded-lg px-2 py-1 text-[10px] font-mono font-medium ${
              affineMatrix ? "text-emerald-500" : "text-amber-500"
            }`}
            title={
              affineMatrix
                ? "Affine warp aktivan"
                : "Bez kalibracije — koordinate približne"
            }
          >
            {affineMatrix ? "● kalibrirano" : "○ bez kalibracije"}
          </div>
        )}
        <div className="glass rounded-lg px-2 py-1 flex items-center gap-1.5">
          <span className="text-[10px] font-mono font-medium text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          {fullResImageUrl && zoom >= HIGH_RES_ZOOM && (
            <span
              className="text-[9px] font-mono font-bold text-emerald-500"
              title="Puna rezolucija aktivna"
            >
              HD
            </span>
          )}
        </div>
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
          {/* IMAGE LAYER — swap to full-res when zoomed in. We render BOTH
              <img> elements so the preview stays in the DOM while the full-res
              decodes (avoids a blank flash). Opacity is user-controlled
              (`imageOpacity`) so users can dim or hide the image to inspect
              the mask alone. */}
          {imgSize.w > 0 && imageOpacity > 0 && (
            <>
              <img
                src={imageUrl}
                alt="Scan (preview)"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: baseW,
                  height: baseH,
                  objectFit: "fill",
                  opacity: imageOpacity,
                  pointerEvents: "none",
                  transition: "opacity 0.15s ease",
                }}
                draggable={false}
              />
              {fullResImageUrl && zoom >= HIGH_RES_ZOOM && (
                <img
                  src={fullResImageUrl}
                  alt="Scan (full-res)"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: baseW,
                    height: baseH,
                    objectFit: "fill",
                    opacity: imageOpacity,
                    pointerEvents: "none",
                    imageRendering: "auto",
                    transition: "opacity 0.15s ease",
                  }}
                  draggable={false}
                />
              )}
            </>
          )}
          {/* MASK-ONLY background: when the image is hidden, paint a soft
              neutral background so the (multiply-blended) mask is visible
              against something other than the page colour. */}
          {imgSize.w > 0 && imageOpacity === 0 && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: baseW,
                height: baseH,
                background: "#fafaf9",
                pointerEvents: "none",
              }}
            />
          )}

          {/* DETECTION MASK LAYER — colored overlay of pixels matched by the
              current detection thresholds. Sits on top of the scan so the user
              can see exactly which pixels are being included. */}
          {maskUrl && maskOpacity > 0 && (
            <img
              src={maskUrl}
              alt=""
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: baseW,
                height: baseH,
                objectFit: "fill",
                opacity: maskOpacity,
                pointerEvents: "none",
                mixBlendMode: "multiply",
                transition: "opacity 0.15s ease",
              }}
              draggable={false}
            />
          )}

          {/* HORIZONTAL BASELINE — black reference line at canvas middle Y.
              Visual aid for rotation alignment: user rotates until detected
              grid horizontals run parallel to this line. Drawn at constant
              screen-px stroke width regardless of zoom. */}
          {showBaseline && (
            <svg
              width={baseW}
              height={baseH}
              viewBox={`0 0 ${baseW} ${baseH}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: baseW,
                height: baseH,
                pointerEvents: "none",
              }}
            >
              <line
                x1={0}
                y1={baseH / 2}
                x2={baseW}
                y2={baseH / 2}
                stroke="#000"
                strokeWidth={Math.max(0.5, 1.5 / zoom)}
                strokeDasharray={`${8 / zoom} ${4 / zoom}`}
                opacity={0.85}
              />
              {/* End markers + center tick for sub-pixel alignment guidance */}
              {[0, baseW / 2, baseW].map((x, i) => (
                <line
                  key={i}
                  x1={x}
                  y1={baseH / 2 - 8 / zoom}
                  x2={x}
                  y2={baseH / 2 + 8 / zoom}
                  stroke="#000"
                  strokeWidth={Math.max(0.5, 1.5 / zoom)}
                  opacity={0.85}
                />
              ))}
            </svg>
          )}

          {/* VECTORIZED TRACE OVERLAY — smooth polylines computed from the
              mask via centerline + Catmull-Rom. Drawn as crisp vector paths
              regardless of zoom (no pixelation). Stroke is independent of
              zoom — we apply 1/zoom in the strokeWidth so it stays visually
              ~1.5 px wide on screen at any magnification. */}
          {tracePolylines && tracePolylines.length > 0 && (
            <svg
              width={baseW}
              height={baseH}
              viewBox={`0 0 ${baseW} ${baseH}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: baseW,
                height: baseH,
                pointerEvents: "none",
              }}
            >
              {tracePolylines.map((poly, i) => {
                // Stroke width in SCREEN pixels: major 3, minor 2, fine 1.
                // Divided by zoom so the visual stroke stays constant
                // regardless of magnification (the outer container is
                // CSS-scaled by `zoom`).
                const screenPx =
                  poly.weight === "major"
                    ? 3
                    : poly.weight === "minor"
                      ? 2
                      : 1;
                return (
                  <path
                    key={i}
                    d={catmullRomToBezierPath(poly.points)}
                    fill="none"
                    stroke="#ec4899"
                    strokeWidth={Math.max(0.2, screenPx / zoom)}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    opacity={0.95}
                  />
                );
              })}
            </svg>
          )}

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
                <div className="w-[14px] h-[14px] rounded-full border-2 border-orange-400 bg-orange-400/20 cursor-pointer group-hover:bg-orange-400/50 transition-colors animate-pulse-glow" />
                <span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[9px] font-mono font-bold text-orange-400 bg-background/80 px-1 rounded whitespace-nowrap">
                  {i + 1} · {p.meta.value}
                  {config.unit.replace(/\s.*/, "")}
                </span>
              </div>
            ))}

          {/* Continuous trace polyline — connects all data points in time
              order, so dense auto-extracted output reads as a smooth line
              rather than a swarm of dots. */}
          {mode === "digitize" && dataPoints.length > 1 && (
            <svg
              width={baseW}
              height={baseH}
              viewBox={`0 0 ${baseW} ${baseH}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: baseW,
                height: baseH,
                pointerEvents: "none",
              }}
            >
              <polyline
                points={[...dataPoints]
                  .sort((a, b) =>
                    a.day !== b.day ? a.day - b.day : a.hour - b.hour
                  )
                  .map((p) => `${p.canvasX},${p.canvasY}`)
                  .join(" ")}
                fill="none"
                stroke="#10b981"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.85}
              />
            </svg>
          )}

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
                  className={`rounded-full transition-all duration-150 ${
                    hoveredPoint === p.id
                      ? "w-[10px] h-[10px] border-2 border-primary bg-primary scale-150 shadow-lg -ml-[5px] -mt-[5px]"
                      : "w-[4px] h-[4px] bg-primary/70 -ml-[2px] -mt-[2px]"
                  }`}
                />
                {hoveredPoint === p.id && (
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap glass rounded-md px-2 py-0.5 text-[9px] font-mono text-foreground shadow-lg pointer-events-none">
                    {p.value.toFixed(1)} {config.unit}
                  </div>
                )}
              </div>
            ))}
        </div>
      </div>

      {/* Calibration dialog */}
      <CalibrationDialog
        open={pendingCalibration !== null}
        onOpenChange={(open) => {
          if (!open) setPendingCalibration(null);
        }}
        config={config}
        onConfirm={handleConfirmCalibration}
        initial={dialogInitial}
      />
    </div>
  );
}
