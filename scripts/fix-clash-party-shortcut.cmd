@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "TARGET=E:\File\Clash Party\Clash Party.exe"
set "WORKDIR=E:\File\Clash Party"
set "SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Clash Party.lnk"

if not exist "%TARGET%" (
  echo [ERROR] 未找到正确程序：
  echo %TARGET%
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:APPDATA+'\Microsoft\Windows\Start Menu\Programs\Clash Party.lnk'; $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut($p); $s.TargetPath='E:\File\Clash Party\Clash Party.exe'; $s.WorkingDirectory='E:\File\Clash Party'; $s.IconLocation='E:\File\Clash Party\Clash Party.exe,0'; $s.Arguments=''; $s.Save()"

if errorlevel 1 (
  echo [ERROR] 快捷方式更新失败。
  pause
  exit /b 1
)

if exist "%SystemRoot%\System32\ie4uinit.exe" "%SystemRoot%\System32\ie4uinit.exe" -show >nul 2>nul

echo [OK] Windows 搜索快捷方式已更新：
echo %SHORTCUT%
echo -^> %TARGET%
pause
exit /b 0
