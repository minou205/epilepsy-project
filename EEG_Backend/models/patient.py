from sqlalchemy import Column, String, Text
from database import Base


class Patient(Base):
    __tablename__ = "patients"

    patient_id   = Column(String, primary_key=True)
    patient_name = Column(String, nullable=False)
    push_token   = Column(String, nullable=True)
    created_at   = Column(String, nullable=False)


class HelperToken(Base):
    __tablename__ = "helper_tokens"

    id            = Column(String, primary_key=True)   # UUID
    patient_id    = Column(String, nullable=False)
    push_token    = Column(String, nullable=False)
    registered_at = Column(String, nullable=False)
