/**
 * Client-side bitmap-to-polyline vectorizer for Lambrecht-style charts.
 *
 * The chart structure is KNOWN: only two families of features exist —
 *   - N parallel HORIZONTAL grid lines (the value axis)
 *   - M near-VERTICAL ARC-SAG time lines (curved due to pen-arm geometry)
 *
 * Anything else in the mask — handwritten labels, decorative graphics,
 * stamps, isolated speckle — is noise and must be ignored.
 *
 * The algorithm exploits that structure with two passes that mirror the
 * approach already proven in auto-calibration:
 *
 *   1. Binarize the mask (alpha > 64).
 *   2. Project on the Y axis (sum each row) to find Y positions where ink
 *      is dense → those are horizontal grid lines. For each detected Y,
 *      walk the line column-by-column and record the median y of ink in a
 *      narrow horizontal band → one clean horizontal polyline per line.
 *   3. Project on the X axis (sum each column), subtract the constant
 *      contribution of horizontal lines, and find X peaks → starting
 *      positions of arc-sag time lines. For each, walk top-to-bottom
 *      tracking the closest ink within a small drift window → one polyline
 *      per arc that follows the curvature naturally.
 *
 * Text, stamps, and isolated dots don't survive because they don't generate
 * sustained row-sum or column-sum peaks at consistent positions, and the
 * line tracker rejects breaks longer than `MAX_GAP_PX`.
 */

const MIN_LINE_LENGTH_FRACTION = 0.6;
const MAX_GAP_PX = 25;

export interface VectorizeOptions {
  /** Output canvas width in display pixels. */
  displayWidth: number;
  /** Output canvas height in display pixels. */
  displayHeight: number;
  /** Search-band half-width in MASK pixels for HORIZONTAL line tracking.
   *  Should be wide enough to absorb anti-aliasing jitter (≈3 px) but small
   *  enough that adjacent lines don't bleed in. Default 4. */
  horizBand?: number;
  /** Search-band half-width for VERTICAL/ARC tracking. Wider than horizBand
   *  because arcs drift horizontally as they go down. Default 8. */
  vertBand?: number;
  /** Smoothness param for projection peak finding (box smoothing radius). */
  smoothRadius?: number;
  /** Peak prominence factor: peak must be >= prominence × global mean of the
   *  projection to count as a line. */
  peakProminence?: number;
  /** Minimum separation between detected line positions (mask px). */
  minPeakSeparation?: number;
  /** When provided, keep only the top-N strongest horizontal peaks. Use to
   *  pin output to expected line count from chart config (e.g. 12 for a
   *  barograph with major lines every 10 hPa). 0 = unlimited. */
  maxHorizontalLines?: number;
  /** When provided, keep only the top-N strongest vertical/arc peaks. */
  maxVerticalLines?: number;
  /** Every Nth horizontal line is tagged as MAJOR (rendered thicker); the
   *  rest are MINOR. For barograph at minor density (23 lines), set this
   *  to 2 → every other line is major (every 10 hPa). 1 = all major. */
  horizontalMajorEvery?: number;
  /** Same idea for vertical lines. */
  verticalMajorEvery?: number;
  /** Douglas-Peucker tolerance in MASK pixels. 0 = no simplification. */
  simplifyTolerance?: number;
}

/** A vectorized line tagged with its axis (horizontal value lines vs
 *  vertical/arc time lines) and its grid weight (major / minor / fine).
 *  The renderer uses both: weight controls stroke width (major thicker than
 *  minor), and the caller can filter by (axis, weight) to show/hide groups. */
export interface VectorPolyline {
  points: number[][];
  axis: "horizontal" | "vertical";
  weight: "major" | "minor" | "fine";
}

export async function vectorizeMaskFromUrl(
  maskUrl: string,
  opts: VectorizeOptions
): Promise<VectorPolyline[]> {
  const img = await loadImage(maskUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("vectorize: no canvas ctx");
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, w, h);
  return vectorizeStructured(imgData, opts);
}

