"""
Rahma (رحمة) — Charity & Orphan Sponsorship API
-------------------------------------------------
FastAPI backend for a donation platform that:
  * lists orphans & associations near the user's GPS position
  * records donations / sponsorship pledges
  * generates scannable QR codes that deep-link straight to a
    donation form for a given orphan or association
  * serves the compiled TS/HTML/CSS frontend as static files

Run locally:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000
"""
import io
import math
from pathlib import Path
from typing import List, Optional

import qrcode
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

import models
import schemas
from database import engine, get_db, Base
from seed import seed_if_empty

Base.metadata.create_all(bind=engine)
seed_if_empty()

app = FastAPI(title="Rahma Charity API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/lng points, in kilometers."""
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * R * math.asin(math.sqrt(a))


# --------------------------------------------------------------------------
# Orphans
# --------------------------------------------------------------------------
@app.get("/api/orphans", response_model=List[schemas.OrphanOut])
def list_orphans(
    lat: Optional[float] = Query(None, description="User latitude"),
    lng: Optional[float] = Query(None, description="User longitude"),
    radius_km: Optional[float] = Query(None, gt=0, description="Filter within this radius"),
    db: Session = Depends(get_db),
):
    """List orphans, optionally sorted/filtered by distance from the
    user's current position. Omit lat/lng to get the full list."""
    orphans = db.query(models.Orphan).all()
    results = []
    for o in orphans:
        item = schemas.OrphanOut.model_validate(o)
        if lat is not None and lng is not None:
            item.distance_km = round(haversine_km(lat, lng, o.latitude, o.longitude), 2)
        results.append(item)

    if lat is not None and lng is not None:
        results.sort(key=lambda r: r.distance_km)
        if radius_km is not None:
            results = [r for r in results if r.distance_km <= radius_km]

    return results


@app.get("/api/orphans/{orphan_id}", response_model=schemas.OrphanOut)
def get_orphan(orphan_id: int, db: Session = Depends(get_db)):
    o = db.query(models.Orphan).filter(models.Orphan.id == orphan_id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Orphan not found")
    return o


# --------------------------------------------------------------------------
# Associations
# --------------------------------------------------------------------------
@app.get("/api/associations", response_model=List[schemas.AssociationOut])
def list_associations(
    lat: Optional[float] = Query(None),
    lng: Optional[float] = Query(None),
    radius_km: Optional[float] = Query(None, gt=0),
    db: Session = Depends(get_db),
):
    assocs = db.query(models.Association).all()
    results = []
    for a in assocs:
        item = schemas.AssociationOut.model_validate(a)
        if lat is not None and lng is not None:
            item.distance_km = round(haversine_km(lat, lng, a.latitude, a.longitude), 2)
        results.append(item)

    if lat is not None and lng is not None:
        results.sort(key=lambda r: r.distance_km)
        if radius_km is not None:
            results = [r for r in results if r.distance_km <= radius_km]

    return results


@app.get("/api/associations/{assoc_id}", response_model=schemas.AssociationOut)
def get_association(assoc_id: int, db: Session = Depends(get_db)):
    a = db.query(models.Association).filter(models.Association.id == assoc_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="Association not found")
    return a


# --------------------------------------------------------------------------
# Donations
# --------------------------------------------------------------------------
def capture_payment(donation: schemas.DonationCreate) -> bool:
    """Placeholder for a real payment gateway integration
    (Stripe, PayPal, local Tunisian gateways like Flouci/ClicToPay, etc).
    Wire the real charge call here; return True on success.
    """
    return True


@app.post("/api/donations", response_model=schemas.DonationOut, status_code=201)
def create_donation(payload: schemas.DonationCreate, db: Session = Depends(get_db)):
    if payload.target_type not in ("orphan", "association"):
        raise HTTPException(status_code=400, detail="target_type must be 'orphan' or 'association'")

    if payload.target_type == "orphan":
        target = db.query(models.Orphan).filter(models.Orphan.id == payload.target_id).first()
        if not target:
            raise HTTPException(status_code=404, detail="Orphan not found")
    else:
        target = db.query(models.Association).filter(models.Association.id == payload.target_id).first()
        if not target:
            raise HTTPException(status_code=404, detail="Association not found")

    if not capture_payment(payload):
        raise HTTPException(status_code=402, detail="Payment failed")

    donation = models.Donation(
        donor_name=payload.donor_name or "Anonymous",
        donor_email=payload.donor_email or "",
        amount=payload.amount,
        currency=payload.currency,
        message=payload.message or "",
        target_type=payload.target_type,
        orphan_id=payload.target_id if payload.target_type == "orphan" else None,
        association_id=payload.target_id if payload.target_type == "association" else None,
        via_qr=payload.via_qr,
    )
    db.add(donation)

    if payload.target_type == "orphan":
        target.amount_raised = (target.amount_raised or 0) + payload.amount

    db.commit()
    db.refresh(donation)
    return donation


@app.get("/api/donations/recent", response_model=List[schemas.DonationOut])
def recent_donations(limit: int = Query(20, le=100), db: Session = Depends(get_db)):
    return (
        db.query(models.Donation)
        .order_by(models.Donation.created_at.desc())
        .limit(limit)
        .all()
    )


# --------------------------------------------------------------------------
# QR codes
# --------------------------------------------------------------------------
@app.get("/api/qr/{target_type}/{target_id}")
def get_qr_code(target_type: str, target_id: int, db: Session = Depends(get_db)):
    """Returns a PNG QR code that deep-links to the donation form for
    this orphan/association. Print it, put it on a flyer, or display
    it at the association's front desk — scanning it opens the app
    with the right donation target pre-selected."""
    if target_type not in ("orphan", "association"):
        raise HTTPException(status_code=400, detail="target_type must be 'orphan' or 'association'")

    if target_type == "orphan":
        exists = db.query(models.Orphan.id).filter(models.Orphan.id == target_id).first()
    else:
        exists = db.query(models.Association.id).filter(models.Association.id == target_id).first()
    if not exists:
        raise HTTPException(status_code=404, detail="Target not found")

    # Deep link consumed by the frontend on load (?donate=type&id=N)
    deep_link = f"/?donate={target_type}&id={target_id}"
    img = qrcode.make(deep_link)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


# --------------------------------------------------------------------------
# Static frontend (must be mounted last so /api/* routes take priority)
# --------------------------------------------------------------------------
# Resolved relative to THIS file, not the current working directory, so the
# app starts correctly no matter which folder you launch uvicorn from.
FRONTEND_DIR = (Path(__file__).resolve().parent.parent / "frontend")

if not FRONTEND_DIR.is_dir():
    raise RuntimeError(
        f"Frontend folder not found at {FRONTEND_DIR}. "
        "Make sure the 'frontend' folder sits next to the 'backend' folder."
    )

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
