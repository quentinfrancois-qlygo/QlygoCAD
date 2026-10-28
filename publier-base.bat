@echo off
chcp 65001 >nul
title Publier la base QlygoCAD
cd /d "%~dp0"

set "SRC=%~1"
if "%SRC%"=="" set "SRC=%USERPROFILE%\Downloads\qlygo-base.json"

echo.
echo   ============================================
echo      Publier la base QlygoCAD (pour TOUS)
echo   ============================================
echo.

if not exist "%SRC%" (
  echo   Fichier introuvable : %SRC%
  echo.
  echo   1^) Dans QlygoCAD : Fichiers ^> Definir ce plan comme base
  echo      ^(ca enregistre un fichier qlygo-base.json^)
  echo   2^) GLISSE ce qlygo-base.json sur ce .bat,
  echo      ou mets-le dans ton dossier Telechargements, puis relance.
  echo.
  pause
  exit /b 1
)

echo   Base source : %SRC%
echo.
echo   [1/3] Mise a jour du depot...
git pull origin main || goto err

echo   [2/3] Compression + copie dans le depot...
node tools\gzip-base.js "%SRC%" "assets\qlygo-base.json.gz" || goto err

echo   [3/3] Publication...
git add assets\qlygo-base.json.gz
git commit -m "Base QlygoCAD mise a jour"
git push origin main || goto err

echo.
echo   ============================================
echo      Base publiee avec succes !
echo      Tous les utilisateurs l'auront dans ~5 min,
echo      au prochain chargement du plan de base.
echo      ^(Aucune reinstallation necessaire.^)
echo   ============================================
echo.
pause
exit /b 0

:err
echo.
echo   *** Une erreur s'est produite. Capture cette fenetre et envoie-la a Claude. ***
pause
exit /b 1
