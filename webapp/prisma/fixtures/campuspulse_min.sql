CREATE SCHEMA IF NOT EXISTS campuspulse;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE campuspulse.user_role AS ENUM ('student','faculty','admin','technician');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE campuspulse.location_type AS ENUM ('campus','building','floor','room','area');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE campuspulse.category_type AS ENUM ('issue_category','asset_category');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS campuspulse.institutions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    code       text NOT NULL UNIQUE,
    domain     text NOT NULL,
    city       text,
    timezone   text NOT NULL DEFAULT 'Asia/Kolkata',
    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campuspulse.users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
    full_name      text NOT NULL,
    email          text NOT NULL,
    phone          text,
    role           campuspulse.user_role NOT NULL DEFAULT 'student',
    department     text,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_unique_per_tenant UNIQUE (institution_id, email),
    CONSTRAINT users_tenant_key              UNIQUE (id, institution_id)
);

CREATE TABLE IF NOT EXISTS campuspulse.locations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
    parent_id      uuid REFERENCES campuspulse.locations(id) ON DELETE CASCADE,
    name           text NOT NULL,
    location_type  campuspulse.location_type NOT NULL,
    code           text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT locations_tenant_key UNIQUE (id, institution_id)
);

CREATE TABLE IF NOT EXISTS campuspulse.categories (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
    parent_id      uuid REFERENCES campuspulse.categories(id) ON DELETE CASCADE,
    name           text NOT NULL,
    category_type  campuspulse.category_type NOT NULL,
    sla_hours      integer,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT categories_tenant_key UNIQUE (id, institution_id)
);
