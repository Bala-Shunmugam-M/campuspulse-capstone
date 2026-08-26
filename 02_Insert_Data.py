"""
02_Insert_Data.py
=================
Generates and bulk-loads a realistic synthetic dataset into the CampusPulse
schema using psycopg2's `execute_values` batch inserter.

This is the "data generating" half of the capstone. The goal is not merely to
fill tables -- it is to produce data whose *statistical shape* mirrors how a
real campus maintenance system behaves, so that the analytics in
04_Analytics_Queries.py return findings that actually mean something.

Realism modelled here
---------------------
  * Report -> Incident aggregation. Incidents are generated first (they are the
    real-world problems); each then attracts 1..5 independent user reports.
    Every report after the first is flagged `is_duplicate` -- exactly the
    de-duplication scenario the UML calls for.
  * Temporal texture. Submissions are weighted by day-of-week (quiet Sundays),
    hour-of-day (two peaks, mid-morning and mid-afternoon), academic calendar
    (semester peaks, summer-break trough) and an adoption ramp, so the platform
    looks like it was gradually rolled out.
  * Lifecycle coherence. Incident timestamps obey the state machine the CHECK
    constraints enforce, and resolution time is drawn from a log-normal-ish
    distribution keyed to priority -- fast for critical, long-tailed for low.
  * Deliberate SLA breaches. Roughly one in five resolved incidents misses its
    category SLA, so the compliance report is not a uniform wall of 100%.
  * Hot spots. A minority of locations and assets are made deliberately
    failure-prone, so the heatmap has genuine signal rather than uniform noise.

Reproducibility
---------------
Every random draw -- including UUIDs -- comes from a single seeded generator.
Running twice with the same RANDOM_SEED produces a byte-identical dataset.

Usage
-----
    python 02_Insert_Data.py                  # uses DATA_SCALE from .env
    python 02_Insert_Data.py --scale small    # override the preset
    python 02_Insert_Data.py --scale large --yes
    python 02_Insert_Data.py --truncate-only  # wipe rows, keep the schema
"""

from __future__ import annotations

import argparse
import math
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from faker import Faker
from psycopg2.extras import execute_values

import os
import random

from db_config import (
    SCHEMA,
    banner,
    describe_target,
    fail,
    managed_connection,
    ok,
    step,
    warn,
)

RANDOM_SEED = int(os.getenv("RANDOM_SEED", "42"))
HISTORY_MONTHS = int(os.getenv("HISTORY_MONTHS", "18"))
DEFAULT_SCALE = os.getenv("DATA_SCALE", "medium")


# ==========================================================================
# Scale presets
# ==========================================================================
@dataclass(frozen=True)
class Scale:
    name: str
    institutions: int
    users_per_institution: int
    buildings_per_campus: int
    floors_per_building: int
    rooms_per_floor: int
    assets_total: int
    incidents_total: int


SCALES: dict[str, Scale] = {
    "small": Scale("small", 1, 200, 4, 3, 6, 400, 800),
    "medium": Scale("medium", 3, 400, 7, 4, 8, 2500, 3000),
    "large": Scale("large", 5, 1200, 10, 5, 10, 12000, 20000),
}


# ==========================================================================
# Domain vocabulary
# ==========================================================================
INSTITUTION_POOL = [
    ("Amrita Vishwa Vidyapeetham", "AMR", "amrita.edu", "Coimbatore"),
    ("National Institute of Technology Tiruchirappalli", "NITT", "nitt.edu", "Tiruchirappalli"),
    ("Vellore Institute of Technology", "VIT", "vit.ac.in", "Vellore"),
    ("PSG College of Technology", "PSG", "psgtech.ac.in", "Coimbatore"),
    ("SSN College of Engineering", "SSN", "ssn.edu.in", "Chennai"),
]

BUILDING_POOL = [
    ("Main Academic Block", "ACA"),
    ("Central Library", "LIB"),
    ("Boys Hostel", "HSTB"),
    ("Girls Hostel", "HSTG"),
    ("Science Laboratory Complex", "LAB"),
    ("Computer Centre", "CC"),
    ("Administrative Block", "ADM"),
    ("Sports Complex", "SPT"),
    ("Central Canteen", "CAN"),
    ("Auditorium", "AUD"),
]

ROOM_KINDS = [
    ("Classroom", "CR", "room"),
    ("Lecture Hall", "LH", "room"),
    ("Laboratory", "LB", "room"),
    ("Staff Room", "SR", "room"),
    ("Washroom", "WR", "area"),
    ("Corridor", "CD", "area"),
    ("Common Area", "CA", "area"),
    ("Stairwell", "ST", "area"),
]

# issue_category tree: (parent, [(child, priority, sla_hours)])
ISSUE_TAXONOMY: list[tuple[str, list[tuple[str, str, int]]]] = [
    ("Electrical", [
        ("Lighting Failure",     "medium",   24),
        ("Power Outage",         "critical",  4),
        ("Fan / AC Not Working", "high",     12),
        ("Exposed Wiring",       "critical",  4),
    ]),
    ("Plumbing", [
        ("Water Leakage",        "high",     12),
        ("Blocked Drain",        "medium",   24),
        ("Water Dispenser Fault","medium",   24),
        ("Toilet Malfunction",   "high",     12),
    ]),
    ("IT & Network", [
        ("WiFi Connectivity",    "high",     12),
        ("Computer Not Working", "medium",   24),
        ("Projector Fault",      "high",      8),
        ("Printer Issue",        "low",      72),
    ]),
    ("Furniture", [
        ("Broken Chair / Desk",  "low",      72),
        ("Door / Window Damage", "medium",   48),
        ("Whiteboard Damage",    "low",      72),
    ]),
    ("Housekeeping", [
        ("Cleanliness Issue",    "medium",   12),
        ("Waste Not Collected",  "medium",   12),
        ("Pest Sighting",        "high",     24),
    ]),
    ("Safety & Security", [
        ("Fire Equipment Fault", "critical",  4),
        ("CCTV Not Working",     "high",     24),
        ("Lock / Access Issue",  "high",     12),
    ]),
]

