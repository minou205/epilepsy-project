from sqlalchemy import Column, String, Integer, Text
from database import Base


class SeizureEvent(Base):
    __tablename__ = "seizure_events"

    seizure_id    = Column(String,  primary_key=True)
    patient_id    = Column(String,  nullable=False, index=True)
    captured_at   = Column(String,  nullable=False)
    preictal_file = Column(String,  nullable=True)
    ictal_file    = Column(String,  nullable=True)
    channel_names = Column(Text,    nullable=True)
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
    __tablename__ = "false_positive_events"

    fp_id         = Column(String,  primary_key=True)
    patient_id    = Column(String,  nullable=False, index=True)
    alarm_id      = Column(String,  nullable=True)
    alarm_type    = Column(String,  nullable=True)
    model_tier    = Column(String,  nullable=True)
    captured_at   = Column(String,  nullable=False)
    eeg_file      = Column(String,  nullable=True)
    channel_names = Column(Text,    nullable=True)
    sampling_rate = Column(Integer, default=256)
    uploaded_at   = Column(String,  nullable=False)
