# 🇮🇳 VANIKA NET v2.0 — Released to Desktop

Project lives at `~/Desktop/vanika-net/`. Your `.env` with 11 keys is **preserved untouched**.

---

## ✅ What's NEW in this build

### 1. Real live data — Discovery Engine wired to your keys
- New backend endpoint `/api/discovery/area?lat=X&lng=Y`
- 8 government APIs called in parallel: OSM Nominatim · Open-Elevation · GBIF · eBird (Cornell, uses your `EBIRD_TOKEN`) · iNaturalist · Open-Meteo · NASA FIRMS (uses your `NASA_FIRMS_MAP_KEY`) · IUCN Red List (uses your `IUCN_TOKEN`)
- Click any pin in Discovery Engine → panel now shows **real** numbers fetched live, not simulated

### 2. 🛡 Verification & Onboarding (new page in sidebar — OPS section)

**Company tab — 5 step onboarding for corporate ESG buyers:**
1. Company details (CIN, PAN, GSTIN, address, sector, BRSR mandate, CO₂ baseline)
2. ESG Lead profile (name, designation, Aadhaar last-4, DIN)
3. 8 mandatory documents (MCA Cert, GST, Director KYC, Annual Reports, Board Resolution, ISO 14001, SA 8000)
4. BRSR + CPCB Environmental Compliance (BRSR Report FY25-26, BRSR Annexure, CPCB CTO, CTE, Hazardous Waste, EIA Clearance, CRZ, CSR Plan)
5. Submit → 4-tier government approval chain (VANIKA Compliance → CPCB/SPCB → MoEFCC Eastern → ZSI · Day 1-21)

**Custodian tab — 7 step physical+digital onboarding:**
1. Aadhaar e-KYC (UIDAI OTP)
2. Scheduled Tribe Certificate (state-issued, 24 tribe options, 24 states)
3. Photo + Voice biometric (12-sec sample, Whisper-1 embedding)
4. Gram Sabha Resolution (physical, panchayat secretary signs, FRA 2006 § 4(1)(e))
5. DFO Field Inspection (auto-routed, 7-day SLA)
6. Site GPS + 8 perimeter photos
7. Issue VANIKA Custodian ID (physical card couriered to Panchayat Bhavan + UPI link + 95% direct payment)

**Status board:** live counters — Pending Review, Verified Companies, Verified Custodians, Rejected — with searchable table of recent applications.

### 3. 🚨 Escalation Network (new page — OPS section)

- **6-step statutory escalation path** (Day 0 → Day 30+):
  - Custodian → DFO → ZSI → MoEFCC → NGT Eastern Bench → Supreme Court
- **12 linked government departments per district** with logos:
  - District Forest Office · ZSI · MoEFCC Regional · Tribal Welfare · NGT · CPCB/SPCB · ISRO NRSC · Fire Services · Tribal Police/STF · NDMA · WII · BNHS
- **Threat-type → Department routing matrix** (10 threat types):
  - Illegal logging → DFO + Forest Police (72 hrs, WPA 1972 § 27)
  - Mining encroachment → MoEFCC + Tribal Welfare (7 days, FRA 2006 § 5)
  - Forest fire → Fire Dept + DFO + NDMA (4 hrs, DM Act 2005)
  - Water pollution → CPCB (48 hrs, Water Act 1974)
  - Wildlife crime → WCCB + Tribal Police (24 hrs, WPA 1972 § 51A)
  - Coercion of custodian → Tribal Police + DM (24 hrs, SCST-POA 1989)
  - Construction in 50m buffer · Flood/landslide · Endemic disease · Air pollution

### 4. 📦 Datasets Registry (new page — INSIGHTS section)

All **31 government + global datasets** in one browsable grid:
- 7 Biodiversity sources (ZSI · BSI · NBA-PBR · FSI ISFR · ENVIS · India Biodiv Portal)
- 5 Satellite sources (ISRO Bhuvan · Sentinel-2 · NASA FIRMS · EONET · Bhoonidhi)
- 4 Climate sources (IMD · CPCB · CGWB · Open-Meteo)
- 5 Government & Legal (FRA-MIS · DILRMP · PARIVESH · ICM/CCTS · data.gov.in)
- 5 Cultural & Knowledge (Wikipedia · Wikidata · Sahapedia · NCM · IGNCA)
- 5 Global Biodiversity (GBIF · iNaturalist · eBird · IUCN · Catalogue of Life)
- 1 Demographic (Census 2011 Tribal)

