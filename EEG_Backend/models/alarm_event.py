from sqlalchemy import Column, String, Integer, Text
from database import Base


class AlarmEventRecord(Base):
    """Persisted alarm events — synced from the phone for helper access."""
    __tablename__ = "alarm_events"

    id              = Column(String, primary_key=True)
    patient_id      = Column(String, nullable=False, index=True)
    alarm_type      = Column(String, nullable=False)     # 'prediction' | 'detection'
    tier            = Column(String, nullable=False)      # 'general' | 'v1' | 'v2' …
    timestamp       = Column(String, nullable=False)      # ISO timestamp
    confirmed       = Column(Integer, nullable=True)      # 1=real seizure, 0=false/auto-no
    predictor_probs = Column(Text, nullable=True)         # JSON array of floats
    detector_probs  = Column(Text, nullable=True)         # JSON array of floats
    prob_timestamps = Column(Text, nullable=True)         # JSON array of ms timestamps
    created_at      = Column(String, nullable=False)
