@echo off
cd /d "%~dp0"
node --max-old-space-size=256 fresh-desk/server.js %*
pause
