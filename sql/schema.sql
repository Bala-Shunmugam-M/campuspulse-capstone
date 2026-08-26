-- ======================================================================
-- CampusPulse - Reference DDL
-- ----------------------------------------------------------------------
-- AUTO-GENERATED from 01_Create_Schema.py via:
--     python 01_Create_Schema.py --dry-run > sql/schema.sql
--
-- This file is documentation, not the source of truth. The Python
-- script is authoritative; regenerate this dump after changing it.
-- ======================================================================


-- ===== user_role =====
CREATE TYPE campuspulse.user_role AS ENUM
            ('student', 'faculty', 'admin', 'technician');

-- ===== location_type =====
CREATE TYPE campuspulse.location_type AS ENUM
            ('campus', 'building', 'floor', 'room', 'area');

-- ===== category_type =====
CREATE TYPE campuspulse.category_type AS ENUM
            ('issue_category', 'asset_category');

-- ===== asset_status =====
CREATE TYPE campuspulse.asset_status AS ENUM
            ('active', 'under_maintenance', 'decommissioned', 'missing');

-- ===== incident_status =====
CREATE TYPE campuspulse.incident_status AS ENUM
            ('reported', 'acknowledged', 'in_progress', 'resolved', 'closed');

-- ===== priority_level =====
CREATE TYPE campuspulse.priority_level AS ENUM
            ('low', 'medium', 'high', 'critical');

-- ===== work_order_status =====
CREATE TYPE campuspulse.work_order_status AS ENUM
            ('assigned', 'in_progress', 'completed', 'verified', 'closed');

-- ===== attachment_parent =====
CREATE TYPE campuspulse.attachment_parent AS ENUM
            ('report', 'incident', 'work_order', 'asset');

-- ===== notification_channel =====
CREATE TYPE campuspulse.notification_channel AS ENUM
            ('in_app', 'email', 'sms');

