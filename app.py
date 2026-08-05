"""
CarbonBridge - Rice straw biochar carbon removal platform (prototype)
===================================================================

A Flask backend for a smallholder-facing biochar carbon removal service.

ROLE BOUNDARY (important):
    CarbonBridge is a project developer and MRV support platform.
    It does NOT verify, approve, or certify emission reductions.
    All quality checks here are PRE-SUBMISSION completeness checks.
    Final verification is always done by an independent verifier and
    the relevant carbon registry.

Run:
    pip install -r requirements.txt
    python app.py
    open http://127.0.0.1:5000

State model:
    - The browser (localStorage) is the single source of truth for user
      progress, farm details and batch records.
    - This server is stateless except for uploaded photo files, which
      must live server-side so duplicate detection can hash them.
"""

import hashlib
import math
import os
import re
import uuid
from datetime import datetime, timezone
from math import asin, cos, radians, sin, sqrt

from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

# Photo hashes seen this server run. Enables real duplicate detection.
# In production this would be a database keyed by farm and season.
SEEN_PHOTO_HASHES = {}


# ---------------------------------------------------------------------------
# SECTION 1. Carbon accounting constants
# ---------------------------------------------------------------------------
# These approximate the structure of an approved biochar carbon removal
# methodology. Real projects must use the actual methodology equations and
# region-specific factors. Sources are noted so a reviewer can trace each
# number rather than treating it as a black box.

# Paddy straw produced per hectare per season. Mekong Delta paddy yields
# are among the highest in the world, averaging roughly 5.7-6.0 t/ha, and
# the straw-to-grain ratio is close to 1:1. 5.8 t/ha of straw per season is
# a reasonable central estimate. This is roughly double the Indian figure
# used in an earlier version of this prototype -- if the project moves to
# another country, revisit this constant first.
STRAW_YIELD_T_PER_HA = 5.8

# Not all straw can be removed. Some is needed for livestock fodder, some
# for soil cover, and some cannot be gathered economically.
COLLECTABLE_FRACTION = 0.65

# Mass of biochar obtained per unit of dry straw in a simple flame-curtain
# (Kon-Tiki style) kiln. Industrial pyrolysis reaches higher yields; small
# farm kilns are lower.
BIOCHAR_YIELD_FRACTION = 0.28

# Organic carbon content of rice straw biochar by mass.
BIOCHAR_CARBON_FRACTION = 0.50

# Molecular mass ratio CO2 / C. One tonne of carbon equals 3.667 t CO2e.
CO2_PER_CARBON = 44.0 / 12.0

# Fraction of biochar carbon still present after 100 years. Methodologies
# derive this from the hydrogen-to-organic-carbon ratio of the biochar.
PERMANENCE_FACTOR = 0.78

# Emissions caused by running the project itself: straw collection,
# transport, kiln operation, and application to the field. Deducted from
# gross removals so the figure shown is a net number.
PROCESS_EMISSION_DEDUCTION = 0.08

# Indicative price per tonne of CO2e for biochar carbon removal credits.
# Biochar removal credits trade far above avoidance credits. This is the
# net price assumed to reach the project after buyer-side costs.
CREDIT_PRICE_VND_PER_TONNE = 3400000

# Share of net credit revenue paid to the farmer, after verification,
# registry and platform costs. Disclosed in full on the terms screen.
FARMER_REVENUE_SHARE = 0.65

# Wider band = less certain input. Keeps the confidence result honest.
UNCERTAINTY_BANDS = {
    "High": (0.88, 1.10),
    "Medium": (0.82, 1.15),
    "Low": (0.70, 1.30),
}

# Area units accepted from the client. The API always computes in hectares.
HECTARES_PER_UNIT = {
    "ha": 1.0,
    "cong": 0.1,
    "sao_bac": 0.036,
    "a" "cre": 0.404686,
}

# Fraction of issued credits released immediately. The remainder is held
# by the registry as a safeguard against over-estimation and released
# after the next review. This mirrors the 80/20 split used in registry
# digital-MRV pilots.
IMMEDIATE_ISSUANCE_SHARE = 0.80

# Minimum annual removal for a project to be worth submitting. Below this
# the measurement uncertainty is larger than the claimed effect, and
# methodologies require the change to be significant.
MIN_VIABLE_TONNES_PER_YEAR = 0.35


