@echo off
chcp 65001 >nul
title QlygoCAD - DWG vers DXF (espace Objet uniquement)
echo.
echo   ======================================================
echo     QlygoCAD : conversion DWG -^> DXF (espace Objet seul)
echo   ======================================================
echo.
echo   Pour chaque DWG de D:\PRO\DOSSIERS IZI BY EDF\Envoyes
echo   on garde UNIQUEMENT l'espace Objet (plans masse, facades,
echo   coupes) et on l'enregistre DANS LE MEME DOSSIER que le DWG :
echo   "<nom du DWG> - OBJET.dxf". Votre rangement ne change pas.
echo   Les DWG d'origine ne sont JAMAIS modifies.
echo.
if /I "%~1"=="TOUT" (
  echo   CONVERSION COMPLETE : tous les dossiers envoyes.
  echo   Arret automatique apres 3 echecs d'affilee.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0convertir-dwg.ps1"
) else (
  echo   ESSAI : les 5 DWG les plus recents de 2026.
  echo   Pour tout convertir ensuite : CONVERTIR-DWG-EN-DXF.bat TOUT
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0convertir-dwg.ps1" -Annee 2026 -Max 5
)
echo.
pause
