@echo off
REM ===================================================================
REM   K2 RANGE DESK - START EVERYTHING
REM
REM   Double-click this file. It starts the desk and opens a public
REM   URL you can use from anywhere in the world.
REM
REM   WHY THIS EXISTS: the Render free tier suspended itself after its
REM   750 monthly hours ran out, and its disk was wiped on every deploy
REM   anyway -- which is what kept destroying the paper ledger. This
REM   runs the desk on THIS machine, where the ledger persists, nothing
REM   sleeps, and there is no monthly cap.
REM ===================================================================

title K2 Range Desk
cd /d "%~dp0"

echo.
echo  ============================================================
echo    K2 RANGE DESK - starting
echo  ============================================================
echo.

REM 1. The desk itself, in its own window so you can read its log.
echo  [1/2] Starting the desk on port 4173 ...
start "K2 Desk - server" cmd /k "cd /d %~dp0 && npm start"

REM Give it time to build the universe before the tunnel points at it.
echo        waiting for it to come up ...
timeout /t 25 /nobreak >nul

REM 2. The public tunnel. Free, no account, no card. The URL it prints
REM    works from your office, your phone, anywhere.
echo  [2/2] Opening a public URL ...
echo.
echo  ============================================================
echo    WATCH THE OTHER WINDOW FOR A LINE LIKE:
echo.
echo      https://something-random-1234.trycloudflare.com
echo.
echo    THAT is your URL for tomorrow. It works from anywhere.
echo    Keep BOTH windows open while you want the desk reachable.
echo.
echo    On this laptop you can also just use:  http://localhost:4173
echo  ============================================================
echo.
start "K2 Desk - public URL" cmd /k "npx --yes cloudflared tunnel --url http://localhost:4173"

timeout /t 3 /nobreak >nul
start "" http://localhost:4173

echo.
echo  Both windows are open. Closing THIS window is fine.
echo  Closing the other two stops the desk.
echo.
pause
