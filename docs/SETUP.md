# CampusPulse — Setup Guide

Step-by-step instructions to get from a fresh clone to a fully loaded database
and a running analytics suite. Budget about 10 minutes.

---

## Prerequisites

| Requirement | Version | Check with |
|---|---|---|
| Python | 3.10 or newer | `python --version` |
| Git | any recent | `git --version` |
| Supabase account | free tier is enough | [supabase.com](https://supabase.com) |
| VS Code | optional but recommended | — |

> **Windows note:** if `python --version` opens the Microsoft Store, Python is
> not actually installed. Install it from [python.org](https://www.python.org/downloads/)
> or run `winget install Python.Python.3.12`, then open a **new** terminal.

---

## Step 1 — Get the code

```bash
git clone https://github.com/YOUR_USERNAME/campuspulse-capstone.git
cd campuspulse-capstone
```

---

## Step 2 — Create a virtual environment

A virtual environment keeps this project's packages separate from everything
else on your machine.

**Windows (PowerShell):**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks the activation script, allow it for the current session
only:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

**macOS / Linux:**

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Your prompt should now be prefixed with `(.venv)`.

---

## Step 3 — Install dependencies

```bash
pip install -r requirements.txt
```

This installs four packages:

| Package | Why |
|---|---|
| `psycopg2-binary` | The PostgreSQL driver. Every database call goes through it. |
| `python-dotenv` | Loads `.env` so credentials never appear in source. |
| `Faker` | Realistic names, emails and phone numbers. |
| `tabulate` | Renders query results as readable console tables. |

---

## Step 4 — Create a Supabase project

1. Sign in at [supabase.com](https://supabase.com) and click **New project**.
2. Choose a name, set a **strong database password**, and pick the region
   closest to you.
3. Wait for provisioning (roughly two minutes).

---

## Step 5 — Collect your connection details

In the Supabase dashboard go to **Project Settings → Database**. You need:

| Field | Where it appears | Example |
|---|---|---|
| Host | Connection info | `db.abcdefgh.supabase.co` |
| Port | Connection info | `5432` |
| Database | Connection info | `postgres` |
| User | Connection info | `postgres` |
| Password | the one you set in Step 4 | — |

---

## Step 6 — Create your `.env`

**Windows:**

```powershell
copy .env.example .env
```

**macOS / Linux:**

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```ini
DB_HOST=db.abcdefgh.supabase.co
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres
DB_PASSWORD=your-actual-password
DB_SSLMODE=require
DB_SCHEMA=campuspulse
DATA_SCALE=medium
RANDOM_SEED=42
HISTORY_MONTHS=18
```

> `.env` is listed in `.gitignore` and will never be committed. Never paste real
> credentials into a source file, an issue, or a chat message.

---

## Step 7 — Test the connection

```bash
python db_config.py
```

Expected:

```
  [OK] Connected as 'postgres' to database 'postgres'
  [OK] PostgreSQL 17.6
```

### If it fails

| Symptom | Cause | Fix |
|---|---|---|
| `could not translate host name` | Supabase direct hosts are IPv6-only on newer projects; your network is IPv4-only. | Go to **Database → Connection Pooling**, switch to **Session** mode, and copy the values into `POOLER_HOST`, `POOLER_PORT` and `POOLER_USER` in `.env`. The scripts fall back automatically. |
| `password authentication failed` | Wrong password. | Reset it under **Settings → Database → Reset database password**. |
| `Connection timed out` | Your campus or corporate firewall blocks outbound port 5432. | Try a mobile hotspot, or use the pooler on port 6543. |
| `Project is paused` | Free-tier projects sleep after inactivity. | Open the dashboard and resume the project. |

---

## Step 8 — Run the pipeline

Either run the whole thing at once:

```bash
python 00_Run_All.py --yes
```

…or step through it, which is better the first time because you see what each
stage does:

```bash
python 01_Create_Schema.py        # 16 tables, 9 ENUMs, 68 indexes, 4 views
python 02_Insert_Data.py          # ~42,000 rows of synthetic activity
python 03_Verify_Data.py          # 47 integrity + plausibility checks
python 04_Analytics_Queries.py    # 14 business questions answered
python 05_Export_Documentation.py # regenerates docs/DATA_DICTIONARY.md
```

Every script accepts `--help`.

---

## Step 9 — Inspect the data in Supabase

1. Open your project and go to **Table Editor**.
2. **Important:** use the schema dropdown at the top-left — it defaults to
   `public`. Switch it to **`campuspulse`**.

All 16 tables and 4 views appear there. You can also use the **SQL Editor**:

```sql
SELECT * FROM campuspulse.v_incident_details
 WHERE sla_breached
 ORDER BY resolution_hours DESC
 LIMIT 20;
```

---

## Step 10 — VS Code

Open the folder in VS Code. It picks up `.vscode/` automatically:

- **`settings.json`** points the Python extension at `.venv`.
- **`extensions.json`** prompts you to install the recommended extensions.
- **`launch.json`** adds six ready-made **Run and Debug** configurations, so you
  can run any stage from the sidebar and set breakpoints inside the generator.

If the interpreter is wrong: `Ctrl+Shift+P` → **Python: Select Interpreter** →
choose the one inside `./.venv`.

---

## Common tasks

| Task | Command |
|---|---|
| Rebuild everything from scratch | `python 00_Run_All.py --yes` |
| Load a smaller dataset | `python 02_Insert_Data.py --scale small --yes` |
| Load a much larger dataset | `python 02_Insert_Data.py --scale large --yes` |
| Generate a *different* dataset | `python 02_Insert_Data.py --seed 1234 --yes` |
| Reproduce an exact dataset | `python 02_Insert_Data.py --yes --seed 42 --anchor 2026-08-26T00:00:00Z` |
| Hash the dataset to compare runs | `python 03_Verify_Data.py --fingerprint` |
| Empty the tables, keep the schema | `python 02_Insert_Data.py --truncate-only` |
| Run one analytics query | `python 04_Analytics_Queries.py --only 12` |
| List the analytics questions | `python 04_Analytics_Queries.py --list` |
| Export results to CSV | `python 04_Analytics_Queries.py --export out/` |
| Inspect a query plan | `python 04_Analytics_Queries.py --explain 2` |
| Print the DDL without connecting | `python 01_Create_Schema.py --dry-run` |

---

## Resetting completely

`01_Create_Schema.py` drops and rebuilds the `campuspulse` schema. Because
CampusPulse lives in its own schema, this never touches Supabase's `public`,
`auth` or `storage` schemas:

```bash
python 01_Create_Schema.py --yes
python 02_Insert_Data.py --yes
```
