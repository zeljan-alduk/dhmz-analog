/**
 * Auto-calibration: detect grid line intersections in a Lambrecht chart scan
 * and produce calibration correspondences without user interaction.
 *
 * Pipeline:
 *   1. Build a "grid-like pixel" mask via HSV thresholding (saturated, mid-value).
 *   2. Project the mask onto X (column sums) and Y (row sums) → two 1D signals.
 *   3. Smooth and find peaks. Peak positions are line locations in pixels.
 *   4. Fit a uniform lattice (origin + k·spacing) to each axis via least-squares,
 *      iteratively reassigning indices.
 *   5. Validate detected line counts against ChartConfig expectations.
 *   6. Map the four outermost lattice corners → known chart-mm coordinates and
 *      return them as CalibrationPoint[].
 *
 * Pure logic in autoCalibrate(); DOM-side image loading in runAutoCalibration().
 */

import { CalibrationPoint, ChartConfig } from "./types";
import { valueToChart } from "./chart-geometry";

interface DetectionConfig {
  /** Min saturation (0-1) to count a pixel as "colored grid" */
  minSaturation: number;
  /** Min value (0-1) to skip near-black noise */
  minValue: number;
  /** Max value (0-1) to skip near-white background */
  maxValue: number;
  /** Half-window for box-smoothing the 1D projections */
  smoothRadius: number;
  /** A peak must reach `peakProminence × global mean` of the projection */
  peakProminence: number;
  /** Pixels closer than this are merged */
  minPeakSeparation: number;
}

const DEFAULTS: DetectionConfig = {
  minSaturation: 0.10,
  minValue: 0.15,
  maxValue: 0.92,
  smoothRadius: 2,
  peakProminence: 1.4,
  minPeakSeparation: 4,
};

interface LatticeFit {
  origin: number;
  spacing: number;
  /** Number of lattice positions detected (last index + 1) */
  count: number;
  /** RMS residual of detected peaks vs lattice (pixels) */
  rms: number;
}

export interface AutoCalibrationDiagnostics {
  detectedRows: number;
  detectedCols: number;
  expectedRows: number;
  expectedCols: number;
  rowsRms: number;
  colsRms: number;
  /** Image dimensions used for detection (natural, not display) */
  imageWidth: number;
  imageHeight: number;
}

