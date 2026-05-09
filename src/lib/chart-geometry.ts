import { ChartConfig, ChartType } from "./types";

/**
 * Pixels per chart-mm in the OverlayCanvas display layer. The underlying
 * geometry is in millimetres (Lambrecht paper sizes), but rendering at 1px/mm
 * makes the chart unusably small (~349×98 for a landscape barograph). 4×
 * fills a typical desktop viewport while preserving aspect ratio. Both
 * OverlayCanvas (display) and page.tsx (auto-cal display dims) must use this
 * same multiplier so calibration corners land in the same coordinate system
 * the user sees.
 */
export const DISPLAY_SCALE = 4;

/**
 * Compute the OverlayCanvas display dimensions for a given chart config.
 * Returns pixel sizes already scaled by DISPLAY_SCALE.
 */
export function getDisplaySize(config: ChartConfig): { w: number; h: number } {
  const isLandscape = config.orientation === "landscape";
  const svgW = isLandscape ? config.chartWidth + 36 : config.paperWidth + 19;
  const svgH = isLandscape ? config.chartHeight + 22 : config.paperHeight + 24;
  return { w: svgW * DISPLAY_SCALE, h: svgH * DISPLAY_SCALE };
}

export const CHART_CONFIGS: Record<ChartType, ChartConfig> = {
  barograph: {
    type: "barograph",
    label: "Barograf",
    unit: "hPa",
    minValue: 950,
    maxValue: 1060,
    majorGrid: 10,
    minorGrid: 5,
    fineGrid: 1,
    paperWidth: 313,
    paperHeight: 90,
    chartWidth: 313,
    chartHeight: 76.2,
    marginStart: 0,
    penArmRadius: 177.8,
    penArmPivot: 44.45,
    days: 8,
    orientation: "landscape",
  },
  hygrograph: {
    type: "hygrograph",
    label: "Higrograf",
    unit: "% RH",
    minValue: 0,
    maxValue: 100,
    majorGrid: 10,
    minorGrid: 5,
    fineGrid: 1,
    paperWidth: 90,
    paperHeight: 300,
    chartWidth: 76.2,
    chartHeight: 280,
    marginStart: 7,
    penArmRadius: 177.8,
    penArmPivot: 44.45,
    days: 8,
    orientation: "portrait",
  },
  thermograph: {
    type: "thermograph",
    label: "Termograf",
    unit: "°C",
    minValue: -35,
    maxValue: 45,
    majorGrid: 10,
    minorGrid: 5,
    fineGrid: 1,
    paperWidth: 90,
    paperHeight: 300,
    chartWidth: 76.2,
    chartHeight: 280,
    marginStart: 7,
    penArmRadius: 177.8,
    penArmPivot: 44.45,
    days: 8,
    orientation: "portrait",
  },
};

const DAY_LABELS = [
  { de: "Montag", en: "Monday", fr: "Lundi" },
  { de: "Dienstag", en: "Tuesday", fr: "Mardi" },
  { de: "Mittwoch", en: "Wednesday", fr: "Mercredi" },
  { de: "Donnerstag", en: "Thursday", fr: "Jeudi" },
  { de: "Freitag", en: "Friday", fr: "Vendredi" },
  { de: "Samstag", en: "Saturday", fr: "Samedi" },
  { de: "Sonntag", en: "Sunday", fr: "Dimanche" },
  { de: "Montag", en: "Monday", fr: "Lundi" },
];

export function getDayLabels() {
  return DAY_LABELS;
}

/**
 * Pen-arm arc sag (horizontal displacement) at a given measurement-axis position.
 *
 * Arm of length R, pivot at distance P from chart start. At measurement
 * position x, the pen sits at horizontal offset:
 *     sag(x) = (R − √(R² − (x−P)²)) − (R − √(R² − P²))
 * relative to a vertical reference line through the pivot height.
 *
 * Returns 0 at x = P (the pivot height) and grows with |x − P|.
 */
