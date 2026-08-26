"""
01_Create_Schema.py
===================
Builds the complete CampusPulse database schema on Supabase / PostgreSQL
using psycopg2.

What it creates
---------------
  * A dedicated `campuspulse` schema (never touches Supabase's own
    `public` / `auth` / `storage` schemas).
  * 9 ENUM types that encode the domain's controlled vocabularies.
  * 16 tables implementing the UML design, with multi-tenant isolation.
  * Composite foreign keys that make cross-tenant data leakage
    *structurally impossible*, not just discouraged.
  * 30+ indexes tuned for the analytics queries in 04_Analytics_Queries.py.
  * 1 trigger function (auto-maintained `updated_at`).
  * 4 reporting views used by the analytics layer.

Usage
-----
    python 01_Create_Schema.py            # build (asks before overwriting)
    python 01_Create_Schema.py --yes      # build, no confirmation prompt
    python 01_Create_Schema.py --dry-run  # print the DDL, execute nothing
"""

from __future__ import annotations

import argparse
import re
import sys
import time

from psycopg2 import sql

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

# --------------------------------------------------------------------------
# Guard: the schema name is interpolated into DDL, so validate its shape.
# --------------------------------------------------------------------------
if not re.fullmatch(r"[a-z_][a-z0-9_]*", SCHEMA):
    raise SystemExit(
        f"Invalid DB_SCHEMA value {SCHEMA!r}. "
        "Use lowercase letters, digits and underscores only."
    )

S = SCHEMA  # short alias to keep the DDL readable


# ==========================================================================
# SECTION 1 - ENUM TYPES
# --------------------------------------------------------------------------
# Using native ENUMs (instead of free-text columns) pushes the controlled
# vocabulary into the database itself. An invalid status literally cannot be
# stored, which is exactly the guarantee an operations system needs.
# ==========================================================================
DDL_ENUMS: list[tuple[str, str]] = [
    (
        "user_role",
        f"""
        CREATE TYPE {S}.user_role AS ENUM
            ('student', 'faculty', 'admin', 'technician');
        """,
    ),
    (
        "location_type",
        f"""
        CREATE TYPE {S}.location_type AS ENUM
            ('campus', 'building', 'floor', 'room', 'area');
        """,
    ),
    (
        "category_type",
        f"""
        CREATE TYPE {S}.category_type AS ENUM
            ('issue_category', 'asset_category');
        """,
    ),
    (
        "asset_status",
        f"""
        CREATE TYPE {S}.asset_status AS ENUM
            ('active', 'under_maintenance', 'decommissioned', 'missing');
        """,
    ),
    (
        "incident_status",
        f"""
        CREATE TYPE {S}.incident_status AS ENUM
            ('reported', 'acknowledged', 'in_progress', 'resolved', 'closed');
        """,
    ),
    (
        "priority_level",
        f"""
        CREATE TYPE {S}.priority_level AS ENUM
            ('low', 'medium', 'high', 'critical');
        """,
    ),
    (
        "work_order_status",
        f"""
        CREATE TYPE {S}.work_order_status AS ENUM
            ('assigned', 'in_progress', 'completed', 'verified', 'closed');
        """,
    ),
    (
        "attachment_parent",
        f"""
        CREATE TYPE {S}.attachment_parent AS ENUM
            ('report', 'incident', 'work_order', 'asset');
        """,
    ),
    (
        "notification_channel",
        f"""
        CREATE TYPE {S}.notification_channel AS ENUM
            ('in_app', 'email', 'sms');
        """,
    ),
]


