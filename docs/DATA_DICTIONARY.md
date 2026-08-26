# CampusPulse - Data Dictionary

> **Auto-generated. Do not edit by hand.**
> Regenerate with `python 05_Export_Documentation.py` after any schema change.

- **Schema:** `campuspulse`
- **Generated:** 2026-08-26 03:58 UTC
- **Source:** PostgreSQL `information_schema` + `pg_catalog` of the live database

---

## 1. Enumerated types

Controlled vocabularies enforced by the database itself. A value outside these lists cannot be stored.

| Type | Allowed values |
|---|---|
| `asset_status` | 'active', 'under_maintenance', 'decommissioned', 'missing' |
| `attachment_parent` | 'report', 'incident', 'work_order', 'asset' |
| `category_type` | 'issue_category', 'asset_category' |
| `incident_status` | 'reported', 'acknowledged', 'in_progress', 'resolved', 'closed' |
| `location_type` | 'campus', 'building', 'floor', 'room', 'area' |
| `notification_channel` | 'in_app', 'email', 'sms' |
| `priority_level` | 'low', 'medium', 'high', 'critical' |
| `user_role` | 'student', 'faculty', 'admin', 'technician' |
| `work_order_status` | 'assigned', 'in_progress', 'completed', 'verified', 'closed' |

---

## 2. Tables

