import { ChartConfig, ChartType } from "./types";

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
 * Calculate the arc sag (horizontal displacement) at a given position
 * along the measurement axis, caused by the pen arm geometry.
 *
 * For a pen arm of length R with pivot at distance P from chart start:
 * At measurement position x (0 = chart start):
 *   sag = R - sqrt(R² - (x - P)²) - (R - sqrt(R² - P²))
 *
 * This gives the horizontal offset (in time-axis direction) relative to
 * the straight line at the pivot height.
 */
export function arcSag(
  measurementPos: number,
  config: ChartConfig
): number {
  const R = config.penArmRadius;
  const P = config.penArmPivot;
  const sagAtPivot = R - Math.sqrt(R * R - P * P);
  const sagAtPos = R - Math.sqrt(R * R - (measurementPos - P) * (measurementPos - P));
  return sagAtPos - sagAtPivot;
}

/**
 * For barograph (landscape): time arcs are vertical curves.
 * Given a time position (x in mm) and measurement position (y from chart base),
 * returns the actual x position accounting for arc curvature.
 */
export function barographArcX(
  timeX: number,
  measurementY: number,
  config: ChartConfig
): number {
  const sag = arcSag(measurementY, config);
  return timeX - sag;
}

/**
 * For drum charts (portrait): time arcs are horizontal curves.
 * Given a time position (y in mm) and measurement position (x from chart left),
 * returns the actual y position accounting for arc curvature.
 */
export function drumArcY(
  timeY: number,
  measurementX: number,
  config: ChartConfig
): number {
  const sag = arcSag(measurementX, config);
  return timeY - sag;
}

/**
 * Convert a canvas pixel position to chart coordinates (day, hour, value).
 * canvasX, canvasY are in the chart coordinate system (mm).
 */
export function canvasToValue(
  chartX: number,
  chartY: number,
  config: ChartConfig
): { day: number; hour: number; value: number } {
  if (config.orientation === "landscape") {
    // Barograph: X = time, Y = measurement (inverted: top = high pressure)
    const dayWidth = config.chartWidth / config.days;
    const totalDay = chartX / dayWidth;
    const day = Math.floor(totalDay);
    const hourFraction = (totalDay - day) * 24;

    // Y axis: top of chart = maxValue, bottom = minValue
    const valueRange = config.maxValue - config.minValue;
    const value = config.maxValue - (chartY / config.chartHeight) * valueRange;

    return { day: Math.min(day, 7), hour: hourFraction, value };
  } else {
    // Drum charts: Y = time (top to bottom), X = measurement
    const dayHeight = config.chartHeight / config.days;
    const totalDay = chartY / dayHeight;
    const day = Math.floor(totalDay);
    const hourFraction = (totalDay - day) * 24;

    // X axis: left = minValue, right = maxValue
    const valueRange = config.maxValue - config.minValue;
    const value = config.minValue + (chartX / config.chartWidth) * valueRange;

    return { day: Math.min(day, 7), hour: hourFraction, value };
  }
}

export function formatHour(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export function getDayName(dayIndex: number): string {
  const names = [
    "Ponedjeljak", "Utorak", "Srijeda", "Četvrtak",
    "Petak", "Subota", "Nedjelja", "Ponedjeljak",
  ];
  return names[Math.min(dayIndex, 7)];
}