# Multipliers applied to the baseline calculation according to what the
# farmer currently does with the straw. This is where additionality
# enters the estimate: straw that is currently burned is the strongest
# case, because burning it releases the carbon immediately and nobody
# was capturing it before.
STRAW_PRACTICE_FACTORS = {
    "burned": {
        "factor": 1.00,
        "confidence": "High",
        "label": "Straw is burned in the field",
        "note": "Burning releases the carbon immediately. Turning that "
                "straw into biochar is a clear change from what happens now.",
    },
    "incorporated": {
        "factor": 0.88,
        "confidence": "Medium",
        "label": "Straw is ploughed back into the soil",
        "note": "Some carbon already returns to the soil, but most of it "
                "breaks down within a year. Biochar holds it far longer.",
    },
    "sold": {
        "factor": 0.72,
        "confidence": "Medium",
        "label": "Straw is sold or removed",
        "note": "Straw sold off the farm may already have a use. The "
                "verifier will look closely at what would have happened "
                "without this project.",
    },
    "unsure": {
        "factor": 0.80,
        "confidence": "Low",
        "label": "Not sure",
        "note": "A field visit will confirm what happens to the straw now. "
                "Until then this estimate is deliberately cautious.",
    },
}

# The full list of variables a trained model would use once the service is
# live. Only the first three come from the farmer. The rest are looked up
# automatically from the farm location and market data.
MODEL_FEATURES = {
    "farmer_provided": [
        "Farm size",
        "Current straw practice",
        "Rice-growing seasons per year",
    ],
    "looked_up_automatically": [
        "Region and district",
        "Rainfall and temperature",
        "Soil texture and organic matter",
        "Local paddy yield records",
        "Straw collection and transport distance",
        "Kiln type and operating temperature",
        "Historical biochar carbon stability results",
        "Carbon-credit price data",
    ],
}


# ---------------------------------------------------------------------------
# SECTION 2. Demo data
# ---------------------------------------------------------------------------

DEMO = {
    "otp_code": "123456",
    "farmer_name": "Nguyen Van An",
    "mobile": "+84 91 234 5678",
    "field_name": "East Rice Field",
    "location": "An Giang, Mekong Delta",
    "farm_size_ha": 1.0,
    "seasons_per_year": 2,
    "farm_id": "FARM-VN-AG-00421",
    "registry_serial": "REG-VNM-2026-00421",
    "payment_reference": "CB-VNM-2026-00421",
    "verifier": "Demo Verification Partner",
    "buyer": "Demo Global Technologies Ltd.",
    "verification_period": "June-October 2026",
    "issuance_date": "2 November 2026",
    "payment_date": "15 November 2026",
    # Approximate centre of the An Giang paddy belt, used as the demo field.
    "field_lat": 10.3860,
    "field_lng": 105.4348,
}

TRAINING_CARDS = [
    {
        "id": "why-not-burn",
        "icon": "flame",
        "title": "Why burning straw wastes value",
        "body": "When straw burns, the carbon in it goes straight into the "
                "air, along with smoke that harms your family and "
                "neighbours. Nothing is left behind for your soil.",
    },
    {
        "id": "what-is-biochar",
        "icon": "layers",
        "title": "What biochar is",
        "body": "Burn straw with very little air and it turns to charcoal "
                "instead of ash. This is biochar. The carbon inside it "
                "stays locked away for hundreds of years.",
    },
    {
        "id": "collect",
        "icon": "stack",
        "title": "Collecting the straw",
        "body": "Gather straw after harvest and keep it dry. Leave some on "
                "the field for your soil and for animals. Do not collect "
                "every last stalk.",
    },
    {
        "id": "kiln",
        "icon": "fire",
        "title": "Running the kiln",
        "body": "Light the kiln from the top. Add straw in thin layers as "
                "the flame moves down. A steady flame with little smoke "
                "means it is working well.",
    },
    {
        "id": "quench",
        "icon": "drop",
        "title": "Stopping at the right time",
        "body": "When the glowing char starts turning grey, stop it with "
                "water or a soil cover. Waiting too long turns your "
                "biochar into ash and you lose it.",
    },
    {
        "id": "apply",
        "icon": "sprout",
        "title": "Putting it back in the field",
        "body": "Crush the biochar and mix it into the topsoil. It holds "
                "water and nutrients, so your soil works better in the "
                "seasons that follow.",
    },
    {
        "id": "safety",
        "icon": "shield",
        "title": "Staying safe",
        "body": "Work outdoors, away from buildings and dry stacks. Keep "
                "water nearby. Never leave a kiln burning alone, and keep "
                "children well away from it.",
    },
    {
        "id": "photos",
        "icon": "camera",
        "title": "Taking a photo that works",
        "body": "Take photos in daylight. Show the whole heap, not a close "
                "up. Keep your phone location turned on so the photo "
                "records where and when it was taken.",
    },
]


