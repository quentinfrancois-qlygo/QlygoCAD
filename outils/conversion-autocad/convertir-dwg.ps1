# QlygoCAD — conversion en lot : pour chaque DWG des dossiers « DP envoyés », on enregistre
# UNIQUEMENT l'espace Objet (plans masse, façades, coupes) en DXF, DANS LE MÊME DOSSIER que le DWG :
#     <nom du DWG> - OBJET.dxf
# Votre rangement ne change pas. Les DWG d'origine ne sont JAMAIS modifiés.
# À la fin, un RAPPORT s'ouvre dans le navigateur : chaque dossier, son résultat, et un lien pour
# ouvrir le dossier directement (aucun logiciel nécessaire, pas besoin d'Excel).
#
# Utilisation (le .bat fait tout) :
#   CONVERTIR-DWG-EN-DXF.bat          -> tout le disque D:
#   CONVERTIR-DWG-EN-DXF.bat ESSAI    -> seulement 5 fichiers, pour vérifier
# Options : -Racine "D:\Dossiers" -Filtre "DP envoy" -Max 5 -Ecraser -Moteur "C:\...\accoreconsole.exe"

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
$rapport = Join-Path $PSScriptRoot ("rapport-conversion-" + (Get-Date -Format "yyyy-MM-dd_HH-mm") + ".html")
$lignes = New-Object System.Collections.Generic.List[object]

# --- 1) recherche des dossiers « DP envoyés » (avec progression) ---
Write-Host "Recherche des dossiers « $Filtre » dans $Racine (peut prendre quelques minutes)..." -ForegroundColor Cyan
$dossiersDP = New-Object System.Collections.Generic.List[string]
$n = 0
Get-ChildItem -Path $Racine -Recurse -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $n++
  if ($n % 1000 -eq 0) { Write-Host ("  ... {0} dossiers parcourus, {1} dossier(s) « DP envoyes » trouve(s)" -f $n, $dossiersDP.Count) }
  if ($_.Name -like "*$Filtre*" -and $_.FullName -notmatch '\\\$RECYCLE|System Volume Information') { $dossiersDP.Add($_.FullName) }
}
Write-Host ("{0} dossiers parcourus, {1} dossier(s) « DP envoyes » trouve(s)." -f $n, $dossiersDP.Count) -ForegroundColor Cyan

$fichiers = foreach ($d in $dossiersDP) { Get-ChildItem -Path $d -Recurse -Filter *.dwg -File -ErrorAction SilentlyContinue }
$fichiers = @($fichiers | Sort-Object FullName)
if ($Max -gt 0) { $fichiers = @($fichiers | Select-Object -First $Max) }
$total = $fichiers.Count
Write-Host "$total fichier(s) DWG a traiter. Chaque DXF sera cree dans le dossier de son DWG." -ForegroundColor Cyan
Write-Host ""

function Noter($f, $dossier, $res, $ko, $sec) {
  $script:lignes.Add([pscustomobject]@{ Dossier = $dossier; Dir = $f.DirectoryName; Dwg = $f.Name; Res = $res; Ko = $ko; Sec = $sec })
}

# --- 2) conversion ---
$ok = 0; $deja = 0; $ko = 0; $i = 0
foreach ($f in $fichiers) {
  $i++
  $dxf = Join-Path $f.DirectoryName ($f.BaseName + " - OBJET.dxf")      # dans le MÊME dossier que le DWG
  $dossier = Split-Path (Split-Path $f.DirectoryName -Parent) -Leaf      # dossier client (au-dessus de « DP envoyés »)

  if ((Test-Path $dxf) -and -not $Ecraser) {
    $deja++; Noter $f $dossier "deja converti" ([math]::Round((Get-Item $dxf).Length/1KB)) 0
    Write-Host "[$i/$total] deja fait : $dossier" -ForegroundColor DarkGray; continue
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
    Noter $f $dossier "OK" $k $duree
    Write-Host "      -> OK ($k Ko, $duree s) : $dxf" -ForegroundColor Green
  } else {
    $ko++; Noter $f $dossier "ECHEC" 0 $duree
    Write-Host "      -> ECHEC (voir le rapport)" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Termine : $ok converti(s), $deja deja fait(s), $ko echec(s)." -ForegroundColor Cyan

# --- 3) rapport HTML : s'ouvre dans le navigateur, recherche + lien vers chaque dossier ---
function Esc([string]$s) { return [System.Net.WebUtility]::HtmlEncode($s) }
$sb = New-Object System.Text.StringBuilder
[void]$sb.Append('<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Conversion DWG vers DXF - QlygoCAD</title>')
[void]$sb.Append('<style>body{font:14px Segoe UI,Arial,sans-serif;margin:24px;color:#1b2130}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e3e6ee;padding:6px 8px;text-align:left}th{background:#f3f5fa;position:sticky;top:0}.ok{color:#1f8a3a;font-weight:600}.ko{color:#c62828;font-weight:700}.deja{color:#6b7280}a{color:#2d6cdf}input{padding:6px 10px;width:340px;margin:6px 0 14px;font:inherit}</style>')
[void]$sb.Append('<script>function filtre(q){q=q.toLowerCase();document.querySelectorAll("tbody tr").forEach(function(r){r.style.display=r.textContent.toLowerCase().indexOf(q)>=0?"":"none";});}</script></head><body>')
[void]$sb.Append("<h1>QlygoCAD : conversion DWG vers DXF (espace Objet)</h1>")
[void]$sb.Append("<p>$(Get-Date -Format 'dd/MM/yyyy HH:mm') &middot; <b>$ok</b> converti(s) &middot; <b>$deja</b> deja fait(s) &middot; <b class=ko>$ko</b> echec(s).<br>Chaque DXF est rangé dans le dossier de son DWG, sous le nom <i>&lt;nom du DWG&gt; - OBJET.dxf</i>.</p>")
[void]$sb.Append('<input placeholder="Rechercher un dossier (nom, numéro)..." oninput="filtre(this.value)">')
[void]$sb.Append('<table><thead><tr><th>Dossier</th><th>Résultat</th><th>Fichier DWG</th><th>DXF (Ko)</th><th></th></tr></thead><tbody>')
foreach ($l in ($lignes | Sort-Object @{ Expression = { $_.Res -ne 'ECHEC' } }, Dossier)) {
  $cls = if ($l.Res -eq 'OK') { 'ok' } elseif ($l.Res -eq 'ECHEC') { 'ko' } else { 'deja' }
  $url = 'file:///' + ($l.Dir -replace '\\', '/')
  [void]$sb.Append("<tr><td>$(Esc $l.Dossier)</td><td class=$cls>$(Esc $l.Res)</td><td>$(Esc $l.Dwg)</td><td>$($l.Ko)</td><td><a href=`"$(Esc $url)`" target=`"_blank`">ouvrir le dossier</a></td></tr>")
}
[void]$sb.Append('</tbody></table></body></html>')
[System.IO.File]::WriteAllText($rapport, $sb.ToString(), (New-Object System.Text.UTF8Encoding($true)))
Write-Host "Rapport (s'ouvre dans le navigateur) : $rapport"
try { Invoke-Item $rapport } catch {}
