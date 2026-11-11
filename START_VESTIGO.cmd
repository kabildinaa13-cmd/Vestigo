@echo off
setlocal
cd /d "%~dp0"
start "Vestigo" /min cmd /c "npm start > vestigo.out.log 2> vestigo.err.log"
timeout /t 8 /nobreak >nul
start "" "http://localhost:3200"
endlocal