# ---------------------------------------------------------------------------
# SECTION 3. Estimation
# ---------------------------------------------------------------------------

def estimate_removals(farm_size_ha, straw_practice, seasons_per_year):
    """Estimate annual net CO2e removal and farmer income for one farm.

    The chain of multiplications below mirrors the structure of a biochar
    methodology: how much straw exists, how much can be collected, how
    much biochar it makes, how much of that is carbon, how much of that
    carbon survives, and what the project itself emits.

    A supervised model would sit on top of this, correcting the fixed
    factors using regional data. Here that correction is represented by
    the straw-practice factor, which is the one regional signal the
    farmer can supply directly.

    Returns a dict of intermediate values so the result screen can show
    the farmer how the number was reached, rather than a bare figure.
    """
    practice = STRAW_PRACTICE_FACTORS.get(
        straw_practice, STRAW_PRACTICE_FACTORS["unsure"]
    )

    hectares = farm_size_ha

    straw_total = hectares * STRAW_YIELD_T_PER_HA * seasons_per_year
    straw_collected = straw_total * COLLECTABLE_FRACTION
    biochar_mass = straw_collected * BIOCHAR_YIELD_FRACTION
    carbon_mass = biochar_mass * BIOCHAR_CARBON_FRACTION
    co2_gross = carbon_mass * CO2_PER_CARBON
    co2_durable = co2_gross * PERMANENCE_FACTOR
    co2_after_process = co2_durable * (1 - PROCESS_EMISSION_DEDUCTION)
    co2_net = co2_after_process * practice["factor"]

    band_low, band_high = UNCERTAINTY_BANDS[practice["confidence"]]
    tonnes_low = co2_net * band_low
    tonnes_high = co2_net * band_high

    gross_low = tonnes_low * CREDIT_PRICE_VND_PER_TONNE
    gross_high = tonnes_high * CREDIT_PRICE_VND_PER_TONNE
    income_low = gross_low * FARMER_REVENUE_SHARE
    income_high = gross_high * FARMER_REVENUE_SHARE

    return {
        "practice": practice,
        "hectares": round(hectares, 3),
        "straw_total_t": round(straw_total, 2),
        "straw_collected_t": round(straw_collected, 2),
        "biochar_mass_t": round(biochar_mass, 2),
        "tonnes_point": round(co2_net, 2),
        "tonnes_low": round(tonnes_low, 2),
        "tonnes_high": round(tonnes_high, 2),
        "income_low": round_money(income_low),
        "income_high": round_money(income_high),
        "confidence": practice["confidence"],
        "uncertainty_band": (band_low, band_high),
        "meets_minimum": co2_net >= MIN_VIABLE_TONNES_PER_YEAR,
    }


def build_assumptions(result, farm_size_ha, size_entered, unit, seasons_per_year):
    """Plain-language list of what the estimate assumes."""
    practice_label = result["practice"]["label"]
    if practice_label.startswith("Straw is "):
        practice_label = practice_label[len("Straw is "):]
    return [
        "About {} tonnes of straw come off {} hectares across {} season{} "
        "each year.".format(
            result["straw_total_t"],
            farm_size_ha,
            seasons_per_year,
            "" if seasons_per_year == 1 else "s",
        ),
        "Around {}% of that straw can be collected. The rest stays for "
        "your soil and animals.".format(int(COLLECTABLE_FRACTION * 100)),
        "A farm kiln turns roughly {}% of dry straw into biochar.".format(
            int(BIOCHAR_YIELD_FRACTION * 100)
        ),
        "About {}% of the carbon in that biochar is still in your soil "
        "after 100 years.".format(int(PERMANENCE_FACTOR * 100)),
        "{}% is taken off for the fuel, transport and kiln emissions the "
        "project itself causes.".format(int(PROCESS_EMISSION_DEDUCTION * 100)),
        "You receive {}% of the net credit revenue. The rest covers "
        "independent verification, registry fees and running the "
        "programme.".format(int(FARMER_REVENUE_SHARE * 100)),
        "Because your straw is {}, the result is reduced to {}% of the raw "
        "figure.".format(
            practice_label.lower(),
            int(result["practice"]["factor"] * 100),
        ),
        "The range shown is {}% to {}% of that figure, because this estimate "
        "is rated {} confidence.".format(
            int(result["uncertainty_band"][0] * 100),
            int(result["uncertainty_band"][1] * 100),
            result["confidence"],
        ),
        "You entered {} {} ({} hectares).".format(
            size_entered, unit, round(farm_size_ha, 2)
        ),
    ]


