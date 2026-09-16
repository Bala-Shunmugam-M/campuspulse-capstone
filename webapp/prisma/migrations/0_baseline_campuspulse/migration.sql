-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "campuspulse";

-- CreateEnum
CREATE TYPE "campuspulse"."category_type" AS ENUM ('issue_category', 'asset_category');

-- CreateEnum
CREATE TYPE "campuspulse"."location_type" AS ENUM ('campus', 'building', 'floor', 'room', 'area');

-- CreateEnum
CREATE TYPE "campuspulse"."user_role" AS ENUM ('student', 'faculty', 'admin', 'technician');

-- CreateTable
CREATE TABLE "campuspulse"."categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "institution_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "category_type" "campuspulse"."category_type" NOT NULL,
    "sla_hours" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campuspulse"."institutions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "city" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campuspulse"."locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "institution_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "location_type" "campuspulse"."location_type" NOT NULL,
    "code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campuspulse"."users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "institution_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" "campuspulse"."user_role" NOT NULL DEFAULT 'student',
    "department" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_key" ON "campuspulse"."categories"("id" ASC, "institution_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "institutions_code_key" ON "campuspulse"."institutions"("code" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "locations_tenant_key" ON "campuspulse"."locations"("id" ASC, "institution_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_unique_per_tenant" ON "campuspulse"."users"("institution_id" ASC, "email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_key" ON "campuspulse"."users"("id" ASC, "institution_id" ASC);

-- AddForeignKey
ALTER TABLE "campuspulse"."categories" ADD CONSTRAINT "categories_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "campuspulse"."institutions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "campuspulse"."categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "campuspulse"."categories"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "campuspulse"."locations" ADD CONSTRAINT "locations_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "campuspulse"."institutions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "campuspulse"."locations" ADD CONSTRAINT "locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "campuspulse"."locations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "campuspulse"."users" ADD CONSTRAINT "users_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "campuspulse"."institutions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