export function vectorizeStructured(
  imgData: ImageData,
  opts: VectorizeOptions
): VectorPolyline[] {
  const w = imgData.width;
  const h = imgData.height;
  const data = imgData.data;
  const horizBand = opts.horizBand ?? 4;
  const vertBand = opts.vertBand ?? 8;
  const smoothR = opts.smoothRadius ?? 2;
  const prominence = opts.peakProminence ?? 1.5;
  const minSep = opts.minPeakSeparation ?? 8;
  const tol = opts.simplifyTolerance ?? 1.5;
  const maxH = opts.maxHorizontalLines ?? 0;
  const maxV = opts.maxVerticalLines ?? 0;
  const hMajorEvery = Math.max(1, Math.floor(opts.horizontalMajorEvery ?? 1));
  const vMajorEvery = Math.max(1, Math.floor(opts.verticalMajorEvery ?? 1));

  // 1. Binarize from alpha
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) {
    if (data[i * 4 + 3] > 64) bin[i] = 1;
  }

  // 2. Row projection → horizontal-line Y positions.
  //    We use LONGEST CONTIGUOUS RUN of ink per row (not pure sum) as the
  //    signal. A horizontal grid line spans nearly the whole chart width
  //    → run ~1000 px. Text labels span maybe 10–20 px → run ~10 px.
  //    Squaring the run amplifies the contrast further. This effectively
  //    silences text-region peaks that would otherwise dominate the
  //    cross-correlation step and pull the lattice origin into the label
  //    area at the top of the mask.
  const rowSignal = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let maxRun = 0;
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (bin[row + x]) {
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
    }
    rowSignal[y] = maxRun * maxRun;
  }
  const rowSmooth = smooth1D(rowSignal, smoothR);
  let yPeaks = findPeaks(rowSmooth, 1.05, minSep);
  if (maxH > 0) {
    yPeaks = fitUniformLattice(yPeaks, rowSmooth, maxH, h);
  } else if (yPeaks.length > 0) {
    yPeaks = yPeaks.slice();
  }

  // 3. Column projection → arc-time-line X positions.
  //    We exclude:
  //      - The TOP MARGIN (~5 % of mask) where day labels live — text strokes
  //        there create spurious column peaks at hour-mark X positions, and
  //        previously pulled the lattice origin off actual day boundaries.
  //      - The BOTTOM MARGIN (~5 %) where publisher info / footer text lives.
  //      - Rows within ±(horizBand + 1) of detected horizontals so their ink
  //        doesn't bridge column runs.
  //    Inside the remaining region we count longest run of ink per column,
  //    squared, as the signal.
  // 7% margin exclusion: trims the day-label band at the top and the
  // publisher info at the bottom while keeping enough chart-interior
  // signal for arc detection.
  const marginExclude = Math.round(h * 0.07);
  const yScanFrom = marginExclude;
  const yScanTo = h - marginExclude;
  const colSignal = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let maxRun = 0;
    let run = 0;
    for (let y = yScanFrom; y < yScanTo; y++) {
      if (isNearAny(y, yPeaks, horizBand + 1)) {
        run = 0;
        continue;
      }
      if (bin[y * w + x]) {
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
    }
    colSignal[x] = maxRun * maxRun;
  }
  const colSmooth = smooth1D(colSignal, smoothR);
  let xPeaks = findPeaks(colSmooth, 1.05, minSep);
  if (maxV > 0) {
    xPeaks = fitUniformLattice(xPeaks, colSmooth, maxV, w);
  }

  const polylines: VectorPolyline[] = [];
  const sx = opts.displayWidth / w;
  const sy = opts.displayHeight / h;

  // 4. HORIZONTAL grid lines: lattice gives us exactly N Y positions (some
  //    extrapolated for missing peaks). For each, try to trace the actual
  //    x-extent. If tracing fails (line is fully missing from the mask),
  //    fall back to spanning the full chart width — the user still sees the
  //    expected grid line at the right Y position.
  for (let i = 0; i < yPeaks.length; i++) {
    const y0 = yPeaks[i];
    const traced = traceHorizontal(bin, w, h, y0, horizBand);
    let xStart: number;
    let xEnd: number;
    let yFlat = y0;
    if (traced.length >= w * 0.2) {
      const xs = traced.map((p) => p[0]);
      const ys = traced.map((p) => p[1]);
      xStart = Math.min(...xs);
      xEnd = Math.max(...xs);
      ys.sort((a, b) => a - b);
      yFlat = ys[ys.length >> 1];
    } else {
      xStart = 0;
      xEnd = w - 1;
    }
    polylines.push({
      points: [
        [xStart * sx, yFlat * sy],
        [xEnd * sx, yFlat * sy],
      ],
      axis: "horizontal",
      weight: i % hMajorEvery === 0 ? "major" : "minor",
    });
  }

  // 5. ARC-SAG time lines — ITERATIVE SNAP-TO-MASK approach.
  //
  //    Pen-arm geometry: all arcs have IDENTICAL shape, only X offset differs.
  //
  //    Step A: For each traced arc, run iterative curve optimization. Each
  //    iteration: sample the current curve, snap each sample to the nearest
  //    mask pixel within a band, refit (a, b, c) least-squares. Repeat until
  //    convergence. After convergence, score = number of mask pixels under
  //    the final curve.
  //
  //    Step B: Pick the arc with the HIGHEST score as the SHAPE TEMPLATE.
  //    Its (b, c) define the canonical arc-sag curvature.
  //
  //    Step C: For every arc (including the template), run per-arc iterative
  //    refinement: sample the curve, snap to mask, refit ONLY `a` (b, c
  //    locked at template values). This finds each arc's true X offset
  //    while preserving the geometric shape we know is correct.
  const yBoundTop = yPeaks.length > 0 ? Math.min(...yPeaks) : 0;
  const yBoundBottom = yPeaks.length > 0 ? Math.max(...yPeaks) : h - 1;
  const N_SAMPLES = 24;

  // STEP A — iterative full optimization for each candidate arc.
  // Each starts from a tracer-fit quadratic, then iteratively snaps to mask
  // and refits all three parameters (a, b, c) until stable.
  const SNAP_BAND_FULL = 6;
  const MAX_ITERS = 8;
  type ArcFit = { a: number; b: number; c: number; score: number };
  const arcFitsOpt: (ArcFit | null)[] = [];
  for (const x0 of xPeaks) {
    const traced = traceArc(bin, w, h, x0, vertBand);
    let fit: { a: number; b: number; c: number } | null = null;
    if (traced.length >= 8) {
      fit = quadraticFitXofY(traced);
    }
    if (!fit) {
      arcFitsOpt.push(null);
      continue;
    }
    // Iteratively centroid-snap-and-refit
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      const snapped: number[][] = [];
      for (let i = 0; i < N_SAMPLES; i++) {
        const y =
          yBoundTop + ((yBoundBottom - yBoundTop) * i) / (N_SAMPLES - 1);
        const xPred = fit.a + fit.b * y + fit.c * y * y;
        const yRow = Math.round(y);
        if (yRow < 0 || yRow >= h) continue;
        const xCenter = Math.round(xPred);
        // Centroid snap (no tie-break bias): sum all ink pixels in the
        // band around xCenter, take the mean. This places the snap at the
        // mass center of the local ink, avoiding the leftward bias that
        // a nearest-pixel-with-iteration-order policy would introduce.
        let sumXc = 0;
        let cnt = 0;
        for (let dx = -SNAP_BAND_FULL; dx <= SNAP_BAND_FULL; dx++) {
          const xc = xCenter + dx;
          if (xc < 0 || xc >= w) continue;
          if (bin[yRow * w + xc]) {
            sumXc += xc;
            cnt++;
          }
        }
        if (cnt > 0) snapped.push([sumXc / cnt, y]);
      }
      if (snapped.length < 5) break;
      const newFit = quadraticFitXofY(snapped);
      if (!newFit) break;
      const da = Math.abs(newFit.a - fit.a);
      const db = Math.abs(newFit.b - fit.b);
      const dc = Math.abs(newFit.c - fit.c);
      fit = newFit;
      if (da < 0.05 && db < 1e-4 && dc < 1e-6) break;
    }
    // Score = ink-coverage of the final curve
    let score = 0;
    for (let i = 0; i < N_SAMPLES; i++) {
      const y =
        yBoundTop + ((yBoundBottom - yBoundTop) * i) / (N_SAMPLES - 1);
      const xPred = fit.a + fit.b * y + fit.c * y * y;
      const yRow = Math.round(y);
      if (yRow < 0 || yRow >= h) continue;
      const xCenter = Math.round(xPred);
      for (let dx = -2; dx <= 2; dx++) {
        const xc = xCenter + dx;
        if (xc >= 0 && xc < w && bin[yRow * w + xc]) {
          score++;
          break; // count each y at most once
        }
      }
    }
    arcFitsOpt.push({ ...fit, score });
  }

  // STEP B — pick best by score. Its (b, c) become the canonical shape.
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < arcFitsOpt.length; i++) {
    const f = arcFitsOpt[i];
    if (f && f.score > bestScore) {
      bestScore = f.score;
      bestIdx = i;
    }
  }
  // Adapter for downstream code that expects `arcFits` shape
  const arcFits: ({ a: number; b: number; c: number; coverage: number } | null)[] =
    arcFitsOpt.map((f) =>
      f ? { a: f.a, b: f.b, c: f.c, coverage: f.score } : null
    );
  // arcTraces no longer needed for positioning since we'll use snap-to-mask
  // refinement, but we keep an empty placeholder so the reference compiles.
  const arcTraces: number[][][] = xPeaks.map(() => []);

  // STEP C — per-arc iterative `a` refinement against the mask, with the
  // template (b, c) locked. For each arc:
  //   1. Initial `a` = template.a + (xPeaks[j] − xPeaks[bestIdx])
  //   2. Iterate: sample curve, snap each sample to nearest mask pixel
  //      within a band, refit only `a` (closed form: a = mean(x_snap) −
  //      b·mean(y_snap) − c·mean(y_snap²))
  //   3. Stop when convergence or max iterations.
  const finalA: (number | null)[] = new Array(xPeaks.length).fill(null);
  if (bestIdx >= 0) {
    const tmpl = arcFits[bestIdx]!;
    const SNAP_BAND_REFINE = 8;
    for (let j = 0; j < xPeaks.length; j++) {
      let a = tmpl.a + (xPeaks[j] - xPeaks[bestIdx]);
      for (let iter = 0; iter < MAX_ITERS; iter++) {
        let sumX = 0;
        let sumY = 0;
        let sumYY = 0;
        let n = 0;
        for (let i = 0; i < N_SAMPLES; i++) {
          const y =
            yBoundTop + ((yBoundBottom - yBoundTop) * i) / (N_SAMPLES - 1);
          const xPred = a + tmpl.b * y + tmpl.c * y * y;
          const yRow = Math.round(y);
          if (yRow < 0 || yRow >= h) continue;
          const xCenter = Math.round(xPred);
          // Centroid snap — same reasoning as Step A: avoids systematic
          // leftward offset caused by tie-break order in nearest-pixel
          // policy when ink straddles the predicted center symmetrically.
          let sumXc = 0;
          let cnt = 0;
          for (let dx = -SNAP_BAND_REFINE; dx <= SNAP_BAND_REFINE; dx++) {
            const xc = xCenter + dx;
            if (xc < 0 || xc >= w) continue;
            if (bin[yRow * w + xc]) {
              sumXc += xc;
              cnt++;
            }
          }
          if (cnt === 0) continue;
          const xCentroid = sumXc / cnt;
          sumX += xCentroid;
          sumY += y;
          sumYY += y * y;
          n++;
        }
        if (n < 4) break;
        const newA = sumX / n - tmpl.b * (sumY / n) - tmpl.c * (sumYY / n);
        if (Math.abs(newA - a) < 0.05) {
          a = newA;
          break;
        }
        a = newA;
      }
      finalA[j] = a;
    }
  }

  // Render
  for (let j = 0; j < xPeaks.length; j++) {
    const x0 = xPeaks[j];
    const sampled: number[][] = [];
    if (bestIdx >= 0 && finalA[j] !== null) {
      const tmpl = arcFits[bestIdx]!;
      const a = finalA[j]!;
      for (let i = 0; i < N_SAMPLES; i++) {
        const y =
          yBoundTop + ((yBoundBottom - yBoundTop) * i) / (N_SAMPLES - 1);
        const xModel = a + tmpl.b * y + tmpl.c * y * y;
        sampled.push([xModel * sx, y * sy]);
      }
    } else {
      sampled.push([x0 * sx, yBoundTop * sy], [x0 * sx, yBoundBottom * sy]);
    }
    polylines.push({
      points: sampled,
      axis: "vertical",
      weight: j % vMajorEvery === 0 ? "major" : "minor",
    });
  }

  return polylines;
}

