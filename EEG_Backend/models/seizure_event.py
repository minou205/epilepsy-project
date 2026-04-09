from sqlalchemy import Column, String, Integer, Text
from database import Base


class SeizureEvent(Base):
    __tablename__ = "seizure_events"

    seizure_id    = Column(String,  primary_key=True)
    patient_id    = Column(String,  nullable=False, index=True)
    captured_at   = Column(String,  nullable=False)
    preictal_file = Column(String,  nullable=True)
    ictal_file    = Column(String,  nullable=True)
    channel_names = Column(Text,    nullable=True)   # JSON array string
    sampling_rate = Column(Integer, default=256)
    uploaded_at   = Column(String,  nullable=False)


class NormalDataFile(Base):
    __tablename__ = "normal_data_files"

    file_id       = Column(String,  primary_key=True)
    patient_id    = Column(String,  nullable=False, index=True)
    captured_at   = Column(String,  nullable=False)
    eeg_file      = Column(String,  nullable=True)
    channel_names = Column(Text,    nullable=True)
    sampling_rate = Column(Integer, default=256)
    uploaded_at   = Column(String,  nullable=False)


class FalsePositiveEvent(Base):
    """Stores EEG segments that were flagged by the AI model but confirmed by
    the patient as non-seizure.  These 'golden negatives' are included in the
    next incremental training run to reduce the False Positive Rate (FPR)."""
    __tablename__ = "false_positive_events"

    fp_id         = Column(String,  primary_key=True)   # UUID / timestamp-based ID
    patient_id    = Column(String,  nullable=False, index=True)
    alarm_id      = Column(String,  nullable=True)       # AlarmEvent.id from the app
    alarm_type    = Column(String,  nullable=True)       # 'prediction' | 'detection'
    model_tier    = Column(String,  nullable=True)       # which model fired the alarm
    captured_at   = Column(String,  nullable=False)
    eeg_file      = Column(String,  nullable=True)       # path to false_positive_*.txt
    channel_names = Column(Text,    nullable=True)       # JSON array string
    sampling_rate = Column(Integer, default=256)
    uploaded_at   = Column(String,  nullable=False)
