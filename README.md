# CarbonBridge — prototype

Rice straw biochar carbon removal platform for smallholder farmers in Vietnam (Mekong Delta).

## Run

```
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000

## Walk through it in this order

1. **Landing** → "See what your field could earn"
2. **Estimator** — enter `1.0` hectares, choose "I burn it in the field", 2 seasons
3. **Estimate result** — 5,000,000–7,100,000 ₫. Open both disclosure panels
4. **Signup** — any name, any number (no format is enforced), OTP `123456`
5. **Consent** → tick and continue
6. **Farm registration** — name the field, `1.0` hectares, tap the map or use
   your location. Try the "Exact boundary" tab and tap 4 corners — the
   area is calculated from the polygon
7. **Eligibility** — answer all seven. To see a block, answer "Yes" to
   "already in another carbon project"
8. **Dashboard** — note the 8-stage bar and the single Next Action card
9. **Training** — eight cards, then finish
10. **Evidence** — upload three photos, enter `400` / `110` kg, share location
11. **Quality check** — Submission ready. Then go back and try `400` / `350`
    to see the mass-balance check reject it, or re-upload the *same* photo
    twice to trigger duplicate detection
12. Save the batch, record a second, then **Submit for verification**
13. Step through verification. At "Additional information requested" the
    Next Action card changes — upload the extra photo
14. **Credits issued** — 80/20 split shown explicitly
15. **Sale** → **Payment**. Before payment, try "I need part of this now"
    on the dashboard to take an advance
16. **Join the next rice season** resets the season but keeps the field

## What genuinely runs vs what is mocked

**Real, not simulated:**
- SHA-256 photo hashing for duplicate detection
- Haversine distance between batch GPS and the registered field
- Mass-balance validation (biochar cannot exceed straw; yield range checked)
- Polygon area from map taps (shoelace on a local projection)
- All carbon arithmetic, from straw tonnage through to farmer payment
- Form validation, error handling, progress persistence

**Mocked, and labelled as such in the UI:**
- OTP delivery (code is always 123456; any number is accepted)
- Satellite fire-detection cross-check
- The external verifier and the corporate buyer
- Registry serial numbers
- Bank transfer

## Role boundary

CarbonBridge is a project developer and MRV support platform. It does not
verify, approve, or certify emission reductions. Every quality check in
this prototype is a pre-submission completeness check. The words
"approved", "certified", "officially verified" and "guaranteed" are
deliberately absent from the quality-check path.

## To take further

- Group multiple farms into one project — the credit maths only becomes
  viable at aggregate scale, and stratified sampling needs it
- Replace the mock satellite check with a real fire-detection API
- Kiln temperature logging, so biochar stability can be evidenced rather
  than assumed
- Vietnamese, offline-first sync, and SMS fallback for farmers
  without a smartphone
- A separate corporate portal — this app is farmer-facing only
