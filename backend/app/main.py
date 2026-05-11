from fastapi import FastAPI, HTTPException, Query
import asyncio
import logging
import traceback

from .schemas import ExtractTraceRequest, ExtractTraceResponse
from .extract import extract_trace
from .calibrate import (
    CalibrateGridRequest,
    CalibrateGridResponse,
    calibrate_grid,
    RectifyRequest,
    RectifyResponse,
    rectify,
)
from .grid_align import (
    VectorizeGridRequest,
    VectorizeGridResponse,
    vectorize_grid,
)
from .sessions import (
    router as sessions_router,
    cleanup_loop as sessions_cleanup_loop,
    load_all_sessions,
)
from .customizations import (
    router as customizations_router,
    cleanup_loop as customizations_cleanup_loop,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dhmz")

app = FastAPI(title="DHMZ Backend", version="1.0.0")
app.include_router(sessions_router, prefix="/api")
app.include_router(customizations_router, prefix="/api")


@app.on_event("startup")
async def _start_cleanup_loops() -> None:
    # Re-hydrate sessions from disk first so any in-flight long-polls reconnect.
    load_all_sessions()
    app.state._sessions_cleanup_task = asyncio.create_task(sessions_cleanup_loop())
    app.state._customizations_cleanup_task = asyncio.create_task(
        customizations_cleanup_loop()
    )


@app.on_event("shutdown")
async def _stop_cleanup_loops() -> None:
    for attr in ("_sessions_cleanup_task", "_customizations_cleanup_task"):
        task = getattr(app.state, attr, None)
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass


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


@app.post("/api/rectify", response_model=RectifyResponse)
def rectify_endpoint(req: RectifyRequest):
    try:
        return rectify(req)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # pragma: no cover
        log.error("rectify failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(500, f"Rectify failed: {e}")


@app.post("/api/vectorize-grid", response_model=VectorizeGridResponse)
def vectorize_grid_endpoint(req: VectorizeGridRequest):
    """Reference-template-based grid vectorization.

    Aligns the user's scan to the bundled empty-chart reference via ECC, then
    transforms every cached reference grid polyline back into the user's
    image space. Returns major / minor / fine horizontals + arcs in a single
    call. Falls back to HTTP 503 if the chart type has no reference template
    or if ECC alignment doesn't converge — caller is expected to fall back
    to client-side vectorization in that case.
    """
    try:
        return vectorize_grid(req)
    except ValueError as e:
        raise HTTPException(503, str(e))
    except Exception as e:  # pragma: no cover
        log.error("vectorize-grid failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(500, f"Vectorize-grid failed: {e}")


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