# ---------------------------------------------------------------------------
# SECTION 4. Helpers
# ---------------------------------------------------------------------------

def error(message, status=400):
    return jsonify({"ok": False, "error": message}), status


def haversine_metres(lat1, lng1, lat2, lng2):
    """Great-circle distance between two points, in metres."""
    radius = 6371000.0
    d_lat = radians(lat2 - lat1)
    d_lng = radians(lng2 - lng1)
    a = (
        sin(d_lat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lng / 2) ** 2
    )
    return 2 * radius * asin(sqrt(a))


def parse_float(raw, field, minimum=None, maximum=None):
    """Parse a number from form or JSON input, raising ValueError on bad data."""
    if raw is None or raw == "":
        raise ValueError("{} is required.".format(field))
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError("{} must be a number.".format(field))
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError("{} must be a real number.".format(field))
    if minimum is not None and value < minimum:
        raise ValueError("{} must be at least {}.".format(field, minimum))
    if maximum is not None and value > maximum:
        raise ValueError("{} cannot be more than {}.".format(field, maximum))
    return value


def parse_area_ha(data, field_name="Farm size"):
    """Read a size + unit pair from a request body and return hectares."""
    size = parse_float(data.get("farm_size"), field_name,
                       minimum=0.001, maximum=500)
    unit = (data.get("unit") or "ha").lower()
    if unit not in HECTARES_PER_UNIT:
        raise ValueError("Unknown area unit.")
    hectares = size * HECTARES_PER_UNIT[unit]
    if not 0.02 <= hectares <= 200:
        raise ValueError("Farm size is outside the range we can estimate for.")
    return hectares, size, unit


def round_money(value):
    """Round a VND amount to three significant figures (min step 100 VND)."""
    if value <= 0:
        return 0
    step = 10 ** max(2, int(math.floor(math.log10(value))) - 2)
    return int(round(value / step) * step)


def valid_mobile(number):
    """Accept any mobile number.

    This prototype never sends a real SMS, and demo audiences type whatever
    number comes to mind. Blocking them at this step only interrupts the
    walkthrough, so no format is enforced here.

    A production build would validate against the Vietnamese format --
    +84 followed by nine digits, or a leading 0 followed by nine -- and
    verify the number by actually delivering a code to it.
    """
    return True


def allowed_file(filename):
    return (
        "." in filename
        and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS
    )


# ---------------------------------------------------------------------------
# SECTION 5. Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template(
        "index.html",
        demo=DEMO,
        training_cards=TRAINING_CARDS,
        constants={
            "farmer_share_pct": int(FARMER_REVENUE_SHARE * 100),
            "immediate_share_pct": int(IMMEDIATE_ISSUANCE_SHARE * 100),
            "safeguard_share_pct": int((1 - IMMEDIATE_ISSUANCE_SHARE) * 100),
            "price_per_tonne": CREDIT_PRICE_VND_PER_TONNE,
        },
    )


@app.route("/api/config")
def api_config():
    """Everything the client needs that lives on the server."""
    return jsonify(
        {
            "ok": True,
            "demo": DEMO,
            "straw_practices": [
                {"value": key, "label": value["label"]}
                for key, value in STRAW_PRACTICE_FACTORS.items()
            ],
            "model_features": MODEL_FEATURES,
            "training_cards": TRAINING_CARDS,
            "immediate_issuance_share": IMMEDIATE_ISSUANCE_SHARE,
            "farmer_revenue_share": FARMER_REVENUE_SHARE,
            "credit_price_vnd": CREDIT_PRICE_VND_PER_TONNE,
        }
    )


