@echo off
cd /d "%~dp0"
echo A iniciar o xCatarina Timelapse Studio local...
echo Mantem esta janela aberta enquanto o timelapse esta a ser criado.
start "" http://localhost:3000
npm run dev
pause
