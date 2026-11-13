@echo off
chcp 65001 >nul
title Tester QlygoCAD v1.1.62
echo.
echo   ============================================
echo      Lancement de QlygoCAD v1.1.62 (corrigee)
echo   ============================================
echo.
echo   [1/2] Fermeture complete de l'ancienne version...
taskkill /im qlygocad.exe /f >nul 2>&1
timeout /t 2 >nul
echo   [2/2] Lancement de la version corrigee...
start "" "%~dp0src-tauri\target\release\qlygocad.exe"
echo.
echo   C'est lance.
echo   Verifie en bas a gauche du launcher : ca doit afficher v1.1.62.
echo.
echo   Tu peux fermer cette fenetre.
timeout /t 8 >nul
