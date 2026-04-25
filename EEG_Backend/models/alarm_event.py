from sqlalchemy import Column, String, Integer, Text
from database import Base


class AlarmEventRecord(Base):
    __tablename__ = "alarm_events"

    id              = Column(String, primary_key=True)
    patient_id      = Column(String, nullable=False, index=True)
    alarm_type      = Column(String, nullable=False)
    tier            = Column(String, nullable=False)
    timestamp       = Column(String, nullable=False)
    confirmed       = Column(Integer, nullable=True)
    predictor_probs = Column(Text, nullable=True)
    detector_probs  = Column(Text, nullable=True)
    prob_timestamps = Column(Text, nullable=True)
    created_at      = Column(String, nullable=False)
