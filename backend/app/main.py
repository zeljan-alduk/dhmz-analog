from fastapi import FastAPI, HTTPException, Query
import logging
import traceback

from .schemas import ExtractTraceRequest, ExtractTraceResponse
from .extract import extract_trace
from .calibrate import (
    CalibrateGridRequest,
    CalibrateGridResponse,
    calibrate_grid,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dhmz")

app = FastAPI(title="DHMZ Backend", version="1.0.0")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/extract-trace", response_model=ExtractTraceResponse)
def extract_trace_endpoint(
    req: ExtractTraceRequest,
    debug: bool = Query(False, description="Include base64 mask + skeleton previews"),
):
    try:
        result = extract_trace(req, debug=debug)
        log.info(
            "extract-trace ok: %d points, mask=%d, skel=%d, timing=%s",
            len(result.points),
            result.diagnostics.maskPixels,
            result.diagnostics.skeletonPixels,
            result.diagnostics.timingMs,
        )
        return result
    except ValueError as e:
        log.warning("extract-trace bad request: %s", e)
        raise HTTPException(400, str(e))
    except Exception as e:  # pragma: no cover
        log.error("extract-trace failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(500, f"Extraction failed: {e}")


@app.post("/api/calibrate-grid", response_model=CalibrateGridResponse)
def calibrate_grid_endpoint(
    req: CalibrateGridRequest,
    debug: bool = Query(False, description="Include base64 annotated preview"),
):
    try:
        result = calibrate_grid(req, debug=debug)
        log.info(
            "calibrate-grid ok: H=%d V=%d angle=%.2f° timing=%s",
            result.diagnostics.detectedHorizontals,
            result.diagnostics.detectedVerticals,
            result.diagnostics.dominantAngleDeg,
            result.diagnostics.timingMs,
        )
        return result
    except ValueError as e:
        log.warning("calibrate-grid failed: %s", e)
        raise HTTPException(400, str(e))
    except Exception as e:  # pragma: no cover
        log.error("calibrate-grid failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(500, f"Calibration failed: {e}")