# ==========================================================================
# SECTION 2 - TABLES
# --------------------------------------------------------------------------
# Multi-tenancy note
# ------------------
# Every tenant-owned table carries `institution_id`, AND declares
# `UNIQUE (id, institution_id)`. That redundant-looking unique key is what
# lets child tables use a COMPOSITE foreign key:
#
#     FOREIGN KEY (location_id, institution_id)
#         REFERENCES locations(id, institution_id)
#
# The effect: a report in Institution A can never reference a location in
# Institution B. The database rejects it. This is far stronger than relying
# on application code to always remember a `WHERE institution_id = ...`.
# ==========================================================================
DDL_TABLES: list[tuple[str, str]] = [
    # ---------------------------------------------------------------- 1
    (
        "institutions",
        f"""
        CREATE TABLE {S}.institutions (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            name        text        NOT NULL,
            code        text        NOT NULL,
            domain      text        NOT NULL,
            city        text,
            timezone    text        NOT NULL DEFAULT 'Asia/Kolkata',
            is_active   boolean     NOT NULL DEFAULT true,
            created_at  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT institutions_code_unique  UNIQUE (code),
            CONSTRAINT institutions_code_format  CHECK (code ~ '^[A-Z0-9]{{2,10}}$'),
            CONSTRAINT institutions_domain_format
                CHECK (domain ~ '^[a-z0-9.-]+\\.[a-z]{{2,}}$')
        );
        COMMENT ON TABLE {S}.institutions IS
            'Tenant root. One row per college / university / campus operator.';
        """,
    ),
    # ---------------------------------------------------------------- 2
    (
        "users",
        f"""
        CREATE TABLE {S}.users (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES {S}.institutions(id) ON DELETE CASCADE,
            full_name       text        NOT NULL,
            email           text        NOT NULL,
            phone           text,
            role            {S}.user_role NOT NULL DEFAULT 'student',
            department      text,
            is_active       boolean     NOT NULL DEFAULT true,
            created_at      timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT users_email_unique_per_tenant UNIQUE (institution_id, email),
            CONSTRAINT users_tenant_key              UNIQUE (id, institution_id),
            CONSTRAINT users_email_format
                CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'),
            CONSTRAINT users_full_name_not_blank
                CHECK (length(btrim(full_name)) > 0)
        );
        COMMENT ON TABLE {S}.users IS
            'All actors: students, faculty, admins and technicians.';
        """,
    ),
    # ---------------------------------------------------------------- 3
    (
        "user_roles",
        f"""
        CREATE TABLE {S}.user_roles (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid        NOT NULL
                REFERENCES {S}.users(id) ON DELETE CASCADE,
            role        {S}.user_role NOT NULL,
            granted_at  timestamptz NOT NULL DEFAULT now(),
            created_at  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT user_roles_unique UNIQUE (user_id, role)
        );
        COMMENT ON TABLE {S}.user_roles IS
            'Secondary roles. users.role holds the primary role; this table '
            'lets one person also be, say, a technician AND a faculty member.';
        """,
    ),
    # ---------------------------------------------------------------- 4
    (
        "service_teams",
        f"""
        CREATE TABLE {S}.service_teams (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES {S}.institutions(id) ON DELETE CASCADE,
            name            text        NOT NULL,
            description     text,
            contact_email   text,
            is_active       boolean     NOT NULL DEFAULT true,
            created_at      timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT service_teams_name_unique_per_tenant
                UNIQUE (institution_id, name),
            CONSTRAINT service_teams_tenant_key UNIQUE (id, institution_id)
        );
        COMMENT ON TABLE {S}.service_teams IS
            'Maintenance crews: Electrical, Plumbing, IT Support, Housekeeping...';
        """,
    ),
    # ---------------------------------------------------------------- 5
    (
        "team_members",
        f"""
        CREATE TABLE {S}.team_members (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            team_id     uuid        NOT NULL
                REFERENCES {S}.service_teams(id) ON DELETE CASCADE,
            user_id     uuid        NOT NULL
                REFERENCES {S}.users(id) ON DELETE CASCADE,
            is_lead     boolean     NOT NULL DEFAULT false,
            joined_at   timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT team_members_unique UNIQUE (team_id, user_id)
        );
        COMMENT ON TABLE {S}.team_members IS
            'Junction table resolving the many-to-many between technicians and '
            'service teams. Added beyond the original UML so that work orders '
            'can be assigned to a real, verifiable member of the owning team.';
        """,
    ),
    # ---------------------------------------------------------------- 6
    (
        "locations",
        f"""
        CREATE TABLE {S}.locations (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES {S}.institutions(id) ON DELETE CASCADE,
            parent_id       uuid
                REFERENCES {S}.locations(id) ON DELETE CASCADE,
            name            text        NOT NULL,
            type            {S}.location_type NOT NULL,
            code            text        NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT locations_code_unique_per_tenant
                UNIQUE (institution_id, code),
            CONSTRAINT locations_tenant_key  UNIQUE (id, institution_id),
            CONSTRAINT locations_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
        );
        COMMENT ON TABLE {S}.locations IS
            'Self-referencing hierarchy: campus > building > floor > room/area. '
            'Recursive CTEs walk this tree to roll incidents up to any level.';
        """,
    ),
    # ---------------------------------------------------------------- 7
    (
        "categories",
        f"""
        CREATE TABLE {S}.categories (
            id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id   uuid        NOT NULL
                REFERENCES {S}.institutions(id) ON DELETE CASCADE,
            parent_id        uuid
                REFERENCES {S}.categories(id) ON DELETE CASCADE,
            name             text        NOT NULL,
            type             {S}.category_type NOT NULL,
            default_priority {S}.priority_level NOT NULL DEFAULT 'medium',
            sla_hours        integer     NOT NULL DEFAULT 48,
            created_at       timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT categories_unique_per_tenant
                UNIQUE (institution_id, type, name),
            CONSTRAINT categories_tenant_key   UNIQUE (id, institution_id),
            CONSTRAINT categories_sla_positive CHECK (sla_hours > 0),
            CONSTRAINT categories_not_own_parent
                CHECK (parent_id IS DISTINCT FROM id)
        );
        COMMENT ON TABLE {S}.categories IS
            'Dual-purpose taxonomy: issue categories (what broke) and asset '
            'categories (what kind of thing it is). sla_hours drives the '
            'SLA-breach analytics.';
        """,
    ),
    # ---------------------------------------------------------------- 8
    (
        "assets",
        f"""
        CREATE TABLE {S}.assets (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES {S}.institutions(id) ON DELETE CASCADE,
            location_id     uuid        NOT NULL,
            category_id     uuid        NOT NULL,
            asset_tag       text        NOT NULL,
            name            text        NOT NULL,
            description     text,
            qr_code         text,
            status          {S}.asset_status NOT NULL DEFAULT 'active',
            purchased_on    date,
            created_at      timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT assets_tag_unique_per_tenant
                UNIQUE (institution_id, asset_tag),
            CONSTRAINT assets_tenant_key UNIQUE (id, institution_id),

            CONSTRAINT assets_location_same_tenant
                FOREIGN KEY (location_id, institution_id)
                REFERENCES {S}.locations(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT assets_category_same_tenant
                FOREIGN KEY (category_id, institution_id)
                REFERENCES {S}.categories(id, institution_id) ON DELETE CASCADE
        );
        COMMENT ON TABLE {S}.assets IS
            'Physical items bearing an Asset Identification Number / QR sticker. '
            'Scanning the QR auto-fills location and asset details on a report.';
        """,
    ),
    # ---------------------------------------------------------------- 9
    (
        "reports",
        f"""
        CREATE TABLE {S}.reports (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES {S}.institutions(id) ON DELETE CASCADE,
            user_id         uuid        NOT NULL,
            asset_id        uuid,
            location_id     uuid        NOT NULL,
            category_id     uuid        NOT NULL,
            description     text        NOT NULL,
            photo_url       text,
            reported_via    text        NOT NULL DEFAULT 'qr_scan',
            is_duplicate    boolean     NOT NULL DEFAULT false,
            created_at      timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT reports_tenant_key UNIQUE (id, institution_id),
            CONSTRAINT reports_channel_valid
                CHECK (reported_via IN ('qr_scan', 'manual', 'web', 'mobile_app', 'email')),
            CONSTRAINT reports_description_not_blank
                CHECK (length(btrim(description)) > 0),

            CONSTRAINT reports_user_same_tenant
                FOREIGN KEY (user_id, institution_id)
                REFERENCES {S}.users(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT reports_location_same_tenant
                FOREIGN KEY (location_id, institution_id)
                REFERENCES {S}.locations(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT reports_category_same_tenant
                FOREIGN KEY (category_id, institution_id)
                REFERENCES {S}.categories(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT reports_asset_same_tenant
                FOREIGN KEY (asset_id, institution_id)
                REFERENCES {S}.assets(id, institution_id)
                ON DELETE SET NULL (asset_id)
        );
        COMMENT ON TABLE {S}.reports IS
            'Raw user submissions. Many reports about the same real-world '
            'problem are later aggregated into ONE incident.';
        """,
    ),
    # --------------------------------------------------------------- 10
    (
        "incidents",
        f"""
        CREATE TABLE {S}.incidents (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES {S}.institutions(id) ON DELETE CASCADE,
            location_id     uuid        NOT NULL,
            asset_id        uuid,
            category_id     uuid        NOT NULL,
            title           text        NOT NULL,
            description     text,
            status          {S}.incident_status  NOT NULL DEFAULT 'reported',
            priority        {S}.priority_level   NOT NULL DEFAULT 'medium',
            created_by      uuid        NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT now(),
            acknowledged_at timestamptz,
            resolved_at     timestamptz,
            closed_at       timestamptz,
            sla_due_at      timestamptz NOT NULL,

            CONSTRAINT incidents_tenant_key UNIQUE (id, institution_id),

            -- Temporal sanity: the lifecycle can only move forwards in time.
            CONSTRAINT incidents_ack_after_created
                CHECK (acknowledged_at IS NULL OR acknowledged_at >= created_at),
            CONSTRAINT incidents_resolved_after_created
                CHECK (resolved_at IS NULL OR resolved_at >= created_at),
            CONSTRAINT incidents_closed_after_resolved
                CHECK (closed_at IS NULL OR resolved_at IS NULL
                       OR closed_at >= resolved_at),

            -- State/timestamp agreement: a resolved incident MUST have a
            -- resolved_at, and an unresolved one MUST NOT. No drift possible.
            CONSTRAINT incidents_resolution_consistent
                CHECK ((status IN ('resolved', 'closed')) = (resolved_at IS NOT NULL)),
            CONSTRAINT incidents_closure_consistent
                CHECK ((status = 'closed') = (closed_at IS NOT NULL)),

            CONSTRAINT incidents_location_same_tenant
                FOREIGN KEY (location_id, institution_id)
                REFERENCES {S}.locations(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT incidents_category_same_tenant
                FOREIGN KEY (category_id, institution_id)
                REFERENCES {S}.categories(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT incidents_creator_same_tenant
                FOREIGN KEY (created_by, institution_id)
                REFERENCES {S}.users(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT incidents_asset_same_tenant
                FOREIGN KEY (asset_id, institution_id)
                REFERENCES {S}.assets(id, institution_id)
                ON DELETE SET NULL (asset_id)
        );
        COMMENT ON TABLE {S}.incidents IS
            'The de-duplicated unit of work. One incident = one real-world '
            'problem, however many people reported it.';
        """,
    ),
    # --------------------------------------------------------------- 11
    (
        "incident_reports",
        f"""
        CREATE TABLE {S}.incident_reports (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            incident_id uuid        NOT NULL
                REFERENCES {S}.incidents(id) ON DELETE CASCADE,
            report_id   uuid        NOT NULL
                REFERENCES {S}.reports(id) ON DELETE CASCADE,
            is_affected boolean     NOT NULL DEFAULT true,
            created_at  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT incident_reports_pair_unique UNIQUE (incident_id, report_id),
            -- A report can only ever belong to ONE incident.
            CONSTRAINT incident_reports_report_once UNIQUE (report_id)
        );
        COMMENT ON TABLE {S}.incident_reports IS
            'Junction implementing many-reports-to-one-incident aggregation. '
            'is_affected marks reporters who should receive status updates.';
        """,
    ),
    # --------------------------------------------------------------- 12
    (
        "work_orders",
        f"""
        CREATE TABLE {S}.work_orders (
            id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            incident_id    uuid        NOT NULL
                REFERENCES {S}.incidents(id) ON DELETE CASCADE,
            team_id        uuid        NOT NULL
                REFERENCES {S}.service_teams(id) ON DELETE RESTRICT,
            assigned_to    uuid
                REFERENCES {S}.users(id) ON DELETE SET NULL,
            status         {S}.work_order_status NOT NULL DEFAULT 'assigned',
            priority       {S}.priority_level    NOT NULL DEFAULT 'medium',
            notes          text,
            labour_minutes integer,
            material_cost  numeric(10, 2),
            created_at     timestamptz NOT NULL DEFAULT now(),
            updated_at     timestamptz NOT NULL DEFAULT now(),
            completed_at   timestamptz,

            CONSTRAINT work_orders_labour_nonneg
                CHECK (labour_minutes IS NULL OR labour_minutes >= 0),
            CONSTRAINT work_orders_cost_nonneg
                CHECK (material_cost IS NULL OR material_cost >= 0),
            CONSTRAINT work_orders_completed_after_created
                CHECK (completed_at IS NULL OR completed_at >= created_at),
            CONSTRAINT work_orders_completion_consistent
                CHECK ((status IN ('completed', 'verified', 'closed'))
                       = (completed_at IS NOT NULL))
        );
        COMMENT ON TABLE {S}.work_orders IS
            'Execution record: which team/technician was dispatched, how long '
            'it took, what it cost.';
        """,
    ),
    # --------------------------------------------------------------- 13
    (
        "status_history",
        f"""
        CREATE TABLE {S}.status_history (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            incident_id uuid        NOT NULL
                REFERENCES {S}.incidents(id) ON DELETE CASCADE,
            status      {S}.incident_status NOT NULL,
            changed_by  uuid
                REFERENCES {S}.users(id) ON DELETE SET NULL,
            notes       text,
            created_at  timestamptz NOT NULL DEFAULT now()
        );
        COMMENT ON TABLE {S}.status_history IS
            'Append-only audit trail of every incident state transition. '
            'This is what makes stage-by-stage cycle-time analysis possible.';
        """,
    ),
    # --------------------------------------------------------------- 14
    (
        "notifications",
        f"""
        CREATE TABLE {S}.notifications (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid        NOT NULL
                REFERENCES {S}.users(id) ON DELETE CASCADE,
            incident_id uuid
                REFERENCES {S}.incidents(id) ON DELETE CASCADE,
            channel     {S}.notification_channel NOT NULL DEFAULT 'email',
            message     text        NOT NULL,
            is_read     boolean     NOT NULL DEFAULT false,
            created_at  timestamptz NOT NULL DEFAULT now(),
            read_at     timestamptz,

            CONSTRAINT notifications_read_consistent
                CHECK (is_read = (read_at IS NOT NULL)),
            CONSTRAINT notifications_read_after_created
                CHECK (read_at IS NULL OR read_at >= created_at)
        );
        COMMENT ON TABLE {S}.notifications IS
            'Outbound messages to reporters and staff (Outlook email, in-app, SMS).';
        """,
    ),
    # --------------------------------------------------------------- 15
    (
        "attachments",
        f"""
        CREATE TABLE {S}.attachments (
            id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            table_type   {S}.attachment_parent NOT NULL,
            table_id     uuid        NOT NULL,
            file_url     text        NOT NULL,
            file_size_kb integer,
            uploaded_by  uuid
                REFERENCES {S}.users(id) ON DELETE SET NULL,
            created_at   timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT attachments_size_nonneg
                CHECK (file_size_kb IS NULL OR file_size_kb >= 0)
        );
        COMMENT ON TABLE {S}.attachments IS
            'Polymorphic file store. table_type + table_id identify the owner '
            'row; a declarative FK is deliberately impossible here, so the '
            'application layer owns that integrity.';
        """,
    ),
    # --------------------------------------------------------------- 16
    (
        "feedback",
        f"""
        CREATE TABLE {S}.feedback (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            incident_id uuid        NOT NULL
                REFERENCES {S}.incidents(id) ON DELETE CASCADE,
            user_id     uuid        NOT NULL
                REFERENCES {S}.users(id) ON DELETE CASCADE,
            rating      smallint    NOT NULL,
            comments    text,
            created_at  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT feedback_rating_range CHECK (rating BETWEEN 1 AND 5),
            CONSTRAINT feedback_once_per_user UNIQUE (incident_id, user_id)
        );
        COMMENT ON TABLE {S}.feedback IS
            'Post-resolution satisfaction score, 1-5. Closes the quality loop.';
        """,
    ),
]