export function arcSag(measurementPos: number, config: ChartConfig): number {
  const R = config.penArmRadius;
  const P = config.penArmPivot;
  const sagAtPivot = R - Math.sqrt(R * R - P * P);
  const dx = measurementPos - P;
  const sagAtPos = R - Math.sqrt(R * R - dx * dx);
  return sagAtPos - sagAtPivot;
}

/**
 * For barograph (landscape): time arcs are vertical curves.
 * Forward: true time x → displayed x at given measurement y.
 */
export function barographArcX(
  timeX: number,
  measurementY: number,
  config: ChartConfig
): number {
  return timeX - arcSag(measurementY, config);
}

/**
 * For drum charts (portrait): time arcs are horizontal curves.
 * Forward: true time y → displayed y at given measurement x.
 */
export function drumArcY(
  timeY: number,
  measurementX: number,
  config: ChartConfig
): number {
  return timeY - arcSag(measurementX, config);
}

/**
 * Convert a chart-mm coordinate (post-affine) to (day, hour, value).
 * Applies inverse arc-sag so that the pen-arm curvature is removed before
 * decoding the time axis.
 */
export function canvasToValue(
  chartX: number,
  chartY: number,
  config: ChartConfig
): { day: number; hour: number; value: number } {
  if (config.orientation === "landscape") {
    // Barograph: X = time, Y = measurement (top = high pressure)
    const valueRange = config.maxValue - config.minValue;
    const value = config.maxValue - (chartY / config.chartHeight) * valueRange;

    // Inverse arc-sag: undo the horizontal shift caused by the pen arm
    // at this measurement height.
    const trueTimeX = chartX + arcSag(chartY, config);

    const dayWidth = config.chartWidth / config.days;
    const totalDay = trueTimeX / dayWidth;
    const day = Math.floor(totalDay);
    const hourFraction = (totalDay - day) * 24;

    return {
      day: Math.max(0, Math.min(day, 7)),
      hour: hourFraction,
      value,
    };
  } else {
    // Drum chart: Y = time (top→bottom), X = measurement (left→right)
    const valueRange = config.maxValue - config.minValue;
    const value = config.minValue + (chartX / config.chartWidth) * valueRange;

    const trueTimeY = chartY + arcSag(chartX, config);

    const dayHeight = config.chartHeight / config.days;
    const totalDay = trueTimeY / dayHeight;
    const day = Math.floor(totalDay);
    const hourFraction = (totalDay - day) * 24;

    return {
      day: Math.max(0, Math.min(day, 7)),
      hour: hourFraction,
      value,
    };
  }
}

/**
 * Inverse of canvasToValue: given a (day, hour, value), return the
 * displayed chart-mm coordinate (with arc-sag applied).
 *
 * Useful for placing reference markers on the template, and for
 * computing chart-mm from user-entered calibration metadata.
 */
export function valueToChart(
  day: number,
  hour: number,
  value: number,
  config: ChartConfig
): { chartX: number; chartY: number } {
  const valueRange = config.maxValue - config.minValue;

  if (config.orientation === "landscape") {
    const dayWidth = config.chartWidth / config.days;
    const trueTimeX = (day + hour / 24) * dayWidth;
    const chartY =
      ((config.maxValue - value) / valueRange) * config.chartHeight;
    // Apply forward arc-sag at this measurement height
    const chartX = trueTimeX - arcSag(chartY, config);
    return { chartX, chartY };
  } else {
    const dayHeight = config.chartHeight / config.days;
    const trueTimeY = (day + hour / 24) * dayHeight;
    const chartX = ((value - config.minValue) / valueRange) * config.chartWidth;
    const chartY = trueTimeY - arcSag(chartX, config);
    return { chartX, chartY };
  }
}

export function formatHour(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export function getDayName(dayIndex: number): string {
  const names = [
    "Ponedjeljak",
    "Utorak",
    "Srijeda",
    "Četvrtak",
    "Petak",
    "Subota",
    "Nedjelja",
    "Ponedjeljak",
  ];
  return names[Math.max(0, Math.min(dayIndex, 7))];
}
