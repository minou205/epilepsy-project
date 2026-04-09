from sqlalchemy import Column, String, Integer, Text
from database import Base


class ModelArtifact(Base):
    __tablename__ = "model_artifacts"

    id          = Column(String,  primary_key=True)   # UUID
    patient_id  = Column(String,  nullable=False, index=True)
    tier        = Column(String,  nullable=False)      # 'general' | 'v1' | 'v2' | 'vN'
    version_num = Column(Integer, nullable=False, server_default="0")  # numeric rank: 0=general, 1=v1, 2=v2 …
    model_type  = Column(String,  nullable=False)      # 'predictor' | 'detector'
    file_path   = Column(String,  nullable=False)      # path to .onnx file
    created_at  = Column(String,  nullable=False)
    is_active   = Column(Integer, default=1)           # 1=active, 0=superseded


class TrainingJob(Base):
    __tablename__ = "training_jobs"

    job_id       = Column(String,  primary_key=True)   # UUID
    patient_id   = Column(String,  nullable=False, index=True)
    tier         = Column(String,  nullable=False)      # 'v1' | 'v2' | 'vN'
    version_num  = Column(Integer, nullable=False, server_default="1")  # same scale as ModelArtifact
    status       = Column(String,  default='queued')   # queued|running|complete|failed
    started_at   = Column(String,  nullable=True)
    completed_at = Column(String,  nullable=True)
    error_msg    = Column(Text,    nullable=True)
