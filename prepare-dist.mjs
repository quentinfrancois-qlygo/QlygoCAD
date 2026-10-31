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

// 2. fichiers racine (ver.txt est RÉGÉNÉRÉ plus bas, pas recopié)
for (const f of ['launcher.html', 'index.html', 'poc.html', 'app-poc.js']) {
  cpSync(join(root, f), join(dist, f));
}

// 3. dossiers complets (moteur de dessin + données/images)
for (const d of ['engine', 'assets']) {
  cpSync(join(root, d), join(dist, d), { recursive: true });
}

// 4. ver.txt TOUJOURS régénéré depuis la version RÉELLE du build (tauri.conf.json),
//    sinon le numéro affiché dans le launcher reste figé (bug : « v1.1.22 » affiché
//    alors que le binaire était déjà plus récent -> l'utilisateur croit être bloqué).
let version = '0.0.0';
try { version = (JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version) || version; }
catch (e) { try { version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) || version; } catch (_) {} }
writeFileSync(join(dist, 'ver.txt'), version);

console.log('[prepare-dist] dist/ prêt pour Tauri :', dist, '| ver.txt =', version);
