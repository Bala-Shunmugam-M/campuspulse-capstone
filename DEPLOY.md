# Deploying CampusPulse for free — Vercel + Supabase

The web application (`webapp/`) runs on **Vercel's Hobby plan**; the database
stays on your existing **Supabase** project (free tier). Both are free for a
personal, non-commercial demo — check the current terms yourself: Vercel Hobby
is for non-commercial use, and free Supabase projects pause after a period of
inactivity (resume them from the dashboard).

Allow about 20 minutes. Every step that needs your accounts or your secrets is
yours to do; nothing here creates accounts or handles secrets for you.

---

## 0. Before anything goes public

| Do this | Why |
|---|---|
| **Rotate the Supabase `postgres` password** (Supabase → Project Settings → Database → Reset database password) | The old one has been exposed. A public site must not run on a leaked credential. |
| **Choose a new demo password** (12+ characters, not used anywhere else) | The repository's default demo password is public; anyone could sign in as admin. Step 2 applies the new one. |
| **Revoke any Hugging Face token you have shared** and create a fresh one with *Make calls to Inference Providers* | Only if you want the AI drafting helper on the live site. |

---

## 1. Get the two database URLs from Supabase

Supabase → your project → **Connect** → *Connection string* → **ORMs → Prisma**.

| Name | Port | Used by | Add to the end |
|---|---|---|---|
| **Transaction pooler** | 6543 | the live site on Vercel | `?pgbouncer=true&connection_limit=1&schema=compliance` |
| **Session pooler** | 5432 | migrations and scripts you run from your computer | `?schema=compliance` |

Serverless functions open many short connections; the transaction pooler is
built for that, and `pgbouncer=true` tells Prisma not to use prepared
statements it cannot keep.

> **If your network blocks ports 5432/6543** (the "site stays on the login
> page" problem on 2026-10-05 was exactly this), run step 2 from another
> network — a phone hotspot works. Vercel itself is not affected: it connects
> to Supabase cloud-to-cloud.

---

## 2. Prepare the hosted database (from your computer)

The Supabase database is already migrated and seeded. It only needs the demo
passwords rotated away from the public default:

```bash
cd webapp
SEED_PASSWORD='your-new-demo-password' \
DATABASE_URL='<session pooler URL>?schema=compliance' \
npm run reset-demo-passwords
```

It prints `Reset 120 demo accounts`. Every reset is audited and signs that
account out everywhere.

Only if `webapp/prisma/migrations/` has changed since the database was last
updated, also run:

```bash
DATABASE_URL='<session pooler URL>?schema=compliance' npx prisma migrate deploy
```

Seeding a **new, empty** database works the same way — `npm run seed` refuses
to use the public default password against anything but `localhost`, so
`SEED_PASSWORD` must be set.

---

## 3. Create the Vercel project

1. Sign up at **vercel.com** with your GitHub account (Hobby plan).
2. **Add New → Project** → import `Bala-Shunmugam-M/campuspulse-capstone`.
3. **Root Directory: `webapp`** — the repository root is the Python project.
4. Framework preset: **Next.js** (detected). Leave build settings at their
   defaults; `postinstall` runs `prisma generate` for you.
5. Before deploying, add the environment variables from step 4.

---

## 4. Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | transaction pooler URL + `?pgbouncer=true&connection_limit=1&schema=compliance` | Port **6543** |
| `AUTH_SECRET` | output of `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` | Generate a new one for production. Not `npx auth secret`: the npm package named `auth` now belongs to Better Auth |
| `AUTH_TRUST_HOST` | `true` | Lets Auth.js accept Vercel's host |
| `IP_HASH_PEPPER` | same value as in your local `webapp/.env` | Do not regenerate — it keeps rate-limit keys stable |
| `EVIDENCE_UPLOADS` | `off` | Vercel keeps no disk between requests; uploads are refused with an explanation instead of being lost |
| `HF_TOKEN` | your new Hugging Face token | Optional — omit it and the AI helper simply does not appear |

Do **not** set `AUTH_URL` (Vercel provides the host), `SIMULATION_MODE`
(refused in production anyway) or `SEED_PASSWORD` (only scripts use it).

Click **Deploy**. The first build takes a few minutes.

---

## 5. Check the live site

1. Open the `https://<project>.vercel.app` address Vercel gives you.
2. Sign in as `admin1@northgate.edu` with **your new demo password**. You land
   on the front door with Dashboard and Case queue.
3. Sign in as `reporter1@northgate.edu`: you see Report, Check a report and
   Policies — no "not permitted" page.
4. Open a case: the Evidence section says uploads are switched off.
5. If you set `HF_TOKEN`: `/report` shows *Describe what happened*.

---

## What the free setup does not give you

- **Evidence uploads** — off, as above. Turning them on needs a cloud storage
  driver (e.g. Supabase Storage); the code has a driver interface for it in
  `webapp/src/lib/storage/`.
- **Always-on database** — a paused free Supabase project makes the site fail
  to sign anyone in until you resume it.
- **Per-visitor rate limits rely on Vercel setting `X-Forwarded-For`**, which
  it does for every request. The site-wide AI cap (300 drafts an hour) applies
  regardless.

## Running it locally afterwards

Nothing changes locally: `start-site.bat`, or `npm run dev` with
`webapp/.env` pointing at local Postgres. Tests still refuse any
non-localhost database.
