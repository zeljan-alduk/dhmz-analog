from pydantic import BaseModel
from typing import List, Literal, Optional


class CalibrationPoint(BaseModel):
    """Single (display-px, chart-mm) correspondence."""
    imgX: float
    imgY: float
    chartX: float
    chartY: float


class ChartConfig(BaseModel):
    """Subset of the frontend ChartConfig that the extractor needs."""
    orientation: Literal["landscape", "portrait"]
    chartWidth: float       # mm
    chartHeight: float      # mm
    minValue: float
    maxValue: float
    majorGrid: float
    days: int
    penArmRadius: float     # mm
    penArmPivot: float      # mm
    unit: str = ""


class ExtractTraceRequest(BaseModel):
    """Image + calibration corners + chart config."""
    # Base64-encoded PNG/JPEG (no data: prefix)
    imageBase64: str
    # Calibration points: imgX/imgY are in DISPLAY-px space (matches what the
    # frontend calls baseW × baseH, post-DISPLAY_SCALE).
    calibrationPoints: List[CalibrationPoint]
    # The display dimensions the calibrationPoints live in.
    displayWidth: float
    displayHeight: float
    config: ChartConfig
    # How many samples to bin per chart day (default = every 30 minutes).
    samplesPerDay: int = 48
    # Trace ink color hint — affects masking. "auto" uses generic dark+saturated.
    traceInk: Literal["auto", "blue", "red", "black"] = "auto"
    # Optional template (prazna / empty chart of the same instrument). When
    # provided, the extractor aligns the input image to this template via ECC
    # then subtracts → the residual contains ONLY the pen trace (grid, labels,
    # logo, paper texture all cancel out). This is the gold-standard trace
    # extraction technique used by Met Office / KNMI digitization pipelines.
    templateImageBase64: Optional[str] = None


class DataPoint(BaseModel):
    day: int
    hour: float
    value: float
    # Display-space pixel position so the frontend can render the dot directly
    # on its overlay without redoing the affine inverse.
    canvasX: float
    canvasY: float


class TraceDiagnostics(BaseModel):
    maskPixels: int
    skeletonPixels: int
    extractedPoints: int
    rectifiedSize: List[int]
    timingMs: dict


class ExtractTraceResponse(BaseModel):
    points: List[DataPoint]
    diagnostics: TraceDiagnostics
    # Optional: base64-encoded preview of the trace mask, for debugging.
    debugMaskBase64: Optional[str] = None
    debugSkeletonBase64: Optional[str] = None
    debugRectifiedBase64: Optional[str] = None
