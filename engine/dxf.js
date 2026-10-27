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

  // ---- ÉCRITURE DXF (AC1009 / R12 ASCII) : export vers AutoCAD / tout logiciel CAO ----
  // On vise le format R12, le plus universellement accepté : AutoCAD l'ouvre SANS
  // réparation (pas besoin de handles, de BLOCK_RECORD ni de section OBJECTS).
  // Coordonnées en mm (réelles). Les cotes/hachures sont « éclatées » en géométrie
  // simple (lignes + texte + contours). Couleurs : index ACL le plus proche
  // (R12 ne gère pas la vraie couleur RVB ; on choisit l'ACI visuellement le plus proche).
  const ACI_RGB = [[1,255,0,0],[2,255,255,0],[3,0,255,0],[4,0,255,255],[5,0,0,255],[6,255,0,255],[7,255,255,255],[8,128,128,128],[9,192,192,192],[10,255,0,0],[11,255,127,127],[12,165,0,0],[13,165,82,82],[14,127,0,0],[15,127,63,63],[16,76,0,0],[17,76,38,38],[18,38,0,0],[19,38,19,19],[20,255,63,0],[21,255,159,127],[22,165,41,0],[23,165,103,82],[24,127,31,0],[25,127,79,63],[26,76,19,0],[27,76,47,38],[28,38,9,0],[29,38,23,19],[30,255,127,0],[31,255,191,127],[32,165,82,0],[33,165,124,82],[34,127,63,0],[35,127,95,63],[36,76,38,0],[37,76,57,38],[38,38,19,0],[39,38,28,19],[40,255,191,0],[41,255,223,127],[42,165,124,0],[43,165,145,82],[44,127,95,0],[45,127,111,63],[46,76,57,0],[47,76,66,38],[48,38,28,0],[49,38,33,19],[50,255,255,0],[51,255,255,127],[52,165,165,0],[53,165,165,82],[54,127,127,0],[55,127,127,63],[56,76,76,0],[57,76,76,38],[58,38,38,0],[59,38,38,19],[60,191,255,0],[61,223,255,127],[62,124,165,0],[63,145,165,82],[64,95,127,0],[65,111,127,63],[66,57,76,0],[67,66,76,38],[68,28,38,0],[69,33,38,19],[70,127,255,0],[71,191,255,127],[72,82,165,0],[73,124,165,82],[74,63,127,0],[75,95,127,63],[76,38,76,0],[77,57,76,38],[78,19,38,0],[79,28,38,19],[80,63,255,0],[81,159,255,127],[82,41,165,0],[83,103,165,82],[84,31,127,0],[85,79,127,63],[86,19,76,0],[87,47,76,38],[88,9,38,0],[89,23,38,19],[90,0,255,0],[91,127,255,127],[92,0,165,0],[93,82,165,82],[94,0,127,0],[95,63,127,63],[96,0,76,0],[97,38,76,38],[98,0,38,0],[99,19,38,19],[100,0,255,63],[101,127,255,159],[102,0,165,41],[103,82,165,103],[104,0,127,31],[105,63,127,79],[106,0,76,19],[107,38,76,47],[108,0,38,9],[109,19,88,23],[110,0,255,127],[111,127,255,191],[112,0,165,82],[113,82,165,124],[114,0,127,63],[115,63,127,95],[116,0,76,38],[117,38,76,57],[118,0,38,19],[119,19,88,28],[120,0,255,191],[121,127,255,223],[122,0,165,124],[123,82,165,145],[124,0,127,95],[125,63,127,111],[126,0,76,57],[127,38,76,66],[128,0,38,28],[129,19,88,88],[130,0,255,255],[131,127,255,255],[132,0,165,165],[133,82,165,165],[134,0,127,127],[135,63,127,127],[136,0,76,76],[137,38,76,76],[138,0,38,38],[139,19,88,88],[140,0,191,255],[141,127,223,255],[142,0,124,165],[143,82,145,165],[144,0,95,127],[145,63,111,127],[146,0,57,76],[147,38,66,126],[148,0,28,38],[149,19,88,88],[150,0,127,255],[151,127,191,255],[152,0,82,165],[153,82,124,165],[154,0,63,127],[155,63,95,127],[156,0,38,76],[157,38,57,126],[158,0,19,38],[159,19,28,88],[160,0,63,255],[161,127,159,255],[162,0,41,165],[163,82,103,165],[164,0,31,127],[165,63,79,127],[166,0,19,76],[167,38,47,126],[168,0,9,38],[169,19,23,88],[170,0,0,255],[171,127,127,255],[172,0,0,165],[173,82,82,165],[174,0,0,127],[175,63,63,127],[176,0,0,76],[177,38,38,126],[178,0,0,38],[179,19,19,88],[180,63,0,255],[181,159,127,255],[182,41,0,165],[183,103,82,165],[184,31,0,127],[185,79,63,127],[186,19,0,76],[187,47,38,126],[188,9,0,38],[189,23,19,88],[190,127,0,255],[191,191,127,255],[192,82,0,165],[193,124,82,165],[194,63,0,127],[195,95,63,127],[196,38,0,76],[197,57,38,126],[198,19,0,38],[199,28,19,88],[200,191,0,255],[201,223,127,255],[202,124,0,165],[203,145,82,165],[204,95,0,127],[205,111,63,127],[206,57,0,76],[207,66,38,76],[208,28,0,38],[209,88,19,88],[210,255,0,255],[211,255,127,255],[212,165,0,165],[213,165,82,165],[214,127,0,127],[215,127,63,127],[216,76,0,76],[217,76,38,76],[218,38,0,38],[219,88,19,88],[220,255,0,191],[221,255,127,223],[222,165,0,124],[223,165,82,145],[224,127,0,95],[225,127,63,111],[226,76,0,57],[227,76,38,66],[228,38,0,28],[229,88,19,88],[230,255,0,127],[231,255,127,191],[232,165,0,82],[233,165,82,124],[234,127,0,63],[235,127,63,95],[236,76,0,38],[237,76,38,57],[238,38,0,19],[239,88,19,28],[240,255,0,63],[241,255,127,159],[242,165,0,41],[243,165,82,103],[244,127,0,31],[245,127,63,79],[246,76,0,19],[247,76,38,47],[248,38,0,9],[249,88,19,23],[250,0,0,0],[251,101,101,101],[252,102,102,102],[253,153,153,153],[254,204,204,204],[255,255,255,255]];
  // Texte DXF : tout caractère non-ASCII -> séquence \U+XXXX (fichier 100 % ASCII,
  // donc insensible à l'encodage du fichier ; AutoCAD décode \U+ nativement).
  function escTxt(s) {
    s = String(s == null ? '' : s).replace(/\n/g, ' ');
    let o = '';
    for (const ch of s) { const c = ch.codePointAt(0); o += (c > 126 || c < 32) ? '\\U+' + c.toString(16).toUpperCase().padStart(4, '0') : ch; }
    return o;
  }
  // Nom de calque : replie les accents (ç->c, é->e…) puis remplace le reste du non-ASCII.
  function foldName(s) {
    return String(s == null ? '0' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\x20-\x7e]/g, '_').replace(/[<>/\\":;?*|=`,]/g, '_').trim().toUpperCase();
  }

  function hexToAci(hex) {
    if (!hex || hex[0] !== '#' || hex.length < 7) return null; // null => BYLAYER (pas de code 62)
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    if (![r, g, b].every(isFinite)) return null;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    // noir ou blanc quasi purs -> couleur 7 (contraste avec le fond, toujours visible)
    if (mx - mn <= 16 && (mx <= 40 || mn >= 215)) return 7;
    let best = 7, bd = Infinity;
    for (let i = 0; i < ACI_RGB.length; i++) { const a = ACI_RGB[i], d = (r - a[1]) * (r - a[1]) + (g - a[2]) * (g - a[2]) + (b - a[3]) * (b - a[3]); if (d < bd) { bd = d; best = a[0]; } }
    return best;
  }

  D.write = function (scene, opts) {
    opts = opts || {};
    const L = [];
    const out = (code, val) => { L.push(code); L.push(val); };
    const fmt = n => (Math.round((n || 0) * 1e6) / 1e6);
    // calques : garantir « 0 », assainir/dédupliquer les noms, indexer par id ET par nom
    const layers = (scene.layers || []).slice();
    if (!layers.some(l => (l.name || '') === '0')) layers.unshift({ id: '__0', name: '0', color: '#ffffff' });
    const used = new Set(), nameOf = {};
    layers.forEach(l => {
      let nm = foldName(l.name || '0');
      if (nm === '') nm = '0';
      let b = nm, i = 1; while (used.has(nm)) nm = b + '_' + (i++); used.add(nm);
      if (l.id != null) nameOf[l.id] = nm; nameOf[l.name] = nm;
    });
    const lnameFor = e => nameOf[e.layer] || (used.has(String(e.layer || '').toUpperCase()) ? String(e.layer).toUpperCase() : '0');
    const G = root.QCAD && root.QCAD.geometry, Rr = root.QCAD && root.QCAD.render;

    // ---- HEADER ----
    out(0, 'SECTION'); out(2, 'HEADER');
    out(9, '$ACADVER'); out(1, 'AC1009');       // R12
    out(9, '$INSUNITS'); out(70, 4);            // millimètres
    out(9, '$MEASUREMENT'); out(70, 1);         // système métrique
    out(9, '$DWGCODEPAGE'); out(3, 'ANSI_1252'); // page de code (texte en ASCII + \U+ de toute façon)
    out(0, 'ENDSEC');

    // ---- TABLES : VPORT, LTYPE (CONTINUOUS), LAYER, STYLE (STANDARD) ----
    out(0, 'SECTION'); out(2, 'TABLES');
    // VPORT actif (valeurs standard)
    out(0, 'TABLE'); out(2, 'VPORT'); out(70, 1);
    out(0, 'VPORT'); out(2, '*ACTIVE'); out(70, 0);
    out(10, 0); out(20, 0); out(11, 1); out(21, 1); out(12, 0); out(22, 0); out(13, 0); out(23, 0);
    out(14, 10); out(24, 10); out(15, 10); out(25, 10); out(16, 0); out(26, 0); out(36, 1);
    out(17, 0); out(27, 0); out(37, 0); out(40, 297); out(41, 1.5); out(42, 50); out(43, 0); out(44, 0);
    out(50, 0); out(51, 0); out(71, 0); out(72, 100); out(73, 1); out(74, 3); out(75, 0); out(76, 1); out(77, 0); out(78, 0);
    out(0, 'ENDTAB');
    // Type de ligne continu (référencé par tous les calques)
    out(0, 'TABLE'); out(2, 'LTYPE'); out(70, 1);
    out(0, 'LTYPE'); out(2, 'CONTINUOUS'); out(70, 0); out(3, 'Solid line'); out(72, 65); out(73, 0); out(40, 0);
    out(0, 'ENDTAB');
    // Calques
    out(0, 'TABLE'); out(2, 'LAYER'); out(70, layers.length);
    layers.forEach(l => { out(0, 'LAYER'); out(2, nameOf[l.name]); out(70, 0); out(62, hexToAci(l.color) || 7); out(6, 'CONTINUOUS'); });
    out(0, 'ENDTAB');
    // Style de texte STANDARD (référencé par les TEXT)
    out(0, 'TABLE'); out(2, 'STYLE'); out(70, 1);
    out(0, 'STYLE'); out(2, 'STANDARD'); out(70, 0); out(40, 0); out(41, 1); out(50, 0); out(71, 0); out(42, 2.5); out(3, 'txt'); out(4, '');
    out(0, 'ENDTAB');
    out(0, 'ENDSEC');

    // ---- BLOCKS (vide mais présent) ----
    out(0, 'SECTION'); out(2, 'BLOCKS'); out(0, 'ENDSEC');

    // ---- ENTITIES ----
    out(0, 'SECTION'); out(2, 'ENTITIES');
    const poly = (pts, closed, ln, aci) => {
      if (!pts || pts.length < 2) return;
      out(0, 'POLYLINE'); out(8, ln); if (aci != null) out(62, aci); out(66, 1); out(70, closed ? 1 : 0);
      out(10, 0); out(20, 0); out(30, 0);
      pts.forEach(p => { out(0, 'VERTEX'); out(8, ln); out(10, fmt(p.x)); out(20, fmt(p.y)); out(30, 0); });
      out(0, 'SEQEND'); out(8, ln);
    };
    const text = (x, y, h, s, ang, ln, aci) => {
      out(0, 'TEXT'); out(8, ln); if (aci != null) out(62, aci);
      out(10, fmt(x)); out(20, fmt(y)); out(30, 0); out(40, fmt(h));
      out(1, escTxt(s)); if (ang) out(50, fmt(ang)); out(7, 'STANDARD');
    };
    for (const e of (scene.entities || [])) {
      const ln = lnameFor(e), aci = e.color ? hexToAci(e.color) : null;
      if (e.type === 'hatch') { poly(e.points, true, ln, aci); if (e.holes) e.holes.forEach(h => poly(h, true, ln, aci)); }
      else if (e.type === 'circle' && e.center) { out(0, 'CIRCLE'); out(8, ln); if (aci != null) out(62, aci); out(10, fmt(e.center.x)); out(20, fmt(e.center.y)); out(30, 0); out(40, fmt(e.r)); }
      else if (e.type === 'text' && e.points && e.points.length) { const h = e.hMm || 800, p = e.points[0]; text(p.x, p.y - h, h, e.text, e.angleDeg || 0, ln, aci); }
      else if (e.type === 'dim' && G) {
        const vaci = aci != null ? aci : hexToAci('#b9375e');
        const g = G.dimGeometry(e, (e.dec != null) ? (mm => (mm / 1000).toFixed(e.dec).replace('.', ',') + ' m') : null);
        poly([g.extA[0], g.extA[1]], false, ln, vaci); poly([g.extB[0], g.extB[1]], false, ln, vaci); poly([g.da, g.db], false, ln, vaci);
        const h = Rr ? Rr.dimHmm(e) : 250; text(g.mid.x - (g.text.length * h * 0.3), g.mid.y + h * 0.15, h, g.text, g.angleDeg, ln, vaci);
      }
      else if (e.points && e.points.length >= 2) poly(e.points, !!e.closed, ln, aci);
    }
    out(0, 'ENDSEC'); out(0, 'EOF');
    let s = ''; for (let i = 0; i < L.length; i += 2) s += L[i] + '\r\n' + L[i + 1] + '\r\n'; return s;
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.dxf = D;
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
})(typeof window !== 'undefined' ? window : globalThis);
