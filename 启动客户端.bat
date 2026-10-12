@echo off
cd /d "%~dp0"
echo.
echo   DLnotebook
echo   http://localhost:8080
echo.
echo   Keep this window open while playing. Press Ctrl+C to stop.
echo.
node tools\dev-server.js --open
echo.
echo   Server stopped.
pause