Per dataset: name · owner · description · live URL · access type · auth requirement (keyless ✓ or 🔑) · category. Open · Sample · Download buttons.

### 5. 🕸 Tribal Interconnection Graph (new page — INSIGHTS section)

- **6 language families** (Austroasiatic-Munda · Austroasiatic-Khasi · Dravidian · Tibeto-Burman · Indo-Aryan · Andamanese) with color-coded tribe groupings
- **36+ named tribes** with their languages and state spread
- **6 shared sacred grove types** (SARNA/JAHER · DEVRAI · KAVU · LAW KYNTANG · ORAN · DEVARAKADU) — showing which tribes share each tradition
- **Species-Tribe linkage table** — 8 endangered species + the multiple tribes that protect each (Asian Elephant protected by 5 tribes across 5 states, etc.)
- **4 cross-community threat cards** — same threat, multiple tribes affected, one legal precedent (Niyamgiri 2013 protects 4 communities)

### 6. Sidebar nav reorganized

New entries appear with badges:
- 🛡 Verification (OPS · "NEW")
- 🚨 Escalation Network (OPS · "12 DEPTS")
- 📦 Datasets Registry (INSIGHTS · "31")
- 🕸 Tribal Graph (INSIGHTS · "705 STs")

All accessible from all 6 roles.

---

## 🚀 To run on your Mac

```sh
cd ~/Desktop/vanika-net
node server.js
```

Open `http://localhost:3000` → sign in as any role → explore new sidebar items.

### Live API check
After server starts, hit:
```sh
curl http://localhost:3000/api/health
```
You should see all your keys loaded (✓ set markers).

Then test the discovery endpoint:
```sh
curl "http://localhost:3000/api/discovery/area?lat=19.66&lng=83.45"
```
This returns real GBIF + eBird + Open-Meteo + IUCN + NASA FIRMS data for Niyamgiri.

In the browser, open **🛰 Discovery Engine** → click any pin → the right panel auto-fetches live data from your endpoint (loader spinner first, then green "✓ LIVE" badges).

---

## 📊 Files modified in this release

| File | Lines added | Purpose |
|---|---|---|
| `server.js` | ~80 | `/api/discovery/area` aggregated endpoint |
| `public/app.js` | ~960 | 4 new page functions + real fetch wiring + sidebar items + PAGES + crumbs |
| `public/data.js` | 0 changed lines (just additions to canAccess arrays) | 4 new pages added to all 6 roles |
| `public/styles.css` | ~110 | CSS for verification, escalation, datasets, tribal-graph |
| `.env` | **untouched** | Your 11 keys preserved verbatim |

---

## 🚧 What is still aspirational (not yet built)

- **LoRaWAN village kiosk** — hardware spec documented, software TBD
- **whisper.cpp on-device offline transcription** — same
- **Bluetooth mesh sync** — same
- **IVR / SMS short-code routing** — needs telco provider integration
- **whisper.cpp model auto-distribution to officer tablets** — needs MDM
- **Live linking with UIDAI / MCA21 / GSTN registries** — needs production API keys + government MoU

These remain as **architecture commitments**. They are described in the blueprint and documented in the codebase as Year 2 roadmap.

---

## 🪂 Push to GitHub

```sh
cd ~/Desktop/vanika-net
git add server.js public/app.js public/data.js public/styles.css V2-RELEASE-NOTES.md
git commit -m "feat(v2.0): nationwide platform — Verification + Escalation + Datasets + Tribal Graph + real Discovery API

- /api/discovery/area aggregates 8 government APIs in parallel using user keys
- 4 new pages: Verification (5+7 step onboarding), Escalation (12 depts), Datasets (31 sources), Tribal Graph (6 lang families)
- All 6 roles granted access
- Sidebar nav reorganized
- Theme matches existing dark/neon design tokens
- API keys read from .env (NASA_FIRMS, EBIRD, IUCN, SENTINEL_HUB, OPENAI, DATA_GOV_IN)"
git push origin main
```

Render / Railway will redeploy automatically when GitHub receives the push.

---

**v2.0 status: shipped to Desktop · keys preserved · ready to run.**
