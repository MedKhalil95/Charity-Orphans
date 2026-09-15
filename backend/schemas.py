from typing import Optional
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict


# ---------- Association ----------
class AssociationOut(BaseModel):
    id: int
    name: str
    description: str
    latitude: float
    longitude: float
    address: str
    phone: str
    logo_url: str
    verified: bool
    distance_km: Optional[float] = None

    model_config = ConfigDict(from_attributes=True)


# ---------- Orphan ----------
class OrphanOut(BaseModel):
    id: int
    first_name: str
    age: int
    gender: str
    latitude: float
    longitude: float
    city: str
    story: str
    needs: str
    photo_url: str
    monthly_goal: float
    amount_raised: float
    association_id: Optional[int] = None
    distance_km: Optional[float] = None

    model_config = ConfigDict(from_attributes=True)


# ---------- Donation ----------
class DonationCreate(BaseModel):
    donor_name: str = Field(default="Anonymous", max_length=150)
    donor_email: Optional[str] = ""
    amount: float = Field(gt=0)
    currency: str = "TND"
    message: Optional[str] = ""
    target_type: str  # 'orphan' | 'association'
    target_id: int
    via_qr: bool = False


class DonationOut(BaseModel):
    id: int
    donor_name: str
    amount: float
    currency: str
    message: str
    target_type: str
    orphan_id: Optional[int]
    association_id: Optional[int]
    via_qr: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