/** Least-squares fit of x = a + b·y + c·y² to (x, y) points. Returns null
 *  when the system is degenerate (fewer than 3 distinct points). */
function quadraticFitXofY(points: number[][]): { a: number; b: number; c: number } | null {
  const n = points.length;
  if (n < 3) return null;
  let s0 = 0,
    s1 = 0,
    s2 = 0,
    s3 = 0,
    s4 = 0;
  let sx0 = 0,
    sx1 = 0,
    sx2 = 0;
  for (const [x, y] of points) {
    s0 += 1;
    s1 += y;
    s2 += y * y;
    s3 += y * y * y;
    s4 += y * y * y * y;
    sx0 += x;
    sx1 += x * y;
    sx2 += x * y * y;
  }
  // Solve 3×3 normal equations:
  //   [s0 s1 s2] [a]   [sx0]
  //   [s1 s2 s3] [b] = [sx1]
  //   [s2 s3 s4] [c]   [sx2]
  const m = [
    [s0, s1, s2, sx0],
    [s1, s2, s3, sx1],
    [s2, s3, s4, sx2],
  ];
  // Gaussian elimination
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let r = i + 1; r < 3; r++) {
      if (Math.abs(m[r][i]) > Math.abs(m[pivot][i])) pivot = r;
    }
    if (Math.abs(m[pivot][i]) < 1e-9) return null;
    if (pivot !== i) [m[i], m[pivot]] = [m[pivot], m[i]];
    for (let r = i + 1; r < 3; r++) {
      const f = m[r][i] / m[i][i];
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c];
    }
  }
  const c = m[2][3] / m[2][2];
  const b = (m[1][3] - m[1][2] * c) / m[1][1];
  const a = (m[0][3] - m[0][1] * b - m[0][2] * c) / m[0][0];
  return { a, b, c };
}

