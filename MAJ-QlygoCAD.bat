@echo off
chcp 65001 >nul
title Mise a jour de QlygoCAD
cd /d "%~dp0"

echo.
echo   ============================================
echo      Mise a jour de QlygoCAD
echo   ============================================
echo.
echo   Fermeture de QlygoCAD s'il est ouvert...
taskkill /im qlygocad.exe /f >nul 2>&1

echo   [1/3] Recuperation de la derniere version du code...
git fetch origin main || goto err
git reset --hard origin/main || goto err

echo   [2/3] Verification des dependances...
call npm install >nul 2>&1

echo   [3/3] Compilation de l'application (1 a 2 min, patiente)...
call npm run tauri:build -- --no-bundle || goto err

echo.
echo   ============================================
echo      TERMINE ! Relance QlygoCAD : il est a jour.
echo   ============================================
echo.
echo   ATTENTION : ceci compile une version de TEST, ce n est PAS
echo   l application installee. L application que tu utilises est
echo   toujours celle-ci, et c est elle qu il faut epingler :
echo.
echo       "D:\QLYGO Launcher\qlygocad.exe"
echo.
echo   (N epingle JAMAIS le fichier de src-tauri\target\release :
echo    tu te retrouverais avec deux applications differentes.)
echo.
pause
exit /b 0

:err
echo.
echo   *** Une erreur s'est produite. ***
echo   Fais une capture de cette fenetre et envoie-la a Claude.
echo.
pause
exit /b 1