# asset_category tree: (parent, [(child, tag_abbrev)])
ASSET_TAXONOMY: list[tuple[str, list[tuple[str, str]]]] = [
    ("Electrical Equipment", [
        ("Light Fixture",     "LF"),
        ("Ceiling Fan",       "CF"),
        ("Air Conditioner",   "AC"),
        ("Power Distribution Board", "PD"),
    ]),
    ("Water Systems", [
        ("Water Dispenser",   "WD"),
        ("Water Purifier",    "WP"),
        ("Wash Basin",        "WB"),
    ]),
    ("IT Equipment", [
        ("Desktop Computer",  "PC"),
        ("Projector",         "PJ"),
        ("Printer",           "PR"),
        ("WiFi Access Point", "AP"),
    ]),
    ("Furniture", [
        ("Student Chair",     "CH"),
        ("Work Desk",         "DK"),
        ("Whiteboard",        "WH"),
        ("Door",              "DR"),
    ]),
    ("Safety Equipment", [
        ("Fire Extinguisher", "FE"),
        ("CCTV Camera",       "CV"),
        ("Emergency Light",   "EL"),
    ]),
]

# Which service team owns which top-level issue category
TEAM_DEFINITIONS = [
    ("Electrical Maintenance", "Electrical",       "Handles wiring, lighting, fans, AC and power distribution."),
    ("Plumbing & Sanitation",  "Plumbing",         "Water supply, drainage, dispensers and washroom fittings."),
    ("IT Support",             "IT & Network",     "Campus network, lab computers, projectors and printers."),
    ("Housekeeping",           "Housekeeping",     "Cleaning, waste management and pest control."),
    ("Carpentry & Civil",      "Furniture",        "Furniture repair, doors, windows and civil works."),
    ("Safety & Security",      "Safety & Security","Fire safety equipment, CCTV and access control."),
]

# Which asset categories a given leaf issue category plausibly concerns
ISSUE_TO_ASSET = {
    "Lighting Failure":       ["Light Fixture", "Emergency Light"],
    "Power Outage":           ["Power Distribution Board"],
    "Fan / AC Not Working":   ["Ceiling Fan", "Air Conditioner"],
    "Exposed Wiring":         ["Power Distribution Board", "Light Fixture"],
    "Water Leakage":          ["Wash Basin", "Water Purifier"],
    "Blocked Drain":          ["Wash Basin"],
    "Water Dispenser Fault":  ["Water Dispenser", "Water Purifier"],
    "Toilet Malfunction":     ["Wash Basin"],
    "WiFi Connectivity":      ["WiFi Access Point"],
    "Computer Not Working":   ["Desktop Computer"],
    "Projector Fault":        ["Projector"],
    "Printer Issue":          ["Printer"],
    "Broken Chair / Desk":    ["Student Chair", "Work Desk"],
    "Door / Window Damage":   ["Door"],
    "Whiteboard Damage":      ["Whiteboard"],
    "Fire Equipment Fault":   ["Fire Extinguisher"],
    "CCTV Not Working":       ["CCTV Camera"],
    "Lock / Access Issue":    ["Door"],
}

# Natural-language report templates, keyed by leaf issue category
REPORT_TEMPLATES = {
    "Lighting Failure": [
        "Two tube lights in {loc} have stopped working since yesterday.",
        "The lights in {loc} keep flickering and it is hard to read.",
        "{loc} is completely dark, the light does not turn on at all.",
    ],
    "Power Outage": [
        "No power in {loc} since this morning. All sockets are dead.",
        "Power went off in {loc} and has not come back for over an hour.",
        "The entire {loc} has lost electricity, class had to be shifted.",
    ],
    "Fan / AC Not Working": [
        "The ceiling fan in {loc} is not rotating even at full speed.",
        "AC in {loc} is blowing warm air only. Room is very hot.",
        "Fan in {loc} is making a loud grinding noise while running.",
    ],
    "Exposed Wiring": [
        "There is an exposed live wire hanging near the entrance of {loc}. Unsafe.",
        "Open wiring visible near the switchboard in {loc}, sparking slightly.",
        "Broken socket in {loc} with wires coming out. Needs urgent attention.",
    ],
    "Water Leakage": [
        "Water is leaking continuously from the ceiling in {loc}.",
        "Pipe near {loc} is leaking, floor is wet and slippery.",
        "Constant dripping from the wall in {loc}, water collecting on the floor.",
    ],
    "Blocked Drain": [
        "The drain in {loc} is blocked and water is overflowing.",
        "Water is not draining out in {loc}, there is a bad smell.",
        "Clogged drainage in {loc} since two days.",
    ],
    "Water Dispenser Fault": [
        "Water dispenser in {loc} is not cooling the water at all.",
        "No water is coming out of the dispenser in {loc}.",
        "The dispenser near {loc} is leaking from the bottom tap.",
    ],
    "Toilet Malfunction": [
        "Flush is not working in the washroom at {loc}.",
        "Tap in {loc} washroom is broken and water is running continuously.",
        "Washroom in {loc} is out of order, door latch is also broken.",
    ],
    "WiFi Connectivity": [
        "No WiFi signal in {loc}, unable to connect since morning.",
        "WiFi in {loc} keeps disconnecting every few minutes.",
        "Internet is extremely slow in {loc}, cannot join online class.",
    ],
    "Computer Not Working": [
        "System in {loc} is not booting up, screen stays blank.",
        "Computer in {loc} keeps restarting on its own during lab session.",
        "Keyboard and mouse of the machine in {loc} are not responding.",
    ],
    "Projector Fault": [
        "Projector in {loc} shows a distorted display with colour patches.",
        "Projector in {loc} is not turning on, lamp indicator is red.",
        "HDMI port of the projector in {loc} is loose, display keeps cutting off.",
    ],
    "Printer Issue": [
        "Printer in {loc} is showing a paper jam error that will not clear.",
        "Print output from {loc} is faded, cartridge may be empty.",
        "Printer in {loc} is not detected on the network.",
    ],
    "Broken Chair / Desk": [
        "Three chairs in {loc} have broken legs and are unusable.",
        "Desk in {loc} is wobbly and the surface is cracked.",
        "Bench in {loc} has a loose bolt, it collapses when someone sits.",
    ],
    "Door / Window Damage": [
        "Window glass in {loc} is cracked and could fall.",
        "Door of {loc} does not close properly, hinge is bent.",
        "Window latch in {loc} is broken so it bangs when it is windy.",
    ],
    "Whiteboard Damage": [
        "Whiteboard in {loc} has a permanent stain, writing is not visible.",
        "Whiteboard in {loc} is coming off the wall on one side.",
        "Board surface in {loc} is scratched badly, marker does not erase.",
    ],
    "Cleanliness Issue": [
        "{loc} has not been cleaned for two days, dust everywhere.",
        "Floor in {loc} is very dirty with spilled food.",
        "{loc} needs cleaning urgently, there is litter all around.",
    ],
    "Waste Not Collected": [
        "Dustbin in {loc} is overflowing and has not been emptied.",
        "Garbage bags are lying outside {loc} since yesterday.",
        "Waste has not been collected from {loc} for three days.",
    ],
    "Pest Sighting": [
        "Cockroaches seen near {loc}, especially in the evening.",
        "Rat sighted inside {loc}, it has chewed through some cables.",
        "Ant infestation around {loc}, please arrange pest control.",
    ],
    "Fire Equipment Fault": [
        "Fire extinguisher near {loc} has an expired inspection date.",
        "Fire extinguisher at {loc} is missing from its mount.",
        "Pressure gauge on the extinguisher near {loc} is in the red zone.",
    ],
    "CCTV Not Working": [
        "CCTV camera covering {loc} appears to be switched off.",
        "The camera near {loc} is hanging loose and pointing at the ceiling.",
        "CCTV at {loc} has no recording since last week.",
    ],
    "Lock / Access Issue": [
        "Door lock of {loc} is jammed, cannot open the room.",
        "Access card reader at {loc} is not reading any card.",
        "{loc} cannot be locked, the latch is broken.",
    ],
}

