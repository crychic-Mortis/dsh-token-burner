@echo off
setlocal
set "PLUGIN_DIR=%~dp0"

where node >nul 2>nul
if not errorlevel 1 (
  node "%PLUGIN_DIR%install.mjs" %*
  goto done
)

set "DSH_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if exist "%DSH_EXE%" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%DSH_EXE%" "%PLUGIN_DIR%install.mjs" %*
  goto done
)

echo.
echo Node.js not found, and DeepSeek Harness was not found either.
echo Install DSH or Node.js 18+ and retry.
echo.

:done
echo.
pause
