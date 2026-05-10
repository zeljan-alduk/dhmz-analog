"""Chart geometry — Python port of src/lib/chart-geometry.ts.

Lambrecht-style strip-chart recorders draw via a pen on a swinging arm.
The arm's pivot is some distance behind the paper, so a constant-time
event traces a CURVE (not a vertical line) across the paper. This module
converts displayed (chart-mm) positions back to true (day, hour, value).
"""
import math
from typing import Tuple
from .schemas import ChartConfig, CalibrationPoint
import numpy as np


def arc_sag(measurement_pos: float, pen_arm_radius: float, pen_arm_pivot: float) -> float:
    """Horizontal displacement of the pen at a given measurement position.

    For a Lambrecht barograph: R = 177.8 mm, P = 44.45 mm. Result is 0 at
    measurement_pos = P (the pivot height) and grows with |x − P|.
    """
    R = pen_arm_radius
    P = pen_arm_pivot
    sag_at_pivot = R - math.sqrt(R * R - P * P)
    dx = measurement_pos - P
    inside = R * R - dx * dx
    sag_at_pos = R - math.sqrt(inside) if inside > 0 else R
    return sag_at_pos - sag_at_pivot


def chart_to_value(chart_x: float, chart_y: float, config: ChartConfig) -> Tuple[int, float, float]:
    """Convert (chart_x, chart_y) in chart-mm to (day, hour, value).

    Mirrors `canvasToValue` in src/lib/chart-geometry.ts.
    """
    if config.orientation == "landscape":
        value_range = config.maxValue - config.minValue
        value = config.maxValue - (chart_y / config.chartHeight) * value_range
        true_time_x = chart_x + arc_sag(chart_y, config.penArmRadius, config.penArmPivot)
        day_width = config.chartWidth / config.days
        total_day = true_time_x / day_width
        day = int(math.floor(total_day))
        hour = (total_day - day) * 24
    else:
        value_range = config.maxValue - config.minValue
        value = config.minValue + (chart_x / config.chartWidth) * value_range
        true_time_y = chart_y + arc_sag(chart_x, config.penArmRadius, config.penArmPivot)
        day_height = config.chartHeight / config.days
        total_day = true_time_y / day_height
        day = int(math.floor(total_day))
        hour = (total_day - day) * 24
    day = max(0, min(day, config.days))
    return day, hour, value


def compute_affine(cal_points) -> np.ndarray:
    """Compute affine transform display-px → chart-mm via least squares.

    Returns a 2x3 matrix M such that:
      [chart_x, chart_y]^T = M @ [img_x, img_y, 1]^T

    Mirrors `computeAffineTransform` in src/lib/transform.ts but uses numpy.
    """
    if len(cal_points) < 3:
        raise ValueError("Need ≥3 calibration points")
    src = np.array([[p.imgX, p.imgY, 1.0] for p in cal_points], dtype=np.float64)
    dst_x = np.array([p.chartX for p in cal_points], dtype=np.float64)
    dst_y = np.array([p.chartY for p in cal_points], dtype=np.float64)
    # Least squares for X and Y separately
    coeffs_x, *_ = np.linalg.lstsq(src, dst_x, rcond=None)
    coeffs_y, *_ = np.linalg.lstsq(src, dst_y, rcond=None)
    return np.array([coeffs_x, coeffs_y], dtype=np.float64)


def affine_to_3x3(M: np.ndarray) -> np.ndarray:
    """Promote 2x3 affine to 3x3 homogeneous form."""
    return np.vstack([M, [0.0, 0.0, 1.0]])


def invert_affine_3x3(H: np.ndarray) -> np.ndarray:
    """Invert a 3x3 homogeneous transform."""
    return np.linalg.inv(H)