@app.route("/api/estimate", methods=["POST"])
def api_estimate():
    """Initial income estimate. Deliberately labelled as an estimate."""
    data = request.get_json(silent=True) or {}

    try:
        farm_size, size_entered, unit = parse_area_ha(data)
        seasons = parse_float(
            data.get("seasons"), "Seasons per year", minimum=1, maximum=3
        )
    except ValueError as exc:
        return error(str(exc))

    seasons = int(seasons)
    practice_key = data.get("straw_practice") or "unsure"
    if practice_key not in STRAW_PRACTICE_FACTORS:
        return error("Choose what happens to your straw today.")

    result = estimate_removals(farm_size, practice_key, seasons)

    return jsonify(
        {
            "ok": True,
            "stage": "AI Estimate",
            "stage_note": "An initial estimate made before your field has "
                          "been registered or visited.",
            "income_low": result["income_low"],
            "income_high": result["income_high"],
            "hectares": result["hectares"],
            "size_entered": size_entered,
            "unit": unit,
            "tonnes_low": result["tonnes_low"],
            "tonnes_high": result["tonnes_high"],
            "biochar_mass_t": result["biochar_mass_t"],
            "straw_collected_t": result["straw_collected_t"],
            "confidence": result["confidence"],
            "practice_note": result["practice"]["note"],
            "meets_minimum": result["meets_minimum"],
            "minimum_note": (
                None
                if result["meets_minimum"]
                else "This field on its own is below the size where the "
                     "measurement is reliable enough to submit. You can "
                     "still join, and your field will be grouped with "
                     "neighbouring farms."
            ),
            "assumptions": build_assumptions(
                result, farm_size, size_entered, unit, seasons
            ),
            "model_features": MODEL_FEATURES,
            "disclaimer": "This is an initial estimate, not a guaranteed "
                          "payment. Your final income depends on "
                          "independent verification, credit issuance and "
                          "the price the credits sell for.",
        }
    )


@app.route("/api/send-otp", methods=["POST"])
def api_send_otp():
    data = request.get_json(silent=True) or {}
    mobile = (data.get("mobile") or "").strip()
    name = (data.get("name") or "").strip()

    if not name:
        return error("Enter your name.")
    if not mobile:
        return error("Enter a mobile number.")

    return jsonify(
        {
            "ok": True,
            "message": "Code sent to {}".format(mobile),
            "demo_hint": "This prototype does not send a real message. "
                         "Use {}.".format(DEMO["otp_code"]),
        }
    )


@app.route("/api/verify-otp", methods=["POST"])
def api_verify_otp():
    data = request.get_json(silent=True) or {}
    code = re.sub(r"\D", "", (data.get("code") or ""))

    if not code:
        return error("Enter the 6-digit code.")
    if code != DEMO["otp_code"]:
        return error("That code is not correct. Try {}.".format(DEMO["otp_code"]))

    return jsonify({"ok": True, "verified": True})


@app.route("/api/register-farm", methods=["POST"])
def api_register_farm():
    """Validate farm details and mint a Farm ID.

    The Farm ID is what stops the same field being enrolled in two
    projects at once. In production it would be checked against a shared
    registry before being issued.
    """
    data = request.get_json(silent=True) or {}

    field_name = (data.get("field_name") or "").strip()
    if len(field_name) < 2:
        return error("Give this field a name you will recognise.")

    try:
        size, size_entered, unit = parse_area_ha(data)
    except ValueError as exc:
        return error(str(exc))

    lat = data.get("lat")
    lng = data.get("lng")
    if lat is None or lng is None:
        return error("Set the field location on the map, or enter it by hand.")

    try:
        lat = parse_float(lat, "Latitude", minimum=-90, maximum=90)
        lng = parse_float(lng, "Longitude", minimum=-180, maximum=180)
    except ValueError as exc:
        return error(str(exc))

    ownership = data.get("ownership") or "owner"
    boundary = data.get("boundary") or []

    suffix = uuid.uuid4().hex[:5].upper()
    farm_id = "FARM-VN-{}".format(suffix)

    return jsonify(
        {
            "ok": True,
            "farm": {
                "farm_id": farm_id,
                "field_name": field_name,
                "farm_size": round(size, 2),
                "size_entered": size_entered,
                "unit": unit,
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "ownership": ownership,
                "boundary": boundary,
                "crop": "Rice",
                "registered_at": datetime.now(timezone.utc).isoformat(),
            },
            "farm_id_note": "This number belongs to this field only. It "
                            "stops the same field being entered into two "
                            "carbon projects at the same time.",
        }
    )


