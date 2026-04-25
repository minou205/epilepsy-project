import asyncio
import logging
import threading
from datetime import datetime, timezone

from sqlalchemy import select

logger = logging.getLogger(__name__)


class TrainingQueue:

    def __init__(self):
        self._worker_thread: threading.Thread | None = None
        self._wake_event = threading.Event()
        self._running = False

    def start(self):
        if self._running:
            return
        self._running = True
        self._worker_thread = threading.Thread(
            target=self._worker_loop, daemon=True, name='training-queue',
        )
        self._worker_thread.start()
        logger.info('[queue] FIFO training queue worker started')

    def stop(self):
        self._running = False
        self._wake_event.set()

    def notify(self):
        self._wake_event.set()

    def _worker_loop(self):
        while self._running:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                job_processed = loop.run_until_complete(self._process_next_job())
            except Exception:
                logger.exception('[queue] unexpected worker error')
                job_processed = False
            finally:
                loop.close()

            if not job_processed:
                self._wake_event.wait(timeout=30)
                self._wake_event.clear()

    async def _process_next_job(self) -> bool:
        from database import async_session
        from models.model_artifact import TrainingJob

        async with async_session() as db:
            result = await db.execute(
                select(TrainingJob)
                .where(TrainingJob.status == 'pending')
                .order_by(TrainingJob.queued_at.asc())
                .limit(1)
            )
            job = result.scalar_one_or_none()
            if not job:
                return False

            job.status     = 'running'
            job.started_at = datetime.now(timezone.utc).isoformat()
            await db.commit()

            logger.info(
                f'[queue] processing job={job.job_id} '
                f'patient={job.patient_id} model={job.model_type} tier={job.tier}'
            )

            try:
                from services.training_service import process_single_training_job
                await process_single_training_job(db, job)

                job.status       = 'complete'
                job.completed_at = datetime.now(timezone.utc).isoformat()
                await db.commit()

                logger.info(
                    f'[queue] completed job={job.job_id} '
                    f'patient={job.patient_id} model={job.model_type}'
                )

            except Exception as exc:
                logger.exception(f'[queue] job {job.job_id} FAILED: {exc}')
                job.status    = 'failed'
                job.error_msg = str(exc)
                job.completed_at = datetime.now(timezone.utc).isoformat()
                await db.commit()

            return True

    async def recover_interrupted_jobs(self):
        from database import async_session
        from models.model_artifact import TrainingJob

        async with async_session() as db:
            result = await db.execute(
                select(TrainingJob).where(TrainingJob.status == 'running')
            )
            stuck_jobs = result.scalars().all()
            for job in stuck_jobs:
                logger.warning(
                    f'[queue] recovering interrupted job={job.job_id} '
                    f'patient={job.patient_id} model={job.model_type} → pending'
                )
                job.status     = 'pending'
                job.started_at = None
                job.error_msg  = None
            if stuck_jobs:
                await db.commit()
                logger.info(f'[queue] recovered {len(stuck_jobs)} interrupted job(s)')


training_queue = TrainingQueue()
