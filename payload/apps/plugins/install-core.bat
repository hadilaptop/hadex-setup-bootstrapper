@echo off
setlocal
cd /d "%~dp0"
if not exist "src\wizard.js" (
  echo [install] ERROR: src\wizard.js is missing.
  exit /b 1
)
if not exist "node_modules\playwright" (
  echo [install] ERROR: bundled Playwright dependency is missing.
  exit /b 1
)
echo [install] Bundled automation dependencies are ready.
endlocal
exit /b 0
