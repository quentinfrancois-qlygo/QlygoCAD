# QlygoCAD — conversion en lot : pour chaque DWG des dossiers envoyés (D:\PRO\DOSSIERS IZI BY EDF\Envoyés,
# toutes années, tous sous-dossiers), on enregistre UNIQUEMENT l'espace Objet (plans masse, façades,
# coupes) en DXF, DANS LE MÊME DOSSIER que le DWG :   <nom du DWG> - OBJET.dxf
# Votre rangement ne change pas. Les DWG d'origine ne sont JAMAIS modifiés.
# Un RAPPORT (navigateur) est mis à jour après chaque fichier et s'ouvre à la fin.
#
# Utilisation (le .bat fait tout) :
#   CONVERTIR-DWG-EN-DXF.bat          -> ESSAI : les 5 DWG les plus récents de 2026
#   CONVERTIR-DWG-EN-DXF.bat TOUT     -> tous les dossiers envoyés (2023 à 2026)
# Sécurité : arrêt automatique après 3 échecs d'affilée ; réponse d'AutoCAD gardée dans « diagnostics ».

param(
  [string]$Racine = "D:\PRO\DOSSIERS IZI BY EDF\Envoyés",
  [string]$Annee = "",
  [int]$Max = 0,
  [switch]$Ecraser,
  [string]$Moteur = "",
  [int]$DelaiMax = 120,
  [int]$ArretApresEchecs = 3
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
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$rapport = Join-Path $PSScriptRoot ("rapport-conversion-" + $stamp + ".html")
$diagDir = Join-Path $PSScriptRoot "diagnostics"
New-Item -ItemType Directory -Force -Path $diagDir | Out-Null
$lignes = New-Object System.Collections.Generic.List[object]

# --- 1) recherche des DWG ---
if ($Annee) { $Racine = Join-Path $Racine $Annee }
if (-not (Test-Path $Racine)) { Write-Host "Dossier introuvable : $Racine" -ForegroundColor Red; exit 1 }
Write-Host "Recherche des DWG dans $Racine ..." -ForegroundColor Cyan
$fichiers = @(Get-ChildItem -Path $Racine -Recurse -Filter *.dwg -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -eq '.dwg' -and $_.Name -notmatch '\.sv\$|recover' } |   # pas les sauvegardes auto
  Sort-Object LastWriteTime -Descending)                                               # les plus récents d'abord