export interface AutoCalibrationResult {
  /** Four corner calibration points, in DISPLAY coordinates (post-rotation if any). */
  points: CalibrationPoint[];
  diagnostics: AutoCalibrationDiagnostics;
  /** Confidence 0-1 (1 = perfect lattice match) */
  confidence: number;
  /**
   * True if the input image was 90°-rotated relative to the chart geometry —
   * see `rotatedImageUrl` for the corrected blob URL the caller should swap in.
   */
  rotated: boolean;
  /**
   * If non-null, a blob URL of the input image rotated to match the chart
   * geometry. The points above are already in this rotated image's
   * coordinate space — the caller should swap `imageUrl` to this value.
   */
  rotatedImageUrl: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public: pure logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect grid lines in raw image data and return four corner calibration points.
 * Returns null if the lattice fit is too poor to trust.
 *
 * The returned points are in NATURAL image coordinates. Use runAutoCalibration()
 * if you want display-space coordinates.
 */
export function autoCalibrate(
  imageData: ImageData,
  config: ChartConfig,
  detection: Partial<DetectionConfig> = {}
): AutoCalibrationResult | null {
  const cfg = { ...DEFAULTS, ...detection };
  const w = imageData.width;
  const h = imageData.height;

  // Step 1: grid-pixel mask
  const mask = buildGridMask(imageData, cfg);

  // Step 2: 1D projections
  const colSums = projectColumns(mask, w, h);
  const rowSums = projectRows(mask, w, h);

  // Step 3: smooth + peaks
  const colSmooth = smooth1D(colSums, cfg.smoothRadius);
  const rowSmooth = smooth1D(rowSums, cfg.smoothRadius);
  const colPeaks = findPeaks(colSmooth, cfg.peakProminence, cfg.minPeakSeparation);
  const rowPeaks = findPeaks(rowSmooth, cfg.peakProminence, cfg.minPeakSeparation);

  // Step 4: expected line counts (major lines only)
  // We're agnostic about which color is which axis — the chart geometry defines
  // expected counts per direction based on orientation.
  //
  //   landscape (barograph): X = time → days+1 vertical lines
  //                          Y = value → (range/majorGrid)+1 horizontal lines
  //   portrait (drum):       Y = time → days+1 horizontal lines
  //                          X = value → (range/majorGrid)+1 vertical lines
  const valueLineCount =
    Math.round((config.maxValue - config.minValue) / config.majorGrid) + 1;
  const timeLineCount = config.days + 1;

  // Step 5: single lattice fit per axis (passes a hint count, but the fit is
  // count-agnostic — the hint is only used by the caller for validation).
  const colsFit = fitLattice(colPeaks, valueLineCount);
  const rowsFit = fitLattice(rowPeaks, timeLineCount);
  if (!colsFit || !rowsFit) return null;

  const colsRmsRel = colsFit.rms / Math.max(1, colsFit.spacing);
  const rowsRmsRel = rowsFit.rms / Math.max(1, rowsFit.spacing);
  if (colsRmsRel > 0.20 || rowsRmsRel > 0.20) return null;

  // Step 6: figure out which axis is which.
  // Real-world Plustek 320e scans land in either:
  //   (a) "natural" orientation — chart geometry orientation matches image aspect
  //   (b) "rotated 90°" — long edge of chart paper aligned with long edge of
  //       portrait scanner platen, so cols/rows roles swap.
  // Decide by which count assignment satisfies the lower-bound check (charts have
  // minor grids between majors, so we accept ≥ expected-1 in either direction).
  // Lambrecht charts: barograph has 8 days × 12 pressure majors, hygro/thermo
  // similar. For the typical case where time-line and value-line counts differ
  // (8 vs 12), this disambiguates cleanly.
  const colsLikelyTime = colsFit.count >= timeLineCount - 1;
  const colsLikelyValue = colsFit.count >= valueLineCount - 1;
  const rowsLikelyTime = rowsFit.count >= timeLineCount - 1;
  const rowsLikelyValue = rowsFit.count >= valueLineCount - 1;

  // For landscape chart: "natural" = cols=time, rows=value
  // For portrait chart:  "natural" = cols=value, rows=time
  type Axes = "cols=time,rows=value" | "cols=value,rows=time";
  let axes: Axes | null = null;
  if (rowsLikelyValue && colsLikelyTime) axes = "cols=time,rows=value";
  else if (rowsLikelyTime && colsLikelyValue) axes = "cols=value,rows=time";
  // If both fit (e.g. days≈valueLines), prefer the one matching chart orientation
  // by aspect ratio.
  if (
    (rowsLikelyValue && colsLikelyTime) &&
    (rowsLikelyTime && colsLikelyValue)
  ) {
    const imageIsLandscape = w >= h;
    axes = imageIsLandscape ? "cols=time,rows=value" : "cols=value,rows=time";
  }
  if (!axes) return null;

  const isRotated =
    (config.orientation === "landscape" && axes === "cols=value,rows=time") ||
    (config.orientation === "portrait" && axes === "cols=time,rows=value");

  // Step 7: corners in pixel space
  const x0 = colsFit.origin;
  const x1 = colsFit.origin + (colsFit.count - 1) * colsFit.spacing;
  const y0 = rowsFit.origin;
  const y1 = rowsFit.origin + (rowsFit.count - 1) * rowsFit.spacing;

  // Map corners to (day, hour, value).
  // For the "natural" cases the polarity matches the SVG template directly. For
  // the "rotated 90°" cases we assume the user rotated the chart 90° CW to fit
  // the platen — i.e. the chart's left edge ended up at the TOP of the scan.
  // This is the most common scanning habit; if the user rotated the other way,
  // they can fix labels manually after auto-detect.
  type CornerSpec = {
    imgX: number;
    imgY: number;
    day: number;
    hour: number;
    value: number;
  };
  let corners: CornerSpec[];
  if (config.orientation === "landscape" && !isRotated) {
    // x = time, y = value (max top, min bottom)
    corners = [
      { imgX: x0, imgY: y0, day: 0, hour: 0, value: config.maxValue },
      { imgX: x1, imgY: y0, day: config.days, hour: 0, value: config.maxValue },
      { imgX: x0, imgY: y1, day: 0, hour: 0, value: config.minValue },
      { imgX: x1, imgY: y1, day: config.days, hour: 0, value: config.minValue },
    ];
  } else if (config.orientation === "landscape" && isRotated) {
    // 90° CW: y = time (top=day0, bottom=day_max),
    //         x = value (left=max → top of chart was at left, right=min)
    corners = [
      { imgX: x0, imgY: y0, day: 0, hour: 0, value: config.maxValue },
      { imgX: x1, imgY: y0, day: 0, hour: 0, value: config.minValue },
      { imgX: x0, imgY: y1, day: config.days, hour: 0, value: config.maxValue },
      { imgX: x1, imgY: y1, day: config.days, hour: 0, value: config.minValue },
    ];
  } else if (config.orientation === "portrait" && !isRotated) {
    // x = value (min left, max right), y = time (top=day0, bottom=day_max)
    corners = [
      { imgX: x0, imgY: y0, day: 0, hour: 0, value: config.minValue },
      { imgX: x1, imgY: y0, day: 0, hour: 0, value: config.maxValue },
      { imgX: x0, imgY: y1, day: config.days, hour: 0, value: config.minValue },
      { imgX: x1, imgY: y1, day: config.days, hour: 0, value: config.maxValue },
    ];
  } else {
    // portrait + rotated 90° CW: x = time, y = value
    corners = [
      { imgX: x0, imgY: y0, day: 0, hour: 0, value: config.minValue },
      { imgX: x1, imgY: y0, day: config.days, hour: 0, value: config.minValue },
      { imgX: x0, imgY: y1, day: 0, hour: 0, value: config.maxValue },
      { imgX: x1, imgY: y1, day: config.days, hour: 0, value: config.maxValue },
    ];
  }

  // Effective expected counts for diagnostics — match the chosen axes assignment.
  const expectedCols = axes === "cols=time,rows=value" ? timeLineCount : valueLineCount;
  const expectedRows = axes === "cols=time,rows=value" ? valueLineCount : timeLineCount;

  const ts = Date.now();
  const points: CalibrationPoint[] = corners.map((c, i) => {
    const { chartX, chartY } = valueToChart(c.day, c.hour, c.value, config);
    return {
      id: `auto-${ts}-${i}`,
      imgX: c.imgX,
      imgY: c.imgY,
      chartX,
      chartY,
      meta: { day: c.day, hour: c.hour, value: c.value },
    };
  });

  // Confidence: smoothly decreases with relative RMS.
  const confidence = Math.max(
    0,
    Math.min(1, 1 - 2 * (colsRmsRel + rowsRmsRel))
  );

  return {
    points,
    confidence,
    rotated: isRotated,
    rotatedImageUrl: null,
    diagnostics: {
      detectedCols: colPeaks.length,
      detectedRows: rowPeaks.length,
      expectedCols,
      expectedRows,
      colsRms: colsFit.rms,
      rowsRms: rowsFit.rms,
      imageWidth: w,
      imageHeight: h,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public: DOM-side runner — loads URL, draws to canvas, returns display-space points
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convenience wrapper for browser use: loads imageUrl, runs autoCalibrate,
 * and rescales the resulting calibration-point pixel positions from natural
 * image space to the (displayWidth × displayHeight) space used by the
 * OverlayCanvas. Caller must pass the same display dimensions used by the
 * canvas (baseW × baseH).
 *
 * Auto-rotation: if the first detection pass reports `rotated: true` (chart
 * geometry's long-axis perpendicular to image's long-axis — typical when a
 * landscape barograph is scanned on a portrait Plustek 320e platen), this
 * function rebuilds the source image rotated 90° CW, re-runs detection on the
 * corrected image, and returns its blob URL via `rotatedImageUrl`. The caller
 * should swap `imageUrl` to this value so subsequent calibration / digitize
 * clicks operate on the corrected orientation. Falls back to 90° CCW if CW
 * doesn't yield a "natural" orientation.
 */
export async function runAutoCalibration(
  imageUrl: string,
  config: ChartConfig,
  displayWidth: number,
  displayHeight: number,
  detection: Partial<DetectionConfig> = {}
): Promise<AutoCalibrationResult | null> {
  const original = await loadImage(imageUrl);

  // First pass: detect on original image.
  const first = detectOnHTMLImage(original, config, detection);

  if (first && !first.rotated) {
    return rescalePoints(first, displayWidth, displayHeight);
  }

  // Either failed entirely OR succeeded but flagged a 90° rotation. Try CW.
  const cwUrl = await rotateImageToBlobUrl(original, 90);
  const cwImg = await loadImage(cwUrl);
  const cwResult = detectOnHTMLImage(cwImg, config, detection);
  if (cwResult && !cwResult.rotated) {
    cwResult.rotatedImageUrl = cwUrl;
    return rescalePoints(cwResult, displayWidth, displayHeight);
  }
  // CW didn't help — release blob and try CCW.
  URL.revokeObjectURL(cwUrl);

  const ccwUrl = await rotateImageToBlobUrl(original, -90);
  const ccwImg = await loadImage(ccwUrl);
  const ccwResult = detectOnHTMLImage(ccwImg, config, detection);
  if (ccwResult && !ccwResult.rotated) {
    ccwResult.rotatedImageUrl = ccwUrl;
    return rescalePoints(ccwResult, displayWidth, displayHeight);
  }
  URL.revokeObjectURL(ccwUrl);

  // No orientation worked; surface the first attempt's result if any.
  return first ? rescalePoints(first, displayWidth, displayHeight) : null;
}

/** Run autoCalibrate on an HTMLImageElement (handles downscale + ImageData). */
function detectOnHTMLImage(
  img: HTMLImageElement,
  config: ChartConfig,
  detection: Partial<DetectionConfig>
): AutoCalibrationResult | null {
  const maxEdge = 1200;
  const scale = Math.min(
    1,
    maxEdge / Math.max(img.naturalWidth, img.naturalHeight)
  );
  const dw = Math.round(img.naturalWidth * scale);
  const dh = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, dw, dh);
  const imgData = ctx.getImageData(0, 0, dw, dh);
  return autoCalibrate(imgData, config, detection);
}

/** Rescale point coordinates from downscaled-natural to display-space. */
function rescalePoints(
  result: AutoCalibrationResult,
  displayWidth: number,
  displayHeight: number
): AutoCalibrationResult {
  const sx = displayWidth / result.diagnostics.imageWidth;
  const sy = displayHeight / result.diagnostics.imageHeight;
  result.points = result.points.map((p) => ({
    ...p,
    imgX: p.imgX * sx,
    imgY: p.imgY * sy,
  }));
  return result;
}

/**
 * Rotate an HTMLImageElement by ±90° and return a blob URL of the result.
 * Caller is responsible for revoking the URL when no longer needed.
 */
async function rotateImageToBlobUrl(
  img: HTMLImageElement,
  degrees: 90 | -90
): Promise<string> {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = h;
  canvas.height = w;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not allocate canvas context for rotation");
  if (degrees === 90) {
    // 90° CW: translate to (h, 0) then rotate 90°.
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    // 90° CCW: translate to (0, w) then rotate -90°.
    ctx.translate(0, w);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Canvas toBlob returned null"));
        return;
      }
      resolve(URL.createObjectURL(blob));
    }, "image/png");
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Internal: image processing primitives
// ─────────────────────────────────────────────────────────────────────────────

function buildGridMask(img: ImageData, cfg: DetectionConfig): Uint8Array {
  const data = img.data;
  const n = img.width * img.height;
  const mask = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const v = max;
    const s = max === 0 ? 0 : (max - min) / max;

    if (s >= cfg.minSaturation && v >= cfg.minValue && v <= cfg.maxValue) {
      mask[i] = 1;
    }
  }
  return mask;
}

function projectColumns(
  mask: Uint8Array,
  w: number,
  h: number
): Float32Array {
  const sums = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) sums[x] += mask[row + x];
  }
  return sums;
}