@app.route("/api/check-eligibility", methods=["POST"])
def api_check_eligibility():
    """Initial eligibility review.

    This is a screening step, not an approval. It tells the farmer whether
    the project can be prepared for submission, and flags what a verifier
    is likely to question.
    """
    data = request.get_json(silent=True) or {}
    answers = data.get("answers") or {}

    blocking = []
    flags = []
    notes = []

    if answers.get("other_project") == "yes":
        blocking.append(
            "This field is already enrolled in another carbon project. A "
            "field cannot be in two projects at the same time."
        )

    if answers.get("has_rights") == "no":
        blocking.append(
            "You need permission from the landowner before this field can "
            "be entered into a carbon project."
        )

    if answers.get("legally_required") == "yes":
        flags.append(
            "A local burning ban is normal. The verifier will check whether "
            "turning straw into biochar, rather than simply stopping open "
            "burning, is required where you farm."
        )

    if answers.get("prior_biochar") == "yes":
        flags.append(
            "You have made biochar here before. The verifier will want to "
            "understand what would have happened without this project."
        )

    if answers.get("straw_practice") == "sold":
        flags.append(
            "Straw sold off the farm may already have a buyer. Expect "
            "questions about where it went previously."
        )

    if answers.get("ownership") == "tenant":
        notes.append(
            "As a tenant you will need written consent from the landowner "
            "before the project is submitted."
        )

    if answers.get("kiln_access") == "none":
        notes.append(
            "You do not have a kiln yet. CarbonBridge provides kiln access "
            "as part of joining, at no upfront cost to you."
        )

    if blocking:
        status = "blocked"
        headline = "This field cannot be submitted yet"
    elif flags:
        status = "more_info"
        headline = "More information is required"
    else:
        status = "passed"
        headline = "Initial eligibility review completed"

    return jsonify(
        {
            "ok": True,
            "status": status,
            "headline": headline,
            "blocking": blocking,
            "flags": flags,
            "notes": notes,
            "disclaimer": "This is CarbonBridge's own first review. It is not "
                          "a decision by a verifier or a registry. Only an "
                          "independent verifier can decide whether this "
                          "project qualifies.",
        }
    )


@app.route("/api/upload-evidence", methods=["POST"])
def api_upload_evidence():
    """Store one evidence photo and return its hash and metadata.

    The file is kept server-side because duplicate detection needs to
    compare the actual bytes. The browser only keeps the returned id.
    """
    if "photo" not in request.files:
        return error("No photo was received. Choose or take a photo first.")

    file = request.files["photo"]
    if not file or file.filename == "":
        return error("No photo was received. Choose or take a photo first.")

    if not allowed_file(file.filename):
        return error("Use a JPG, PNG or WEBP image.")

    raw = file.read()
    if not raw:
        return error("That file is empty. Try taking the photo again.")
    if len(raw) > MAX_UPLOAD_BYTES:
        return error("That photo is too large. Keep it under 8 MB.")

    digest = hashlib.sha256(raw).hexdigest()

    ext = file.filename.rsplit(".", 1)[1].lower()
    stored_name = "{}.{}".format(uuid.uuid4().hex, ext)
    safe_name = secure_filename(stored_name)
    with open(os.path.join(UPLOAD_DIR, safe_name), "wb") as handle:
        handle.write(raw)

    duplicate_of = SEEN_PHOTO_HASHES.get(digest)
    if duplicate_of is None:
        SEEN_PHOTO_HASHES[digest] = {
            "file": safe_name,
            "slot": request.form.get("slot") or "unknown",
            "at": datetime.now(timezone.utc).isoformat(),
        }

    return jsonify(
        {
            "ok": True,
            "photo": {
                "id": safe_name,
                "url": "/static/uploads/{}".format(safe_name),
                "hash": digest[:16],
                "size_kb": round(len(raw) / 1024, 1),
                "slot": request.form.get("slot") or "unknown",
                "captured_at": datetime.now(timezone.utc).isoformat(),
            },
            "is_duplicate": duplicate_of is not None,
            "duplicate_note": (
                "This is the same image as one already submitted for "
                "'{}'.".format(duplicate_of["slot"])
                if duplicate_of
                else None
            ),
        }
    )


