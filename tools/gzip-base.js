// Compresse un qlygo-base.json (exporté par « Définir comme base ») en
// assets/qlygo-base.json.gz, le format que l'application charge.
// Usage : node tools/gzip-base.js <source.json> <dest.json.gz>
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const src = process.argv[2], dst = process.argv[3];
if (!src || !dst) { console.error('usage: node tools/gzip-base.js <src.json> <dst.json.gz>'); process.exit(1); }
let raw;
try { raw = fs.readFileSync(src, 'utf8'); } catch (e) { console.error('Lecture impossible :', e.message); process.exit(1); }
try { JSON.parse(raw); } catch (e) { console.error('Le fichier n\'est pas un JSON QlygoCAD valide :', e.message); process.exit(1); }
fs.writeFileSync(dst, zlib.gzipSync(Buffer.from(raw, 'utf8')));
console.log('OK : ' + path.basename(dst) + ' (' + fs.statSync(dst).size + ' octets)');