function projectRows(mask: Uint8Array, w: number, h: number): Float32Array {
  const sums = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x < w; x++) s += mask[row + x];
    sums[y] = s;
  }
  return sums;
}

function smooth1D(arr: Float32Array, radius: number): Float32Array {
  if (radius <= 0) return new Float32Array(arr);
  const n = arr.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < n) {
        sum += arr[j];
        count++;
      }
    }
    out[i] = sum / count;
  }
  return out;
}

/**
 * Find local maxima: arr[i] > arr[i-1] AND arr[i] >= arr[i+1] AND arr[i] >= threshold.
 * Suppress non-maxima within `minSep` pixels by keeping the higher one.
 */
function findPeaks(
  arr: Float32Array,
  prominenceFactor: number,
  minSep: number
): number[] {
  const n = arr.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += arr[i];
  mean /= n;
  const minHeight = mean * prominenceFactor;

  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (arr[i] < minHeight) continue;
    if (!(arr[i] > arr[i - 1] && arr[i] >= arr[i + 1])) continue;
    if (peaks.length > 0 && i - peaks[peaks.length - 1] < minSep) {
      if (arr[i] > arr[peaks[peaks.length - 1]]) {
        peaks[peaks.length - 1] = i;
      }
      continue;
    }
    peaks.push(i);
  }
  return peaks;
}

