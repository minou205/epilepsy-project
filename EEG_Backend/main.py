import logging
import traceback
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from config import MODELS_DIR, GENERAL_PREDICTOR_PT, GENERAL_DETECTOR_PT
from routers import patients, data_upload, model_management, notifications, training, inference, archive, headset
from services.discovery import initialize_service_discovery, shutdown_service_discovery

# ── Logging ────────────────────────────────────────────────────────────────────
# Configure a basic handler so all logger.info/warning/error calls are visible
# in the terminal.  Without this, log messages go nowhere by default.
logging.basicConfig(
    level  = logging.INFO,
    format = '%(asctime)s [%(name)s] %(levelname)s: %(message)s',
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Database ───────────────────────────────────────────────────────────────
    await init_db()

    # ── Service discovery publishes a public backend URL to Supabase ----------
    # Optional: set ENABLE_SERVICE_DISCOVERY=1 to enable (disabled by default for local dev)
    enable_discovery = os.getenv('ENABLE_SERVICE_DISCOVERY', '0').lower() in ('1', 'true', 'yes')
    if enable_discovery:
        try:
            await initialize_service_discovery(app)
        except Exception:
            logging.exception('[startup] Service discovery initialization failed')
    else:
        logging.info('[startup] Service discovery disabled (set ENABLE_SERVICE_DISCOVERY=1 to enable)')

    # ── Preload general .pt models into inference cache ─────────────────────
    # Server-side inference: models are loaded into memory and kept warm.
    # No ONNX conversion needed — we use PyTorch .pt files directly.
    print('[startup] Preloading general models for server-side inference...', flush=True)
    try:
        from services.inference_service import model_cache
        loaded = []
        if GENERAL_PREDICTOR_PT.exists():
            model_cache.get_or_load("general_predictor", GENERAL_PREDICTOR_PT, "predictor")
            loaded.append(f"predictor ({GENERAL_PREDICTOR_PT.name})")
        if GENERAL_DETECTOR_PT.exists():
            model_cache.get_or_load("general_detector", GENERAL_DETECTOR_PT, "detector")
            loaded.append(f"detector ({GENERAL_DETECTOR_PT.name})")
        if loaded:
            print(f'[startup] Preloaded: {", ".join(loaded)}', flush=True)
        else:
            print('[startup] No general .pt models found — place them at:', flush=True)
            print(f'  Predictor: {GENERAL_PREDICTOR_PT}', flush=True)
            print(f'  Detector:  {GENERAL_DETECTOR_PT}', flush=True)
    except Exception:
        print('[startup] Model preloading encountered an error:', flush=True)
        print(traceback.format_exc(), flush=True)

    yield

    try:
        await shutdown_service_discovery(app)
    except Exception:
        logging.exception('[shutdown] Service discovery shutdown failed')


app = FastAPI(
    title      = "EHSS Backend",
    description= "EEG-based epilepsy detection & prediction backend",
    version    = "1.0.0",
    lifespan   = lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins    = ["*"],
    allow_credentials= True,
    allow_methods    = ["*"],
    allow_headers    = ["*"],
)

app.include_router(patients.router)
app.include_router(data_upload.router)
app.include_router(model_management.router)
app.include_router(notifications.router)
app.include_router(training.router)
app.include_router(inference.router)
app.include_router(archive.router)
app.include_router(headset.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