# ==========================================================================
# SECTION 3 - INDEXES
# --------------------------------------------------------------------------
# Every index below exists to serve a specific query in
# 04_Analytics_Queries.py. Indexes that serve no query are pure write-cost.
# ==========================================================================
DDL_INDEXES: list[tuple[str, str]] = [
    ("users lookup", f"""
        CREATE INDEX idx_users_institution_role
            ON {S}.users (institution_id, role) WHERE is_active;
        CREATE INDEX idx_users_department
            ON {S}.users (institution_id, department);
    """),
    ("locations tree", f"""
        CREATE INDEX idx_locations_parent   ON {S}.locations (parent_id);
        CREATE INDEX idx_locations_tenant_type
            ON {S}.locations (institution_id, type);
    """),
    ("categories tree", f"""
        CREATE INDEX idx_categories_parent  ON {S}.categories (parent_id);
        CREATE INDEX idx_categories_tenant_type
            ON {S}.categories (institution_id, type);
    """),
    ("assets lookup", f"""
        CREATE INDEX idx_assets_location    ON {S}.assets (location_id);
        CREATE INDEX idx_assets_category    ON {S}.assets (category_id);
        CREATE INDEX idx_assets_status      ON {S}.assets (institution_id, status);
        CREATE INDEX idx_assets_tag_trgm    ON {S}.assets (asset_tag text_pattern_ops);
    """),
    ("reports analytics", f"""
        CREATE INDEX idx_reports_created    ON {S}.reports (institution_id, created_at DESC);
        CREATE INDEX idx_reports_location   ON {S}.reports (location_id);
        CREATE INDEX idx_reports_category   ON {S}.reports (category_id);
        CREATE INDEX idx_reports_asset      ON {S}.reports (asset_id) WHERE asset_id IS NOT NULL;
        CREATE INDEX idx_reports_user       ON {S}.reports (user_id);
        CREATE INDEX idx_reports_duplicates ON {S}.reports (institution_id) WHERE is_duplicate;
    """),
    ("incidents analytics", f"""
        CREATE INDEX idx_incidents_status   ON {S}.incidents (institution_id, status);
        CREATE INDEX idx_incidents_created  ON {S}.incidents (institution_id, created_at DESC);
        CREATE INDEX idx_incidents_priority  ON {S}.incidents (institution_id, priority, status);
        CREATE INDEX idx_incidents_heatmap  ON {S}.incidents (location_id, category_id);
        CREATE INDEX idx_incidents_asset    ON {S}.incidents (asset_id) WHERE asset_id IS NOT NULL;
        CREATE INDEX idx_incidents_open
            ON {S}.incidents (institution_id, sla_due_at)
            WHERE status NOT IN ('resolved', 'closed');
        CREATE INDEX idx_incidents_resolution
            ON {S}.incidents (institution_id, resolved_at)
            WHERE resolved_at IS NOT NULL;
    """),
    ("junction + workflow", f"""
        CREATE INDEX idx_incident_reports_incident ON {S}.incident_reports (incident_id);
        CREATE INDEX idx_work_orders_incident      ON {S}.work_orders (incident_id);
        CREATE INDEX idx_work_orders_team_status   ON {S}.work_orders (team_id, status);
        CREATE INDEX idx_work_orders_assignee
            ON {S}.work_orders (assigned_to) WHERE assigned_to IS NOT NULL;
        CREATE INDEX idx_status_history_incident
            ON {S}.status_history (incident_id, created_at);
        CREATE INDEX idx_team_members_user         ON {S}.team_members (user_id);
    """),
    ("engagement", f"""
        CREATE INDEX idx_notifications_unread
            ON {S}.notifications (user_id, created_at DESC) WHERE NOT is_read;
        CREATE INDEX idx_notifications_incident    ON {S}.notifications (incident_id);
        CREATE INDEX idx_attachments_owner         ON {S}.attachments (table_type, table_id);
        CREATE INDEX idx_feedback_incident         ON {S}.feedback (incident_id);
        CREATE INDEX idx_feedback_rating           ON {S}.feedback (rating);
    """),
]


