import { CalibrationPoint } from "./types";

/**
 * Compute an affine transformation matrix from calibration points.
 * Maps image pixel coordinates → chart mm coordinates.
 *
 * Uses least-squares fit for overdetermined systems (>3 points).
 * Affine transform: [chartX] = [a b c] [imgX]
 *                   [chartY]   [d e f] [imgY]
 *                                      [ 1  ]
 */
export function computeAffineTransform(
  points: CalibrationPoint[]
): { matrix: number[]; inverse: number[] } | null {
  if (points.length < 3) return null;

  const n = points.length;

  // Build matrices for least squares: A * params = B
  // For X: a*imgX + b*imgY + c = chartX
  // For Y: d*imgX + e*imgY + f = chartY

  // Using normal equations: (A^T A) params = A^T B
  let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
  let sumXcx = 0, sumYcx = 0, sumCx = 0;
  let sumXcy = 0, sumYcy = 0, sumCy = 0;

  for (const p of points) {
    sumX += p.imgX;
    sumY += p.imgY;
    sumXX += p.imgX * p.imgX;
    sumYY += p.imgY * p.imgY;
    sumXY += p.imgX * p.imgY;
    sumXcx += p.imgX * p.chartX;
    sumYcx += p.imgY * p.chartX;
    sumCx += p.chartX;
    sumXcy += p.imgX * p.chartY;
    sumYcy += p.imgY * p.chartY;
    sumCy += p.chartY;
  }

  // Solve 3x3 system: [sumXX sumXY sumX] [a]   [sumXcx]
  //                    [sumXY sumYY sumY] [b] = [sumYcx]
  //                    [sumX  sumY  n   ] [c]   [sumCx ]
  const A = [
    [sumXX, sumXY, sumX],
    [sumXY, sumYY, sumY],
    [sumX, sumY, n],
  ];
  const Bx = [sumXcx, sumYcx, sumCx];
  const By = [sumXcy, sumYcy, sumCy];

  const paramsX = solve3x3(A, Bx);
  const paramsY = solve3x3(A, By);

  if (!paramsX || !paramsY) return null;

  const [a, b, c] = paramsX;
  const [d, e, f] = paramsY;

  // Forward matrix: img → chart
  const matrix = [a, b, c, d, e, f];

  // Inverse: chart → img
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-10) return null;

  const ia = e / det;
  const ib = -b / det;
  const ic = (b * f - e * c) / det;
  const id = -d / det;
  const ie = a / det;
  const iF = (d * c - a * f) / det;

  const inverse = [ia, ib, ic, id, ie, iF];

  return { matrix, inverse };
}

function solve3x3(A: number[][], B: number[]): number[] | null {
  // Gaussian elimination with partial pivoting
  const m = A.map((row, i) => [...row, B[i]]);

  for (let col = 0; col < 3; col++) {
    // Find pivot
    let maxRow = col;
    let maxVal = Math.abs(m[col][col]);
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row][col]) > maxVal) {
        maxVal = Math.abs(m[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) return null;

    // Swap rows
    [m[col], m[maxRow]] = [m[maxRow], m[col]];

    // Eliminate
    for (let row = col + 1; row < 3; row++) {
      const factor = m[row][col] / m[col][col];
      for (let j = col; j < 4; j++) {
        m[row][j] -= factor * m[col][j];
      }
    }
  }

  // Back substitution
  const result = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let sum = m[i][3];
    for (let j = i + 1; j < 3; j++) {
      sum -= m[i][j] * result[j];
    }
    result[i] = sum / m[i][i];
  }

  return result;
}

/**
 * Apply forward transform: image pixels → chart mm
 */
export function imageToChart(
  imgX: number,
  imgY: number,
  matrix: number[]
): { chartX: number; chartY: number } {
  return {
    chartX: matrix[0] * imgX + matrix[1] * imgY + matrix[2],
    chartY: matrix[3] * imgX + matrix[4] * imgY + matrix[5],
  };
}

/**
 * Apply inverse transform: chart mm → image pixels
 */
export function chartToImage(
  chartX: number,
  chartY: number,
  inverse: number[]
): { imgX: number; imgY: number } {
  return {
    imgX: inverse[0] * chartX + inverse[1] * chartY + inverse[2],
    imgY: inverse[3] * chartX + inverse[4] * chartY + inverse[5],
  };
}
