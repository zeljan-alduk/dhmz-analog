export type ChartType = "barograph" | "hygrograph" | "thermograph";

export interface ChartConfig {
  type: ChartType;
  label: string;
  unit: string;
  minValue: number;
  maxValue: number;
  majorGrid: number;
  minorGrid: number;
  fineGrid: number;
  /** Paper width in mm (measurement axis) */
  paperWidth: number;
  /** Paper height in mm (time axis) */
  paperHeight: number;
  /** Active chart grid width in mm */
  chartWidth: number;
  /** Active chart grid height in mm */
  chartHeight: number;
  /** Margin from paper edge to chart grid start (measurement axis) */
  marginStart: number;
  /** Pen arm length in mm */
  penArmRadius: number;
  /** Pen arm pivot offset from chart start in mm */
  penArmPivot: number;
  /** Days per chart (7 + 1 overlap) */
  days: number;
  /** Orientation: 'landscape' for barograph, 'portrait' for drum charts */
  orientation: "landscape" | "portrait";
}

export interface CalibrationPoint {
  id: string;
  /** X position on the image (pixels) */
  imgX: number;
  /** Y position on the image (pixels) */
  imgY: number;
  /** X position on the chart template (mm) */
  chartX: number;
  /** Y position on the chart template (mm) */
  chartY: number;
}

export interface DataPoint {
  id: string;
  /** X on overlay canvas (pixels) */
  canvasX: number;
  /** Y on overlay canvas (pixels) */
  canvasY: number;
  /** Day of week (0=Monday, 6=Sunday) */
  day: number;
  /** Hour (0-24, decimal) */
  hour: number;
  /** Measured value in chart units */
  value: number;
  /** Day label */
  dayLabel: string;
  /** Formatted time string */
  timeLabel: string;
}

export type WorkflowStep = "select" | "upload" | "calibrate" | "digitize";

export interface AppState {
  step: WorkflowStep;
  chartType: ChartType | null;
  imageFile: File | null;
  imageUrl: string | null;
  calibrationPoints: CalibrationPoint[];
  dataPoints: DataPoint[];
  imageOpacity: number;
}
