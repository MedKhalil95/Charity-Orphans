"""
Database engine/session setup.
Uses SQLite by default (file: charity.db) so the app runs with zero
external services. Swap SQLALCHEMY_DATABASE_URL for Postgres/MySQL in
production by setting the DATABASE_URL environment variable.
"""
import os
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# Anchor the SQLite file next to this file so the same database is used
# regardless of which directory you launch the server from.
DB_PATH = Path(__file__).resolve().parent / "charity.db"

SQLALCHEMY_DATABASE_URL = os.environ.get(
    "DATABASE_URL", f"sqlite:///{DB_PATH}"
)

connect_args = {}
if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