/**
 * Fit a uniform lattice peak_i = origin + k_i * spacing to detected peaks.
 *
 * Initial guess: origin = min(peaks), spacing = median consecutive diff.
 * Then iterate: assign each peak its nearest integer index, refit by closed-form
 * least-squares, repeat until RMS converges or maxIters.
 */
function fitLattice(peaks: number[], _expectedCount: number): LatticeFit | null {
  if (peaks.length < 3) return null;
  const sorted = [...peaks].sort((a, b) => a - b);

  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    diffs.push(sorted[i] - sorted[i - 1]);
  }
  diffs.sort((a, b) => a - b);
  let spacing = diffs[Math.floor(diffs.length / 2)];
  if (spacing <= 0) return null;
  let origin = sorted[0];

  let prevRms = Infinity;
  let lastIndices: number[] = [];
  let lastUsed: number[] = [];

  for (let iter = 0; iter < 12; iter++) {
    const indices: number[] = [];
    const used: number[] = [];
    for (const p of sorted) {
      const k = Math.round((p - origin) / spacing);
      if (k < 0) continue;
      indices.push(k);
      used.push(p);
    }
    if (used.length < 3) return null;

    const m = used.length;
    let sumK = 0,
      sumP = 0,
      sumKK = 0,
      sumKP = 0;
    for (let i = 0; i < m; i++) {
      sumK += indices[i];
      sumP += used[i];
      sumKK += indices[i] * indices[i];
      sumKP += indices[i] * used[i];
    }
    const denom = m * sumKK - sumK * sumK;
    if (Math.abs(denom) < 1e-9) return null;
    const newSpacing = (m * sumKP - sumK * sumP) / denom;
    const newOrigin = (sumP - newSpacing * sumK) / m;

    let rms = 0;
    for (let i = 0; i < m; i++) {
      const r = used[i] - (newOrigin + indices[i] * newSpacing);
      rms += r * r;
    }
    rms = Math.sqrt(rms / m);

    origin = newOrigin;
    spacing = newSpacing;
    lastIndices = indices;
    lastUsed = used;

    if (Math.abs(prevRms - rms) < 0.005) {
      prevRms = rms;
      break;
    }
    prevRms = rms;
  }

  if (lastIndices.length === 0) return null;
  const lastIndex = lastIndices[lastIndices.length - 1];
  const count = lastIndex + 1;
  // Suppress unused-variable warning on `lastUsed` (kept for debug).
  void lastUsed;

  return { origin, spacing, count, rms: prevRms };
}