// ─── Horizontal line trace (column-by-column median y) ────────────────────
function traceHorizontal(
  bin: Uint8Array,
  w: number,
  h: number,
  y0: number,
  band: number
): number[][] {
  const yLo = Math.max(0, Math.floor(y0 - band));
  const yHi = Math.min(h - 1, Math.ceil(y0 + band));
  const points: number[][] = [];
  let lastX = -MAX_GAP_PX - 1;
  for (let x = 0; x < w; x++) {
    const candidates: number[] = [];
    for (let y = yLo; y <= yHi; y++) {
      if (bin[y * w + x]) candidates.push(y);
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => a - b);
    const med = candidates[candidates.length >> 1];
    if (x - lastX > MAX_GAP_PX && points.length > 0) {
      // Big break — skip; downstream Catmull-Rom would otherwise interpolate
      // a fictitious segment across the gap. Just leave the gap visible.
      points.push([NaN, NaN]); // marker, removed below
    }
    points.push([x, med]);
    lastX = x;
  }
  // Strip NaN markers; if there were gaps we keep the largest-segment only.
  if (points.some((p) => Number.isNaN(p[0]))) {
    const segments: number[][][] = [[]];
    for (const p of points) {
      if (Number.isNaN(p[0])) {
        if (segments[segments.length - 1].length > 0) segments.push([]);
      } else {
        segments[segments.length - 1].push(p);
      }
    }
    let best: number[][] = [];
    for (const s of segments) if (s.length > best.length) best = s;
    return best;
  }
  return points;
}

