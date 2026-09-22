@echo off
REM ===================================================================
REM   K2 RANGE DESK - START EVERYTHING
REM
REM   Double-click this. It starts the desk if it is not already
REM   running, then opens a public URL you can use from anywhere.
REM
REM   IT IS SAFE TO RUN TWICE. The first version was not: it always
REM   tried to start a second server, which died with EADDRINUSE
REM   because port 4173 was already taken -- and the error looked like
REM   a crash when the desk was in fact running perfectly.
REM ===================================================================

title K2 Range Desk
cd /d "%~dp0"

echo.
echo  ============================================================
echo    K2 RANGE DESK
echo  ============================================================
echo.

REM --- Is the desk already up? ----------------------------------------
REM Ask the port rather than assume. Starting a second server on a port
REM that is taken is what produced EADDRINUSE and a wall of red text.
set "DESK_UP="
for /f %%R in ('powershell -NoProfile -Command "try{(Invoke-WebRequest -Uri http://localhost:4173/ -TimeoutSec 5 -UseBasicParsing).StatusCode}catch{0}" 2^>nul') do set "DESK_UP=%%R"

if "%DESK_UP%"=="200" (
  echo  [1/2] The desk is ALREADY RUNNING on port 4173 - leaving it alone.
) else (
  echo  [1/2] Starting the desk on port 4173 ...
  start "K2 Desk - server" cmd /k "cd /d %~dp0 && npm start"
  echo        waiting for it to build the universe ...
  timeout /t 30 /nobreak >nul
)

REM --- The public URL -------------------------------------------------
echo  [2/2] Opening a public URL ...
echo.
echo  ============================================================
echo    WATCH THE OTHER WINDOW FOR A LINE LIKE:
echo.
echo      https://something-random-1234.trycloudflare.com
echo.
echo    THAT is your URL. It works from your office, your phone,
echo    anywhere in the world. Keep that window open.
echo.
echo    On this laptop:        http://localhost:4173
echo    On your home Wi-Fi:    http://10.99.210.36:4173
echo  ============================================================
echo.
start "K2 Desk - public URL" cmd /k "npx --yes cloudflared tunnel --url http://localhost:4173"

timeout /t 3 /nobreak >nul
start "" http://localhost:4173

echo.
echo  Closing THIS window is fine. Closing the other windows stops the desk.
echo.
pause
