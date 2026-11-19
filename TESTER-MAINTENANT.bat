@echo off
chcp 65001 >/dev/null
title Tester QLYGO Launcher v1.1.78
echo.
echo   ============================================
echo      Lancement du QLYGO Launcher v1.1.78
echo   ============================================
echo.
echo   [1/2] Fermeture complete de l'ancienne version...
taskkill /im qlygocad.exe /f >/dev/null 2>&1
timeout /t 2 >/dev/null
echo   [2/2] Lancement de la version a jour...
start "" "%~dp0src-tauri\target\release\qlygocad.exe"
echo.
echo   C'est lance.
echo   Verifie en bas a gauche : ca doit afficher v1.1.78.
echo.
echo   Tu peux fermer cette fenetre.
timeout /t 8 >/dev/null
