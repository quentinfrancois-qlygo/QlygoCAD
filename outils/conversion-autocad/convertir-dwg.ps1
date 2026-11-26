# QlygoCAD — conversion en lot : pour chaque DWG des dossiers « DP envoyés », on enregistre
# UNIQUEMENT l'espace Objet (plans masse, façades, coupes) en DXF.
#
# OÙ SONT LES DXF ? Tous dans UN SEUL dossier, avec la même arborescence que vos dossiers :
#     D:\QlygoCAD - DXF\<année>\<mois>\<dossier>\...\<nom du DWG> - OBJET.dxf
# + un journal CSV (Excel) qui donne, pour chaque DWG, le chemin exact de son DXF.
# Les DWG d'origine ne sont JAMAIS modifiés.
#
# Utilisation (le .bat fait tout) :
#   CONVERTIR-DWG-EN-DXF.bat          -> tout le disque D:
#   CONVERTIR-DWG-EN-DXF.bat ESSAI    -> seulement 5 fichiers, pour vérifier
# Options : -Racine "D:\Dossiers" -Sortie "D:\QlygoCAD - DXF" -Filtre "DP envoy" -Max 5 -Ecraser -Moteur "C:\...\accoreconsole.exe"

param(
  [string]$Racine = "D:\",
  [string]$Sortie = "D:\QlygoCAD - DXF",
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

New-Item -ItemType Directory -Force -Path $Sortie | Out-Null
$lsp = (Join-Path $PSScriptRoot "qlygo-objet-dxf.lsp") -replace '\\', '/'
$journal = Join-Path $Sortie ("journal-conversion-" + (Get-Date -Format "yyyy-MM-dd_HH-mm") + ".csv")
"Dossier;Fichier DWG;Resultat;Fichier DXF;Taille DWG (Ko);Taille DXF (Ko);Duree (s)" | Out-File $journal -Encoding utf8

# --- 1) recherche des dossiers « DP envoyés » (avec progression) ---
$racineNorm = (Resolve-Path $Racine).Path.TrimEnd('\')
$sortieNorm = (Resolve-Path $Sortie).Path.TrimEnd('\')
Write-Host "Recherche des dossiers « $Filtre » dans $Racine (peut prendre quelques minutes)..." -ForegroundColor Cyan
$dossiersDP = New-Object System.Collections.Generic.List[string]
$n = 0
Get-ChildItem -Path $Racine -Recurse -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $n++
  if ($n % 1000 -eq 0) { Write-Host ("  ... {0} dossiers parcourus, {1} dossier(s) « DP envoyes » trouve(s)" -f $n, $dossiersDP.Count) }
  $fn = $_.FullName
  if ($_.Name -like "*$Filtre*" -and $fn -notmatch '\\\$RECYCLE|System Volume Information' -and -not $fn.StartsWith($sortieNorm)) { $dossiersDP.Add($fn) }
}
Write-Host ("{0} dossiers parcourus, {1} dossier(s) « DP envoyes » trouve(s)." -f $n, $dossiersDP.Count) -ForegroundColor Cyan

$fichiers = foreach ($d in $dossiersDP) { Get-ChildItem -Path $d -Recurse -Filter *.dwg -File -ErrorAction SilentlyContinue }
$fichiers = @($fichiers | Sort-Object FullName)
if ($Max -gt 0) { $fichiers = @($fichiers | Select-Object -First $Max) }
$total = $fichiers.Count
Write-Host "$total fichier(s) DWG a traiter. Les DXF iront dans : $Sortie" -ForegroundColor Cyan
Write-Host ""

# --- 2) conversion ---
$ok = 0; $deja = 0; $ko = 0; $i = 0
foreach ($f in $fichiers) {
  $i++
  # Même arborescence que l'original, sous le dossier de sortie.
  $rel = $f.DirectoryName.Substring([Math]::Min($racineNorm.Length, $f.DirectoryName.Length)).TrimStart('\')
  $dirOut = if ($rel) { Join-Path $Sortie $rel } else { $Sortie }
  New-Item -ItemType Directory -Force -Path $dirOut | Out-Null
  $dxf = Join-Path $dirOut ($f.BaseName + " - OBJET.dxf")
  $dossier = Split-Path (Split-Path $f.DirectoryName -Parent) -Leaf   # dossier client (au-dessus de « DP envoyés »)
  $ligne = { param($res, $kdxf, $sec) "$dossier;$($f.FullName);$res;$dxf;$([math]::Round($f.Length/1KB));$kdxf;$sec" | Out-File $journal -Append -Encoding utf8 }

  # DXF déjà fait par l'ancienne version du script (à côté du DWG) : on le RANGE, sans reconvertir.
  $ancien = Join-Path $f.DirectoryName ($f.BaseName + " - OBJET.dxf")
  if ((Test-Path $ancien) -and -not (Test-Path $dxf) -and -not $Ecraser) {
    Move-Item $ancien $dxf -Force
    $deja++; & $ligne "deja converti (range)" ([math]::Round((Get-Item $dxf).Length/1KB)) 0
    Write-Host "[$i/$total] deja fait, range : $dxf" -ForegroundColor DarkGray; continue
  }
  if ((Test-Path $dxf) -and -not $Ecraser) {
    $deja++; & $ligne "deja converti" ([math]::Round((Get-Item $dxf).Length/1KB)) 0
    Write-Host "[$i/$total] deja fait : $dxf" -ForegroundColor DarkGray; continue
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

  Write-Host "[$i/$total] $dossier  ($($f.Name))"
  $t0 = Get-Date
  $p = Start-Process -FilePath $Moteur -ArgumentList @('/i', "`"$($f.FullName)`"", '/s', "`"$scr`"") -WindowStyle Hidden -PassThru
  if (-not $p.WaitForExit($DelaiMax * 1000)) { try { $p.Kill() } catch {} }
  $duree = [math]::Round(((Get-Date) - $t0).TotalSeconds)
  Remove-Item $scr -Force -ErrorAction SilentlyContinue

  if ((Test-Path $dxf) -and (Get-Item $dxf).Length -gt 0) {
    $ok++; $k = [math]::Round((Get-Item $dxf).Length/1KB)
    & $ligne "OK" $k $duree
    Write-Host "      -> OK ($k Ko, $duree s) : $dxf" -ForegroundColor Green
  } else {
    $ko++; & $ligne "ECHEC" 0 $duree
    Write-Host "      -> ECHEC (voir le journal)" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Termine : $ok converti(s), $deja deja fait(s), $ko echec(s)." -ForegroundColor Cyan
Write-Host "Tous les DXF sont dans : $Sortie"
Write-Host "Journal (a ouvrir dans Excel) : $journal"
# On ouvre le dossier des DXF et le journal pour les retrouver tout de suite.
try { Invoke-Item $Sortie } catch {}
try { Invoke-Item $journal } catch {}
