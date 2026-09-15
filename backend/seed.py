"""Seeds a handful of demo associations & orphans around Tunis so the
map has something to show out of the box. Replace with real data via
the database, an admin panel, or a CSV import in production."""
from database import SessionLocal
import models


def seed_if_empty():
    db = SessionLocal()
    try:
        if db.query(models.Association).count() > 0:
            return

        associations = [
            models.Association(
                name="Association Amal pour l'Enfance",
                description="Local association supporting orphaned and vulnerable children in greater Tunis.",
                latitude=36.8065, longitude=10.1815,
                address="Avenue Habib Bourguiba, Tunis",
                phone="+216 71 000 111",
                logo_url="", verified=True,
            ),
            models.Association(
                name="SOS Villages d'Enfants Tunisie",
                description="Family-based long-term care for orphaned and abandoned children.",
                latitude=36.8985, longitude=10.1892,
                address="Gammarth, Tunis",
                phone="+216 71 000 222",
                logo_url="", verified=True,
            ),
            models.Association(
                name="Fondation Rahma",
                description="Sponsorship network connecting donors directly with orphan families.",
                latitude=36.7538, longitude=10.2275,
                address="Ben Arous",
                phone="+216 71 000 333",
                logo_url="", verified=True,
            ),
        ]
        db.add_all(associations)
        db.flush()  # get IDs

        orphans = [
            models.Orphan(
                first_name="Youssef", age=7, gender="M",
                latitude=36.8100, longitude=10.1750,
                city="Tunis", story="Youssef loves drawing and dreams of becoming an architect.",
                needs="School supplies, winter clothes",
                monthly_goal=150, amount_raised=40,
                association_id=associations[0].id,
            ),
            models.Orphan(
                first_name="Rania", age=9, gender="F",
                latitude=36.8210, longitude=10.1660,
                city="Tunis", story="Rania is top of her class in maths and wants to be a doctor.",
                needs="Tuition fees, books",
                monthly_goal=180, amount_raised=90,
                association_id=associations[0].id,
            ),
            models.Orphan(
                first_name="Mohamed", age=5, gender="M",
                latitude=36.8950, longitude=10.1830,
                city="La Marsa", story="Mohamed is the youngest in his host family, very playful.",
                needs="Milk, diapers, medical checkups",
                monthly_goal=120, amount_raised=20,
                association_id=associations[1].id,
            ),
            models.Orphan(
                first_name="Salma", age=12, gender="F",
                latitude=36.7600, longitude=10.2350,
                city="Ben Arous", story="Salma helps care for her younger siblings and loves reading.",
                needs="School fees, shoes",
                monthly_goal=160, amount_raised=160,
                association_id=associations[2].id,
            ),
            models.Orphan(
                first_name="Karim", age=10, gender="M",
                latitude=36.7450, longitude=10.2200,
                city="Ben Arous", story="Karim is passionate about football and wants new cleats.",
                needs="Sportswear, tuition",
                monthly_goal=140, amount_raised=55,
                association_id=associations[2].id,
            ),
            models.Orphan(
                first_name="Nour", age=6, gender="F",
                latitude=36.8300, longitude=10.1650,
                city="Tunis", story="Nour recently started school and needs a uniform.",
                needs="Uniform, backpack, notebooks",
                monthly_goal=130, amount_raised=10,
                association_id=None,
            ),
        ]
        db.add_all(orphans)
        db.commit()
    finally:
        db.close()
