/* Contrôles automatiques des automatismes de précision (engine/snap.js). */
const path = require('path');
const root = globalThis;
require(path.join(__dirname, '..', 'engine', 'units.js'));
require(path.join(__dirname, '..', 'engine', 'geometry.js'));
require(path.join(__dirname, '..', 'engine', 'snap.js'));
const G = root.QCAD.geometry, SN = root.QCAD.snap;

let ok = true;
function check(l, c) { console.log((c ? 'OK  ' : 'FAIL') + '  ' + l); if (!c) ok = false; }
const near = (a, b, t) => Math.abs(a - b) <= (t || 0.001);

const s = G.createScene();
G.addRect(s, 0, 0, 10000, 8000, {});          // rectangle 10x8 m
G.addLine(s, 0, 4000, 10000, 4000, {});        // ligne horizontale médiane

// Accroche extrémité : près de (0,0)
let h = SN.query(s, { x: 50, y: 60 }, 200, { types: { end: true } });
check('accroche extrémité -> (0,0)', h && h.type === 'end' && near(h.x, 0) && near(h.y, 0));

// Accroche milieu du bas [0,0]-[10000,0] -> (5000,0)
h = SN.query(s, { x: 5010, y: 30 }, 200, { types: { mid: true } });
check('accroche milieu -> (5000,0)', h && h.type === 'mid' && near(h.x, 5000) && near(h.y, 0));

// Intersection ligne médiane x côté DROIT (point intérieur, pas une extrémité) -> (10000,4000)
// (on désactive les autres accroches pour isoler l'intersection)
h = SN.query(s, { x: 9970, y: 4030 }, 200,
  { types: { inter: true, end: false, mid: false, perp: false, grid: false } });
check('accroche intersection -> (10000,4000)', h && h.type === 'inter' && near(h.x, 10000) && near(h.y, 4000));

// Perpendiculaire depuis (3000,6000) sur le côté droit x=10000 -> (10000,6000)
h = SN.query(s, { x: 9900, y: 6050 }, 300, { from: { x: 3000, y: 6000 }, types: { perp: true } });
check('perpendiculaire -> (10000,6000)', h && h.type === 'perp' && near(h.x, 10000) && near(h.y, 6000));

// Ortho : de (0,0) vers (5000,120) -> horizontal pur (y=0), longueur conservée
let c = SN.constrain({ x: 0, y: 0 }, { x: 5000, y: 120 }, 90);
check('ortho force horizontal', near(c.y, 0, 1) && c.x > 4900);

// Polaire : de (0,0) vers (1000,900) -> 45° (x==y)
c = SN.constrain({ x: 0, y: 0 }, { x: 1000, y: 900 }, 45);
check('polaire force 45° (x==y)', near(c.x, c.y, 1));

// Cote au clavier : de (0,0) en visant la droite, longueur 3250 -> (3250,0)
let p = SN.alongDir({ x: 0, y: 0 }, { x: 999, y: 2 }, 3250);
check('saisie cote 3250 mm -> (3250,0)', near(p.x, 3250, 1) && near(p.y, 0, 7));

// Priorité : extrémité l'emporte sur grille au même endroit
h = SN.query(s, { x: 30, y: 30 }, 300, { grid: true, gridStepMm: 100, types: { end: true, grid: true } });
check('priorité extrémité > grille', h && h.type === 'end');

// Saisie dynamique "longueur<angle" : 2000 à 90° depuis (0,0) -> (0,2000)
p = SN.polar({ x: 0, y: 0 }, 2000, 90);
check('polar 2000<90 -> (0,2000)', near(p.x, 0, 1) && near(p.y, 2000, 1));
p = SN.polar({ x: 0, y: 0 }, 1000, 180);
check('polar 1000<180 -> (-1000,0)', near(p.x, -1000, 1) && near(p.y, 0, 1));

// Décaler (offset) : le bas [0,0]-[10000,0] décalé de +200 (côté gauche = +y) -> y=200
let o = SN.offset({ x: 0, y: 0 }, { x: 10000, y: 0 }, 200);
check('offset +200 du bas -> y=200', near(o.a.y, 200, 1) && near(o.b.y, 200, 1) && near(o.a.x, 0, 1));

// Outil Cote : survol près du bas [0,0]-[10000,0] -> accroche ce segment
let seg = SN.pickSegment(s, { x: 5000, y: 120 }, 300);
check('pickSegment trouve le bas', seg && near(Math.min(seg.a.y, seg.b.y), 0) && Math.abs(seg.a.x - seg.b.x) > 5000);
// loin de tout segment -> rien
check('pickSegment ne trouve rien au centre', SN.pickSegment(s, { x: 5000, y: 2000 }, 300) === null);

console.log(ok ? '\n>>> AUTOMATISMES : TOUS LES CONTROLES PASSENT' : '\n>>> ECHEC');
process.exit(ok ? 0 : 1);
