@echo off
cd /d "%~dp0"
if not defined BLOB_READ_WRITE_TOKEN if exist "..\xcatarina\.env.local" (
  for /f "usebackq tokens=1,* delims==" %%A in ("..\xcatarina\.env.local") do if "%%A"=="BLOB_READ_WRITE_TOKEN" set "XC_BLOB_TOKEN=%%B"
)
if not defined BLOB_READ_WRITE_TOKEN if defined XC_BLOB_TOKEN set "BLOB_READ_WRITE_TOKEN=%XC_BLOB_TOKEN:"=%"
set "XC_BLOB_TOKEN="
echo A iniciar o xCatarina Timelapse Studio local...
echo Mantem esta janela aberta enquanto o timelapse esta a ser criado.
if defined BLOB_READ_WRITE_TOKEN echo Publicacao ligada ao Blob store do site publico.
start "" http://localhost:3000
npm run dev
pause
