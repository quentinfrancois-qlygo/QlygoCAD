/* prepare-dist.mjs — prépare le dossier dist/ pour l'empaquetage Tauri.
 *
 * Tauri embarque TOUT le contenu de `frontendDist` (../dist) dans le .exe/.app.
 * On recopie donc uniquement les fichiers web nécessaires dans un dist/ propre,
 * pour ne PAS embarquer node_modules/, src-tauri/, .git/, etc.
 *
 * Lancé automatiquement par Tauri (beforeBuildCommand / beforeDevCommand),
 * ou à la main :  node prepare-dist.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url)); // racine du dépôt
const dist = join(root, 'dist');

// 1. dist/ propre
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Version RÉELLE du build (source de vérité : tauri.conf.json).
let version = '0.0.0';
try { version = (JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version) || version; }
catch (e) { try { version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) || version; } catch (_) {} }

// 2. fichiers racine (ver.txt est RÉGÉNÉRÉ plus bas, pas recopié)
for (const f of ['launcher.html', 'index.html', 'poc.html', 'app-poc.js']) {
  cpSync(join(root, f), join(dist, f));
}

// 2b. CACHE-BUSTING CRITIQUE : le jeton « ?v=122 » des scripts (engine/*.js, app-poc.js)
//     était FIGÉ -> après mise à jour, la webview continuait de servir l'ANCIEN app-poc.js
//     en cache (tous les correctifs du moteur n'arrivaient jamais !). On le remplace par la
//     VERSION du build à chaque release -> l'URL change -> la webview recharge le vrai fichier.
//     On met aussi à jour le badge de version figé « v1.1.8 » dans poc.html.
for (const f of ['launcher.html', 'index.html', 'poc.html']) {
  const p = join(dist, f);
  let html = readFileSync(p, 'utf8');
  html = html.replace(/(\.(?:js|css))\?v=[0-9A-Za-z._-]+/g, '$1?v=' + version);   // jetons de cache
  html = html.replace(/(<span class="ver">)v[0-9.]+(<\/span>)/g, '$1v' + version + '$2'); // badge figé
  writeFileSync(p, html);
}

// 3. dossiers complets (moteur de dessin + données/images)
for (const d of ['engine', 'assets']) {
  cpSync(join(root, d), join(dist, d), { recursive: true });
}

// 4. ver.txt TOUJOURS régénéré depuis la version RÉELLE du build.
writeFileSync(join(dist, 'ver.txt'), version);

console.log('[prepare-dist] dist/ prêt :', dist, '| version =', version, '| cache-bust + badge ré-écrits');