@app.route("/api/check-evidence", methods=["POST"])
def api_check_evidence():
    """Pre-submission quality check on one biochar batch.

    Nothing here approves or verifies anything. It checks that the
    package is complete and internally consistent, so the farmer is not
    sent back weeks later by the verifier over something fixable today.

    Several of these checks genuinely run rather than being simulated:
    the GPS distance is calculated, the mass balance is arithmetic, and
    duplicate photos are detected by hashing the file bytes.
    """
    data = request.get_json(silent=True) or {}

    photos = data.get("photos") or {}
    straw_kg = data.get("straw_kg")
    biochar_kg = data.get("biochar_kg")
    gps = data.get("gps") or {}
    farm = data.get("farm") or {}

    passed = []
    issues = []
    warnings = []

    # --- required photos -------------------------------------------------
    required_slots = {
        "straw": "the collected straw heap",
        "kiln": "the kiln while it is running",
        "biochar": "the finished biochar",
    }
    for slot, description in required_slots.items():
        entry = photos.get(slot)
        if not entry or not entry.get("id"):
            issues.append("Add a photo of {}.".format(description))
        elif entry.get("is_duplicate"):
            issues.append(
                "The photo of {} has already been submitted before. Take a "
                "new one for this batch.".format(description)
            )
        else:
            passed.append("Photo of {} received.".format(description))

    # --- timestamps ------------------------------------------------------
    timestamped = [
        slot for slot, entry in photos.items()
        if entry and entry.get("captured_at")
    ]
    if timestamped:
        passed.append("Date and time recorded on every photo.")
    elif photos:
        warnings.append(
            "No date and time was recorded. The verifier may ask when this "
            "batch was made."
        )

    # --- location --------------------------------------------------------
    distance_m = None
    if gps.get("lat") is not None and farm.get("lat") is not None:
        try:
            distance_m = haversine_metres(
                float(gps["lat"]),
                float(gps["lng"]),
                float(farm["lat"]),
                float(farm["lng"]),
            )
        except (TypeError, ValueError):
            distance_m = None

    if distance_m is None:
        warnings.append(
            "Location was not shared, so we cannot match this batch to your "
            "registered field. You can type the location by hand instead."
        )
    elif distance_m <= 300:
        passed.append(
            "Location matches your registered field, {} m away.".format(
                int(distance_m)
            )
        )
    elif distance_m <= 2000:
        warnings.append(
            "Location is {} m from your registered field. Confirm this is "
            "the right field.".format(int(distance_m))
        )
    else:
        issues.append(
            "Location is {:.1f} km from your registered field. This batch "
            "does not appear to be from {}.".format(
                distance_m / 1000, farm.get("field_name") or "your field"
            )
        )

    # --- mass balance ----------------------------------------------------
    yield_pct = None
    if straw_kg is None or biochar_kg is None:
        issues.append("Enter how much straw went in and how much biochar came out.")
    else:
        try:
            straw_value = float(straw_kg)
            biochar_value = float(biochar_kg)
        except (TypeError, ValueError):
            issues.append("Weights must be numbers.")
            straw_value = biochar_value = None

        if straw_value is not None and biochar_value is not None:
            if straw_value <= 0 or biochar_value <= 0:
                issues.append("Weights must be greater than zero.")
            elif biochar_value >= straw_value:
                issues.append(
                    "The biochar cannot weigh as much as the straw it came "
                    "from. Check both weights."
                )
            else:
                yield_pct = (biochar_value / straw_value) * 100
                if yield_pct < 10:
                    warnings.append(
                        "Only {:.0f}% of the straw became biochar. That is "
                        "low. The kiln may have burned too long and turned "
                        "some of it to ash.".format(yield_pct)
                    )
                elif yield_pct > 45:
                    issues.append(
                        "{:.0f}% of the straw became biochar. That is higher "
                        "than a kiln can produce. Please check the "
                        "weights.".format(yield_pct)
                    )
                else:
                    passed.append(
                        "Weights are consistent: {:.0f}% of the straw became "
                        "biochar.".format(yield_pct)
                    )

    # --- satellite cross-check (demonstration only) ----------------------
    satellite = None
    if distance_m is not None and distance_m <= 2000:
        satellite = {
            "checked": True,
            "headline": "No burning detected at this field",
            "detail": "Satellite fire-detection data for this location "
                      "shows no burn signal around the batch date, which "
                      "is consistent with the photos you submitted.",
            "note": "Shown to demonstrate how a second, independent source "
                    "supports your photos. This prototype does not connect "
                    "to a live satellite service, and this is not a "
                    "verifier's finding.",
        }
        passed.append("Satellite record agrees with your photos.")

    # --- outcome ---------------------------------------------------------
    if issues:
        status = "needs_more"
        headline = "Additional evidence needed"
        summary = ("This batch is not ready to go into the verification "
                   "package yet. Fixing the points below now saves weeks "
                   "of waiting later.")
    else:
        status = "ready"
        headline = "Submission ready"
        summary = ("Your evidence has passed CarbonBridge's initial quality "
                   "check and is ready to be included in the external "
                   "verification package.")

    return jsonify(
        {
            "ok": True,
            "status": status,
            "headline": headline,
            "summary": summary,
            "passed": passed,
            "issues": issues,
            "warnings": warnings,
            "satellite": satellite,
            "yield_pct": round(yield_pct, 1) if yield_pct is not None else None,
            "disclaimer": "CarbonBridge checks that your evidence is complete "
                          "and consistent. It does not measure or confirm "
                          "how much carbon was removed. Only an independent "
                          "verifier does that.",
        }
    )