-- ===== institutions =====
CREATE TABLE campuspulse.institutions (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            name        text        NOT NULL,
            code        text        NOT NULL,
            domain      text        NOT NULL,
            city        text,
            timezone    text        NOT NULL DEFAULT 'Asia/Kolkata',
            is_active   boolean     NOT NULL DEFAULT true,
            created_at  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT institutions_code_unique  UNIQUE (code),
            CONSTRAINT institutions_code_format  CHECK (code ~ '^[A-Z0-9]{2,10}$'),
            CONSTRAINT institutions_domain_format
                CHECK (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$')
        );
        COMMENT ON TABLE campuspulse.institutions IS
            'Tenant root. One row per college / university / campus operator.';

-- ===== users =====
CREATE TABLE campuspulse.users (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
            full_name       text        NOT NULL,
            email           text        NOT NULL,
            phone           text,
            role            campuspulse.user_role NOT NULL DEFAULT 'student',
            department      text,
            is_active       boolean     NOT NULL DEFAULT true,
            created_at      timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT users_email_unique_per_tenant UNIQUE (institution_id, email),
            CONSTRAINT users_tenant_key              UNIQUE (id, institution_id),
            CONSTRAINT users_email_format
                CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
            CONSTRAINT users_full_name_not_blank
                CHECK (length(btrim(full_name)) > 0)
        );
        COMMENT ON TABLE campuspulse.users IS
            'All actors: students, faculty, admins and technicians.';

-- ===== user_roles =====
CREATE TABLE campuspulse.user_roles (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid        NOT NULL
                REFERENCES campuspulse.users(id) ON DELETE CASCADE,
            role        campuspulse.user_role NOT NULL,
            granted_at  timestamptz NOT NULL DEFAULT now(),
            created_at  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT user_roles_unique UNIQUE (user_id, role)
        );
        COMMENT ON TABLE campuspulse.user_roles IS
            'Secondary roles. users.role holds the primary role; this table '
            'lets one person also be, say, a technician AND a faculty member.';

-- ===== service_teams =====
CREATE TABLE campuspulse.service_teams (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
            name            text        NOT NULL,
            description     text,
            contact_email   text,
            is_active       boolean     NOT NULL DEFAULT true,
            created_at      timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT service_teams_name_unique_per_tenant
                UNIQUE (institution_id, name),
            CONSTRAINT service_teams_tenant_key UNIQUE (id, institution_id)
        );
        COMMENT ON TABLE campuspulse.service_teams IS
            'Maintenance crews: Electrical, Plumbing, IT Support, Housekeeping...';

-- ===== team_members =====
CREATE TABLE campuspulse.team_members (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            team_id     uuid        NOT NULL
                REFERENCES campuspulse.service_teams(id) ON DELETE CASCADE,
            user_id     uuid        NOT NULL
                REFERENCES campuspulse.users(id) ON DELETE CASCADE,
            is_lead     boolean     NOT NULL DEFAULT false,
            joined_at   timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT team_members_unique UNIQUE (team_id, user_id)
        );
        COMMENT ON TABLE campuspulse.team_members IS
            'Junction table resolving the many-to-many between technicians and '
            'service teams. Added beyond the original UML so that work orders '
            'can be assigned to a real, verifiable member of the owning team.';

-- ===== locations =====
CREATE TABLE campuspulse.locations (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
            parent_id       uuid
                REFERENCES campuspulse.locations(id) ON DELETE CASCADE,
            name            text        NOT NULL,
            type            campuspulse.location_type NOT NULL,
            code            text        NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT locations_code_unique_per_tenant
                UNIQUE (institution_id, code),
            CONSTRAINT locations_tenant_key  UNIQUE (id, institution_id),
            CONSTRAINT locations_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
        );
        COMMENT ON TABLE campuspulse.locations IS
            'Self-referencing hierarchy: campus > building > floor > room/area. '
            'Recursive CTEs walk this tree to roll incidents up to any level.';

-- ===== categories =====
CREATE TABLE campuspulse.categories (
            id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id   uuid        NOT NULL
                REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
            parent_id        uuid
                REFERENCES campuspulse.categories(id) ON DELETE CASCADE,
            name             text        NOT NULL,
            type             campuspulse.category_type NOT NULL,
            default_priority campuspulse.priority_level NOT NULL DEFAULT 'medium',
            sla_hours        integer     NOT NULL DEFAULT 48,
            created_at       timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT categories_unique_per_tenant
                UNIQUE (institution_id, type, name),
            CONSTRAINT categories_tenant_key   UNIQUE (id, institution_id),
            CONSTRAINT categories_sla_positive CHECK (sla_hours > 0),
            CONSTRAINT categories_not_own_parent
                CHECK (parent_id IS DISTINCT FROM id)
        );
        COMMENT ON TABLE campuspulse.categories IS
            'Dual-purpose taxonomy: issue categories (what broke) and asset '
            'categories (what kind of thing it is). sla_hours drives the '
            'SLA-breach analytics.';

-- ===== assets =====
CREATE TABLE campuspulse.assets (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
            location_id     uuid        NOT NULL,
            category_id     uuid        NOT NULL,
            asset_tag       text        NOT NULL,
            name            text        NOT NULL,
            description     text,
            qr_code         text,
            status          campuspulse.asset_status NOT NULL DEFAULT 'active',
            purchased_on    date,
            created_at      timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT assets_tag_unique_per_tenant
                UNIQUE (institution_id, asset_tag),
            CONSTRAINT assets_tenant_key UNIQUE (id, institution_id),

            CONSTRAINT assets_location_same_tenant
                FOREIGN KEY (location_id, institution_id)
                REFERENCES campuspulse.locations(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT assets_category_same_tenant
                FOREIGN KEY (category_id, institution_id)
                REFERENCES campuspulse.categories(id, institution_id) ON DELETE CASCADE
        );
        COMMENT ON TABLE campuspulse.assets IS
            'Physical items bearing an Asset Identification Number / QR sticker. '
            'Scanning the QR auto-fills location and asset details on a report.';

-- ===== reports =====
CREATE TABLE campuspulse.reports (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
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
                REFERENCES campuspulse.users(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT reports_location_same_tenant
                FOREIGN KEY (location_id, institution_id)
                REFERENCES campuspulse.locations(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT reports_category_same_tenant
                FOREIGN KEY (category_id, institution_id)
                REFERENCES campuspulse.categories(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT reports_asset_same_tenant
                FOREIGN KEY (asset_id, institution_id)
                REFERENCES campuspulse.assets(id, institution_id)
                ON DELETE SET NULL (asset_id)
        );
        COMMENT ON TABLE campuspulse.reports IS
            'Raw user submissions. Many reports about the same real-world '
            'problem are later aggregated into ONE incident.';

-- ===== incidents =====
CREATE TABLE campuspulse.incidents (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            institution_id  uuid        NOT NULL
                REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
            location_id     uuid        NOT NULL,
            asset_id        uuid,
            category_id     uuid        NOT NULL,
            title           text        NOT NULL,
            description     text,
            status          campuspulse.incident_status  NOT NULL DEFAULT 'reported',
            priority        campuspulse.priority_level   NOT NULL DEFAULT 'medium',
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
                REFERENCES campuspulse.locations(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT incidents_category_same_tenant
                FOREIGN KEY (category_id, institution_id)
                REFERENCES campuspulse.categories(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT incidents_creator_same_tenant
                FOREIGN KEY (created_by, institution_id)
                REFERENCES campuspulse.users(id, institution_id) ON DELETE CASCADE,
            CONSTRAINT incidents_asset_same_tenant
                FOREIGN KEY (asset_id, institution_id)
                REFERENCES campuspulse.assets(id, institution_id)
                ON DELETE SET NULL (asset_id)
        );
        COMMENT ON TABLE campuspulse.incidents IS
            'The de-duplicated unit of work. One incident = one real-world '
            'problem, however many people reported it.';

-- ===== incident_reports =====
CREATE TABLE campuspulse.incident_reports (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            incident_id uuid        NOT NULL
                REFERENCES campuspulse.incidents(id) ON DELETE CASCADE,
            report_id   uuid        NOT NULL
                REFERENCES campuspulse.reports(id) ON DELETE CASCADE,
            is_affected boolean     NOT NULL DEFAULT true,
            created_at  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT incident_reports_pair_unique UNIQUE (incident_id, report_id),
            -- A report can only ever belong to ONE incident.
            CONSTRAINT incident_reports_report_once UNIQUE (report_id)
        );
        COMMENT ON TABLE campuspulse.incident_reports IS
            'Junction implementing many-reports-to-one-incident aggregation. '
            'is_affected marks reporters who should receive status updates.';

-- ===== work_orders =====
CREATE TABLE campuspulse.work_orders (
            id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            incident_id    uuid        NOT NULL
                REFERENCES campuspulse.incidents(id) ON DELETE CASCADE,
            team_id        uuid        NOT NULL
                REFERENCES campuspulse.service_teams(id) ON DELETE RESTRICT,
            assigned_to    uuid
                REFERENCES campuspulse.users(id) ON DELETE SET NULL,
            status         campuspulse.work_order_status NOT NULL DEFAULT 'assigned',
            priority       campuspulse.priority_level    NOT NULL DEFAULT 'medium',
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
        COMMENT ON TABLE campuspulse.work_orders IS
            'Execution record: which team/technician was dispatched, how long '
            'it took, what it cost.';

-- ===== status_history =====
CREATE TABLE campuspulse.status_history (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            incident_id uuid        NOT NULL
                REFERENCES campuspulse.incidents(id) ON DELETE CASCADE,
            status      campuspulse.incident_status NOT NULL,
            changed_by  uuid
                REFERENCES campuspulse.users(id) ON DELETE SET NULL,
            notes       text,
            created_at  timestamptz NOT NULL DEFAULT now()
        );
        COMMENT ON TABLE campuspulse.status_history IS
            'Append-only audit trail of every incident state transition. '
            'This is what makes stage-by-stage cycle-time analysis possible.';

-- ===== notifications =====
CREATE TABLE campuspulse.notifications (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid        NOT NULL
                REFERENCES campuspulse.users(id) ON DELETE CASCADE,
            incident_id uuid
                REFERENCES campuspulse.incidents(id) ON DELETE CASCADE,
            channel     campuspulse.notification_channel NOT NULL DEFAULT 'email',
            message     text        NOT NULL,
            is_read     boolean     NOT NULL DEFAULT false,
            created_at  timestamptz NOT NULL DEFAULT now(),
            read_at     timestamptz,

            CONSTRAINT notifications_read_consistent
                CHECK (is_read = (read_at IS NOT NULL)),
            CONSTRAINT notifications_read_after_created
                CHECK (read_at IS NULL OR read_at >= created_at)
        );
        COMMENT ON TABLE campuspulse.notifications IS
            'Outbound messages to reporters and staff (Outlook email, in-app, SMS).';

-- ===== attachments =====
CREATE TABLE campuspulse.attachments (
            id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            table_type   campuspulse.attachment_parent NOT NULL,
            table_id     uuid        NOT NULL,
            file_url     text        NOT NULL,
            file_size_kb integer,
            uploaded_by  uuid
                REFERENCES campuspulse.users(id) ON DELETE SET NULL,
            created_at   timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT attachments_size_nonneg
                CHECK (file_size_kb IS NULL OR file_size_kb >= 0)
        );
        COMMENT ON TABLE campuspulse.attachments IS
            'Polymorphic file store. table_type + table_id identify the owner '
            'row; a declarative FK is deliberately impossible here, so the '
            'application layer owns that integrity.';

-- ===== feedback =====
CREATE TABLE campuspulse.feedback (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            incident_id uuid        NOT NULL
                REFERENCES campuspulse.incidents(id) ON DELETE CASCADE,
            user_id     uuid        NOT NULL
                REFERENCES campuspulse.users(id) ON DELETE CASCADE,
            rating      smallint    NOT NULL,
            comments    text,
            created_at  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT feedback_rating_range CHECK (rating BETWEEN 1 AND 5),
            CONSTRAINT feedback_once_per_user UNIQUE (incident_id, user_id)
        );
        COMMENT ON TABLE campuspulse.feedback IS
            'Post-resolution satisfaction score, 1-5. Closes the quality loop.';

-- ===== users lookup =====
CREATE INDEX idx_users_institution_role
            ON campuspulse.users (institution_id, role) WHERE is_active;
        CREATE INDEX idx_users_department
            ON campuspulse.users (institution_id, department);

-- ===== locations tree =====
CREATE INDEX idx_locations_parent   ON campuspulse.locations (parent_id);
        CREATE INDEX idx_locations_tenant_type
            ON campuspulse.locations (institution_id, type);

-- ===== categories tree =====
CREATE INDEX idx_categories_parent  ON campuspulse.categories (parent_id);
        CREATE INDEX idx_categories_tenant_type
            ON campuspulse.categories (institution_id, type);

-- ===== assets lookup =====
CREATE INDEX idx_assets_location    ON campuspulse.assets (location_id);
        CREATE INDEX idx_assets_category    ON campuspulse.assets (category_id);
        CREATE INDEX idx_assets_status      ON campuspulse.assets (institution_id, status);
        CREATE INDEX idx_assets_tag_trgm    ON campuspulse.assets (asset_tag text_pattern_ops);

-- ===== reports analytics =====
CREATE INDEX idx_reports_created    ON campuspulse.reports (institution_id, created_at DESC);
        CREATE INDEX idx_reports_location   ON campuspulse.reports (location_id);
        CREATE INDEX idx_reports_category   ON campuspulse.reports (category_id);
        CREATE INDEX idx_reports_asset      ON campuspulse.reports (asset_id) WHERE asset_id IS NOT NULL;
        CREATE INDEX idx_reports_user       ON campuspulse.reports (user_id);
        CREATE INDEX idx_reports_duplicates ON campuspulse.reports (institution_id) WHERE is_duplicate;

-- ===== incidents analytics =====
CREATE INDEX idx_incidents_status   ON campuspulse.incidents (institution_id, status);
        CREATE INDEX idx_incidents_created  ON campuspulse.incidents (institution_id, created_at DESC);
        CREATE INDEX idx_incidents_priority  ON campuspulse.incidents (institution_id, priority, status);
        CREATE INDEX idx_incidents_heatmap  ON campuspulse.incidents (location_id, category_id);
        CREATE INDEX idx_incidents_asset    ON campuspulse.incidents (asset_id) WHERE asset_id IS NOT NULL;
        CREATE INDEX idx_incidents_open
            ON campuspulse.incidents (institution_id, sla_due_at)
            WHERE status NOT IN ('resolved', 'closed');
        CREATE INDEX idx_incidents_resolution
            ON campuspulse.incidents (institution_id, resolved_at)
            WHERE resolved_at IS NOT NULL;

-- ===== junction + workflow =====
CREATE INDEX idx_incident_reports_incident ON campuspulse.incident_reports (incident_id);
        CREATE INDEX idx_work_orders_incident      ON campuspulse.work_orders (incident_id);
        CREATE INDEX idx_work_orders_team_status   ON campuspulse.work_orders (team_id, status);
        CREATE INDEX idx_work_orders_assignee
            ON campuspulse.work_orders (assigned_to) WHERE assigned_to IS NOT NULL;
        CREATE INDEX idx_status_history_incident
            ON campuspulse.status_history (incident_id, created_at);
        CREATE INDEX idx_team_members_user         ON campuspulse.team_members (user_id);

-- ===== engagement =====
CREATE INDEX idx_notifications_unread
            ON campuspulse.notifications (user_id, created_at DESC) WHERE NOT is_read;
        CREATE INDEX idx_notifications_incident    ON campuspulse.notifications (incident_id);
        CREATE INDEX idx_attachments_owner         ON campuspulse.attachments (table_type, table_id);
        CREATE INDEX idx_feedback_incident         ON campuspulse.feedback (incident_id);
        CREATE INDEX idx_feedback_rating           ON campuspulse.feedback (rating);

-- ===== set_updated_at() =====
CREATE OR REPLACE FUNCTION campuspulse.set_updated_at()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
        BEGIN
            NEW.updated_at := now();
            RETURN NEW;
        END;
        $fn$;

        CREATE TRIGGER trg_work_orders_updated_at
            BEFORE UPDATE ON campuspulse.work_orders
            FOR EACH ROW
            EXECUTE FUNCTION campuspulse.set_updated_at();

-- ===== v_incident_details =====
CREATE OR REPLACE VIEW campuspulse.v_incident_details AS
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
            (SELECT count(*) FROM campuspulse.incident_reports ir
              WHERE ir.incident_id = i.id)          AS report_count
        FROM campuspulse.incidents i
        JOIN campuspulse.institutions inst ON inst.id = i.institution_id
        JOIN campuspulse.categories  cat  ON cat.id  = i.category_id
        JOIN campuspulse.locations   loc  ON loc.id  = i.location_id
        JOIN campuspulse.users   reporter ON reporter.id = i.created_by
        LEFT JOIN campuspulse.assets a    ON a.id    = i.asset_id;

-- ===== v_location_heatmap =====
CREATE OR REPLACE VIEW campuspulse.v_location_heatmap AS
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
        FROM campuspulse.incidents i
        JOIN campuspulse.locations loc     ON loc.id = i.location_id
        JOIN campuspulse.institutions inst ON inst.id = i.institution_id
        LEFT JOIN campuspulse.locations parent ON parent.id = loc.parent_id
        GROUP BY inst.code, loc.id, loc.name, loc.type, parent.name;

-- ===== v_team_performance =====
CREATE OR REPLACE VIEW campuspulse.v_team_performance AS
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
        FROM campuspulse.service_teams t
        JOIN campuspulse.institutions inst ON inst.id = t.institution_id
        LEFT JOIN campuspulse.work_orders wo ON wo.team_id = t.id
        LEFT JOIN campuspulse.feedback f     ON f.incident_id = wo.incident_id
        GROUP BY inst.code, t.id, t.name;

-- ===== v_sla_compliance =====
CREATE OR REPLACE VIEW campuspulse.v_sla_compliance AS
        SELECT
            inst.code                  AS institution_code,
            cat.name                   AS category,
            cat.sla_hours,
            count(*)                   AS resolved_incidents,
            count(*) FILTER (WHERE i.resolved_at <= i.sla_due_at) AS met_sla,
            count(*) FILTER (WHERE i.resolved_at >  i.sla_due_at) AS breached_sla,
            round(100.0 * count(*) FILTER (WHERE i.resolved_at <= i.sla_due_at)
                  / NULLIF(count(*), 0), 1) AS sla_compliance_pct
        FROM campuspulse.incidents i
        JOIN campuspulse.categories cat    ON cat.id  = i.category_id
        JOIN campuspulse.institutions inst ON inst.id = i.institution_id
        WHERE i.resolved_at IS NOT NULL
        GROUP BY inst.code, cat.name, cat.sla_hours;
