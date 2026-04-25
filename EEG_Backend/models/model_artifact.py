from sqlalchemy import Column, String, Integer, Text
from database import Base


class ModelArtifact(Base):
    __tablename__ = "model_artifacts"

    id                 = Column(String,  primary_key=True)
    patient_id         = Column(String,  nullable=False, index=True)
    tier               = Column(String,  nullable=False)
    version_num        = Column(Integer, nullable=False, server_default="0")
    model_type         = Column(String,  nullable=False)
    file_path          = Column(String,  nullable=False)
    created_at         = Column(String,  nullable=False)
    is_active          = Column(Integer, default=1)
    base_model_version = Column(String,  nullable=True)


class TrainingJob(Base):
    __tablename__ = "training_jobs"

    job_id       = Column(String,  primary_key=True)
    patient_id   = Column(String,  nullable=False, index=True)
    tier         = Column(String,  nullable=False)
    version_num  = Column(Integer, nullable=False, server_default="1")
    model_type   = Column(String,  nullable=False, server_default="predictor")
    status       = Column(String,  default='pending')
    queued_at    = Column(String,  nullable=True)
    started_at   = Column(String,  nullable=True)
    completed_at = Column(String,  nullable=True)
    error_msg    = Column(Text,    nullable=True)
