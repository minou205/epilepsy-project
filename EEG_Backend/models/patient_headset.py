from sqlalchemy import Column, String, Integer, Text
from database import Base


class PatientHeadset(Base):
    """Per-patient headset lock — all training data must use this exact channel set."""
    __tablename__ = "patient_headsets"

    patient_id    = Column(String, primary_key=True)
    headset_name  = Column(String, nullable=False)
    n_channels    = Column(Integer, nullable=False)
    channel_names = Column(Text, nullable=False)        # JSON list of channel names
    sampling_rate = Column(Integer, nullable=False, default=256)
    created_at    = Column(String, nullable=False)
    updated_at    = Column(String, nullable=False)