RESOLUTION_NOTES = [
    "Replaced the faulty component and tested. Working normally.",
    "Cleaned and serviced the unit. Issue no longer reproducible.",
    "Temporary fix applied; permanent replacement scheduled.",
    "Rewired the connection and verified with the reporter.",
    "Part replaced from stock. Verified by the department in-charge.",
    "Escalated to external vendor; work completed and inspected.",
]

FEEDBACK_POSITIVE = [
    "Fixed quickly, thank you.",
    "Very prompt response from the team.",
    "Resolved the same day. Great service.",
    "Technician was polite and did a neat job.",
]
FEEDBACK_NEUTRAL = [
    "Took a while but finally sorted out.",
    "Issue is fixed, though follow-up was slow.",
    "Okay service, could be faster.",
]
FEEDBACK_NEGATIVE = [
    "Took far too long to get any response.",
    "Problem came back within a week.",
    "Had to report it three times before anyone came.",
    "Still not fully fixed properly.",
]

DEPARTMENTS = [
    "Computer Science and Engineering", "Electronics and Communication",
    "Mechanical Engineering", "Electrical and Electronics", "Civil Engineering",
    "Information Technology", "Mathematics", "Physics", "Chemistry",
    "Management Studies", "Biotechnology", "Aerospace Engineering",
]


# ==========================================================================
# Generator
# ==========================================================================
@dataclass
class Generated:
    """In-memory staging area for every row before it is bulk-inserted."""
    institutions: list = field(default_factory=list)
    locations: list = field(default_factory=list)
    categories: list = field(default_factory=list)
    users: list = field(default_factory=list)
    user_roles: list = field(default_factory=list)
    service_teams: list = field(default_factory=list)
    team_members: list = field(default_factory=list)
    assets: list = field(default_factory=list)
    incidents: list = field(default_factory=list)
    reports: list = field(default_factory=list)
    incident_reports: list = field(default_factory=list)
    work_orders: list = field(default_factory=list)
    status_history: list = field(default_factory=list)
    notifications: list = field(default_factory=list)
    attachments: list = field(default_factory=list)
    feedback: list = field(default_factory=list)


