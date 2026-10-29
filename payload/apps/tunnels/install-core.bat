@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [install] Bundled Node.js runtime is not available in PATH.
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [install] Bundled npm is not available in PATH.
  exit /b 1
)
if not exist "src\wizard.js" (
  echo [install] ERROR: src\wizard.js is missing.
  exit /b 1
)
echo [install] Preparing Hadex automation dependencies...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo [install] ERROR: Dependency installation failed.
  exit /b 1
)
echo [install] Dependencies ready.
endlocal
exit /b 0