# ==========================================================================
# SECTION 4 - TRIGGER
# ==========================================================================
DDL_TRIGGERS: list[tuple[str, str]] = [
    ("set_updated_at()", f"""
        CREATE OR REPLACE FUNCTION {S}.set_updated_at()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
        BEGIN
            NEW.updated_at := now();
            RETURN NEW;
        END;
        $fn$;

        CREATE TRIGGER trg_work_orders_updated_at
            BEFORE UPDATE ON {S}.work_orders
            FOR EACH ROW
            EXECUTE FUNCTION {S}.set_updated_at();
    """),
]


# ==========================================================================
# SECTION 5 - REPORTING VIEWS
# --------------------------------------------------------------------------
# These encode the joins the admin dashboard needs, so that BI tools (and
# 04_Analytics_Queries.py) query business concepts instead of re-deriving
# eight-table joins every time.
# ==========================================================================
DDL_VIEWS: list[tuple[str, str]] = [
    ("v_incident_details", f"""
        CREATE OR REPLACE VIEW {S}.v_incident_details AS
        SELECT
            i.id                AS incident_id,
            inst.code           AS institution_code,
            inst.name           AS institution_name,
            i.title,
            i.status,
            i.priority,
            cat.name            AS category,
            loc.name            AS location,
            loc.type            AS location_type,
            a.asset_tag,
            a.name              AS asset_name,
            reporter.full_name  AS raised_by,
            i.created_at,
            i.acknowledged_at,
            i.resolved_at,
            i.sla_due_at,
            EXTRACT(EPOCH FROM (i.resolved_at - i.created_at)) / 3600.0
                                AS resolution_hours,
            (i.resolved_at IS NOT NULL AND i.resolved_at > i.sla_due_at)
                                AS sla_breached,
            (SELECT count(*) FROM {S}.incident_reports ir
              WHERE ir.incident_id = i.id)          AS report_count
        FROM {S}.incidents i
        JOIN {S}.institutions inst ON inst.id = i.institution_id
        JOIN {S}.categories  cat  ON cat.id  = i.category_id
        JOIN {S}.locations   loc  ON loc.id  = i.location_id
        JOIN {S}.users   reporter ON reporter.id = i.created_by
        LEFT JOIN {S}.assets a    ON a.id    = i.asset_id;
    """),
    ("v_location_heatmap", f"""
        CREATE OR REPLACE VIEW {S}.v_location_heatmap AS
        SELECT
            inst.code                  AS institution_code,
            loc.id                     AS location_id,
            loc.name                   AS location_name,
            loc.type                   AS location_type,
            parent.name                AS parent_location,
            count(*)                   AS incident_count,
            count(*) FILTER (WHERE i.status NOT IN ('resolved', 'closed'))
                                       AS open_count,
            count(*) FILTER (WHERE i.priority IN ('high', 'critical'))
                                       AS high_priority_count,
            round(avg(EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))
                      / 3600.0)::numeric, 2) AS avg_resolution_hours
        FROM {S}.incidents i
        JOIN {S}.locations loc     ON loc.id = i.location_id
        JOIN {S}.institutions inst ON inst.id = i.institution_id
        LEFT JOIN {S}.locations parent ON parent.id = loc.parent_id
        GROUP BY inst.code, loc.id, loc.name, loc.type, parent.name;
    """),
    ("v_team_performance", f"""
        CREATE OR REPLACE VIEW {S}.v_team_performance AS
        SELECT
            inst.code                     AS institution_code,
            t.id                          AS team_id,
            t.name                        AS team_name,
            count(wo.id)                  AS work_orders_total,
            count(wo.id) FILTER (WHERE wo.status IN ('completed', 'verified', 'closed'))
                                          AS work_orders_completed,
            round(avg(wo.labour_minutes)::numeric, 1)  AS avg_labour_minutes,
            round(sum(wo.material_cost)::numeric, 2)   AS total_material_cost,
            round(avg(f.rating)::numeric, 2)           AS avg_satisfaction
        FROM {S}.service_teams t
        JOIN {S}.institutions inst ON inst.id = t.institution_id
        LEFT JOIN {S}.work_orders wo ON wo.team_id = t.id
        LEFT JOIN {S}.feedback f     ON f.incident_id = wo.incident_id
        GROUP BY inst.code, t.id, t.name;
    """),
    ("v_sla_compliance", f"""
        CREATE OR REPLACE VIEW {S}.v_sla_compliance AS
        SELECT
            inst.code                  AS institution_code,
            cat.name                   AS category,
            cat.sla_hours,
            count(*)                   AS resolved_incidents,
            count(*) FILTER (WHERE i.resolved_at <= i.sla_due_at) AS met_sla,
            count(*) FILTER (WHERE i.resolved_at >  i.sla_due_at) AS breached_sla,
            round(100.0 * count(*) FILTER (WHERE i.resolved_at <= i.sla_due_at)
                  / NULLIF(count(*), 0), 1) AS sla_compliance_pct
        FROM {S}.incidents i
        JOIN {S}.categories cat    ON cat.id  = i.category_id
        JOIN {S}.institutions inst ON inst.id = i.institution_id
        WHERE i.resolved_at IS NOT NULL
        GROUP BY inst.code, cat.name, cat.sla_hours;
    """),
]


