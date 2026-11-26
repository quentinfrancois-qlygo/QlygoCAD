# QlygoCAD — conversion en lot : pour chaque DWG des dossiers « DP envoyés », on enregistre
# UNIQUEMENT l'espace Objet (plans masse, façades, coupes) en DXF, à côté du DWG :
#     <nom du DWG> - OBJET.dxf
# Les DWG d'origine ne sont JAMAIS modifiés. Un journal CSV liste chaque fichier traité.
#
# Utilisation (le .bat fait tout) :
#   CONVERTIR-DWG-EN-DXF.bat                -> tout le disque D:, dossiers contenant « DP envoy »
#   CONVERTIR-DWG-EN-DXF.bat ESSAI          -> seulement 5 fichiers, pour vérifier
# Options PowerShell : -Racine "D:\Dossiers" -Filtre "DP envoy" -Max 5 -Ecraser -Moteur "C:\...\accoreconsole.exe"

param(
  [string]$Racine = "D:\",
  [string]$Filtre = "DP envoy",
  [int]$Max = 0,
  [switch]$Ecraser,
  [string]$Moteur = "",
  [int]$DelaiMax = 300
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# --- moteur AutoCAD sans fenêtre (accoreconsole.exe) ---
if (-not $Moteur) {
  $Moteur = Get-ChildItem "C:\Program Files\Autodesk" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "AutoCAD*" } | Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "accoreconsole.exe" } | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Moteur -or -not (Test-Path $Moteur)) {
  Write-Host "accoreconsole.exe introuvable (AutoCAD doit etre installe). Indiquez-le avec -Moteur." -ForegroundColor Red
  exit 1
}
Write-Host "Moteur AutoCAD : $Moteur"

$lsp = (Join-Path $PSScriptRoot "qlygo-objet-dxf.lsp") -replace '\\', '/'
$journal = Join-Path $PSScriptRoot ("journal-conversion-" + (Get-Date -Format "yyyy-MM-dd_HH-mm") + ".csv")
"Fichier DWG;Resultat;Taille DWG (Ko);Taille DXF (Ko);Duree (s)" | Out-File $journal -Encoding utf8

Write-Host "Recherche des DWG dans $Racine (dossiers contenant « $Filtre »)..."
$fichiers = Get-ChildItem -Path $Racine -Recurse -Filter *.dwg -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -like "*$Filtre*" -and $_.FullName -notmatch '\\\$RECYCLE|System Volume Information' } |
  Sort-Object FullName
if ($Max -gt 0) { $fichiers = $fichiers | Select-Object -First $Max }
$total = @($fichiers).Count
Write-Host "$total fichier(s) DWG a traiter." -ForegroundColor Cyan

$ok = 0; $deja = 0; $ko = 0; $i = 0
foreach ($f in $fichiers) {
  $i++
  $dxf = Join-Path $f.DirectoryName ($f.BaseName + " - OBJET.dxf")
  if ((Test-Path $dxf) -and -not $Ecraser) {
    $deja++; "$($f.FullName);deja converti;$([math]::Round($f.Length/1KB));$([math]::Round((Get-Item $dxf).Length/1KB));0" | Out-File $journal -Append -Encoding utf8
    Write-Host "[$i/$total] deja fait : $($f.Name)" -ForegroundColor DarkGray; continue
  }
  if (Test-Path $dxf) { Remove-Item $dxf -Force }
  $scr = Join-Path $env:TEMP ("qlygo-objet-" + [guid]::NewGuid().ToString() + ".scr")
  $out = $dxf -replace '\\', '/'
  @(
    "(load `"$lsp`")",
    "(qlygo-objet-dxf `"$out`")",
    "_.QUIT",
    "_Y",
    ""
  ) | Out-File $scr -Encoding default

  Write-Host "[$i/$total] $($f.FullName)"
  $t0 = Get-Date
  $p = Start-Process -FilePath $Moteur -ArgumentList @('/i', "`"$($f.FullName)`"", '/s', "`"$scr`"") -WindowStyle Hidden -PassThru
  if (-not $p.WaitForExit($DelaiMax * 1000)) { try { $p.Kill() } catch {} }
  $duree = [math]::Round(((Get-Date) - $t0).TotalSeconds)
  Remove-Item $scr -Force -ErrorAction SilentlyContinue

  if ((Test-Path $dxf) -and (Get-Item $dxf).Length -gt 0) {
    $ok++; $k = [math]::Round((Get-Item $dxf).Length/1KB)
    "$($f.FullName);OK;$([math]::Round($f.Length/1KB));$k;$duree" | Out-File $journal -Append -Encoding utf8
    Write-Host "      -> OK ($k Ko, $duree s)" -ForegroundColor Green
  } else {
    $ko++; "$($f.FullName);ECHEC;$([math]::Round($f.Length/1KB));0;$duree" | Out-File $journal -Append -Encoding utf8
    Write-Host "      -> ECHEC (voir le journal)" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Termine : $ok converti(s), $deja deja fait(s), $ko echec(s)." -ForegroundColor Cyan
Write-Host "Journal : $journal"
