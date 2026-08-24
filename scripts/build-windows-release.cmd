@echo off
setlocal EnableExtensions
chcp 65001 >nul

cd /d "%~dp0.."

echo ========================================
echo Clash Party Windows x64 release build
echo Project: %CD%
echo ========================================
echo.

if not exist "extra\sidecar\sysproxy.win32-x64-msvc.node" (
  echo [ERROR] Missing extra\sidecar\sysproxy.win32-x64-msvc.node
  echo Run the prepare step before packaging.
  pause
  exit /b 1
)

where pnpm.cmd >nul 2>nul
if not errorlevel 1 (
  call pnpm.cmd run build:win
) else if exist "C:\nvm4w\nodejs\corepack.cmd" (
  call "C:\nvm4w\nodejs\corepack.cmd" pnpm run build:win
) else (
  echo [ERROR] pnpm/corepack was not found.
  pause
  exit /b 1
)

if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. See the output above.
  pause
  exit /b 1
)

set "SETUP=dist\clash-party-windows-2.0.0-x64-setup.exe"
set "NATIVE=dist\win-unpacked\resources\sidecar\sysproxy.win32-x64-msvc.node"

if not exist "%NATIVE%" (
  echo.
  echo [ERROR] Build completed but the sysproxy native module is missing:
  echo %NATIVE%
  pause
  exit /b 1
)

if not exist "%SETUP%" (
  echo.
  echo [ERROR] Installer was not generated:
  echo %SETUP%
  pause
  exit /b 1
)

echo.
echo [OK] Build and sidecar verification completed.
echo Installer: %CD%\%SETUP%
for %%F in ("%SETUP%") do echo Size: %%~zF bytes
powershell.exe -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '%CD%\%SETUP%').Hash" 2>nul
echo.
pause
exit /b 0