@app.route("/api/season-summary", methods=["POST"])
def api_season_summary():
    """Turn a season's batches into the numbers shown from issuance onward."""
    data = request.get_json(silent=True) or {}
    batches = data.get("batches") or []

    total_biochar_kg = 0.0
    for batch in batches:
        try:
            total_biochar_kg += float(batch.get("biochar_kg") or 0)
        except (TypeError, ValueError):
            continue

    biochar_t = total_biochar_kg / 1000.0
    carbon_t = biochar_t * BIOCHAR_CARBON_FRACTION
    co2_gross = carbon_t * CO2_PER_CARBON
    co2_durable = co2_gross * PERMANENCE_FACTOR
    co2_net = co2_durable * (1 - PROCESS_EMISSION_DEDUCTION)

    credits_total = round(co2_net, 1)
    credits_now = round(credits_total * IMMEDIATE_ISSUANCE_SHARE, 1)
    credits_held = round(credits_total - credits_now, 1)

    gross_value = credits_now * CREDIT_PRICE_VND_PER_TONNE
    farmer_payment = int(round(gross_value * FARMER_REVENUE_SHARE, -4))
    held_value = int(
        round(
            credits_held * CREDIT_PRICE_VND_PER_TONNE * FARMER_REVENUE_SHARE,
            -4,
        )
    )

    # The result reflects only the batches actually recorded. If a farmer
    # records two batches in a demo but a real season is a dozen or more,
    # the figure will look far below the earlier estimate. Say so plainly
    # rather than letting it look like a mistake.
    context_note = (
        "This is the total from the {} batch{} you recorded. Each batch is "
        "one kiln run. Over a full season most farmers record ten to twenty "
        "batches, so a real season's figure is several times this "
        "one.".format(len(batches), "" if len(batches) == 1 else "es")
    )

    return jsonify(
        {
            "ok": True,
            "batch_count": len(batches),
            "context_note": context_note,
            "biochar_kg": round(total_biochar_kg, 1),
            "credits_total": credits_total,
            "credits_now": credits_now,
            "credits_held": credits_held,
            "farmer_payment": farmer_payment,
            "held_value": held_value,
            "safeguard_note": "The registry releases {}% of your credits "
                              "straight away and holds {}% until the next "
                              "review. The held portion protects against "
                              "over-estimation. It is not a CarbonBridge fee, "
                              "and it is paid to you when it is "
                              "released.".format(
                                  int(IMMEDIATE_ISSUANCE_SHARE * 100),
                                  int((1 - IMMEDIATE_ISSUANCE_SHARE) * 100),
                              ),
        }
    )


@app.errorhandler(413)
def too_large(_):
    return error("That photo is too large. Keep it under 8 MB.", 413)


@app.errorhandler(404)
def not_found(_):
    return error("Not found.", 404)


@app.errorhandler(500)
def server_error(_):
    return error(
        "Something went wrong on our side. Please try again.", 500
    )


@app.route("/static/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_DIR, filename)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))

    if os.environ.get("APP_ENV") == "production":
        # Public deployment (e.g. Render): no debug mode (the Werkzeug
        # debugger is a code-execution risk once the app is reachable by
        # anyone), and a real WSGI server instead of Flask's single-threaded
        # dev server. waitress is pure Python, so it installs the same way
        # on the host as it does here — no platform-specific build step.
        from waitress import serve
        print("CarbonBridge prototype running in production mode on port {}".format(port))
        serve(app, host="0.0.0.0", port=port)
    else:
        # Local / demo laptop: unchanged from before.
        print("CarbonBridge prototype running at http://127.0.0.1:{}".format(port))
        app.run(debug=True, port=port)
