/* Génère un PDF d'exemple avec le moteur (hors navigateur) et vérifie la mesure.
 * Usage: node tools/make-sample.js
 */
const path = require('path');
const fs = require('fs');
const root = globalThis;
require(path.join(__dirname, '..', 'engine', 'units.js'));
require(path.join(__dirname, '..', 'engine', 'geometry.js'));
require(path.join(__dirname, '..', 'engine', 'pdf.js'));
require(path.join(__dirname, '..', 'engine', 'export.js'));
const G = root.QCAD.geometry;
const U = root.QCAD.units;

// --- Petite scène "plan de maison" en mm réels (10 m x 8 m) ---
const scene = G.createScene();
G.addRect(scene, 0, 0, 10000, 8000, { color: '#1b2b4b', penMm: 0.5 });        // murs extérieurs
G.addLine(scene, 4000, 0, 4000, 8000, { color: '#1b2b4b', penMm: 0.35 });      // refend
G.addLine(scene, 0, 5000, 4000, 5000, { color: '#1b2b4b', penMm: 0.35 });      // cloison
G.addRect(scene, 6000, 2000, 2500, 1500, { color: '#c0392b', penMm: 0.35 });   // meuble/ouverture
G.addLine(scene, 1500, 0, 2700, 0, { color: '#ffffff', penMm: 0.9 });          // trémie porte (coupure)
// Cotations (outil Cote) : largeur en bas, hauteur à gauche
G.addDim(scene, { x: 0, y: 0 }, { x: 10000, y: 0 }, -900, {});                  // 10,00 m
G.addDim(scene, { x: 0, y: 0 }, { x: 0, y: 8000 }, -900, {});                   // 8,00 m

const doc = root.QCAD.exportPdf(scene, { scaleDenom: 100, paper: 'A4', orientation: 'landscape', title: 'QlygoCAD POC - plan maison 10x8 m' });
const bytes = doc.toBytes();
const out = path.join(__dirname, '..', 'sample.pdf');
fs.writeFileSync(out, Buffer.from(bytes));
console.log('PDF ecrit:', out, '(' + bytes.length + ' octets)');

// --- Vérifications automatiques ("tester avant de dire que c'est fini") ---
const pdfStr = doc.build();
let ok = true;
function check(label, cond) { console.log((cond ? 'OK  ' : 'FAIL') + '  ' + label); if (!cond) ok = false; }

check('en-tete %PDF', pdfStr.startsWith('%PDF-1.4'));
check('fin %%EOF', pdfStr.trimEnd().endsWith('%%EOF'));
check('table xref presente', pdfStr.includes('\nxref\n'));

// Longueur réelle vs longueur papier attendue pour le mur de 10 m à 1:100
const murRealMm = G.length(scene.entities[0]) ; // rectangle 10x8 fermé -> périmètre
const paperMm10m = U.realMmToPaperMm(10000, 100); // 10 m à 1:100 -> 100 mm papier
check('10 m reels -> 100 mm papier a 1:100', Math.abs(paperMm10m - 100) < 1e-9);
check('temoin 1 m -> 10 mm papier a 1:100', Math.abs(U.realMmToPaperMm(1000, 100) - 10) < 1e-9);

// Vérif conversion mm->pt (210 mm A4 = 595.276 pt)
check('A4 largeur 210 mm = 595.28 pt', Math.abs(U.mmToPt(210) - 595.2756) < 0.01);

// Cotations : valeur mesurée + libellé + présence du texte dans le PDF
const dimW = scene.entities.find(e => e.type === 'dim');
check('cote largeur mesure 10000 mm', Math.abs(G.dimValue(dimW) - 10000) < 1e-6);
check('libelle cote = "10,00 m"', G.formatDim(10000) === '10,00 m');
check('texte des cotes present dans le PDF', pdfStr.includes('10,00 m') && pdfStr.includes('8,00 m'));

// Vérif offsets xref cohérents (chaque "N 0 obj" se trouve bien à l'offset annoncé)
const xrefMatch = pdfStr.match(/\nxref\n0 6\n([\s\S]*?)\ntrailer/);
let offsetsOk = true;
if (xrefMatch) {
  const lines = xrefMatch[1].split('\n').slice(1); // ignore l'entrée 0 (free)
  lines.forEach((ln, idx) => {
    const off = parseInt(ln.slice(0, 10), 10);
    const expect = (idx + 1) + ' 0 obj';
    if (pdfStr.substr(off, expect.length) !== expect) offsetsOk = false;
  });
}
check('offsets xref pointent sur les bons objets', offsetsOk);

console.log(ok ? '\n>>> TOUS LES CONTROLES PASSENT' : '\n>>> ECHEC');
process.exit(ok ? 0 : 1);
