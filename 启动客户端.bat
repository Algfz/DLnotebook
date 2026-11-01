@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  DLnotebook launcher (Windows)
rem  ASCII only on purpose: cmd parses batch files byte-wise, so
rem  non-ASCII text breaks on machines with a different code page.
rem  Line endings MUST be CRLF (enforced by .gitattributes).
rem ============================================================

set "RUNTIME="
where node >nul 2>nul
if not errorlevel 1 set "RUNTIME=node"
if defined RUNTIME goto run_node

if exist "%ProgramFiles%\nodejs\node.exe" set "RUNTIME=%ProgramFiles%\nodejs\node.exe"
if defined RUNTIME goto run_node
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "RUNTIME=%ProgramFiles(x86)%\nodejs\node.exe"
if defined RUNTIME goto run_node
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "RUNTIME=%LocalAppData%\Programs\nodejs\node.exe"
if defined RUNTIME goto run_node

set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py"
if defined PY goto run_py
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if defined PY goto run_py

goto no_runtime

rem ------------------------------------------------------------
:run_node
echo.
echo   DLnotebook
echo   address: http://localhost:8080
echo.
echo   runtime: %RUNTIME%
echo   Keep this window open while playing. Press Ctrl+C to stop.
echo.
"%RUNTIME%" tools\dev-server.js --open
echo.
echo   Server stopped.
pause
exit /b 0

rem ------------------------------------------------------------
:run_py
echo.
echo   DLnotebook
echo   address: http://localhost:8080
echo.
echo   Node.js not found - falling back to a Python static server.
echo   (same game, only without the request log)
echo.
echo   Keep this window open while playing. Press Ctrl+C to stop.
echo.
start "" http://localhost:8080
%PY% -m http.server 8080
echo.
echo   Server stopped.
pause
exit /b 0

rem ------------------------------------------------------------
:no_runtime
echo.
echo   ==========================================================
echo    Node.js is NOT installed on this computer.
echo.
echo    How to fix (about 1 minute):
echo      1. open   https://nodejs.org/zh-cn
echo      2. download the LTS version, run the installer,
echo         and keep the default options all the way through
echo      3. close this window and double-click this file again
echo.
echo    NOTE: after installing you MUST open this window again,
echo          otherwise the new node is not in PATH yet.
echo   ==========================================================
echo.
pause
exit /b 1
