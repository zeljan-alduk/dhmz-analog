"use client";

import { ChartConfig } from "@/lib/types";
import { getDayLabels } from "@/lib/chart-geometry";

const GREEN = "#2E8B2E";
const GREEN_LIGHT = "#7DBF7D";
const GREEN_FAINT = "#A8D8A8";

interface ChartSVGProps {
  config: ChartConfig;
  width?: number;
  height?: number;
  className?: string;
}

export function ChartSVG({ config, className }: ChartSVGProps) {
  if (config.orientation === "landscape") {
    return <BarographSVG config={config} className={className} />;
  }
  return <DrumChartSVG config={config} className={className} />;
}

function BarographSVG({
  config,
  className,
}: {
  config: ChartConfig;
  className?: string;
}) {
  const { chartWidth, chartHeight, penArmRadius: R, penArmPivot: P, days } = config;
  const dayWidth = chartWidth / days;
  const margin = { top: 14, left: 18, right: 18, bottom: 8 };
  const totalW = chartWidth + margin.left + margin.right;
  const totalH = chartHeight + margin.top + margin.bottom;

  const valueRange = config.maxValue - config.minValue;
  const numLines = valueRange / config.fineGrid;

  // Arc angles
  const thetaA = Math.PI + Math.asin(P / R);
  const thetaB = Math.PI - Math.asin((chartHeight - P) / R);

  // Arc start (bottom of chart) and end (top of chart) horizontal offset
  const arcStartX = R * Math.cos(thetaA);
  const arcEndX = R * Math.cos(thetaB);
  const arcEndY = R * Math.sin(thetaB) - R * Math.sin(thetaA);

  const dayLabels = getDayLabels();

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${totalW} ${totalH}`}
      className={className}
      style={{ width: "100%", height: "100%" }}
    >
      <rect width={totalW} height={totalH} fill="white" />
      <g transform={`translate(${margin.left},${margin.top})`}>
        {/* Chart border */}
        <rect
          x={0} y={0}
          width={chartWidth} height={chartHeight}
          fill="none" stroke={GREEN} strokeWidth={0.4}
        />

        {/* Pressure grid lines (horizontal, straight) */}
        {Array.from({ length: numLines + 1 }, (_, i) => {
          const y = chartHeight - (i / numLines) * chartHeight;
          const isMajor = i % (config.majorGrid / config.fineGrid) === 0;
          const isMinor = i % (config.minorGrid / config.fineGrid) === 0;
          const sw = isMajor ? 0.35 : isMinor ? 0.18 : 0.07;
          const color = isMajor ? GREEN : isMinor ? GREEN_LIGHT : GREEN_FAINT;
          return (
            <line
              key={`h${i}`}
              x1={0} y1={y} x2={chartWidth} y2={y}
              stroke={color} strokeWidth={sw}
            />
          );
        })}

        {/* Time arcs (vertical curves) */}
        {Array.from({ length: days * 12 + 1 }, (_, i) => {
          const x = (i / 12) * dayWidth;
          const isDayBoundary = i % 12 === 0;
          const is6h = i % 3 === 0;
          const is2h = true;
          const sw = isDayBoundary ? 0.4 : is6h ? 0.18 : 0.08;
          const color = isDayBoundary ? GREEN : is6h ? GREEN_LIGHT : GREEN_FAINT;

          // SVG arc from bottom to top
          const startX = x;
          const startY = chartHeight;
          const endXOffset = arcEndX - arcStartX;
          const endX = x + endXOffset;
          const endY = 0;

          return (
            <path
              key={`v${i}`}
              d={`M ${startX},${startY} A ${R},${R} 0 0,1 ${endX},${endY}`}
              fill="none"
              stroke={color}
              strokeWidth={sw}
            />
          );
        })}

        {/* Hour labels (top) */}
        {Array.from({ length: days }, (_, dayIdx) => (
          Array.from({ length: 12 }, (_, h) => {
            const hour = h * 2;
            const x = dayIdx * dayWidth + (h / 12) * dayWidth;
            return (
              <text
                key={`ht${dayIdx}-${h}`}
                x={x} y={-1.5}
                textAnchor="middle"
                fontSize={1.8} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
              >
                {hour}
              </text>
            );
          })
        ))}

        {/* Day labels (top) */}
        {dayLabels.map((day, i) => {
          const x = i * dayWidth + dayWidth / 2;
          return (
            <g key={`day${i}`}>
              <text
                x={x} y={-6}
                textAnchor="middle"
                fontSize={2.5} fontWeight={600} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
              >
                {day.de}
              </text>
              <text
                x={x} y={-3.8}
                textAnchor="middle"
                fontSize={1.8} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
              >
                {day.en} / {day.fr}
              </text>
            </g>
          );
        })}

        {/* Pressure labels (left) */}
        {Array.from(
          { length: Math.floor(valueRange / config.majorGrid) + 1 },
          (_, i) => {
            const value = config.minValue + i * config.majorGrid;
            const y = chartHeight - (i * config.majorGrid / valueRange) * chartHeight;
            return (
              <text
                key={`pl${i}`}
                x={-1.5} y={y + 0.7}
                textAnchor="end"
                fontSize={2.2} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
              >
                {value}
              </text>
            );
          }
        )}

        {/* Pressure labels (right) */}
        {Array.from(
          { length: Math.floor(valueRange / config.majorGrid) + 1 },
          (_, i) => {
            const value = config.minValue + i * config.majorGrid;
            const y = chartHeight - (i * config.majorGrid / valueRange) * chartHeight;
            return (
              <text
                key={`pr${i}`}
                x={chartWidth + 1.5} y={y + 0.7}
                textAnchor="start"
                fontSize={2.2} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
              >
                {value}
              </text>
            );
          }
        )}

        {/* Unit label */}
        <text
          x={-1.5} y={-2}
          textAnchor="end"
          fontSize={2} fill={GREEN}
          fontFamily="Helvetica,Arial,sans-serif"
        >
          hPa
        </text>
      </g>
    </svg>
  );
}

function DrumChartSVG({
  config,
  className,
}: {
  config: ChartConfig;
  className?: string;
}) {
  const { chartWidth, chartHeight, penArmRadius: R, penArmPivot: P, days, marginStart } = config;
  const dayHeight = chartHeight / days;
  const margin = { top: 12, left: 5, right: 14, bottom: 12 };
  const totalW = config.paperWidth + margin.left + margin.right;
  const totalH = config.paperHeight + margin.top + margin.bottom;

  const valueRange = config.maxValue - config.minValue;
  const numValueLines = valueRange / config.fineGrid;

  const dayLabels = getDayLabels();

  // For drum charts, arc sag is in the Y direction
  // At measurement position x from chart start:
  // sagY = R - sqrt(R² - (x-P)²) - (R - sqrt(R²-P²))
  function sagAt(x: number): number {
    const sagPivot = R - Math.sqrt(R * R - P * P);
    const sagX = R - Math.sqrt(R * R - (x - P) * (x - P));
    return sagX - sagPivot;
  }

  // Generate arc path for a horizontal time line
  function arcPath(timeY: number): string {
    const points: string[] = [];
    const steps = 50;
    for (let i = 0; i <= steps; i++) {
      const x = marginStart + (i / steps) * chartWidth;
      const measPos = (i / steps) * chartWidth;
      const y = timeY + sagAt(measPos);
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    return `M ${points.join(" L ")}`;
  }

  const chartTop = (config.paperHeight - chartHeight) / 2;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${totalW} ${totalH}`}
      className={className}
      style={{ width: "100%", height: "100%" }}
    >
      <rect width={totalW} height={totalH} fill="white" />
      <g transform={`translate(${margin.left},${margin.top})`}>
        {/* Chart border */}
        <rect
          x={marginStart} y={chartTop}
          width={chartWidth} height={chartHeight}
          fill="none" stroke={GREEN} strokeWidth={0.3}
        />

        {/* Measurement grid lines (vertical, straight) */}
        {Array.from({ length: numValueLines + 1 }, (_, i) => {
          const x = marginStart + (i / numValueLines) * chartWidth;
          const isMajor = i % (config.majorGrid / config.fineGrid) === 0;
          const isMinor = i % (config.minorGrid / config.fineGrid) === 0;
          const sw = isMajor ? 0.3 : isMinor ? 0.15 : 0.06;
          const color = isMajor ? GREEN : isMinor ? GREEN_LIGHT : GREEN_FAINT;

          // Highlight 0 line for thermograph
          const isZero = config.type === "thermograph" &&
            config.minValue + (i / numValueLines) * valueRange === 0;

          return (
            <line
              key={`v${i}`}
              x1={x} y1={chartTop}
              x2={x} y2={chartTop + chartHeight}
              stroke={isZero ? "#1E6B1E" : color}
              strokeWidth={isZero ? 0.5 : sw}
            />
          );
        })}

        {/* Time arcs (horizontal curves) */}
        {Array.from({ length: days * 12 + 1 }, (_, i) => {
          const y = chartTop + (i / 12) * dayHeight;
          const isDayBoundary = i % 12 === 0;
          const is6h = i % 3 === 0;
          const sw = isDayBoundary ? 0.35 : is6h ? 0.15 : 0.06;
          const color = isDayBoundary ? GREEN : is6h ? GREEN_LIGHT : GREEN_FAINT;

          return (
            <path
              key={`h${i}`}
              d={arcPath(y)}
              fill="none"
              stroke={color}
              strokeWidth={sw}
            />
          );
        })}

        {/* Value labels (top) */}
        {Array.from(
          { length: Math.floor(valueRange / config.majorGrid) + 1 },
          (_, i) => {
            const value = config.minValue + i * config.majorGrid;
            const x = marginStart + (i * config.majorGrid / valueRange) * chartWidth;
            return (
              <text
                key={`vt${i}`}
                x={x} y={chartTop - 1.5}
                textAnchor="middle"
                fontSize={2.2} fontWeight={600} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
              >
                {value}
              </text>
            );
          }
        )}

        {/* Value labels (bottom) */}
        {Array.from(
          { length: Math.floor(valueRange / config.majorGrid) + 1 },
          (_, i) => {
            const value = config.minValue + i * config.majorGrid;
            const x = marginStart + (i * config.majorGrid / valueRange) * chartWidth;
            return (
              <text
                key={`vb${i}`}
                x={x} y={chartTop + chartHeight + 3.5}
                textAnchor="middle"
                fontSize={2.2} fontWeight={600} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
              >
                {value}
              </text>
            );
          }
        )}

        {/* Unit label */}
        <text
          x={marginStart + chartWidth / 2} y={chartTop - 4}
          textAnchor="middle"
          fontSize={2} fill={GREEN}
          fontFamily="Helvetica,Arial,sans-serif"
        >
          {config.unit}
        </text>

        {/* Day labels (right side) */}
        {dayLabels.map((day, i) => {
          const y = chartTop + i * dayHeight + dayHeight / 2;
          return (
            <g key={`day${i}`}>
              <text
                x={marginStart + chartWidth + 2} y={y - 1.5}
                fontSize={2} fontWeight={600} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
              >
                {day.de}
              </text>
              <text
                x={marginStart + chartWidth + 2} y={y + 1}
                fontSize={1.5} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
              >
                {day.en}
              </text>
              <text
                x={marginStart + chartWidth + 2} y={y + 3}
                fontSize={1.5} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
                fontStyle="italic"
              >
                {day.fr}
              </text>
            </g>
          );
        })}

        {/* Hour labels (left side) */}
        {Array.from({ length: days }, (_, dayIdx) =>
          [0, 6, 12, 18].map((hour) => {
            const y = chartTop + dayIdx * dayHeight + (hour / 24) * dayHeight;
            return (
              <text
                key={`hl${dayIdx}-${hour}`}
                x={marginStart - 1} y={y + 0.6}
                textAnchor="end"
                fontSize={1.6} fill={GREEN}
                fontFamily="Helvetica,Arial,sans-serif"
              >
                {hour}
              </text>
            );
          })
        )}
      </g>
    </svg>
  );
}
