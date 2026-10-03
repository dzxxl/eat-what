@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   Server starting... Please keep this window open.
echo   On your phone (same Wi-Fi), open the address
echo   shown below, for example http://192.168.1.5:8080
echo ================================================
where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server 8080
) else (
  python -m http.server 8080
)
pause
