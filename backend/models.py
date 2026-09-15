from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Float, Text, DateTime, ForeignKey, Boolean
)
from sqlalchemy.orm import relationship
from database import Base


class Association(Base):
    """A registered charity / orphanage association."""
    __tablename__ = "associations"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text, default="")
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    address = Column(String(300), default="")
    phone = Column(String(50), default="")
    logo_url = Column(String(500), default="")
    verified = Column(Boolean, default=True)

    orphans = relationship("Orphan", back_populates="association")
    donations = relationship("Donation", back_populates="association")


class Orphan(Base):
    """An individual orphan profile with a location (e.g. host family
    or partner association address) that can be shown on the map."""
    __tablename__ = "orphans"

    id = Column(Integer, primary_key=True, index=True)
    first_name = Column(String(100), nullable=False)
    age = Column(Integer, nullable=False)
    gender = Column(String(10), default="")
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    city = Column(String(120), default="")
    story = Column(Text, default="")
    needs = Column(Text, default="")  # e.g. "School fees, winter clothes"
    photo_url = Column(String(500), default="")
    monthly_goal = Column(Float, default=0.0)   # target sponsorship amount
    amount_raised = Column(Float, default=0.0)
    association_id = Column(Integer, ForeignKey("associations.id"), nullable=True)

    association = relationship("Association", back_populates="orphans")
    donations = relationship("Donation", back_populates="orphan")


class Donation(Base):
    """A donation / pledge record. In this reference implementation,
    payment capture is simulated -- wire up a real processor
    (Stripe/PayPal/local gateway) in `capture_payment()` in main.py."""
    __tablename__ = "donations"

    id = Column(Integer, primary_key=True, index=True)
    donor_name = Column(String(150), default="Anonymous")
    donor_email = Column(String(200), default="")
    amount = Column(Float, nullable=False)
    currency = Column(String(10), default="TND")
    message = Column(Text, default="")
    target_type = Column(String(20), nullable=False)  # 'orphan' | 'association'
    orphan_id = Column(Integer, ForeignKey("orphans.id"), nullable=True)
    association_id = Column(Integer, ForeignKey("associations.id"), nullable=True)
    via_qr = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    orphan = relationship("Orphan", back_populates="donations")
    association = relationship("Association", back_populates="donations")
