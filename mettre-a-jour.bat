@echo off
REM ============================================================
REM  QlygoCAD - recupere la derniere version depuis GitHub
REM  Double-clique ce fichier, puis fais F5 dans ton navigateur.
REM ============================================================
cd /d "%~dp0"
echo.
echo   Mise a jour de QlygoCAD depuis GitHub...
echo.
git pull
echo.
echo   ------------------------------------------------------------
echo   Termine. Ouvre (ou rafraichis avec F5) QlygoCAD dans ton
echo   navigateur : ouvrir-qlygocad.bat  ou  poc.html
echo   ------------------------------------------------------------
echo.
pause
