/* QlygoCAD — engine/dxf.js
 * Import DXF (ASCII) -> entités QlygoCAD natives, en MILLIMÈTRES RÉELS.
 * Objectif : ouvrir n'importe quel plan AutoCAD exporté en DXF sans perte —
 * lignes, polylignes, cercles, arcs, ellipses, textes, hachures/solides,
 * et surtout les BLOCS (INSERT) qui composent la plupart des plans réels —
 * en CONSERVANT la structure des CALQUES (nom + couleur), l'échelle réelle
 * (via $INSUNITS) et les couleurs vraies (truecolor 420).
 * Fonctions PURES : aucune dépendance au Canvas ni à Electron -> réutilisable
 * côté navigateur ET en appli bureautique (et embarquable dans QLYGO).
 */
(function (root) {
  const D = {};

  // Palette ACI (index couleur AutoCAD) -> hex (sous-ensemble courant + repli).
  const ACI = {
    1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff',
    7: '#e8ebf2', 8: '#808080', 9: '#c0c0c0',
    10: '#ff0000', 11: '#ff7f7f', 30: '#ff7f00', 40: '#ffbf00', 50: '#ffff00',
    60: '#bfff00', 70: '#7fff00', 90: '#00ff00', 140: '#00ffff', 150: '#007fff',
    170: '#0000ff', 210: '#7f00ff', 230: '#ff00ff',
    250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe', 255: '#ffffff'
  };
  function aci(n) { if (n == null) return null; if (ACI[n]) return ACI[n]; return '#9fb0d0'; }
  function trueColorHex(n) { if (n == null) return null; const v = (n & 0xffffff); return '#' + v.toString(16).padStart(6, '0'); }

  function insFactor(code) {
    return ({ 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 25.4 / 1000, 9: 0.1, 10: 914.4, 13: 1e-6, 14: 0.01, 15: 10000, 16: 1e6 })[code] || null;
  }

  function tokenize(text) {
    const L = text.split(/\r\n|\r|\n/), t = [];
    let i = 0;
    while (i + 1 < L.length) {
      const code = parseInt(L[i].trim(), 10); const val = L[i + 1];
      i += 2;
      if (Number.isNaN(code)) { i -= 1; continue; }
      t.push({ code, val });
    }
    return t;
  }
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
  function seqPts(g) { const out = []; let cur = null; for (const x of g) { if (x.code === 10) { cur = { x: parseFloat(x.val), y: 0 }; out.push(cur); } else if (x.code === 20 && cur) cur.y = parseFloat(x.val); } return out; }

  function circlePoints(cx, cy, r) { const n = 64, p = []; for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; p.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return p; }
  function arcPoints(cx, cy, r, a0, a1) {
    let s = a0 * Math.PI / 180, e = a1 * Math.PI / 180; if (e <= s) e += 2 * Math.PI;
    const n = Math.max(6, Math.ceil((e - s) / (Math.PI / 24))), p = [];
    for (let i = 0; i <= n; i++) { const a = s + (e - s) * i / n; p.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
    return p;
  }
  function ellipsePoints(cx, cy, mx, my, ratio, a0, a1) {
    const major = Math.hypot(mx, my) || 1, minor = major * (ratio || 1), ang = Math.atan2(my, mx);
    let s = (a0 == null ? 0 : a0), e = (a1 == null ? 2 * Math.PI : a1); if (e <= s) e += 2 * Math.PI;
    const ca = Math.cos(ang), sa = Math.sin(ang), n = 72, p = [];
    for (let i = 0; i <= n; i++) {
      const t = s + (e - s) * i / n, ux = Math.cos(t) * major, uy = Math.sin(t) * minor;
      p.push({ x: cx + ux * ca - uy * sa, y: cy + ux * sa + uy * ca });
    }
    return p;
  }
  function cleanMtext(s) { return (s || '').replace(/\\P/g, '\n').replace(/\\~/g, ' ').replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/[{}]/g, '').replace(/\\\\/g, '\\'); }

  // Couleur d'une entité : truecolor (420) prioritaire, sinon ACI (62), sinon BYLAYER (null)
  function entColor(g) {
    const tc = getn(g, 420); if (tc != null) return trueColorHex(tc);
    const c = getn(g, 62); return (c != null && c !== 256 && c !== 0) ? aci(Math.abs(c)) : null;
  }
  const lay = g => (get(g, 8) || '0').trim();

  // Construit une entité QlygoCAD à partir d'un enregistrement simple (hors INSERT/POLYLINE).
  function buildEntity(type, g) {
    const layer = lay(g), color = entColor(g);
    if (type === 'LINE') {
      const x1 = getn(g, 10), y1 = getn(g, 20), x2 = getn(g, 11), y2 = getn(g, 21);
      if ([x1, y1, x2, y2].every(isFinite)) return { type: 'polyline', points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], layer, color, penMm: 0.25 };
    } else if (type === 'LWPOLYLINE') {
      const pts = seqPts(g); if (pts.length >= 2) return { type: 'polyline', points: pts, layer, color, penMm: 0.25, closed: ((getn(g, 70) || 0) & 1) === 1 };
    } else if (type === 'CIRCLE') {
      const cx = getn(g, 10), cy = getn(g, 20), r = getn(g, 40);
      if ([cx, cy, r].every(isFinite)) return { type: 'circle', center: { x: cx, y: cy }, r, points: circlePoints(cx, cy, r), closed: true, layer, color, penMm: 0.25 };
    } else if (type === 'ARC') {
      const cx = getn(g, 10), cy = getn(g, 20), r = getn(g, 40), a0 = getn(g, 50), a1 = getn(g, 51);
      if ([cx, cy, r, a0, a1].every(isFinite)) return { type: 'polyline', points: arcPoints(cx, cy, r, a0, a1), layer, color, penMm: 0.25 };
    } else if (type === 'ELLIPSE') {
      const cx = getn(g, 10), cy = getn(g, 20), mx = getn(g, 11), my = getn(g, 21), ratio = getn(g, 40), a0 = getn(g, 41), a1 = getn(g, 42);
      if ([cx, cy, mx, my].every(isFinite)) return { type: 'polyline', points: ellipsePoints(cx, cy, mx, my, ratio, a0, a1), layer, color, penMm: 0.25, closed: a0 == null };
    } else if (type === 'SPLINE') {
      // approximation : relie les points de lissage (11/21) ou de contrôle (10/20)
      const fit = []; let c = null;
      for (const x of g) { if (x.code === 11) { c = { x: parseFloat(x.val), y: 0 }; fit.push(c); } else if (x.code === 21 && c) c.y = parseFloat(x.val); }
      const pts = fit.length >= 2 ? fit : seqPts(g);
      if (pts.length >= 2) return { type: 'polyline', points: pts, layer, color, penMm: 0.25, closed: ((getn(g, 70) || 0) & 1) === 1 };
    } else if (type === 'TEXT') {
      const x = getn(g, 10), y = getn(g, 20), h = getn(g, 40) || 2.5, s = get(g, 1), rot = getn(g, 50) || 0;
      if (isFinite(x) && isFinite(y) && s) return { type: 'text', points: [{ x, y }], text: s, hMm: h, angleDeg: rot, layer, color };
    } else if (type === 'MTEXT') {
      const x = getn(g, 10), y = getn(g, 20), h = getn(g, 40) || 2.5, rot = getn(g, 50) || 0;
      const s = cleanMtext(g.filter(z => z.code === 3).map(z => z.val).join('') + (get(g, 1) || ''));
      if (isFinite(x) && isFinite(y) && s) return { type: 'text', points: [{ x, y }], text: s, hMm: h, angleDeg: rot, layer, color };
    } else if (type === 'SOLID' || type === '3DFACE') {
      const p0 = { x: getn(g, 10), y: getn(g, 20) }, p1 = { x: getn(g, 11), y: getn(g, 21) }, p2 = { x: getn(g, 12), y: getn(g, 22) }, p3 = { x: getn(g, 13), y: getn(g, 23) };
      let poly = (type === 'SOLID' ? [p0, p1, p3, p2] : [p0, p1, p2, p3]).filter(p => isFinite(p.x) && isFinite(p.y));
      if (poly.length >= 4 && poly[3].x === poly[2].x && poly[3].y === poly[2].y) poly.pop();
      if (poly.length >= 3) return { type: 'hatch', points: poly, pattern: 'solid', color, spacingMm: 300, angleDeg: 45, layer };
    } else if (type === 'HATCH') {
      const pts = seqPts(g), name = (get(g, 2) || 'SOLID').trim();
      if (pts.length >= 3) return { type: 'hatch', points: pts, pattern: name.toUpperCase() === 'SOLID' ? 'solid' : 'lines', color, spacingMm: 300, angleDeg: 45, layer };
    }
    return null;
  }

  D.parse = function (text) {
    const recs = records(tokenize(text));
    // 1) unité
    let factor = null;
    for (const r of recs) if (r.type === 'SECTION' && (get(r.g, 2) || '').trim() === 'HEADER') {
      for (let k = 0; k < r.g.length; k++) if (r.g[k].code === 9 && (r.g[k].val || '').trim() === '$INSUNITS') { const n = r.g[k + 1] && r.g[k + 1].code === 70 ? parseInt(r.g[k + 1].val, 10) : null; factor = insFactor(n); break; }
    }
    if (factor == null) factor = 1000; // défaut : mètres -> mm (cas cadastre)

    // 2) calques (nom + couleur, truecolor pris en compte)
    const layers = [], layerColor = {};
    { let section = null, inTables = false;
      for (const r of recs) {
        if (r.type === 'SECTION') { section = (get(r.g, 2) || '').trim(); inTables = section === 'TABLES'; continue; }
        if (r.type === 'ENDSEC') { inTables = false; continue; }
        if (inTables && r.type === 'LAYER') {
          const name = (get(r.g, 2) || '0').trim(); if (name === '') continue;
          const tc = getn(r.g, 420), col = getn(r.g, 62);
          const hex = tc != null ? trueColorHex(tc) : aci(col != null ? Math.abs(col) : null);
          if (!layerColor[name]) { layerColor[name] = hex || '#9fb0d0'; layers.push({ name, color: hex || '#9fb0d0' }); }
        }
      }
    }

    // 3) blocs (BLOCKS) : nom -> { base, recs }
    const blocks = {};
    { let section = null, inBlocks = false, cur = null;
      for (const r of recs) {
        if (r.type === 'SECTION') { section = (get(r.g, 2) || '').trim(); inBlocks = section === 'BLOCKS'; cur = null; continue; }
        if (r.type === 'ENDSEC') { inBlocks = false; cur = null; continue; }
        if (!inBlocks) continue;
        if (r.type === 'BLOCK') { const name = (get(r.g, 2) || '').trim(); cur = { bx: getn(r.g, 10) || 0, by: getn(r.g, 20) || 0, recs: [] }; if (name) blocks[name] = cur; continue; }
        if (r.type === 'ENDBLK') { cur = null; continue; }
        if (cur) cur.recs.push(r);
      }
    }

    // 4) émission des entités (ENTITIES), avec expansion récursive des INSERT/blocs
    const ents = [];
    function emit(list, X, depth) {
      if (depth > 10) return;
      for (let i = 0; i < list.length; i++) {
        const r = list[i], g = r.g;
        if (r.type === 'INSERT') {
          const name = (get(g, 2) || '').trim(), blk = blocks[name]; if (!blk) continue;
          const ix = getn(g, 10) || 0, iy = getn(g, 20) || 0, sx = getn(g, 41) || 1, sy = getn(g, 42) || 1, rotd = getn(g, 50) || 0, rot = rotd * Math.PI / 180;
          const cos = Math.cos(rot), sin = Math.sin(rot), bx = blk.bx, by = blk.by;
          const L = p => { const x = (p.x - bx) * sx, y = (p.y - by) * sy; return { x: ix + x * cos - y * sin, y: iy + x * sin + y * cos }; };
          emit(blk.recs, { tf: p => X.tf(L(p)), sc: X.sc * Math.sqrt(Math.abs(sx * sy) || 1), rot: X.rot + rotd }, depth + 1);
          continue;
        }
        if (r.type === 'POLYLINE') {
          const closed = ((getn(g, 70) || 0) & 1) === 1, pts = [], layer = lay(g), color = entColor(g);
          let j = i + 1;
          for (; j < list.length; j++) { const rr = list[j]; if (rr.type === 'VERTEX') { const x = getn(rr.g, 10), y = getn(rr.g, 20); if (isFinite(x) && isFinite(y)) pts.push({ x, y }); } else if (rr.type === 'SEQEND') break; else break; }
          i = j;
          if (pts.length >= 2) pushEnt({ type: 'polyline', points: pts, layer, color, penMm: 0.25, closed }, X);
          continue;
        }
        const e = buildEntity(r.type, g);
        if (e) pushEnt(e, X);
      }
    }
    function pushEnt(e, X) {
      if (e.points) e.points = e.points.map(X.tf);
      if (e.center) e.center = X.tf(e.center);
      if (e.type === 'circle' && (X.sc !== 1 || X.rot !== 0)) { e.type = 'polyline'; e.closed = true; delete e.center; delete e.r; }
      if (e.hMm) e.hMm *= X.sc;
      if (e.type === 'text' && X.rot) e.angleDeg = (e.angleDeg || 0) + X.rot;
      ents.push(e);
    }
    { let section = null, inEnt = false; const top = [];
      for (const r of recs) {
        if (r.type === 'SECTION') { section = (get(r.g, 2) || '').trim(); inEnt = section === 'ENTITIES'; continue; }
        if (r.type === 'ENDSEC') { inEnt = false; continue; }
        if (inEnt) top.push(r);
      }
      emit(top, { tf: p => ({ x: p.x, y: p.y }), sc: 1, rot: 0 }, 0);
    }

    // 5) mise à l'échelle (mm) + recentrage près de l'origine
    let minX = Infinity, minY = Infinity;
    const scalePt = p => { p.x *= factor; p.y *= factor; if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; };
    for (const e of ents) { (e.points || []).forEach(scalePt); if (e.center) { e.center.x *= factor; e.center.y *= factor; } if (e.hMm) e.hMm *= factor; if (e.r) e.r *= factor; }
    if (!isFinite(minX)) { minX = 0; minY = 0; }
    for (const e of ents) { (e.points || []).forEach(p => { p.x -= minX; p.y -= minY; }); if (e.center) { e.center.x -= minX; e.center.y -= minY; } }

    // calques réellement utilisés mais absents de la table
    const used = {}; ents.forEach(e => { used[e.layer] = true; });
    Object.keys(used).forEach(name => { if (!layerColor[name]) layers.push({ name, color: '#9fb0d0' }); });

    return { layers, entities: ents, origin: { x: minX, y: minY }, units: factor };
  };

  // ---- ÉCRITURE DXF (AC1015 ASCII) : export vers AutoCAD / tout logiciel CAO ----
  // Coordonnées en mm (réelles). Les cotes/hachures sont « éclatées » en géométrie
  // simple (lignes + texte + contours) pour un affichage fidèle partout.
  D.write = function (scene, opts) {
    opts = opts || {};
    const L = [];
    const out = (code, val) => { L.push(code); L.push(val); };
    const fmt = n => (Math.round(n * 1e6) / 1e6);
    const rgb = hex => (!hex || hex[0] !== '#') ? 0 : (parseInt(hex.slice(1, 7), 16) || 0);
    const layers = (scene.layers || []).slice();
    if (!layers.some(l => (l.name || '') === '0')) layers.unshift({ id: '__0', name: '0', color: '#000000' });
    const used = new Set(), nameOf = {};
    layers.forEach(l => { let nm = String(l.name || '0').replace(/[<>/\\":;?*|=`,\u0000-\u001f]/g, '_'); let b = nm, i = 1; while (used.has(nm)) nm = b + '_' + (i++); used.add(nm); nameOf[l.id] = nm; });
    const G = root.QCAD && root.QCAD.geometry, Rr = root.QCAD && root.QCAD.render;
    // HEADER (unités = millimètres)
    out(0, 'SECTION'); out(2, 'HEADER'); out(9, '$ACADVER'); out(1, 'AC1015'); out(9, '$INSUNITS'); out(70, 4); out(0, 'ENDSEC');
    // TABLES : définitions de calques (nom + couleur vraie)
    out(0, 'SECTION'); out(2, 'TABLES'); out(0, 'TABLE'); out(2, 'LAYER'); out(70, layers.length);
    layers.forEach(l => { out(0, 'LAYER'); out(2, nameOf[l.id]); out(70, 0); out(62, 7); out(420, rgb(l.color)); out(6, 'CONTINUOUS'); });
    out(0, 'ENDTAB'); out(0, 'ENDSEC');
    // ENTITIES
    out(0, 'SECTION'); out(2, 'ENTITIES');
    const poly = (pts, closed, lname, col) => { if (!pts || pts.length < 2) return; out(0, 'LWPOLYLINE'); out(100, 'AcDbEntity'); out(8, lname); if (col) out(420, rgb(col)); out(100, 'AcDbPolyline'); out(90, pts.length); out(70, closed ? 1 : 0); pts.forEach(p => { out(10, fmt(p.x)); out(20, fmt(p.y)); }); };
    const text = (x, y, h, s, ang, lname, col) => { out(0, 'TEXT'); out(8, lname); if (col) out(420, rgb(col)); out(10, fmt(x)); out(20, fmt(y)); out(40, fmt(h)); out(1, String(s == null ? '' : s).replace(/\n/g, ' ')); if (ang) out(50, fmt(ang)); };
    for (const e of (scene.entities || [])) {
      const lname = nameOf[e.layer] || '0', col = e.color || null;
      if (e.type === 'hatch') { poly(e.points, true, lname, col); if (e.holes) e.holes.forEach(h => poly(h, true, lname, col)); }
      else if (e.type === 'circle' && e.center) { out(0, 'CIRCLE'); out(8, lname); if (col) out(420, rgb(col)); out(10, fmt(e.center.x)); out(20, fmt(e.center.y)); out(40, fmt(e.r)); }
      else if (e.type === 'text' && e.points && e.points.length) { const h = e.hMm || 800, p = e.points[0]; text(p.x, p.y - h, h, e.text, e.angleDeg || 0, lname, col); }
      else if (e.type === 'dim' && G) {
        const vcol = col || '#b9375e';
        const g = G.dimGeometry(e, (e.dec != null) ? (mm => (mm / 1000).toFixed(e.dec).replace('.', ',') + ' m') : null);
        poly([g.extA[0], g.extA[1]], false, lname, vcol); poly([g.extB[0], g.extB[1]], false, lname, vcol); poly([g.da, g.db], false, lname, vcol);
        const h = Rr ? Rr.dimHmm(e) : 250; text(g.mid.x - (g.text.length * h * 0.3), g.mid.y + h * 0.15, h, g.text, g.angleDeg, lname, vcol);
      }
      else if (e.points && e.points.length >= 2) poly(e.points, !!e.closed, lname, col);
    }
    out(0, 'ENDSEC'); out(0, 'EOF');
    let s = ''; for (let i = 0; i < L.length; i += 2) s += L[i] + '\r\n' + L[i + 1] + '\r\n'; return s;
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.dxf = D;
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
})(typeof window !== 'undefined' ? window : globalThis);
