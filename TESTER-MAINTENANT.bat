@echo off
chcp 65001 >nul
title Tester QLYGO Launcher v1.1.90
echo.
echo   ============================================
echo      Lancement du QLYGO Launcher v1.1.90
echo   ============================================
echo.
echo   [1/2] Fermeture complete de l ancienne version...
taskkill /im qlygocad.exe /f >nul 2>&1
timeout /t 2 >nul
echo   [2/2] Lancement de la version a jour...
start "" "%~dp0src-tauri\target\release\qlygocad.exe"
echo.
echo   C est lance.
echo   Verifie en bas a gauche : ca doit afficher v1.1.90.
echo.
echo   Tu peux fermer cette fenetre.
timeout /t 8 >nul
