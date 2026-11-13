@echo off
rem ============================================================
rem  marvis-site start script  (port 50001, auto-replace old instance)
rem
rem  Usage:
rem    start-server.bat            start, keep window, pause at end
rem    start-server.bat /nopause   start, no pause (for automation)
rem    start-server.bat /dryrun    check port only, do not start
rem
rem  The service runs in its OWN console window. The launcher exits
rem  as soon as the port answers, so a caller shell is never blocked.
rem ============================================================
setlocal

rem freeze the script directory BEFORE any shift, because shift also
rem moves %0 on this cmd build and would break %~dp0 afterwards.
set "BATDIR=%~dp0"

set "NP="
set "DRY="
set "RC=0"

:parse
if "%~1"=="" goto :run
if /i "%~1"=="/nopause" ( set "NP=1" & shift & goto :parse )
if /i "%~1"=="/dryrun"  ( set "DRY=-DryRun" & shift & goto :parse )
if /i "%~1"=="/?" (
  echo Usage: start-server.bat [/nopause] [/dryrun]
  exit /b 0
)
shift
goto :parse

:run
set "PS1=%BATDIR%tools\launch_server.ps1"
if not exist "%PS1%" (
  echo [fail] launcher not found: %PS1%
  set "RC=1"
  goto :end
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %DRY%
set "RC=%ERRORLEVEL%"

:end
if defined DRY (
  echo [done] dry run finished, exit code %RC%
  goto :tail
)
if "%RC%"=="0" (
  echo [done] marvis-site is running at http://127.0.0.1:50001/
) else (
  echo [done] startup failed, exit code %RC%
)
:tail
if not defined NP pause
exit /b %RC%