class CampusPulseGenerator:
    def __init__(self, scale: Scale, seed: int, history_months: int) -> None:
        self.scale = scale
        self.rng = random.Random(seed)
        self.fake = Faker("en_IN")
        Faker.seed(seed)

        self.now = datetime.now(timezone.utc).replace(microsecond=0)
        self.window_start = self.now - timedelta(days=int(history_months * 30.44))
        self.out = Generated()

        # Per-institution indexes built during generation
        self._rooms: dict[str, list] = {}
        self._issue_leaves: dict[str, list] = {}
        self._asset_leaf_by_name: dict[str, dict[str, str]] = {}
        self._assets_by_leafcat: dict[str, dict[str, list]] = {}
        self._assets_by_location: dict[str, dict[str, list]] = {}
        self._users_by_role: dict[str, dict[str, list]] = {}
        self._team_by_parent: dict[str, dict[str, str]] = {}
        self._members_by_team: dict[str, list] = {}
        self._hot_locations: dict[str, set] = {}

    # ---------------------------------------------------------------- utils
    def uid(self) -> str:
        """Deterministic UUID4 drawn from the seeded RNG (uuid.uuid4() is not seedable)."""
        return str(uuid.UUID(int=self.rng.getrandbits(128), version=4))

    def pick(self, seq):
        return seq[self.rng.randrange(len(seq))]

    def weighted_choice(self, options: list[tuple[object, float]]):
        total = sum(w for _, w in options)
        r = self.rng.random() * total
        upto = 0.0
        for value, weight in options:
            upto += weight
            if r <= upto:
                return value
        return options[-1][0]

    # ------------------------------------------------------- temporal model
    def _activity_weight(self, ts: datetime) -> float:
        """Relative likelihood that a report is filed at this instant."""
        # Day of week: campus is quiet at the weekend.
        dow_weight = [1.00, 1.00, 1.00, 0.98, 0.90, 0.55, 0.28][ts.weekday()]

        # Academic calendar: two teaching semesters, a summer trough.
        month_weight = {
            1: 0.95, 2: 1.00, 3: 1.00, 4: 0.92, 5: 0.45, 6: 0.40,
            7: 0.80, 8: 1.00, 9: 1.00, 10: 1.00, 11: 0.95, 12: 0.55,
        }[ts.month]

        # Adoption ramp: the platform was rolled out gradually.
        progress = (ts - self.window_start) / (self.now - self.window_start)
        adoption = 0.35 + 0.65 * max(0.0, min(1.0, progress))

        return dow_weight * month_weight * adoption

    def _business_hour(self, ts: datetime) -> datetime:
        """Snap a timestamp onto a realistic hour-of-day profile."""
        hour = self.weighted_choice([
            (7, 1.0), (8, 3.0), (9, 6.0), (10, 8.0), (11, 8.0), (12, 5.0),
            (13, 3.0), (14, 7.0), (15, 8.0), (16, 7.0), (17, 5.0), (18, 3.0),
            (19, 2.0), (20, 2.0), (21, 1.5), (22, 0.8), (23, 0.4), (6, 0.4),
        ])
        return ts.replace(
            hour=hour,
            minute=self.rng.randrange(60),
            second=self.rng.randrange(60),
            microsecond=0,
        )

    def random_event_time(self) -> datetime:
        """Rejection-sample a timestamp under the activity weighting."""
        span = (self.now - self.window_start).total_seconds()
        for _ in range(40):
            candidate = self.window_start + timedelta(seconds=self.rng.random() * span)
            if self.rng.random() <= self._activity_weight(candidate):
                return self._business_hour(candidate)
        return self._business_hour(
            self.window_start + timedelta(seconds=self.rng.random() * span)
        )

    # ------------------------------------------------------------ 1. tenants
    def gen_institutions(self) -> None:
        for name, code, domain, city in INSTITUTION_POOL[: self.scale.institutions]:
            iid = self.uid()
            created = self.window_start - timedelta(days=self.rng.randrange(30, 120))
            self.out.institutions.append(
                (iid, name, code, domain, city, "Asia/Kolkata", True, created)
            )
            self._rooms[iid] = []
            self._issue_leaves[iid] = []
            self._asset_leaf_by_name[iid] = {}
            self._assets_by_leafcat[iid] = {}
            self._assets_by_location[iid] = {}
            self._users_by_role[iid] = {"student": [], "faculty": [], "admin": [], "technician": []}
            self._team_by_parent[iid] = {}
            self._hot_locations[iid] = set()

    # ----------------------------------------------------------- 2. locations
    def gen_locations(self) -> None:
        s = self.scale
        for institution in self.out.institutions:
            iid, name, code = institution[0], institution[1], institution[2]
            created = self.window_start - timedelta(days=self.rng.randrange(20, 90))

            campus_id = self.uid()
            self.out.locations.append(
                (campus_id, iid, None, f"{name} Main Campus",
                 "campus", f"{code}-CMP", created)
            )

            buildings = BUILDING_POOL[: s.buildings_per_campus]
            for b_name, b_abbr in buildings:
                b_id = self.uid()
                self.out.locations.append(
                    (b_id, iid, campus_id, b_name, "building",
                     f"{code}-{b_abbr}", created)
                )

                for floor_no in range(s.floors_per_building):
                    f_id = self.uid()
                    floor_label = "Ground Floor" if floor_no == 0 else f"Floor {floor_no}"
                    self.out.locations.append(
                        (f_id, iid, b_id, f"{b_name} - {floor_label}", "floor",
                         f"{code}-{b_abbr}-F{floor_no}", created)
                    )

                    for room_no in range(s.rooms_per_floor):
                        kind_name, kind_abbr, kind_type = self.pick(ROOM_KINDS)
                        r_id = self.uid()
                        room_number = f"{floor_no}{room_no + 1:02d}"
                        r_name = f"{kind_name} {b_abbr}-{room_number}"
                        self.out.locations.append(
                            (r_id, iid, f_id, r_name, kind_type,
                             f"{code}-{b_abbr}-F{floor_no}-{kind_abbr}{room_number}",
                             created)
                        )
                        self._rooms[iid].append((r_id, r_name, b_abbr, floor_no))

            # ~12% of rooms are "problem spots" that generate outsized incidents.
            room_ids = [r[0] for r in self._rooms[iid]]
            hot_count = max(1, int(len(room_ids) * 0.12))
            self._hot_locations[iid] = set(self.rng.sample(room_ids, hot_count))

    # ---------------------------------------------------------- 3. categories
    def gen_categories(self) -> None:
        for inst in self.out.institutions:
            iid = inst[0]
            created = inst[7]

            for parent_name, children in ISSUE_TAXONOMY:
                p_id = self.uid()
                self.out.categories.append(
                    (p_id, iid, None, parent_name, "issue_category", "medium", 48, created)
                )
                for child_name, priority, sla in children:
                    c_id = self.uid()
                    self.out.categories.append(
                        (c_id, iid, p_id, child_name, "issue_category", priority, sla, created)
                    )
                    self._issue_leaves[iid].append(
                        (c_id, child_name, priority, sla, parent_name)
                    )

            for parent_name, children in ASSET_TAXONOMY:
                p_id = self.uid()
                self.out.categories.append(
                    (p_id, iid, None, parent_name, "asset_category", "medium", 48, created)
                )
                for child_name, abbrev in children:
                    c_id = self.uid()
                    self.out.categories.append(
                        (c_id, iid, p_id, child_name, "asset_category", "medium", 48, created)
                    )
                    self._asset_leaf_by_name[iid][child_name] = c_id
                    self._assets_by_leafcat[iid][child_name] = []

    # -------------------------------------------------------------- 4. users
    def gen_users(self) -> None:
        role_mix = [("student", 0.76), ("faculty", 0.13),
                    ("technician", 0.07), ("admin", 0.04)]

        for inst in self.out.institutions:
            iid, _name, code, domain = inst[0], inst[1], inst[2], inst[3]
            seen_emails: set[str] = set()

            for _ in range(self.scale.users_per_institution):
                role = self.weighted_choice(role_mix)
                full_name = self.fake.name()

                slug = (
                    full_name.lower()
                    .replace(".", "").replace("'", "")
                    .replace(" ", ".")
                )
                base = f"{slug}@{domain}"
                email, n = base, 1
                while email in seen_emails:
                    n += 1
                    email = f"{slug}{n}@{domain}"
                seen_emails.add(email)

                uid_ = self.uid()
                created = self.window_start + timedelta(
                    days=self.rng.randrange(0, max(1, (self.now - self.window_start).days // 2))
                )
                department = (
                    self.pick(DEPARTMENTS)
                    if role in ("student", "faculty")
                    else "Facilities & Operations"
                )
                phone = f"+91{self.rng.randrange(7000000000, 9999999999)}"

                self.out.users.append(
                    (uid_, iid, full_name, email, phone, role, department, True, created)
                )
                self._users_by_role[iid][role].append(uid_)

                # A minority of staff hold a secondary role as well.
                if role in ("faculty", "admin") and self.rng.random() < 0.18:
                    self.out.user_roles.append(
                        (self.uid(), uid_, "technician", created, created)
                    )
                elif role == "technician" and self.rng.random() < 0.12:
                    self.out.user_roles.append(
                        (self.uid(), uid_, "admin", created, created)
                    )

            # Guarantee at least one admin and a few technicians per tenant.
            for needed_role, minimum in (("admin", 2), ("technician", 6)):
                while len(self._users_by_role[iid][needed_role]) < minimum:
                    uid_ = self.uid()
                    full_name = self.fake.name()
                    slug = full_name.lower().replace(".", "").replace("'", "").replace(" ", ".")
                    email = f"{slug}.{needed_role}{len(seen_emails)}@{domain}"
                    seen_emails.add(email)
                    created = self.window_start
                    self.out.users.append(
                        (uid_, iid, full_name, email,
                         f"+91{self.rng.randrange(7000000000, 9999999999)}",
                         needed_role, "Facilities & Operations", True, created)
                    )
                    self._users_by_role[iid][needed_role].append(uid_)

    # ------------------------------------------------------- 5. service teams
    def gen_service_teams(self) -> None:
        for inst in self.out.institutions:
            iid, domain, created = inst[0], inst[3], inst[7]
            technicians = list(self._users_by_role[iid]["technician"])
            self.rng.shuffle(technicians)

            per_team = max(1, len(technicians) // len(TEAM_DEFINITIONS))
            cursor = 0

            for team_name, owns_parent, description in TEAM_DEFINITIONS:
                t_id = self.uid()
                slug = team_name.lower().replace(" & ", "-").replace(" ", "-")
                self.out.service_teams.append(
                    (t_id, iid, team_name, description, f"{slug}@{domain}", True, created)
                )
                self._team_by_parent[iid][owns_parent] = t_id

                members = technicians[cursor: cursor + per_team] or technicians[:1]
                cursor += per_team
                self._members_by_team[t_id] = list(members)
                for idx, member in enumerate(members):
                    self.out.team_members.append(
                        (self.uid(), t_id, member, idx == 0, created)
                    )

    # ------------------------------------------------------------- 6. assets
    def gen_assets(self) -> None:
        per_institution = max(1, self.scale.assets_total // len(self.out.institutions))
        flat_asset_leaves = [
            (child, abbrev)
            for _parent, children in ASSET_TAXONOMY
            for child, abbrev in children
        ]

        for inst in self.out.institutions:
            iid, code, created = inst[0], inst[2], inst[7]
            rooms = self._rooms[iid]
            counters: dict[str, int] = {}

            for _ in range(per_institution):
                leaf_name, abbrev = self.pick(flat_asset_leaves)
                room_id, _room_name, b_abbr, floor_no = self.pick(rooms)

                counters[abbrev] = counters.get(abbrev, 0) + 1
                asset_tag = f"{code}-{b_abbr}-F{floor_no}-{abbrev}-{counters[abbrev]:04d}"

                a_id = self.uid()
                status = self.weighted_choice([
                    ("active", 0.88), ("under_maintenance", 0.07),
                    ("decommissioned", 0.04), ("missing", 0.01),
                ])
                purchased = (
                    self.window_start - timedelta(days=self.rng.randrange(60, 2200))
                ).date()

                self.out.assets.append((
                    a_id, iid, room_id, self._asset_leaf_by_name[iid][leaf_name],
                    asset_tag, f"{leaf_name} #{counters[abbrev]}",
                    f"{leaf_name} installed in block {b_abbr}, floor {floor_no}.",
                    f"https://campuspulse.app/qr/{a_id[:8]}",
                    status, purchased, created,
                ))

                self._assets_by_leafcat[iid][leaf_name].append((a_id, room_id))
                self._assets_by_location[iid].setdefault(room_id, []).append(
                    (a_id, leaf_name)
                )

    # ----------------------------------------- 7. incidents + reports + flow
    def _resolution_hours(self, priority: str, sla_hours: int) -> float:
        """Log-normal-ish resolution time; ~20% deliberately breach the SLA."""
        breach = self.rng.random() < {
            "critical": 0.14, "high": 0.18, "medium": 0.22, "low": 0.27
        }[priority]

        if breach:
            factor = self.rng.uniform(1.05, 3.4)
        else:
            factor = self.rng.betavariate(2.0, 3.0) * 0.95 + 0.03

        jitter = math.exp(self.rng.gauss(0, 0.25))
        return max(0.25, sla_hours * factor * jitter)

    def gen_incidents(self) -> None:
        per_institution = max(1, self.scale.incidents_total // len(self.out.institutions))

        status_mix = [
            ("closed", 0.52), ("resolved", 0.14), ("in_progress", 0.13),
            ("acknowledged", 0.09), ("reported", 0.12),
        ]

        for inst in self.out.institutions:
            iid = inst[0]
            rooms = self._rooms[iid]
            hot = list(self._hot_locations[iid])
            leaves = self._issue_leaves[iid]
            students = (
                self._users_by_role[iid]["student"] + self._users_by_role[iid]["faculty"]
            )
            staff = (
                self._users_by_role[iid]["admin"] + self._users_by_role[iid]["technician"]
            )

            for _ in range(per_institution):
                cat_id, cat_name, priority, sla_hours, parent_name = self.pick(leaves)

                # 40% of incidents land in the minority of "problem" rooms.
                if hot and self.rng.random() < 0.40:
                    room_id = self.pick(hot)
                    room_name = next(r[1] for r in rooms if r[0] == room_id)
                else:
                    room_id, room_name, _b, _f = self.pick(rooms)

                # Attach an asset when the issue category implies one.
                asset_id = None
                candidate_leaves = ISSUE_TO_ASSET.get(cat_name, [])
                for leaf in candidate_leaves:
                    pool = [
                        a for a, loc in self._assets_by_leafcat[iid].get(leaf, [])
                        if loc == room_id
                    ]
                    if pool:
                        asset_id = self.pick(pool)
                        break
                if asset_id is None and candidate_leaves and self.rng.random() < 0.45:
                    fallback = self._assets_by_leafcat[iid].get(self.pick(candidate_leaves), [])
                    if fallback:
                        asset_id = self.pick(fallback)[0]

                created_at = self.random_event_time()
                sla_due_at = created_at + timedelta(hours=sla_hours)
                status = self.weighted_choice(status_mix)

                # --- lifecycle timestamps, obeying the CHECK constraints ---
                acknowledged_at = resolved_at = closed_at = None
                if status != "reported":
                    ack_delay = self.rng.uniform(0.1, max(0.5, sla_hours * 0.35))
                    acknowledged_at = created_at + timedelta(hours=ack_delay)
                if status in ("resolved", "closed"):
                    resolved_at = created_at + timedelta(
                        hours=self._resolution_hours(priority, sla_hours)
                    )
                    if acknowledged_at and acknowledged_at > resolved_at:
                        acknowledged_at = created_at + (resolved_at - created_at) / 3
                if status == "closed":
                    closed_at = resolved_at + timedelta(hours=self.rng.uniform(1, 72))

                # Never let a simulated future leak past "now".
                if closed_at and closed_at > self.now:
                    continue
                if resolved_at and resolved_at > self.now:
                    continue

                reporter = self.pick(students)
                inc_id = self.uid()
                title = f"{cat_name} - {room_name}"
                description = self.pick(
                    REPORT_TEMPLATES.get(cat_name, ["Issue reported at {loc}."])
                ).format(loc=room_name)

                self.out.incidents.append((
                    inc_id, iid, room_id, asset_id, cat_id, title, description,
                    status, priority, reporter, created_at, acknowledged_at,
                    resolved_at, closed_at, sla_due_at,
                ))

                self._emit_reports(iid, inc_id, cat_id, cat_name, room_id, room_name,
                                   asset_id, created_at, reporter, students)
                self._emit_status_history(inc_id, status, created_at, acknowledged_at,
                                          resolved_at, closed_at, staff)
                self._emit_work_order(iid, inc_id, parent_name, priority, status,
                                      created_at, acknowledged_at, resolved_at, closed_at)

    def _emit_reports(self, iid, inc_id, cat_id, cat_name, room_id, room_name,
                      asset_id, incident_created, first_reporter, students) -> None:
        """One incident attracts 1..5 independent reports; extras are duplicates."""
        n_reports = self.weighted_choice([
            (1, 0.55), (2, 0.24), (3, 0.12), (4, 0.06), (5, 0.03)
        ])
        templates = REPORT_TEMPLATES.get(cat_name, ["Issue reported at {loc}."])
        reporters = {first_reporter}

        for idx in range(n_reports):
            if idx == 0:
                reporter = first_reporter
                created_at = incident_created
            else:
                reporter = self.pick(students)
                if reporter in reporters:
                    continue
                reporters.add(reporter)
                # Duplicates arrive shortly AFTER the original sighting.
                created_at = incident_created + timedelta(
                    minutes=self.rng.randrange(3, 60 * 20)
                )
                if created_at > self.now:
                    continue

            rep_id = self.uid()
            self.out.reports.append((
                rep_id, iid, reporter, asset_id, room_id, cat_id,
                self.pick(templates).format(loc=room_name),
                (f"https://campuspulse.app/uploads/{rep_id[:12]}.jpg"
                 if self.rng.random() < 0.42 else None),
                self.weighted_choice([
                    ("qr_scan", 0.46), ("mobile_app", 0.24),
                    ("web", 0.18), ("manual", 0.08), ("email", 0.04),
                ]),
                idx > 0,
                created_at,
            ))
            self.out.incident_reports.append(
                (self.uid(), inc_id, rep_id, self.rng.random() < 0.85, created_at)
            )

            if self.rng.random() < 0.18:
                self.out.attachments.append((
                    self.uid(), "report", rep_id,
                    f"https://campuspulse.app/uploads/{rep_id[:12]}-extra.jpg",
                    self.rng.randrange(120, 4200), reporter, created_at,
                ))

    def _emit_status_history(self, inc_id, status, created_at, acknowledged_at,
                             resolved_at, closed_at, staff) -> None:
        """Append-only audit trail: one row per state actually reached."""
        self.out.status_history.append(
            (self.uid(), inc_id, "reported", None,
             "Incident opened from user report.", created_at)
        )
        if acknowledged_at:
            self.out.status_history.append(
                (self.uid(), inc_id, "acknowledged", self.pick(staff),
                 "Verified by facilities desk and queued for assignment.",
                 acknowledged_at)
            )
        if status in ("in_progress", "resolved", "closed"):
            in_prog_at = acknowledged_at + timedelta(
                hours=self.rng.uniform(0.2, 6)
            ) if acknowledged_at else created_at
            if resolved_at and in_prog_at > resolved_at:
                in_prog_at = acknowledged_at or created_at
            if in_prog_at <= self.now:
                self.out.status_history.append(
                    (self.uid(), inc_id, "in_progress", self.pick(staff),
                     "Work order dispatched to service team.", in_prog_at)
                )
        if resolved_at:
            self.out.status_history.append(
                (self.uid(), inc_id, "resolved", self.pick(staff),
                 self.pick(RESOLUTION_NOTES), resolved_at)
            )
        if closed_at:
            self.out.status_history.append(
                (self.uid(), inc_id, "closed", self.pick(staff),
                 "Closed after reporter confirmation.", closed_at)
            )

    def _emit_work_order(self, iid, inc_id, parent_name, priority, status,
                         created_at, acknowledged_at, resolved_at, closed_at) -> None:
        """Work orders exist only once an incident has been triaged."""
        if status in ("reported",):
            return
        if status == "acknowledged" and self.rng.random() < 0.45:
            return

        team_id = self._team_by_parent[iid].get(parent_name)
        if not team_id:
            return

        members = self._members_by_team.get(team_id, [])
        assignee = self.pick(members) if members else None
        wo_created = acknowledged_at or created_at

        if status in ("resolved", "closed"):
            wo_status = self.weighted_choice([
                ("closed", 0.5), ("verified", 0.3), ("completed", 0.2)
            ]) if status == "closed" else self.weighted_choice([
                ("completed", 0.6), ("verified", 0.4)
            ])
            completed_at = resolved_at
            labour = max(5, int(self.rng.lognormvariate(3.9, 0.75)))
            # Only about a third of jobs consume billable parts.
            cost = (round(self.rng.uniform(50, 4800), 2)
                    if self.rng.random() < 0.35 else 0.00)
        else:
            wo_status = "in_progress" if status == "in_progress" else "assigned"
            completed_at = None
            labour = None
            cost = None

        self.out.work_orders.append((
            self.uid(), inc_id, team_id, assignee, wo_status, priority,
            self.pick(RESOLUTION_NOTES) if completed_at else "Assigned, pending site visit.",
            labour, cost, wo_created, closed_at or resolved_at or wo_created, completed_at,
        ))

    # ------------------------------------------- 8. notifications + feedback
    def gen_notifications_and_feedback(self) -> None:
        # Map incident -> its reporters, so notifications go to the right people.
        reporters_by_incident: dict[str, list[str]] = {}
        report_owner = {r[0]: r[2] for r in self.out.reports}
        for _id, inc_id, rep_id, is_affected, _ts in self.out.incident_reports:
            if is_affected:
                reporters_by_incident.setdefault(inc_id, []).append(report_owner[rep_id])

        for inc in self.out.incidents:
            (inc_id, _iid, _loc, _asset, _cat, title, _desc, status, _prio,
             _creator, created_at, acknowledged_at, resolved_at, closed_at, _sla) = inc

            audience = reporters_by_incident.get(inc_id, [])
            if not audience:
                continue

            events: list[tuple[str, datetime]] = []
            if acknowledged_at:
                events.append((f"Your report '{title}' has been acknowledged.", acknowledged_at))
            if resolved_at:
                events.append((f"'{title}' has been marked resolved.", resolved_at))
            if closed_at:
                events.append((f"'{title}' is now closed. Please rate the service.", closed_at))

            for message, ts in events:
                if ts > self.now:
                    continue
                for user_id in audience[:3]:
                    is_read = self.rng.random() < 0.68
                    read_at = (
                        ts + timedelta(minutes=self.rng.randrange(2, 60 * 48))
                        if is_read else None
                    )
                    if read_at and read_at > self.now:
                        read_at, is_read = None, False
                    self.out.notifications.append((
                        self.uid(), user_id, inc_id,
                        self.weighted_choice([("email", 0.6), ("in_app", 0.32), ("sms", 0.08)]),
                        message, is_read, ts, read_at,
                    ))

            # Feedback only after closure, and only sometimes.
            if status == "closed" and closed_at and self.rng.random() < 0.42:
                rater = audience[0]
                # Satisfaction correlates with whether the SLA was actually met.
                sla_due = inc[14]
                met_sla = resolved_at is not None and resolved_at <= sla_due
                if met_sla:
                    rating = self.weighted_choice([(5, 0.45), (4, 0.38), (3, 0.13), (2, 0.03), (1, 0.01)])
                else:
                    rating = self.weighted_choice([(1, 0.22), (2, 0.30), (3, 0.28), (4, 0.15), (5, 0.05)])

                if rating >= 4:
                    comment = self.pick(FEEDBACK_POSITIVE)
                elif rating == 3:
                    comment = self.pick(FEEDBACK_NEUTRAL)
                else:
                    comment = self.pick(FEEDBACK_NEGATIVE)

                fb_at = closed_at + timedelta(hours=self.rng.uniform(1, 96))
                if fb_at <= self.now:
                    self.out.feedback.append(
                        (self.uid(), inc_id, rater, rating, comment, fb_at)
                    )

    # -------------------------------------------------------------- driver
    def generate(self) -> Generated:
        step("Generating institutions...")
        self.gen_institutions()
        step("Generating location hierarchy (campus > building > floor > room)...")
        self.gen_locations()
        step("Generating issue + asset taxonomies...")
        self.gen_categories()
        step("Generating users...")
        self.gen_users()
        step("Generating service teams and memberships...")
        self.gen_service_teams()
        step("Generating tagged assets...")
        self.gen_assets()
        step("Generating incidents, reports, work orders and audit trail...")
        self.gen_incidents()
        step("Generating notifications and satisfaction feedback...")
        self.gen_notifications_and_feedback()
        return self.out


# ==========================================================================
# Bulk loading
# ==========================================================================
TABLE_ORDER: list[tuple[str, str, tuple[str, ...]]] = [
    ("institutions", "institutions",
     ("id", "name", "code", "domain", "city", "timezone", "is_active", "created_at")),
    ("locations", "locations",
     ("id", "institution_id", "parent_id", "name", "type", "code", "created_at")),
    ("categories", "categories",
     ("id", "institution_id", "parent_id", "name", "type",
      "default_priority", "sla_hours", "created_at")),
    ("users", "users",
     ("id", "institution_id", "full_name", "email", "phone",
      "role", "department", "is_active", "created_at")),
    ("user_roles", "user_roles", ("id", "user_id", "role", "granted_at", "created_at")),
    ("service_teams", "service_teams",
     ("id", "institution_id", "name", "description", "contact_email",
      "is_active", "created_at")),
    ("team_members", "team_members", ("id", "team_id", "user_id", "is_lead", "joined_at")),
    ("assets", "assets",
     ("id", "institution_id", "location_id", "category_id", "asset_tag",
      "name", "description", "qr_code", "status", "purchased_on", "created_at")),
    ("incidents", "incidents",
     ("id", "institution_id", "location_id", "asset_id", "category_id",
      "title", "description", "status", "priority", "created_by", "created_at",
      "acknowledged_at", "resolved_at", "closed_at", "sla_due_at")),
    ("reports", "reports",
     ("id", "institution_id", "user_id", "asset_id", "location_id", "category_id",
      "description", "photo_url", "reported_via", "is_duplicate", "created_at")),
    ("incident_reports", "incident_reports",
     ("id", "incident_id", "report_id", "is_affected", "created_at")),
    ("work_orders", "work_orders",
     ("id", "incident_id", "team_id", "assigned_to", "status", "priority",
      "notes", "labour_minutes", "material_cost", "created_at",
      "updated_at", "completed_at")),
    ("status_history", "status_history",
     ("id", "incident_id", "status", "changed_by", "notes", "created_at")),
    ("notifications", "notifications",
     ("id", "user_id", "incident_id", "channel", "message",
      "is_read", "created_at", "read_at")),
    ("attachments", "attachments",
     ("id", "table_type", "table_id", "file_url", "file_size_kb",
      "uploaded_by", "created_at")),
    ("feedback", "feedback",
     ("id", "incident_id", "user_id", "rating", "comments", "created_at")),
]

# Order in which rows must be REMOVED (children before parents).
TRUNCATE_ORDER = [name for name, _attr, _cols in reversed(TABLE_ORDER)]


def bulk_insert(cur, table: str, columns: tuple[str, ...], rows: list) -> int:
    if not rows:
        return 0
    statement = (
        f'INSERT INTO {SCHEMA}."{table}" ({", ".join(columns)}) VALUES %s'
    )
    execute_values(cur, statement, rows, page_size=1000)
    return len(rows)


def table_row_counts(cur) -> dict[str, int]:
    counts: dict[str, int] = {}
    for name, _attr, _cols in TABLE_ORDER:
        cur.execute(f'SELECT count(*) FROM {SCHEMA}."{name}";')
        counts[name] = cur.fetchone()[0]
    return counts


def truncate_all(cur) -> None:
    cur.execute(
        "TRUNCATE TABLE "
        + ", ".join(f'{SCHEMA}."{t}"' for t in TRUNCATE_ORDER)
        + " RESTART IDENTITY CASCADE;"
    )


# ==========================================================================
# Entry point
# ==========================================================================
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate and load synthetic CampusPulse data."
    )
    parser.add_argument("--scale", choices=sorted(SCALES), default=DEFAULT_SCALE)
    parser.add_argument("--seed", type=int, default=RANDOM_SEED)
    parser.add_argument("--months", type=int, default=HISTORY_MONTHS)
    parser.add_argument("-y", "--yes", action="store_true",
                        help="Do not prompt before clearing existing rows.")
    parser.add_argument("--truncate-only", action="store_true",
                        help="Delete all rows and exit, leaving the schema intact.")
    args = parser.parse_args()

    scale = SCALES[args.scale]

    banner("CampusPulse - Synthetic Data Generator")
    step(f"Target : {describe_target()}")
    step(f"Scale  : {scale.name}  |  seed={args.seed}  |  history={args.months} months")

    try:
        with managed_connection() as conn:
            with conn.cursor() as cur:
                # ---- guard against silently doubling an existing dataset ----
                existing = table_row_counts(cur)
                total_existing = sum(existing.values())
                if total_existing:
                    warn(f"Schema already holds {total_existing:,} row(s).")
                    if not (args.yes or args.truncate_only):
                        answer = input("  Delete them and reload? [y/N]: ")
                        if answer.strip().lower() not in {"y", "yes"}:
                            fail("Aborted. Nothing was changed.")
                            sys.exit(1)
                    step("Truncating existing rows...")
                    truncate_all(cur)
                    ok("Existing rows cleared")

                if args.truncate_only:
                    banner("Truncate complete - schema left intact")
                    return

                # ---- generate in memory --------------------------------
                banner("Generating", char="-")
                gen_started = time.perf_counter()
                generator = CampusPulseGenerator(scale, args.seed, args.months)
                data = generator.generate()
                gen_elapsed = time.perf_counter() - gen_started
                ok(f"Generation finished in {gen_elapsed:.2f}s")

                # ---- load ----------------------------------------------
                banner("Loading into PostgreSQL", char="-")
                load_started = time.perf_counter()
                totals: dict[str, int] = {}
                for table, attribute, columns in TABLE_ORDER:
                    rows = getattr(data, attribute)
                    inserted = bulk_insert(cur, table, columns, rows)
                    totals[table] = inserted
                    ok(f"{table:<18} {inserted:>8,} rows")
                load_elapsed = time.perf_counter() - load_started

                step("Refreshing planner statistics (ANALYZE)...")
                for table, _attr, _cols in TABLE_ORDER:
                    cur.execute(f'ANALYZE {SCHEMA}."{table}";')
                ok("Statistics refreshed")

                # ---- quick shape check ---------------------------------
                cur.execute(f"""
                    SELECT
                      (SELECT count(*) FROM {SCHEMA}.reports WHERE is_duplicate),
                      (SELECT count(*) FROM {SCHEMA}.reports),
                      (SELECT count(*) FROM {SCHEMA}.incidents
                        WHERE status NOT IN ('resolved','closed')),
                      (SELECT round(avg(EXTRACT(EPOCH FROM (resolved_at-created_at))/3600.0)::numeric,1)
                         FROM {SCHEMA}.incidents WHERE resolved_at IS NOT NULL),
                      (SELECT count(*) FROM {SCHEMA}.incidents
                        WHERE resolved_at IS NOT NULL AND resolved_at > sla_due_at);
                """)
                dup, all_reports, open_inc, avg_hours, breaches = cur.fetchone()

    except KeyboardInterrupt:
        fail("Interrupted. Transaction rolled back; no partial data was left behind.")
        sys.exit(130)
    except Exception as exc:  # noqa: BLE001 - top-level CLI handler
        fail(f"Data load failed: {exc}")
        sys.exit(1)

    grand_total = sum(totals.values())
    banner("Data load complete")
    print(f"    Rows inserted        : {grand_total:,}")
    print(f"    Generation time      : {gen_elapsed:.2f}s")
    print(f"    Load time            : {load_elapsed:.2f}s")
    print()
    print("    Dataset shape")
    print(f"      Duplicate reports  : {dup:,} of {all_reports:,} "
          f"({100.0 * dup / max(all_reports, 1):.1f}%)")
    print(f"      Still-open incidents: {open_inc:,}")
    print(f"      Avg resolution     : {avg_hours} hours")
    print(f"      SLA breaches       : {breaches:,}")
    print()
    print("    Next step:  python 03_Verify_Data.py")
    print()


if __name__ == "__main__":
    main()