| # | Table | Rows | Purpose |
|---|---|---|---|
| 1 | [`assets`](#assets) | 2,499 | Physical items bearing an Asset Identification Number / QR sticker. Scanning the QR auto-fills location and asset details on a report. |
| 2 | [`attachments`](#attachments) | 944 | Polymorphic file store. table_type + table_id identify the owner row; a declarative FK is deliberately impossible here, so the application layer owns that integrity. |
| 3 | [`categories`](#categories) | 150 | Dual-purpose taxonomy: issue categories (what broke) and asset categories (what kind of thing it is). sla_hours drives the SLA-breach analytics. |
| 4 | [`feedback`](#feedback) | 558 | Post-resolution satisfaction score, 1-5. Closes the quality loop. |
| 5 | [`incident_reports`](#incident-reports) | 5,367 | Junction implementing many-reports-to-one-incident aggregation. is_affected marks reporters who should receive status updates. |
| 6 | [`incidents`](#incidents) | 2,985 | The de-duplicated unit of work. One incident = one real-world problem, however many people reported it. |
| 7 | [`institutions`](#institutions) | 3 | Tenant root. One row per college / university / campus operator. |
| 8 | [`locations`](#locations) | 780 | Self-referencing hierarchy: campus > building > floor > room/area. Recursive CTEs walk this tree to roll incidents up to any level. |
| 9 | [`notifications`](#notifications) | 8,749 | Outbound messages to reporters and staff (Outlook email, in-app, SMS). |
| 10 | [`reports`](#reports) | 5,367 | Raw user submissions. Many reports about the same real-world problem are later aggregated into ONE incident. |
| 11 | [`service_teams`](#service-teams) | 18 | Maintenance crews: Electrical, Plumbing, IT Support, Housekeeping... |
| 12 | [`status_history`](#status-history) | 11,402 | Append-only audit trail of every incident state transition. This is what makes stage-by-stage cycle-time analysis possible. |
| 13 | [`team_members`](#team-members) | 78 | Junction table resolving the many-to-many between technicians and service teams. Added beyond the original UML so that work orders can be assigned to a real, verifiable member of the owning team. |
| 14 | [`user_roles`](#user-roles) | 47 | Secondary roles. users.role holds the primary role; this table lets one person also be, say, a technician AND a faculty member. |
| 15 | [`users`](#users) | 1,200 | All actors: students, faculty, admins and technicians. |
| 16 | [`work_orders`](#work-orders) | 2,495 | Execution record: which team/technician was dispatched, how long it took, what it cost. |

---

### assets

_Physical items bearing an Asset Identification Number / QR sticker. Scanning the QR auto-fills location and asset details on a report._

**Live row count:** 2,499

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `institution_id` | `uuid` | NO | - |
| `location_id` | `uuid` | NO | - |
| `category_id` | `uuid` | NO | - |
| `asset_tag` | `text` | NO | - |
| `name` | `text` | NO | - |
| `description` | `text` | yes | - |
| `qr_code` | `text` | yes | - |
| `status` | `asset_status` | NO | 'active'::asset_status |
| `purchased_on` | `date` | yes | - |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `assets_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `assets_category_same_tenant` | `FOREIGN KEY (category_id, institution_id) REFERENCES categories(id, institution_id) ON DELETE CASCADE` |
| FOREIGN KEY | `assets_institution_id_fkey` | `FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE` |
| FOREIGN KEY | `assets_location_same_tenant` | `FOREIGN KEY (location_id, institution_id) REFERENCES locations(id, institution_id) ON DELETE CASCADE` |
| UNIQUE | `assets_tag_unique_per_tenant` | `UNIQUE (institution_id, asset_tag)` |
| UNIQUE | `assets_tenant_key` | `UNIQUE (id, institution_id)` |

#### Indexes

- `assets_tag_unique_per_tenant` on assets USING btree (institution_id, asset_tag)
- `assets_tenant_key` on assets USING btree (id, institution_id)
- `idx_assets_category` on assets USING btree (category_id)
- `idx_assets_location` on assets USING btree (location_id)
- `idx_assets_status` on assets USING btree (institution_id, status)
- `idx_assets_tag_trgm` on assets USING btree (asset_tag text_pattern_ops)

---

### attachments

_Polymorphic file store. table_type + table_id identify the owner row; a declarative FK is deliberately impossible here, so the application layer owns that integrity._

**Live row count:** 944

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `table_type` | `attachment_parent` | NO | - |
| `table_id` | `uuid` | NO | - |
| `file_url` | `text` | NO | - |
| `file_size_kb` | `integer` | yes | - |
| `uploaded_by` | `uuid` | yes | - |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `attachments_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `attachments_uploaded_by_fkey` | `FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL` |
| CHECK | `attachments_size_nonneg` | `CHECK (((file_size_kb IS NULL) OR (file_size_kb >= 0)))` |

#### Indexes

- `idx_attachments_owner` on attachments USING btree (table_type, table_id)

---

### categories

_Dual-purpose taxonomy: issue categories (what broke) and asset categories (what kind of thing it is). sla_hours drives the SLA-breach analytics._

**Live row count:** 150

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `institution_id` | `uuid` | NO | - |
| `parent_id` | `uuid` | yes | - |
| `name` | `text` | NO | - |
| `type` | `category_type` | NO | - |
| `default_priority` | `priority_level` | NO | 'medium'::priority_level |
| `sla_hours` | `integer` | NO | 48 |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `categories_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `categories_institution_id_fkey` | `FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE` |
| FOREIGN KEY | `categories_parent_id_fkey` | `FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE` |
| UNIQUE | `categories_tenant_key` | `UNIQUE (id, institution_id)` |
| UNIQUE | `categories_unique_per_tenant` | `UNIQUE (institution_id, type, name)` |
| CHECK | `categories_not_own_parent` | `CHECK ((parent_id IS DISTINCT FROM id))` |
| CHECK | `categories_sla_positive` | `CHECK ((sla_hours > 0))` |

#### Indexes

- `categories_tenant_key` on categories USING btree (id, institution_id)
- `categories_unique_per_tenant` on categories USING btree (institution_id, type, name)
- `idx_categories_parent` on categories USING btree (parent_id)
- `idx_categories_tenant_type` on categories USING btree (institution_id, type)

---

### feedback

_Post-resolution satisfaction score, 1-5. Closes the quality loop._

**Live row count:** 558

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `incident_id` | `uuid` | NO | - |
| `user_id` | `uuid` | NO | - |
| `rating` | `smallint` | NO | - |
| `comments` | `text` | yes | - |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `feedback_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `feedback_incident_id_fkey` | `FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE` |
| FOREIGN KEY | `feedback_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE` |
| UNIQUE | `feedback_once_per_user` | `UNIQUE (incident_id, user_id)` |
| CHECK | `feedback_rating_range` | `CHECK (((rating >= 1) AND (rating <= 5)))` |

#### Indexes

- `feedback_once_per_user` on feedback USING btree (incident_id, user_id)
- `idx_feedback_incident` on feedback USING btree (incident_id)
- `idx_feedback_rating` on feedback USING btree (rating)

---

### incident_reports

_Junction implementing many-reports-to-one-incident aggregation. is_affected marks reporters who should receive status updates._

**Live row count:** 5,367

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `incident_id` | `uuid` | NO | - |
| `report_id` | `uuid` | NO | - |
| `is_affected` | `boolean` | NO | true |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `incident_reports_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `incident_reports_incident_id_fkey` | `FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE` |
| FOREIGN KEY | `incident_reports_report_id_fkey` | `FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE` |
| UNIQUE | `incident_reports_pair_unique` | `UNIQUE (incident_id, report_id)` |
| UNIQUE | `incident_reports_report_once` | `UNIQUE (report_id)` |

#### Indexes

- `idx_incident_reports_incident` on incident_reports USING btree (incident_id)
- `incident_reports_pair_unique` on incident_reports USING btree (incident_id, report_id)
- `incident_reports_report_once` on incident_reports USING btree (report_id)

---

### incidents

_The de-duplicated unit of work. One incident = one real-world problem, however many people reported it._

**Live row count:** 2,985

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `institution_id` | `uuid` | NO | - |
| `location_id` | `uuid` | NO | - |
| `asset_id` | `uuid` | yes | - |
| `category_id` | `uuid` | NO | - |
| `title` | `text` | NO | - |
| `description` | `text` | yes | - |
| `status` | `incident_status` | NO | 'reported'::incident_status |
| `priority` | `priority_level` | NO | 'medium'::priority_level |
| `created_by` | `uuid` | NO | - |
| `created_at` | `timestamp with time zone` | NO | now() |
| `acknowledged_at` | `timestamp with time zone` | yes | - |
| `resolved_at` | `timestamp with time zone` | yes | - |
| `closed_at` | `timestamp with time zone` | yes | - |
| `sla_due_at` | `timestamp with time zone` | NO | - |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `incidents_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `incidents_asset_same_tenant` | `FOREIGN KEY (asset_id, institution_id) REFERENCES assets(id, institution_id) ON DELETE SET NULL (asset_id)` |
| FOREIGN KEY | `incidents_category_same_tenant` | `FOREIGN KEY (category_id, institution_id) REFERENCES categories(id, institution_id) ON DELETE CASCADE` |
| FOREIGN KEY | `incidents_creator_same_tenant` | `FOREIGN KEY (created_by, institution_id) REFERENCES users(id, institution_id) ON DELETE CASCADE` |
| FOREIGN KEY | `incidents_institution_id_fkey` | `FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE` |
| FOREIGN KEY | `incidents_location_same_tenant` | `FOREIGN KEY (location_id, institution_id) REFERENCES locations(id, institution_id) ON DELETE CASCADE` |
| UNIQUE | `incidents_tenant_key` | `UNIQUE (id, institution_id)` |
| CHECK | `incidents_ack_after_created` | `CHECK (((acknowledged_at IS NULL) OR (acknowledged_at >= created_at)))` |
| CHECK | `incidents_closed_after_resolved` | `CHECK (((closed_at IS NULL) OR (resolved_at IS NULL) OR (closed_at >= resolved_at)))` |
| CHECK | `incidents_closure_consistent` | `CHECK (((status = 'closed'::incident_status) = (closed_at IS NOT NULL)))` |
| CHECK | `incidents_resolution_consistent` | `CHECK (((status = ANY (ARRAY['resolved'::incident_status, 'closed'::incident_status])) = (resolved_at IS NOT NULL)))` |
| CHECK | `incidents_resolved_after_created` | `CHECK (((resolved_at IS NULL) OR (resolved_at >= created_at)))` |

#### Indexes

- `idx_incidents_asset` on incidents USING btree (asset_id) WHERE (asset_id IS NOT NULL)
- `idx_incidents_created` on incidents USING btree (institution_id, created_at DESC)
- `idx_incidents_heatmap` on incidents USING btree (location_id, category_id)
- `idx_incidents_open` on incidents USING btree (institution_id, sla_due_at) WHERE (status <> ALL (ARRAY['resolved'::incident_status, 'closed'::incident_status]))
- `idx_incidents_priority` on incidents USING btree (institution_id, priority, status)
- `idx_incidents_resolution` on incidents USING btree (institution_id, resolved_at) WHERE (resolved_at IS NOT NULL)
- `idx_incidents_status` on incidents USING btree (institution_id, status)
- `incidents_tenant_key` on incidents USING btree (id, institution_id)

---

### institutions

_Tenant root. One row per college / university / campus operator._

**Live row count:** 3

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `name` | `text` | NO | - |
| `code` | `text` | NO | - |
| `domain` | `text` | NO | - |
| `city` | `text` | yes | - |
| `timezone` | `text` | NO | 'Asia/Kolkata'::text |
| `is_active` | `boolean` | NO | true |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `institutions_pkey` | `PRIMARY KEY (id)` |
| UNIQUE | `institutions_code_unique` | `UNIQUE (code)` |
| CHECK | `institutions_code_format` | `CHECK ((code ~ '^[A-Z0-9]{2,10}$'::text))` |
| CHECK | `institutions_domain_format` | `CHECK ((domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'::text))` |

#### Indexes

- `institutions_code_unique` on institutions USING btree (code)

---

### locations

_Self-referencing hierarchy: campus > building > floor > room/area. Recursive CTEs walk this tree to roll incidents up to any level._

**Live row count:** 780

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `institution_id` | `uuid` | NO | - |
| `parent_id` | `uuid` | yes | - |
| `name` | `text` | NO | - |
| `type` | `location_type` | NO | - |
| `code` | `text` | NO | - |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `locations_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `locations_institution_id_fkey` | `FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE` |
| FOREIGN KEY | `locations_parent_id_fkey` | `FOREIGN KEY (parent_id) REFERENCES locations(id) ON DELETE CASCADE` |
| UNIQUE | `locations_code_unique_per_tenant` | `UNIQUE (institution_id, code)` |
| UNIQUE | `locations_tenant_key` | `UNIQUE (id, institution_id)` |
| CHECK | `locations_not_own_parent` | `CHECK ((parent_id IS DISTINCT FROM id))` |

#### Indexes

- `idx_locations_parent` on locations USING btree (parent_id)
- `idx_locations_tenant_type` on locations USING btree (institution_id, type)
- `locations_code_unique_per_tenant` on locations USING btree (institution_id, code)
- `locations_tenant_key` on locations USING btree (id, institution_id)

---

### notifications

_Outbound messages to reporters and staff (Outlook email, in-app, SMS)._

**Live row count:** 8,749

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `user_id` | `uuid` | NO | - |
| `incident_id` | `uuid` | yes | - |
| `channel` | `notification_channel` | NO | 'email'::notification_channel |
| `message` | `text` | NO | - |
| `is_read` | `boolean` | NO | false |
| `created_at` | `timestamp with time zone` | NO | now() |
| `read_at` | `timestamp with time zone` | yes | - |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `notifications_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `notifications_incident_id_fkey` | `FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE` |
| FOREIGN KEY | `notifications_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE` |
| CHECK | `notifications_read_after_created` | `CHECK (((read_at IS NULL) OR (read_at >= created_at)))` |
| CHECK | `notifications_read_consistent` | `CHECK ((is_read = (read_at IS NOT NULL)))` |

#### Indexes

- `idx_notifications_incident` on notifications USING btree (incident_id)
- `idx_notifications_unread` on notifications USING btree (user_id, created_at DESC) WHERE (NOT is_read)

---

### reports

_Raw user submissions. Many reports about the same real-world problem are later aggregated into ONE incident._

**Live row count:** 5,367

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `institution_id` | `uuid` | NO | - |
| `user_id` | `uuid` | NO | - |
| `asset_id` | `uuid` | yes | - |
| `location_id` | `uuid` | NO | - |
| `category_id` | `uuid` | NO | - |
| `description` | `text` | NO | - |
| `photo_url` | `text` | yes | - |
| `reported_via` | `text` | NO | 'qr_scan'::text |
| `is_duplicate` | `boolean` | NO | false |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `reports_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `reports_asset_same_tenant` | `FOREIGN KEY (asset_id, institution_id) REFERENCES assets(id, institution_id) ON DELETE SET NULL (asset_id)` |
| FOREIGN KEY | `reports_category_same_tenant` | `FOREIGN KEY (category_id, institution_id) REFERENCES categories(id, institution_id) ON DELETE CASCADE` |
| FOREIGN KEY | `reports_institution_id_fkey` | `FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE` |
| FOREIGN KEY | `reports_location_same_tenant` | `FOREIGN KEY (location_id, institution_id) REFERENCES locations(id, institution_id) ON DELETE CASCADE` |
| FOREIGN KEY | `reports_user_same_tenant` | `FOREIGN KEY (user_id, institution_id) REFERENCES users(id, institution_id) ON DELETE CASCADE` |
| UNIQUE | `reports_tenant_key` | `UNIQUE (id, institution_id)` |
| CHECK | `reports_channel_valid` | `CHECK ((reported_via = ANY (ARRAY['qr_scan'::text, 'manual'::text, 'web'::text, 'mobile_app'::text, 'email'::text])))` |
| CHECK | `reports_description_not_blank` | `CHECK ((length(btrim(description)) > 0))` |

#### Indexes

- `idx_reports_asset` on reports USING btree (asset_id) WHERE (asset_id IS NOT NULL)
- `idx_reports_category` on reports USING btree (category_id)
- `idx_reports_created` on reports USING btree (institution_id, created_at DESC)
- `idx_reports_duplicates` on reports USING btree (institution_id) WHERE is_duplicate
- `idx_reports_location` on reports USING btree (location_id)
- `idx_reports_user` on reports USING btree (user_id)
- `reports_tenant_key` on reports USING btree (id, institution_id)

---

### service_teams

_Maintenance crews: Electrical, Plumbing, IT Support, Housekeeping..._

**Live row count:** 18

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `institution_id` | `uuid` | NO | - |
| `name` | `text` | NO | - |
| `description` | `text` | yes | - |
| `contact_email` | `text` | yes | - |
| `is_active` | `boolean` | NO | true |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `service_teams_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `service_teams_institution_id_fkey` | `FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE` |
| UNIQUE | `service_teams_name_unique_per_tenant` | `UNIQUE (institution_id, name)` |
| UNIQUE | `service_teams_tenant_key` | `UNIQUE (id, institution_id)` |

#### Indexes

- `service_teams_name_unique_per_tenant` on service_teams USING btree (institution_id, name)
- `service_teams_tenant_key` on service_teams USING btree (id, institution_id)

---

### status_history

_Append-only audit trail of every incident state transition. This is what makes stage-by-stage cycle-time analysis possible._

**Live row count:** 11,402

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `incident_id` | `uuid` | NO | - |
| `status` | `incident_status` | NO | - |
| `changed_by` | `uuid` | yes | - |
| `notes` | `text` | yes | - |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `status_history_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `status_history_changed_by_fkey` | `FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL` |
| FOREIGN KEY | `status_history_incident_id_fkey` | `FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE` |

#### Indexes

- `idx_status_history_incident` on status_history USING btree (incident_id, created_at)

---

### team_members

_Junction table resolving the many-to-many between technicians and service teams. Added beyond the original UML so that work orders can be assigned to a real, verifiable member of the owning team._

**Live row count:** 78

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `team_id` | `uuid` | NO | - |
| `user_id` | `uuid` | NO | - |
| `is_lead` | `boolean` | NO | false |
| `joined_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `team_members_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `team_members_team_id_fkey` | `FOREIGN KEY (team_id) REFERENCES service_teams(id) ON DELETE CASCADE` |
| FOREIGN KEY | `team_members_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE` |
| UNIQUE | `team_members_unique` | `UNIQUE (team_id, user_id)` |

#### Indexes

- `idx_team_members_user` on team_members USING btree (user_id)
- `team_members_unique` on team_members USING btree (team_id, user_id)

---

### user_roles

_Secondary roles. users.role holds the primary role; this table lets one person also be, say, a technician AND a faculty member._

**Live row count:** 47

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `user_id` | `uuid` | NO | - |
| `role` | `user_role` | NO | - |
| `granted_at` | `timestamp with time zone` | NO | now() |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `user_roles_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `user_roles_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE` |
| UNIQUE | `user_roles_unique` | `UNIQUE (user_id, role)` |

#### Indexes

- `user_roles_unique` on user_roles USING btree (user_id, role)

---

### users

_All actors: students, faculty, admins and technicians._

**Live row count:** 1,200

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `institution_id` | `uuid` | NO | - |
| `full_name` | `text` | NO | - |
| `email` | `text` | NO | - |
| `phone` | `text` | yes | - |
| `role` | `user_role` | NO | 'student'::user_role |
| `department` | `text` | yes | - |
| `is_active` | `boolean` | NO | true |
| `created_at` | `timestamp with time zone` | NO | now() |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `users_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `users_institution_id_fkey` | `FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE` |
| UNIQUE | `users_email_unique_per_tenant` | `UNIQUE (institution_id, email)` |
| UNIQUE | `users_tenant_key` | `UNIQUE (id, institution_id)` |
| CHECK | `users_email_format` | `CHECK ((email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::text))` |
| CHECK | `users_full_name_not_blank` | `CHECK ((length(btrim(full_name)) > 0))` |

#### Indexes

- `idx_users_department` on users USING btree (institution_id, department)
- `idx_users_institution_role` on users USING btree (institution_id, role) WHERE is_active
- `users_email_unique_per_tenant` on users USING btree (institution_id, email)
- `users_tenant_key` on users USING btree (id, institution_id)

---

### work_orders

_Execution record: which team/technician was dispatched, how long it took, what it cost._

**Live row count:** 2,495

#### Columns

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | NO | gen_random_uuid() |
| `incident_id` | `uuid` | NO | - |
| `team_id` | `uuid` | NO | - |
| `assigned_to` | `uuid` | yes | - |
| `status` | `work_order_status` | NO | 'assigned'::work_order_status |
| `priority` | `priority_level` | NO | 'medium'::priority_level |
| `notes` | `text` | yes | - |
| `labour_minutes` | `integer` | yes | - |
| `material_cost` | `numeric(10,2)` | yes | - |
| `created_at` | `timestamp with time zone` | NO | now() |
| `updated_at` | `timestamp with time zone` | NO | now() |
| `completed_at` | `timestamp with time zone` | yes | - |

#### Constraints

| Kind | Name | Definition |
|---|---|---|
| PRIMARY KEY | `work_orders_pkey` | `PRIMARY KEY (id)` |
| FOREIGN KEY | `work_orders_assigned_to_fkey` | `FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL` |
| FOREIGN KEY | `work_orders_incident_id_fkey` | `FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE` |
| FOREIGN KEY | `work_orders_team_id_fkey` | `FOREIGN KEY (team_id) REFERENCES service_teams(id) ON DELETE RESTRICT` |
| CHECK | `work_orders_completed_after_created` | `CHECK (((completed_at IS NULL) OR (completed_at >= created_at)))` |
| CHECK | `work_orders_completion_consistent` | `CHECK (((status = ANY (ARRAY['completed'::work_order_status, 'verified'::work_order_status, 'closed'::work_order_status])) = (completed_at IS NOT NULL)))` |
| CHECK | `work_orders_cost_nonneg` | `CHECK (((material_cost IS NULL) OR (material_cost >= (0)::numeric)))` |
| CHECK | `work_orders_labour_nonneg` | `CHECK (((labour_minutes IS NULL) OR (labour_minutes >= 0)))` |

#### Indexes

- `idx_work_orders_assignee` on work_orders USING btree (assigned_to) WHERE (assigned_to IS NOT NULL)
- `idx_work_orders_incident` on work_orders USING btree (incident_id)
- `idx_work_orders_team_status` on work_orders USING btree (team_id, status)

---

## 3. Reporting views

Pre-joined projections used by the analytics layer and any BI tool pointed at this schema.

### v_incident_details

**Rows:** 2,985

| Column | Type |
|---|---|
| `incident_id` | `uuid` |
| `institution_code` | `text` |
| `institution_name` | `text` |
| `title` | `text` |
| `status` | `incident_status` |
| `priority` | `priority_level` |
| `category` | `text` |
| `location` | `text` |
| `location_type` | `location_type` |
| `asset_tag` | `text` |
| `asset_name` | `text` |
| `raised_by` | `text` |
| `created_at` | `timestamp with time zone` |
| `acknowledged_at` | `timestamp with time zone` |
| `resolved_at` | `timestamp with time zone` |
| `sla_due_at` | `timestamp with time zone` |
| `resolution_hours` | `numeric` |
| `sla_breached` | `boolean` |
| `report_count` | `bigint` |

---

### v_location_heatmap

**Rows:** 631

| Column | Type |
|---|---|
| `institution_code` | `text` |
| `location_id` | `uuid` |
| `location_name` | `text` |
| `location_type` | `location_type` |
| `parent_location` | `text` |
| `incident_count` | `bigint` |
| `open_count` | `bigint` |
| `high_priority_count` | `bigint` |
| `avg_resolution_hours` | `numeric` |

---

### v_sla_compliance

**Rows:** 63

| Column | Type |
|---|---|
| `institution_code` | `text` |
| `category` | `text` |
| `sla_hours` | `integer` |
| `resolved_incidents` | `bigint` |
| `met_sla` | `bigint` |
| `breached_sla` | `bigint` |
| `sla_compliance_pct` | `numeric` |

---

### v_team_performance

**Rows:** 18

| Column | Type |
|---|---|
| `institution_code` | `text` |
| `team_id` | `uuid` |
| `team_name` | `text` |
| `work_orders_total` | `bigint` |
| `work_orders_completed` | `bigint` |
| `avg_labour_minutes` | `numeric` |
| `total_material_cost` | `numeric` |
| `avg_satisfaction` | `numeric` |

---
