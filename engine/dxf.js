/* QlygoCAD — engine/dxf.js
 * Import DXF (ASCII) -> entités QlygoCAD natives, en MILLIMÈTRES RÉELS.
 * Objectif : récupérer un export cadastre.gouv (ou AutoCAD) en CONSERVANT la
 * structure des CALQUES (traits du terrain, zones de remplissage/solides,
 * textes) dans des calques distincts.
 * Fonctions PURES : aucune dépendance au Canvas ni à Electron -> réutilisable
 * côté navigateur ET en appli bureautique (et embarquable dans QLYGO).
 */
(function (root) {
  const D = {};

  // --- Palette ACI (index couleur AutoCAD) -> hex. Sous-ensemble courant +
  //     repli neutre ; la couleur 7 (noir/blanc) devient claire pour l'espace sombre.
  const ACI = {
    1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff',
    7: '#e8ebf2', 8: '#808080', 9: '#c0c0c0',
    10: '#ff0000', 11: '#ff7f7f', 30: '#ff7f00', 40: '#ffbf00', 50: '#ffff00',
    60: '#bfff00', 70: '#7fff00', 90: '#00ff00', 140: '#00ffff', 150: '#007fff',
    170: '#0000ff', 210: '#7f00ff', 230: '#ff00ff',
    250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe', 255: '#ffffff'
  };
  function aci(n) { if (n == null) return null; if (ACI[n]) return ACI[n]; return '#9fb0d0'; }

  // Unité DXF ($INSUNITS) -> facteur vers millimètres
  function insFactor(code) {
    return ({ 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 25.4 / 1000, 9: 0.1, 10: 914.4, 13: 1e-6, 14: 0.01, 15: 10000, 16: 1e6 })[code] || null;
  }

  // Découpe le texte DXF en couples {code, val}
  function tokenize(text) {
    const L = text.split(/\r\n|\r|\n/), t = [];
    let i = 0;
    while (i + 1 < L.length) {
      const code = parseInt(L[i].trim(), 10); const val = L[i + 1];
      i += 2;
      if (Number.isNaN(code)) { i -= 1; continue; } // resync best-effort
      t.push({ code, val });
    }
    return t;
  }
  // Regroupe en enregistrements démarrant à chaque code 0
  function records(t) {
    const recs = []; let cur = { type: '_pre', g: [] }; recs.push(cur);
    for (const tok of t) {
      if (tok.code === 0) { cur = { type: (tok.val || '').trim(), g: [] }; recs.push(cur); }
      else cur.g.push(tok);
    }
    return recs;
  }
  const get = (g, c) => { for (const x of g) if (x.code === c) return x.val; return undefined; };
  const getn = (g, c) => { const v = get(g, c); return v == null ? undefined : parseFloat(v); };
  // Suites de points (10/20) dans l'ordre d'apparition
  function seqPts(g) { const out = []; let cur = null; for (const x of g) { if (x.code === 10) { cur = { x: parseFloat(x.val), y: 0 }; out.push(cur); } else if (x.code === 20 && cur) cur.y = parseFloat(x.val); } return out; }

  function circlePoints(cx, cy, r) { const n = 64, p = []; for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; p.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return p; }
  function arcPoints(cx, cy, r, a0, a1) {
    let s = a0 * Math.PI / 180, e = a1 * Math.PI / 180; if (e <= s) e += 2 * Math.PI;
    const n = Math.max(6, Math.ceil((e - s) / (Math.PI / 24))), p = [];
    for (let i = 0; i <= n; i++) { const a = s + (e - s) * i / n; p.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
    return p;
  }
  function cleanMtext(s) { return (s || '').replace(/\\P/g, '\n').replace(/\\~/g, ' ').replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/[{}]/g, '').replace(/\\\\/g, '\\'); }

  /* parse(text) -> { layers:[{name,color}], entities:[...], origin:{x,y}, units }
   * entities : modèle QlygoCAD (layer = NOM de calque DXF ; l'appli fera la
   * correspondance vers des id de calques). Coordonnées en mm, recentrées
   * près de l'origine (origin = décalage retiré, pour un éventuel géoréférencement).
   */
  D.parse = function (text) {
    const recs = records(tokenize(text));
    // 1) unité
    let factor = null;
    for (const r of recs) if (r.type === 'SECTION' && (get(r.g, 2) || '').trim() === 'HEADER') {
      for (let k = 0; k < r.g.length; k++) if (r.g[k].code === 9 && (r.g[k].val || '').trim() === '$INSUNITS') { const n = r.g[k + 1] && r.g[k + 1].code === 70 ? parseInt(r.g[k + 1].val, 10) : null; factor = insFactor(n); break; }
    }
    if (factor == null) factor = 1000; // par défaut : mètres -> mm (cas cadastre)

    // 2) calques déclarés dans les TABLES
    const layers = [], layerColor = {}; let section = null, inTables = false;
    for (const r of recs) {
      if (r.type === 'SECTION') { section = (get(r.g, 2) || '').trim(); inTables = section === 'TABLES'; continue; }
      if (r.type === 'ENDSEC') { section = null; inTables = false; continue; }
      if (inTables && r.type === 'LAYER') {
        const name = (get(r.g, 2) || '0').trim(); if (name === '' ) continue;
        const col = getn(r.g, 62); const hex = aci(col != null ? Math.abs(col) : null);
        if (!layerColor[name]) { layerColor[name] = hex || '#9fb0d0'; layers.push({ name, color: hex || '#9fb0d0' }); }
      }
    }

    // 3) entités (section ENTITIES uniquement)
    const ents = [];
    const entColor = g => { const c = getn(g, 62); return (c != null && c !== 256 && c !== 0) ? aci(Math.abs(c)) : null; };
    const lay = g => (get(g, 8) || '0').trim();
    section = null; let inEnt = false;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.type === 'SECTION') { section = (get(r.g, 2) || '').trim(); inEnt = section === 'ENTITIES'; continue; }
      if (r.type === 'ENDSEC') { inEnt = false; continue; }
      if (!inEnt) continue;
      const g = r.g, layer = lay(g), color = entColor(g);
      if (r.type === 'LINE') {
        const x1 = getn(g, 10), y1 = getn(g, 20), x2 = getn(g, 11), y2 = getn(g, 21);
        if ([x1, y1, x2, y2].every(isFinite)) ents.push({ type: 'polyline', points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], layer, color, penMm: 0.25 });
      } else if (r.type === 'LWPOLYLINE') {
        const pts = seqPts(g); if (pts.length >= 2) ents.push({ type: 'polyline', points: pts, layer, color, penMm: 0.25, closed: ((getn(g, 70) || 0) & 1) === 1 });
      } else if (r.type === 'POLYLINE') {
        const closed = ((getn(g, 70) || 0) & 1) === 1; const pts = [];
        let j = i + 1; for (; j < recs.length; j++) { const rr = recs[j]; if (rr.type === 'VERTEX') { const x = getn(rr.g, 10), y = getn(rr.g, 20); if (isFinite(x) && isFinite(y)) pts.push({ x, y }); } else if (rr.type === 'SEQEND') break; else if (rr.type === 'SECTION' || rr.type === 'ENDSEC') break; }
        i = j; if (pts.length >= 2) ents.push({ type: 'polyline', points: pts, layer, color, penMm: 0.25, closed });
      } else if (r.type === 'CIRCLE') {
        const cx = getn(g, 10), cy = getn(g, 20), rr = getn(g, 40);
        if ([cx, cy, rr].every(isFinite)) ents.push({ type: 'circle', center: { x: cx, y: cy }, r: rr, points: circlePoints(cx, cy, rr), closed: true, layer, color, penMm: 0.25 });
      } else if (r.type === 'ARC') {
        const cx = getn(g, 10), cy = getn(g, 20), rr = getn(g, 40), a0 = getn(g, 50), a1 = getn(g, 51);
        if ([cx, cy, rr, a0, a1].every(isFinite)) ents.push({ type: 'polyline', points: arcPoints(cx, cy, rr, a0, a1), layer, color, penMm: 0.25 });
      } else if (r.type === 'TEXT') {
        const x = getn(g, 10), y = getn(g, 20), h = getn(g, 40) || 2.5, s = get(g, 1), rot = getn(g, 50) || 0;
        if (isFinite(x) && isFinite(y) && s) ents.push({ type: 'text', points: [{ x, y }], text: s, hMm: h, angleDeg: rot, layer, color });
      } else if (r.type === 'MTEXT') {
        const x = getn(g, 10), y = getn(g, 20), h = getn(g, 40) || 2.5, rot = getn(g, 50) || 0;
        const chunks = g.filter(z => z.code === 3).map(z => z.val).join('') + (get(g, 1) || '');
        const s = cleanMtext(chunks);
        if (isFinite(x) && isFinite(y) && s) ents.push({ type: 'text', points: [{ x, y }], text: s, hMm: h, angleDeg: rot, layer, color });
      } else if (r.type === 'SOLID' || r.type === '3DFACE') {
        const p0 = { x: getn(g, 10), y: getn(g, 20) }, p1 = { x: getn(g, 11), y: getn(g, 21) }, p2 = { x: getn(g, 12), y: getn(g, 22) }, p3 = { x: getn(g, 13), y: getn(g, 23) };
        // SOLID : ordre 0,1,3,2 ; 3DFACE : 0,1,2,3
        let poly = r.type === 'SOLID' ? [p0, p1, p3, p2] : [p0, p1, p2, p3];
        poly = poly.filter(p => isFinite(p.x) && isFinite(p.y));
        // dédoublonne le dernier point s'il répète le précédent (triangle)
        if (poly.length >= 4 && poly[3].x === poly[2].x && poly[3].y === poly[2].y) poly.pop();
        if (poly.length >= 3) ents.push({ type: 'hatch', points: poly, pattern: 'solid', color, spacingMm: 300, angleDeg: 45, layer });
      } else if (r.type === 'HATCH') {
        const pts = seqPts(g); const name = (get(g, 2) || 'SOLID').trim();
        if (pts.length >= 3) ents.push({ type: 'hatch', points: pts, pattern: name.toUpperCase() === 'SOLID' ? 'solid' : 'lines', color, spacingMm: 300, angleDeg: 45, layer });
      }
    }

    // 4) mise à l'échelle (mm) + recentrage près de l'origine
    let minX = Infinity, minY = Infinity;
    const scalePt = p => { p.x *= factor; p.y *= factor; if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; };
    for (const e of ents) { (e.points || []).forEach(scalePt); if (e.center) { e.center.x *= factor; e.center.y *= factor; } if (e.hMm) e.hMm *= factor; if (e.r) e.r *= factor; }
    if (!isFinite(minX)) { minX = 0; minY = 0; }
    const ox = minX, oy = minY;
    for (const e of ents) { (e.points || []).forEach(p => { p.x -= ox; p.y -= oy; }); if (e.center) { e.center.x -= ox; e.center.y -= oy; } }

    // calques réellement utilisés par des entités (même absents de la table)
    const used = {}; ents.forEach(e => { used[e.layer] = true; });
    Object.keys(used).forEach(name => { if (!layerColor[name]) layers.push({ name, color: '#9fb0d0' }); });

    return { layers, entities: ents, origin: { x: ox, y: oy }, units: factor };
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.dxf = D;
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
})(typeof window !== 'undefined' ? window : globalThis);
