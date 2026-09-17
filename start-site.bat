@echo off
setlocal enabledelayedexpansion
title CampusPulse - start site

REM ---------------------------------------------------------------------------
REM  One-click launcher: brings up Postgres, starts the Next.js dev server, and
REM  opens the browser once the site actually answers.
REM
REM  This is for a local Windows setup running Postgres directly, without
REM  Docker. On a machine where Docker works, docker-compose.yml is the shorter
REM  route and this file is unnecessary.
REM
REM  The paths below are machine-specific: set them once for yours. Everything
REM  else resolves from this script's own location (%~dp0), so the file works
REM  from the main checkout or a worktree without further editing.
REM ---------------------------------------------------------------------------

set "PGBIN=D:\pg-extract\pgsql\bin"
set "PGDATA_DIR=D:\pgsql-data"
set "PGPORT=5433"
set "PGUSER_NAME=compliance"
set "PGDB=compliance"
set "SITE_PORT=3100"
set "SITE_URL=http://localhost:%SITE_PORT%"

set "WEBAPP=%~dp0webapp"

echo.
echo   CampusPulse
echo   -----------
echo   webapp    %WEBAPP%
echo   database  localhost:%PGPORT%
echo   site      %SITE_URL%
echo.

REM ---- sanity checks ---------------------------------------------------------

if not exist "%WEBAPP%\package.json" (
  echo [X] No webapp found at "%WEBAPP%".
  echo     Put this file in the repository root, beside the webapp folder.
  goto :fail
)

if not exist "%PGBIN%\pg_ctl.exe" (
  echo [X] Postgres not found at "%PGBIN%".
  echo     Edit PGBIN at the top of this file.
  goto :fail
)

if not exist "%WEBAPP%\.env" (
  echo [X] "%WEBAPP%\.env" is missing - it is git-ignored and never committed.
  echo     Copy it from another checkout, or see webapp\.env.example.
  echo     Do NOT regenerate IP_HASH_PEPPER: it breaks correlation of
  echo     historical reporter IP hashes.
  goto :fail
)

if not exist "%WEBAPP%\node_modules" (
  echo [!] node_modules missing - installing, this takes a few minutes...
  pushd "%WEBAPP%"
  call npm install
  if errorlevel 1 ( popd & echo [X] npm install failed. & goto :fail )
  call npx prisma generate
  if errorlevel 1 ( popd & echo [X] prisma generate failed. & goto :fail )
  popd
)

REM ---- database --------------------------------------------------------------

"%PGBIN%\pg_ctl.exe" -D "%PGDATA_DIR%" status >nul 2>&1
if errorlevel 1 (
  echo [1/3] Starting Postgres on port %PGPORT%...
  REM pg_ctl holds the console pipe open, so run it detached and poll instead
  REM of waiting on it - it usually started even when it looks stuck.
  start "" /B "%PGBIN%\pg_ctl.exe" -D "%PGDATA_DIR%" -o "-p %PGPORT%" -l "%PGDATA_DIR%\server.log" start
) else (
  echo [1/3] Postgres already running.
)

REM After an unclean shutdown Postgres replays WAL and refuses connections with
REM "the database system is starting up" for ~20s. Poll rather than assume.
set "PGPASSWORD=localdev"
set /a tries=0
:waitdb
set /a tries+=1
"%PGBIN%\psql.exe" -h localhost -p %PGPORT% -U %PGUSER_NAME% -d %PGDB% -c "SELECT 1" >nul 2>&1
if not errorlevel 1 goto dbready
if !tries! geq 24 (
  echo [X] Postgres did not accept connections after 2 minutes.
  echo     Check "%PGDATA_DIR%\server.log".
  goto :fail
)
echo      waiting for the database... ^(!tries!^)
timeout /t 5 /nobreak >nul
goto waitdb

:dbready
set "PGPASSWORD="
echo      database ready.

REM ---- dev server ------------------------------------------------------------

REM Don't start a second one on an occupied port: next dev would either fail or
REM quietly move to another port, and the browser would open on the wrong one.
curl.exe -s -o nul "%SITE_URL%/login"
if not errorlevel 1 (
  echo [2/3] Dev server already running on port %SITE_PORT%.
  goto webready
)

echo [2/3] Starting the dev server on port %SITE_PORT%...
REM Its own window, so it keeps running after this script exits and can be
REM stopped with Ctrl-C or by closing that window.
start "CampusPulse dev server" cmd /k "cd /d "%WEBAPP%" && npm run dev"

echo [3/3] Waiting for the site to answer...
set /a tries=0
:waitweb
set /a tries+=1
curl.exe -s -o nul "%SITE_URL%/login"
if not errorlevel 1 goto webready
if !tries! geq 40 (
  echo [X] The site did not answer after 2 minutes.
  echo     Look at the "CampusPulse dev server" window for the error.
  goto :fail
)
timeout /t 3 /nobreak >nul
goto waitweb

:webready
echo      site is up.
echo.
start "" "%SITE_URL%/login"

echo   Opened %SITE_URL%/login
echo.
echo   Sign in with any seeded account, for example:
echo     admin1@northgate.edu        sees both dashboards
echo     officer1@northgate.edu      case queue and workload
echo     reporter1@northgate.edu     can file a report
echo   The seeded passphrase is printed by "npm run seed".
echo.
echo   To stop: close the "CampusPulse dev server" window, then run
echo     "%PGBIN%\pg_ctl.exe" -D "%PGDATA_DIR%" -m fast -w stop
echo   Shutting Postgres down cleanly avoids a WAL replay on the next start.
echo.
pause
exit /b 0

:fail
echo.
echo   Startup aborted.
echo.
pause
exit /b 1
