@echo off
chcp 65001 >nul
title QlygoCAD - DWG vers DXF (espace Objet uniquement)
echo.
echo   ======================================================
echo     QlygoCAD : conversion DWG -^> DXF (espace Objet seul)
echo   ======================================================
echo.
echo   Pour chaque DWG des dossiers "DP envoyes" du disque D:
echo   on garde UNIQUEMENT l'espace Objet (plans masse, facades,
echo   coupes) et on l'enregistre DANS LE MEME DOSSIER que le DWG :
echo   "<nom du DWG> - OBJET.dxf". Votre rangement ne change pas.
echo   Les DWG d'origine ne sont JAMAIS modifies.
echo   A la fin, un rapport s'ouvre dans le navigateur.
echo.
if /I "%~1"=="ESSAI" (
  echo   MODE ESSAI : 5 fichiers seulement.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0convertir-dwg.ps1" -Max 5
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0convertir-dwg.ps1" %*
)
echo.
pause
