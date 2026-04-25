import logging
import traceback
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from config import MODELS_DIR, GENERAL_PREDICTOR_PT, GENERAL_DETECTOR_PT
from routers import data_upload, model_management, notifications, training, inference, archive, headset
from services.discovery import initialize_service_discovery, shutdown_service_discovery

logging.basicConfig(
    level  = logging.INFO,
    format = '%(asctime)s [%(name)s] %(levelname)s: %(message)s',
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()

    enable_discovery = os.getenv('ENABLE_SERVICE_DISCOVERY', '0').lower() in ('1', 'true', 'yes')
    if enable_discovery:
        try:
            await initialize_service_discovery(app)
        except Exception:
            logging.exception('[startup] Service discovery initialization failed')

    try:
        from services.training_queue import training_queue
        await training_queue.recover_interrupted_jobs()
        training_queue.start()
    except Exception:
        logging.exception('[startup] Training queue initialization failed')

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
            print('[startup] No general .pt models found', flush=True)
    except Exception:
        print('[startup] Model preloading encountered an error:', flush=True)
        print(traceback.format_exc(), flush=True)

    yield

    try:
        from services.training_queue import training_queue
        training_queue.stop()
    except Exception:
        logging.exception('[shutdown] Training queue shutdown failed')

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
