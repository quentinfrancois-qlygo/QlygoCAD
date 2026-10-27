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
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url)); // racine du dépôt
const dist = join(root, 'dist');

// 1. dist/ propre
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 2. fichiers racine
for (const f of ['index.html', 'poc.html', 'app-poc.js', 'ver.txt']) {
  cpSync(join(root, f), join(dist, f));
}

// 3. dossiers complets (moteur de dessin + données/images)
for (const d of ['engine', 'assets']) {
  cpSync(join(root, d), join(dist, d), { recursive: true });
}

console.log('[prepare-dist] dist/ prêt pour Tauri :', dist);
