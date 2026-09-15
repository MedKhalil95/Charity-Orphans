# Rahma — Give near you

A donation platform for orphans and associations: find recipients close to
your GPS location on a map, get walking/driving directions via Google Maps,
donate directly online, or scan/print a QR code that opens a pre-filled
donation form for a specific orphan or association. Available in Arabic,
French and English (with right-to-left layout for Arabic). Responsive from
phone to laptop.

## Stack

- **Backend:** FastAPI + SQLAlchemy + SQLite (swap to Postgres by setting the
  `DATABASE_URL` env var), `qrcode` for QR generation.
- **Frontend:** TypeScript (compiled to plain JS, no framework/bundler
  needed), HTML, CSS. Map rendering via **Leaflet + OpenStreetMap** (free,
  no API key). "Get directions" opens **Google Maps** via its deep-link URL
  (`google.com/maps/dir/?...`), which also needs no API key and works on
  both desktop and the mobile app.

## Project layout

```
backend/
  main.py        FastAPI app: REST endpoints, QR generation, static hosting
  models.py       SQLAlchemy models (Orphan, Association, Donation)
  schemas.py      Pydantic request/response schemas
  database.py     Engine/session setup
  seed.py         Demo data (Tunis-area orphans & associations)
  requirements.txt
frontend/
  index.html
  css/styles.css
  ts/app.ts       Source TypeScript
  js/app.js       Compiled output actually served (rebuild after editing ts/)
  i18n/{en,fr,ar}.json
  tsconfig.json
```

## Running it locally

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Open **http://127.0.0.1:8000** — the backend serves the compiled frontend
directly, so there's nothing else to start. A SQLite file `charity.db` is
created and seeded automatically on first run.

If you edit `frontend/ts/app.ts`, recompile it:

```bash
cd frontend
npm install -g typescript   # once
tsc -p tsconfig.json
```

## API reference

| Method | Path                              | Purpose                                             |
|--------|------------------------------------|------------------------------------------------------|
| GET    | `/api/orphans?lat&lng&radius_km`   | List orphans, sorted by distance if lat/lng given    |
| GET    | `/api/orphans/{id}`                | One orphan                                            |
| GET    | `/api/associations?lat&lng&radius_km` | List associations, same distance sorting           |
| GET    | `/api/associations/{id}`           | One association                                       |
| POST   | `/api/donations`                   | Record a donation (`target_type`: orphan/association) |
| GET    | `/api/donations/recent`            | Recent donation feed                                   |
| GET    | `/api/qr/{target_type}/{id}`       | PNG QR code deep-linking to that recipient's donate form |

## Notes on what's real vs. a placeholder

- **Payment capture is simulated.** `capture_payment()` in `main.py` is the
  single place to wire in a real gateway (Stripe, PayPal, or a local
  Tunisian processor like Flouci/ClicToPay/Paymee) — right now it always
  succeeds and the donation is just recorded in the database.
- **Demo data** in `seed.py` is fictional, placed around Tunis. Replace it
  with real orphan/association records (an admin panel or CSV import would
  be the next step) before using this for a live cause — and make sure you
  have consent and appropriate safeguarding review before publishing any
  real child's photo, name, or precise home location on a public map.
- **QR codes** encode a link back into this same app
  (`/?donate=orphan&id=5`) which auto-opens the donation form for that
  recipient when scanned — print the PNG from the "Download QR code"
  button onto flyers or a front-desk sign.

## Extending

- Swap SQLite for Postgres: set `DATABASE_URL=postgresql://...` before
  starting uvicorn.
- Add an admin interface to manage orphans/associations instead of editing
  `seed.py`.
- Add more languages: drop a new `frontend/i18n/<code>.json` file (copy
  `en.json`'s keys) and add a button in the `.lang-switch` group in
  `index.html`.