Write-Host ("{0} fichier(s) DWG trouve(s)." -f $fichiers.Count) -ForegroundColor Cyan
if ($Max -gt 0) { $fichiers = @($fichiers | Select-Object -First $Max) }
$total = $fichiers.Count
Write-Host "$total fichier(s) DWG a traiter. Chaque DXF sera cree dans le dossier de son DWG." -ForegroundColor Cyan
Write-Host ""
$racineNorm = (Resolve-Path $Racine).Path.TrimEnd('\')

# --- rapport HTML (réécrit après chaque fichier : lisible même si on interrompt) ---
function Esc([string]$s) { return [System.Net.WebUtility]::HtmlEncode($s) }
function EcrireRapport {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Conversion DWG vers DXF - QlygoCAD</title>')
  [void]$sb.Append('<style>body{font:14px Segoe UI,Arial,sans-serif;margin:24px;color:#1b2130}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e3e6ee;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f5fa;position:sticky;top:0}.ok{color:#1f8a3a;font-weight:600}.ko{color:#c62828;font-weight:700}.deja{color:#6b7280}a{color:#2d6cdf}input{padding:6px 10px;width:340px;margin:6px 0 14px;font:inherit}pre{white-space:pre-wrap;font-size:12px;color:#555;margin:4px 0 0}</style>')
  [void]$sb.Append('<script>function filtre(q){q=q.toLowerCase();document.querySelectorAll("tbody tr").forEach(function(r){r.style.display=r.textContent.toLowerCase().indexOf(q)>=0?"":"none";});}</script></head><body>')
  [void]$sb.Append("<h1>QlygoCAD : conversion DWG vers DXF (espace Objet)</h1>")
  [void]$sb.Append("<p>$(Get-Date -Format 'dd/MM/yyyy HH:mm') &middot; <b>$script:ok</b> converti(s) &middot; <b>$script:deja</b> deja fait(s) &middot; <b class=ko>$script:ko</b> echec(s) &middot; $script:i / $total traite(s).<br>Chaque DXF est rangé dans le dossier de son DWG, sous le nom <i>&lt;nom du DWG&gt; - OBJET.dxf</i>.</p>")
  [void]$sb.Append('<input placeholder="Rechercher un dossier (nom, numéro)..." oninput="filtre(this.value)">')
  [void]$sb.Append('<table><thead><tr><th>Dossier</th><th>Résultat</th><th>Fichier DWG</th><th>DXF (Ko)</th><th></th></tr></thead><tbody>')
  foreach ($l in ($script:lignes | Sort-Object @{ Expression = { $_.Res -ne 'ECHEC' } }, Dossier)) {
    $cls = if ($l.Res -eq 'OK') { 'ok' } elseif ($l.Res -eq 'ECHEC') { 'ko' } else { 'deja' }
    $url = 'file:///' + ($l.Dir -replace '\\', '/')
    $diag = if ($l.Diag) { "<pre>$(Esc $l.Diag)</pre>" } else { '' }
    [void]$sb.Append("<tr><td>$(Esc $l.Dossier)</td><td class=$cls>$(Esc $l.Res)$diag</td><td>$(Esc $l.Dwg)</td><td>$($l.Ko)</td><td><a href=`"$(Esc $url)`" target=`"_blank`">ouvrir le dossier</a></td></tr>")
  }
  [void]$sb.Append('</tbody></table></body></html>')
  [System.IO.File]::WriteAllText($script:rapport, $sb.ToString(), (New-Object System.Text.UTF8Encoding($true)))
}
function Noter($f, $dossier, $res, $ko, $sec, $diag) {
  $script:lignes.Add([pscustomobject]@{ Dossier = $dossier; Dir = $f.DirectoryName; Dwg = $f.Name; Res = $res; Ko = $ko; Sec = $sec; Diag = $diag })
  EcrireRapport
}

# --- 2) conversion ---
$script:ok = 0; $script:deja = 0; $script:ko = 0; $script:i = 0; $suite = 0
foreach ($f in $fichiers) {
  $script:i++
  $dxf = Join-Path $f.DirectoryName ($f.BaseName + " - OBJET.dxf")      # dans le MÊME dossier que le DWG
  $dossier = $f.DirectoryName.Substring([Math]::Min($racineNorm.Length, $f.DirectoryName.Length)).TrimStart('\')
  if (-not $dossier) { $dossier = $f.Directory.Name }

  if ((Test-Path $dxf) -and -not $Ecraser) {
    $script:deja++; Noter $f $dossier "deja converti" ([math]::Round((Get-Item $dxf).Length/1KB)) 0 ''
    Write-Host "[$script:i/$total] deja fait : $dossier" -ForegroundColor DarkGray; continue
  }
  if (Test-Path $dxf) { Remove-Item $dxf -Force }

  # Script AutoCAD : même méthode que celle qui fonctionne déjà sur ce poste (SECURELOAD 0, sinon le LISP
  # placé hors des dossiers de confiance d'AutoCAD n'est pas chargé).
  $scr = Join-Path $env:TEMP ("qlygo-objet-" + [guid]::NewGuid().ToString() + ".scr")
  $out = $dxf -replace '\\', '/'
  @(
    "FILEDIA", "0", "SECURELOAD", "0",
    "(load `"$lsp`")",
    "(qlygo-objet-dxf `"$out`")",
    "FILEDIA", "1", ""
  ) | Out-File $scr -Encoding default

  Write-Host "[$script:i/$total] $dossier  ($($f.Name))"
  $t0 = Get-Date
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Moteur
  $psi.Arguments = "/i `"$($f.FullName)`" /s `"$scr`""
  $psi.WorkingDirectory = $PSScriptRoot
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.StandardOutputEncoding = [System.Text.Encoding]::Unicode
  $psi.RedirectStandardInput = $true    # entrée clavier coupée : AutoCAD s'arrête à la fin du script
  $p = [System.Diagnostics.Process]::Start($psi)
  try { $p.StandardInput.Close() } catch {}
  $lecture = $p.StandardOutput.ReadToEndAsync()
  if (-not $p.WaitForExit($DelaiMax * 1000)) { try { $p.Kill() } catch {} }
  $reponse = ''; try { if ($lecture.Wait(5000)) { $reponse = ($lecture.Result -replace "`0", '') } } catch {}
  $duree = [math]::Round(((Get-Date) - $t0).TotalSeconds)
  Remove-Item $scr -Force -ErrorAction SilentlyContinue

  if ((Test-Path $dxf) -and (Get-Item $dxf).Length -gt 0) {
    $script:ok++; $suite = 0; $k = [math]::Round((Get-Item $dxf).Length/1KB)
    Noter $f $dossier "OK" $k $duree ''
    Write-Host "      -> OK ($k Ko, $duree s) : $dxf" -ForegroundColor Green
  } else {
    $script:ko++; $suite++
    $nomDiag = Join-Path $diagDir (($f.BaseName -replace '[^\w\- ]', '_') + ".txt")
    $reponse | Out-File $nomDiag -Encoding utf8
    $fin = (($reponse -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last 12) -join "`n"
    Noter $f $dossier "ECHEC" 0 $duree $fin
    Write-Host "      -> ECHEC. Reponse d'AutoCAD (fin) :" -ForegroundColor Red
    Write-Host $fin -ForegroundColor DarkYellow
    Write-Host "      (complet : $nomDiag)" -ForegroundColor DarkGray
    if ($ArretApresEchecs -gt 0 -and $suite -ge $ArretApresEchecs) {
      Write-Host ""
      Write-Host "ARRET : $suite echecs d'affilee. Envoyez le rapport (ou le dossier « diagnostics ») pour correction." -ForegroundColor Red
      break
    }
  }
}

Write-Host ""
Write-Host "Termine : $script:ok converti(s), $script:deja deja fait(s), $script:ko echec(s)." -ForegroundColor Cyan
EcrireRapport
Write-Host "Rapport (s'ouvre dans le navigateur) : $rapport"
try { Invoke-Item $rapport } catch {}