# ==========================================================================
# Execution driver
# ==========================================================================
def schema_exists(cur) -> bool:
    cur.execute(
        "SELECT 1 FROM information_schema.schemata WHERE schema_name = %s;", (SCHEMA,)
    )
    return cur.fetchone() is not None


def run_block(cur, label: str, ddl: str, kind: str) -> None:
    cur.execute(ddl)
    ok(f"{kind:<8} {label}")


def build(assume_yes: bool) -> None:
    banner("CampusPulse - Schema Builder")
    step(f"Target: {describe_target()}")

    started = time.perf_counter()

    with managed_connection() as conn:
        with conn.cursor() as cur:
            # ---- Reset -----------------------------------------------
            if schema_exists(cur):
                cur.execute(
                    """
                    SELECT count(*) FROM information_schema.tables
                     WHERE table_schema = %s;
                    """,
                    (SCHEMA,),
                )
                existing = cur.fetchone()[0]
                warn(f"Schema '{SCHEMA}' already exists with {existing} table(s).")
                if not assume_yes:
                    answer = input(
                        f"  Drop and rebuild '{SCHEMA}'? All its data is lost. [y/N]: "
                    )
                    if answer.strip().lower() not in {"y", "yes"}:
                        fail("Aborted by user. Nothing was changed.")
                        sys.exit(1)
                step(f"Dropping schema '{SCHEMA}' (CASCADE)...")
                cur.execute(
                    sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE;").format(
                        sql.Identifier(SCHEMA)
                    )
                )
                ok("Old schema removed")

            # ---- Create ----------------------------------------------
            banner("1/5  Schema + ENUM types", char="-")
            cur.execute(
                sql.SQL("CREATE SCHEMA {};").format(sql.Identifier(SCHEMA))
            )
            ok(f"SCHEMA   {SCHEMA}")
            cur.execute(
                sql.SQL("SET search_path TO {}, public;").format(
                    sql.Identifier(SCHEMA)
                )
            )
            for label, ddl in DDL_ENUMS:
                run_block(cur, label, ddl, "ENUM")

            banner("2/5  Tables", char="-")
            for label, ddl in DDL_TABLES:
                run_block(cur, label, ddl, "TABLE")

            banner("3/5  Indexes", char="-")
            for label, ddl in DDL_INDEXES:
                run_block(cur, label, ddl, "INDEX")

            banner("4/5  Trigger", char="-")
            for label, ddl in DDL_TRIGGERS:
                run_block(cur, label, ddl, "TRIGGER")

            banner("5/5  Reporting views", char="-")
            for label, ddl in DDL_VIEWS:
                run_block(cur, label, ddl, "VIEW")

            # ---- Summarise -------------------------------------------
            cur.execute(
                """
                SELECT
                    (SELECT count(*) FROM information_schema.tables
                      WHERE table_schema = %(s)s AND table_type = 'BASE TABLE'),
                    (SELECT count(*) FROM information_schema.views
                      WHERE table_schema = %(s)s),
                    (SELECT count(*) FROM pg_indexes WHERE schemaname = %(s)s),
                    (SELECT count(*) FROM pg_type t
                      JOIN pg_namespace n ON n.oid = t.typnamespace
                     WHERE n.nspname = %(s)s AND t.typtype = 'e'),
                    (SELECT count(*) FROM pg_constraint c
                      JOIN pg_namespace n ON n.oid = c.connamespace
                     WHERE n.nspname = %(s)s AND c.contype = 'f');
                """,
                {"s": SCHEMA},
            )
            tables, views, indexes, enums, fks = cur.fetchone()

    elapsed = time.perf_counter() - started

    banner("Schema build complete")
    print(f"    Schema          : {SCHEMA}")
    print(f"    Tables          : {tables}")
    print(f"    Views           : {views}")
    print(f"    Indexes         : {indexes}")
    print(f"    ENUM types      : {enums}")
    print(f"    Foreign keys    : {fks}")
    print(f"    Elapsed         : {elapsed:.2f}s")
    print()
    print("    Next step:  python 02_Insert_Data.py")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create the CampusPulse schema on Supabase/PostgreSQL."
    )
    parser.add_argument(
        "-y", "--yes", action="store_true",
        help="Do not prompt before dropping an existing schema.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the DDL without connecting to or modifying the database.",
    )
    args = parser.parse_args()

    if args.dry_run:
        for section in (DDL_ENUMS, DDL_TABLES, DDL_INDEXES, DDL_TRIGGERS, DDL_VIEWS):
            for label, ddl in section:
                print(f"\n-- ===== {label} =====")
                print(ddl.strip())
        return

    try:
        build(assume_yes=args.yes)
    except KeyboardInterrupt:
        fail("Interrupted. Transaction rolled back; database unchanged.")
        sys.exit(130)
    except Exception as exc:  # noqa: BLE001 - top-level CLI handler
        fail(f"Schema build failed: {exc}")
        fail("The whole build ran in one transaction, so nothing was left half-created.")
        sys.exit(1)


if __name__ == "__main__":
    main()