// ─── Vertical/arc trace (top-to-bottom particle tracker) ──────────────────
function traceArc(
  bin: Uint8Array,
  w: number,
  h: number,
  x0: number,
  band: number
): number[][] {
  // Find a starting row by scanning down from the top until we get an ink
  // pixel near x0. This makes the tracker robust to the chart not starting
  // at y=0 (margins, etc).
  let xPredicted = x0;
  let started = false;
  let yStart = 0;
  for (let y = 0; y < h; y++) {
    const xLo = Math.max(0, Math.floor(xPredicted - band));
    const xHi = Math.min(w - 1, Math.ceil(xPredicted + band));
    let nearest = -1;
    let nearestD = Infinity;
    for (let x = xLo; x <= xHi; x++) {
      if (bin[y * w + x]) {
        const d = Math.abs(x - xPredicted);
        if (d < nearestD) {
          nearestD = d;
          nearest = x;
        }
      }
    }
    if (nearest >= 0) {
      xPredicted = nearest;
      started = true;
      yStart = y;
      break;
    }
  }
  if (!started) return [];

  // March down. At each row, pick the ink pixel closest to xPredicted, then
  // update xPredicted with a low-pass filter so single-pixel jitter doesn't
  // shake the trace but a real curvature can still drift the predictor.
  const points: number[][] = [];
  let lastY = yStart;
  for (let y = yStart; y < h; y++) {
    const xLo = Math.max(0, Math.floor(xPredicted - band));
    const xHi = Math.min(w - 1, Math.ceil(xPredicted + band));
    const candidates: number[] = [];
    for (let x = xLo; x <= xHi; x++) {
      if (bin[y * w + x]) candidates.push(x);
    }
    if (candidates.length === 0) {
      if (y - lastY > MAX_GAP_PX) break; // arc has ended (or big gap, treat as end)
      continue;
    }
    // Take the median ink pixel for robustness against neighbour-arc bleed.
    candidates.sort((a, b) => a - b);
    const med = candidates[candidates.length >> 1];
    // EMA so the predictor follows the curve smoothly
    xPredicted = xPredicted * 0.4 + med * 0.6;
    points.push([med, y]);
    lastY = y;
  }
  return points;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function isNearAny(value: number, list: number[], dist: number): boolean {
  for (const v of list) if (Math.abs(value - v) <= dist) return true;
  return false;
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

/** Sort `peakIdx` by signal[peak] descending, keep the first `n`, return as
 *  array of indices (caller re-sorts ascending if needed). */
function topNByHeight(peakIdx: number[], signal: Float32Array, n: number): number[] {
  return [...peakIdx]
    .sort((a, b) => signal[b] - signal[a])
    .slice(0, n);
}

/**
 * Fit a UNIFORM LATTICE of exactly N positions through the strongest detected
 * peaks. Returns N positions guaranteed to be evenly spaced.
 *
 * Algorithm:
 *  1. Use the top-N strongest raw peaks as anchors (or all of them if fewer
 *     than N were found).
 *  2. Estimate spacing as the median consecutive diff (after sorting).
 *  3. Iteratively refit origin + spacing via least-squares: for each anchor,
 *     assign it to its nearest integer index, then minimise residuals.
 *  4. Generate N output positions y_k = origin + k·spacing for k = 0..N-1,
 *     clipped to [0, axisLen).
 *
 * The lattice fit handles the case where 1-2 grid lines are missing from the
 * raw mask (occluded by labels, low contrast, etc.) by extrapolating along
 * the regular spacing — we get all N back even when detection misses a few.
 */
function fitUniformLattice(
  peaks: number[],
  signal: Float32Array,
  N: number,
  axisLen: number
): number[] {
  if (peaks.length === 0 || N <= 0) return [];
  if (peaks.length === 1) {
    return [peaks[0]];
  }
  // Use the strongest 3N peaks at most so spurious low peaks don't bias the
  // spacing estimate (we want enough candidates to handle noise but not so
  // many that text-density peaks dominate the median diff).
  const ranked = topNByHeight(peaks, signal, Math.min(peaks.length, 3 * N));
  const anchors = ranked.slice().sort((a, b) => a - b);

  // Initial spacing estimation. We use a STRONG GEOMETRIC PRIOR: with N
  // expected lines spread across an axis of length `axisLen` and assuming
  // the chart fills roughly 80–90 % of the mask, the spacing should be
  // close to `axisLen * 0.85 / (N - 1)`. We trust the data-driven median
  // diff only when it's within 40 % of this prior — otherwise the data is
  // dominated by text/noise peaks and the prior is more reliable.
  const priorSpacing = axisLen * 0.85 / Math.max(1, N - 1);
  const diffs: number[] = [];
  for (let i = 1; i < anchors.length; i++) diffs.push(anchors[i] - anchors[i - 1]);
  diffs.sort((a, b) => a - b);
  const medianDiff = diffs[diffs.length >> 1] || 0;
  let spacing: number;
  if (
    medianDiff > priorSpacing * 0.6 &&
    medianDiff < priorSpacing * 1.4
  ) {
    spacing = medianDiff;
  } else {
    spacing = priorSpacing;
  }
  if (!isFinite(spacing) || spacing < 1) spacing = priorSpacing;
  // 2D CROSS-CORRELATION: vary BOTH `spacing` and `origin`, score each
  // (s, o) pair by ∑ signal[o + k·s] for k=0..N-1. Take the maximum-scoring
  // pair as the lattice. This is much more robust than fixing spacing from
  // a noisy median diff or geometric prior alone — the search finds the
  // periodicity that best matches the actual ink distribution.
  //
  // Search range: spacing within ±25 % of prior (covers paper variation,
  // scanner aspect, and chart-vs-mask ratio uncertainty), origin over the
  // full feasible range so the first lattice point can land anywhere from
  // the very top of the axis to (axisLen - (N-1)·spacing).
  //
  // Cost: ~50 × 700 × 12 = 420 k float adds per axis pass — well under 5 ms.
  let bestOrigin = 0;
  let bestSpacing = spacing;
  let bestScore = -Infinity;
  // Tight search range around the geometric prior. ±10 % is enough to
  // absorb chart-fills-X% variation across instruments while preventing
  // the cross-correlation from locking onto sub-major periodicity (e.g.
  // hour-mark spacing for the time axis, where 18h spacing happens to
  // hit hour-marks evenly across the chart and would otherwise win
  // against the correct 24h day-boundary spacing).
  const sMin = Math.max(2, priorSpacing * 0.9);
  const sMax = priorSpacing * 1.1;
  for (let s = sMin; s <= sMax; s += 0.5) {
    const oMax = axisLen - (N - 1) * s;
    if (oMax <= 0) continue;
    for (let o = 0; o <= oMax; o += 1) {
      let score = 0;
      for (let i = 0; i < N; i++) {
        const pos = Math.round(o + i * s);
        if (pos >= 0 && pos < axisLen) score += signal[pos];
      }
      if (score > bestScore) {
        bestScore = score;
        bestOrigin = o;
        bestSpacing = s;
      }
    }
  }
  let origin = bestOrigin;
  spacing = bestSpacing;

  // Sub-pixel refinement via one least-squares pass on the strongest anchors
  // that snap close to lattice positions (within ±spacing/4). This nudges
  // origin/spacing by sub-pixel amounts when the ink is slightly off the
  // integer-grid maximum we found above.
  {
    const snapTol = spacing / 4;
    const used: number[] = [];
    const indices: number[] = [];
    for (const p of anchors) {
      const k = Math.round((p - origin) / spacing);
      const expected = origin + k * spacing;
      if (Math.abs(p - expected) <= snapTol) {
        used.push(p);
        indices.push(k);
      }
    }
    if (used.length >= 3) {
      let sumK = 0,
        sumP = 0,
        sumKK = 0,
        sumKP = 0;
      const m = used.length;
      for (let i = 0; i < m; i++) {
        sumK += indices[i];
        sumP += used[i];
        sumKK += indices[i] * indices[i];
        sumKP += indices[i] * used[i];
      }
      const denom = m * sumKK - sumK * sumK;
      if (Math.abs(denom) >= 1e-9) {
        const ns = (m * sumKP - sumK * sumP) / denom;
        const no = (sumP - ns * sumK) / m;
        if (
          isFinite(ns) &&
          ns >= priorSpacing * 0.75 &&
          ns <= priorSpacing * 1.25 &&
          isFinite(no)
        ) {
          spacing = ns;
          origin = no;
        }
      }
    }
  }

  // Generate N lattice positions starting from `origin`.
  const lattice: number[] = [];
  for (let i = 0; i < N; i++) {
    lattice.push(origin + i * spacing);
  }

  // Optional: snap each lattice position to the nearest detected peak within
  // ±spacing/3, so the output uses real ink centroids when available.
  const snapWindow = spacing / 3;
  const snapped = lattice.map((v) => {
    let best = v;
    let bestD = Infinity;
    for (const p of peaks) {
      const d = Math.abs(p - v);
      if (d < bestD && d <= snapWindow) {
        bestD = d;
        best = p;
      }
    }
    return best;
  });

  // Trim positions outside the axis (rare — happens if the anchor estimate
  // was slightly off and an extrapolated line landed past the edge).
  return snapped.filter((v) => v >= 0 && v < axisLen);
}

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

function douglasPeucker(points: number[][], epsilon: number): number[][] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let maxI = -1;
    const [x1, y1] = points[s];
    const [x2, y2] = points[e];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const denom = Math.hypot(dx, dy) || 1;
    for (let i = s + 1; i < e; i++) {
      const [x, y] = points[i];
      const d = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / denom;
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > epsilon && maxI !== -1) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  const out: number[][] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`vectorize: load failed for ${url}`));
    img.src = url;
  });
}
