/* Construit un POC en FICHIER UNIQUE (tout le moteur inliné) pour un test
 * immédiat par double-clic, sans dépendre de l'arborescence des fichiers.
 * Usage: node tools/build-standalone.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let html = fs.readFileSync(path.join(ROOT, 'poc.html'), 'utf8');

function inline(file) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return '<script>\n/* ' + file + ' */\n' + code + '\n</script>';
}

const files = ['engine/units.js', 'engine/geometry.js', 'engine/snap.js', 'engine/render.js',
  'engine/pdf.js', 'engine/export.js', 'app-poc.js'];

for (const f of files) {
  const tag = '<script src="' + f + '"></script>';
  if (!html.includes(tag)) throw new Error('balise introuvable: ' + tag);
  html = html.replace(tag, inline(f));
}

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'qlygocad-poc.html');
fs.writeFileSync(out, html);
console.log('Fichier unique ecrit:', out, '(' + html.length + ' octets)');
