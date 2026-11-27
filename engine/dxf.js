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
  // Table ACI complète (256 couleurs AutoCAD) construite à la demande depuis ACI_RGB (défini plus bas,
  // réutilisé de l'export). Avant, seule une vingtaine d'indices étaient mappés -> couleurs fausses.
  let ACI_MAP = null;
  function aciFull() {
    if (!ACI_MAP) {
      ACI_MAP = {};
      for (const a of ACI_RGB) ACI_MAP[a[0]] = '#' + [a[1], a[2], a[3]].map(v => v.toString(16).padStart(2, '0')).join('');
      ACI_MAP[7] = '#e8ebf2'; // 7 = blanc/noir selon fond : clair lisible sur le fond sombre de QlygoCAD
    }
    return ACI_MAP;
  }
  function aci(n) { if (n == null) return null; const m = aciFull(); return m[n] || ACI[n] || '#9fb0d0'; }
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
  // Sommets de contour d'une HATCH UNIQUEMENT. On IGNORE le « point d'élévation » (premier 10/20,
  // presque toujours 0,0) qui, sinon, reliait chaque hachure à l'origine -> effet « éventail »/3D.
  // On ignore aussi les points de graine (seed, après code 98) et les données de motif.
  // Les contours « polyligne » utilisent 10/20 ; les contours « par arêtes » utilisent 10/20 + 11/21.
  function hatchPts(g) {
    const out = []; let cur = null, inB = false;
    for (const x of g) {
      if (x.code === 91) { inB = true; continue; }                  // début des contours (après l'élévation)
      if (x.code === 75 || x.code === 76 || x.code === 98 || x.code === 450 || x.code === 470) inB = false; // fin des contours
      if (!inB) continue;
      if (x.code === 10 || x.code === 11) { cur = { x: parseFloat(x.val), y: 0 }; out.push(cur); }
      else if ((x.code === 20 || x.code === 21) && cur) cur.y = parseFloat(x.val);
    }
    return out;
  }

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
  // Décode les échappements AutoCAD « \U+XXXX » (texte non-ASCII, p. ex. accents « Ç » = \U+00C7)
  // -> caractère réel. Sans ça, l'aller-retour QlygoCAD -> DXF -> QlygoCAD affichait « FA\U+00C7ADE ».
  function decodeU(s) { return String(s == null ? '' : s).replace(/\\U\+([0-9A-Fa-f]{4})/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } }); }
  function cleanMtext(s) { return decodeU(s || '').replace(/\\P/g, '\n').replace(/\\~/g, ' ').replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/[{}]/g, '').replace(/\\\\/g, '\\'); }

  // Couleur d'une entité : truecolor (420) prioritaire, sinon ACI (62), sinon BYLAYER (null)
  function entColor(g) {
    const tc = getn(g, 420); if (tc != null) return trueColorHex(tc);
    const c = getn(g, 62); return (c != null && c !== 256 && c !== 0) ? aci(Math.abs(c)) : null;
  }
  const lay = g => (get(g, 8) || '0').trim();


  // ---------- Courbes exactes (fidélité AutoCAD) ----------
  // Arc d'une « bulge » (polyligne arrondie) entre p0 et p1 : points intermédiaires (sans p0 ni p1).
  function bulgePts(p0, p1, b) {
    const th = 4 * Math.atan(b), dx = p1.x - p0.x, dy = p1.y - p0.y, c = Math.hypot(dx, dy);
    if (!b || c < 1e-12 || !isFinite(th)) return [];
    const h = c / (2 * Math.tan(th / 2)), R0 = Math.abs(c / (2 * Math.sin(th / 2)));
    const cx = (p0.x + p1.x) / 2 - dy / c * h, cy = (p0.y + p1.y) / 2 + dx / c * h, a0 = Math.atan2(p0.y - cy, p0.x - cx);
    const n = Math.max(4, Math.ceil(Math.abs(th) / (Math.PI / 24))), out = [];
    for (let t = 1; t < n; t++) { const a = a0 + th * t / n; out.push({ x: cx + R0 * Math.cos(a), y: cy + R0 * Math.sin(a) }); }
    return out;
  }
  // Polyligne avec arcs (code 42 = bulge du sommet) -> points (arcs échantillonnés).
  function lwPts(g, closed) {
    const vs = []; let cur = null;
    for (const x of g) { if (x.code === 10) { cur = { x: parseFloat(x.val), y: 0, b: 0 }; vs.push(cur); } else if (x.code === 20 && cur) cur.y = parseFloat(x.val); else if (x.code === 42 && cur) cur.b = parseFloat(x.val) || 0; }
    const out = [];
    vs.forEach((v, k) => { out.push({ x: v.x, y: v.y }); const nx = vs[k + 1] || (closed ? vs[0] : null); if (nx && v.b) bulgePts(v, nx, v.b).forEach(q => out.push(q)); });
    return out;
  }
  // B-spline / NURBS (algorithme de de Boor) : la VRAIE courbe, pas le polygone de contrôle.
  function bspline(ctrl, knots, deg, w) {
    const n = ctrl.length;
    if (n < deg + 1 || knots.length !== n + deg + 1) return ctrl.slice();
    const t0 = knots[deg], t1 = knots[n], N = Math.max(16, (n - deg) * 12), out = [];
    for (let sI = 0; sI <= N; sI++) {
      const u = t0 + (t1 - t0) * sI / N;
      let k = deg; while (k < n - 1 && !(u >= knots[k] && u < knots[k + 1])) k++;
      const d = []; for (let j = 0; j <= deg; j++) { const i = k - deg + j, ww = (w && w[i]) || 1; d.push([ctrl[i].x * ww, ctrl[i].y * ww, ww]); }
      for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
        const i = k - deg + j, den = knots[i + deg - r + 1] - knots[i], al = den ? (u - knots[i]) / den : 0;
        d[j] = [(1 - al) * d[j - 1][0] + al * d[j][0], (1 - al) * d[j - 1][1] + al * d[j][1], (1 - al) * d[j - 1][2] + al * d[j][2]];
      }
      out.push({ x: d[deg][0] / d[deg][2], y: d[deg][1] / d[deg][2] });
    }
    return out;
  }
  // Contours d'une HATCH, un par un (îlots compris) : polylignes (avec arcs) ou arêtes (segment, arc,
  // arc d'ellipse, spline). Remplace l'ancienne lecture qui collait tous les contours en un seul.
  function hatchLoops(g) {
    const loops = []; let i = g.findIndex(x => x.code === 91); if (i < 0) return loops;
    const nL = parseInt(g[i].val, 10) || 0; i++;
    const rd = code => (g[i] && g[i].code === code) ? parseFloat(g[i++].val) : NaN;
    const skipTo = (code, stop) => { while (i < g.length && g[i].code !== code && !(stop && stop(g[i].code))) i++; };
    for (let L = 0; L < nL && i < g.length; L++) {
      skipTo(92); if (i >= g.length) break;
      const flags = parseInt(g[i++].val, 10) || 0, pts = [];
      if (flags & 2) {   // contour polyligne
        let hasB = 0, nv = 0;
        while (i < g.length && g[i].code !== 10) { if (g[i].code === 72) hasB = parseInt(g[i].val, 10); else if (g[i].code === 93) nv = parseInt(g[i].val, 10); i++; }
        const vs = []; for (let k = 0; k < nv; k++) { const x = rd(10), y = rd(20); const b = hasB ? (rd(42) || 0) : 0; vs.push({ x, y, b }); }
        vs.forEach((v, k) => { pts.push({ x: v.x, y: v.y }); if (v.b) bulgePts(v, vs[(k + 1) % vs.length], v.b).forEach(q => pts.push(q)); });
      } else {             // contour par arêtes
        skipTo(93); const ne = parseInt((g[i++] || {}).val, 10) || 0;
        const add = seg => { if (!seg.length) return; if (pts.length) { const l = pts[pts.length - 1], d0 = Math.hypot(seg[0].x - l.x, seg[0].y - l.y), d1 = Math.hypot(seg[seg.length - 1].x - l.x, seg[seg.length - 1].y - l.y); if (d1 < d0) seg = seg.slice().reverse(); } seg.forEach((q, k) => { if (k === 0 && pts.length) { const l = pts[pts.length - 1]; if (Math.hypot(q.x - l.x, q.y - l.y) < 1e-9) return; } pts.push(q); }); };
        for (let k = 0; k < ne && i < g.length; k++) {
          skipTo(72); const et = parseInt(g[i++].val, 10);
          if (et === 1) { const x1 = rd(10), y1 = rd(20), x2 = rd(11), y2 = rd(21); add([{ x: x1, y: y1 }, { x: x2, y: y2 }]); }
          else if (et === 2) { const cx = rd(10), cy = rd(20), r = rd(40); let a0 = rd(50), a1 = rd(51); const ccw = rd(73);
            if (ccw === 0) { a0 = -a0; a1 = -a1; } let sw = (a1 - a0); if (ccw === 0) { while (sw > 0) sw -= 360; } else { while (sw < 0) sw += 360; } if (Math.abs(sw) < 1e-9) sw = ccw === 0 ? -360 : 360;
            const n = Math.max(4, Math.ceil(Math.abs(sw) / 7.5)), seg = []; for (let t = 0; t <= n; t++) { const a = (a0 + sw * t / n) * Math.PI / 180; seg.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } add(seg); }
          else if (et === 3) { const cx = rd(10), cy = rd(20), mx = rd(11), my = rd(21), ratio = rd(40); let a0 = rd(50), a1 = rd(51); const ccw = rd(73);
            if (ccw === 0) { a0 = -a0; a1 = -a1; } let sw = a1 - a0; if (ccw === 0) { while (sw > 0) sw -= 360; } else { while (sw < 0) sw += 360; }
            const maj = Math.hypot(mx, my), ang = Math.atan2(my, mx), ca = Math.cos(ang), sa = Math.sin(ang), n = Math.max(8, Math.ceil(Math.abs(sw) / 5)), seg = [];
            for (let t = 0; t <= n; t++) { const q = (a0 + sw * t / n) * Math.PI / 180, ux = Math.cos(q) * maj, uy = Math.sin(q) * maj * ratio; seg.push({ x: cx + ux * ca - uy * sa, y: cy + ux * sa + uy * ca }); } add(seg); }
          else if (et === 4) { const deg = rd(94); rd(73); rd(74); const nk = rd(95), nc = rd(96), knots = [], ctrl = [], w = [];
            for (let q = 0; q < nk; q++) knots.push(rd(40));
            for (let q = 0; q < nc; q++) { const x = rd(10), y = rd(20); ctrl.push({ x, y }); const ww = rd(42); w.push(isFinite(ww) ? ww : 1); }
            add(bspline(ctrl, knots, deg || 3, w));
            const nf = rd(97); if (isFinite(nf)) for (let q = 0; q < nf; q++) { rd(11); rd(21); }
            rd(12); rd(22); rd(13); rd(23); }
        }
      }
      if (pts.length >= 3) loops.push(pts.filter(q => isFinite(q.x) && isFinite(q.y)));
    }
    return loops;
  }
  const polyArea = P => { let a = 0; for (let k = 0, j = P.length - 1; k < P.length; j = k++) a += (P[j].x + P[k].x) * (P[j].y - P[k].y); return Math.abs(a / 2); };
  const inPoly = (q, P) => { let c = false; for (let k = 0, j = P.length - 1; k < P.length; j = k++) { const a = P[k], b = P[j]; if (((a.y > q.y) !== (b.y > q.y)) && (q.x < (b.x - a.x) * (q.y - a.y) / ((b.y - a.y) || 1e-12) + a.x)) c = !c; } return c; };
  // Contours -> zones à remplir : un contour de profondeur paire = zone pleine, ses contours directement
  // intérieurs = trous (îlots non remplis), comme le style « normal » d'AutoCAD.
  function loopsToHatches(loops) {
    const info = loops.map(P => ({ P, a: polyArea(P), depth: 0 }));
    info.forEach(L => { L.depth = info.filter(M => M !== L && M.a > L.a && inPoly(L.P[0], M.P)).length; });
    const res = [];
    info.filter(L => L.depth % 2 === 0).forEach(O => {
      const holes = info.filter(H => H.depth === O.depth + 1 && H.a < O.a && inPoly(H.P[0], O.P)).map(H => H.P);
      res.push({ points: O.P, holes });
    });
    return res;
  }
  // Motif AutoCAD -> motif QlygoCAD le plus proche.
  function hatchPattern(name) {
    const n = String(name || 'SOLID').toUpperCase();
    if (n === 'SOLID') return 'solid';
    if (/BRICK|AR-B|AR-BRSTD|BRSTONE/.test(n)) return 'briques';
    if (/ROOF|RSHKE|TUILE|SHAKE/.test(n)) return 'tuiles';
    if (/GRAVEL|STONE|PIERRE|CONC|SAND|EARTH/.test(n)) return 'pierre';
    if (/ANGLE|NET|GRID|SQUARE|CROSS|BOX|ANSI37|ANSI38/.test(n)) return 'cross';
    if (/^LINE$|HORIZ/.test(n)) return 'horiz';
    return 'lines';
  }
  // Type de trait AutoCAD -> 'dotted' | 'dashed' | 'dashdot' (d'après sa définition réelle dans le fichier).
  let LT = {}, LAYLT = {}, DIMCLR = {};
  // Couleur d'une cote AutoCAD : la couleur de l'entité si elle est forcée, sinon celle du STYLE de cote
  // (DIMCLRD 176 = ligne, DIMCLRT 178 = texte), surchargée cote par cote dans les XDATA « ACAD DSTYLE ».
  function dimColor(g) {
    const own = entColor(g); if (own) return own;
    let ov = null, inAcad = false;
    for (let i = 0; i < g.length; i++) {
      const x = g[i];
      if (x.code === 1001) inAcad = String(x.val).trim() === 'ACAD';
      else if (inAcad && x.code === 1070 && g[i + 1] && g[i + 1].code === 1070) {
        const k = parseInt(x.val, 10), v = parseInt(g[i + 1].val, 10);
        if (k === 176 || (k === 178 && ov == null)) { if (v > 0 && v < 256) ov = v; }
        if (k >= 1 && k <= 400) i++;   // couple (code, valeur) consommé
      }
    }
    if (ov == null) { const st = DIMCLR[String(get(g, 3) || 'STANDARD').trim().toUpperCase()]; if (st) ov = st; }
    return ov ? aci(ov) : null;
  }
  function dashOf(g) {
    let n = (get(g, 6) || '').trim(); const u = n.toUpperCase();
    if (!n || u === 'BYLAYER') n = LAYLT[lay(g)] || '';
    const k = String(n).toUpperCase();
    if (!k || k === 'CONTINUOUS' || k === 'BYBLOCK') return null;
    return LT[k] || null;
  }
  // Construit une entité QlygoCAD à partir d'un enregistrement simple (hors INSERT/POLYLINE).
  // Épaisseur de trait d'une entité : code DXF 370 (lineweight en 1/100 mm) -> mm, sinon 0.25 par défaut.
  function penOf(g) { const v = getn(g, 370); return (v != null && v > 0) ? v / 100 : 0.25; }
  function buildEntity(type, g) {
    const e = buildEntity0(type, g);
    if (e && !Array.isArray(e) && (e.type === 'polyline' || e.type === 'circle')) { const d = dashOf(g); if (d) e.dash = d; }
    // Transparence AutoCAD (code 440 = 0x02000000 | alpha 0-255) : reprise sur les aplats/hachures.
    const tr = getn(g, 440);
    if (e && tr != null && (tr & 0x02000000)) { const a = Math.round(((tr & 0xff) / 255) * 100) / 100; if (a < 1) (Array.isArray(e) ? e : [e]).forEach(x => { if (x && x.type === 'hatch') x.opacity = a; }); }
    // Aplat en couleur explicite (vraie couleur ou ACI ≠ 7) : couleur FIDÈLE sur le papier
    // (jaune pâle de la maison, blanc de masquage…) au lieu d'être forcé en noir sur les pages.
    const c62 = getn(g, 62);
    if (e && (getn(g, 420) != null || (c62 != null && c62 !== 7 && c62 !== 0 && c62 !== 256))) (Array.isArray(e) ? e : [e]).forEach(x => { if (x && x.type === 'hatch' && x.pattern === 'solid') x.trueFill = true; });
    return e;
  }
  function buildEntity0(type, g) {
    const layer = lay(g), color = entColor(g);
    if (type === 'LINE') {
      const x1 = getn(g, 10), y1 = getn(g, 20), x2 = getn(g, 11), y2 = getn(g, 21);
      if ([x1, y1, x2, y2].every(isFinite)) return { type: 'polyline', points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], layer, color, penMm: penOf(g) };
    } else if (type === 'LWPOLYLINE') {
      const closed = ((getn(g, 70) || 0) & 1) === 1, pts = lwPts(g, closed); if (pts.length >= 2) return { type: 'polyline', points: pts, layer, color, penMm: penOf(g), closed };
    } else if (type === 'CIRCLE') {
      const cx = getn(g, 10), cy = getn(g, 20), r = getn(g, 40);
      if ([cx, cy, r].every(isFinite)) return { type: 'circle', center: { x: cx, y: cy }, r, points: circlePoints(cx, cy, r), closed: true, layer, color, penMm: penOf(g) };
    } else if (type === 'ARC') {
      const cx = getn(g, 10), cy = getn(g, 20), r = getn(g, 40), a0 = getn(g, 50), a1 = getn(g, 51);
      if ([cx, cy, r, a0, a1].every(isFinite)) return { type: 'polyline', points: arcPoints(cx, cy, r, a0, a1), layer, color, penMm: penOf(g) };
    } else if (type === 'ELLIPSE') {
      const cx = getn(g, 10), cy = getn(g, 20), mx = getn(g, 11), my = getn(g, 21), ratio = getn(g, 40), a0 = getn(g, 41), a1 = getn(g, 42);
      if ([cx, cy, mx, my].every(isFinite)) return { type: 'polyline', points: ellipsePoints(cx, cy, mx, my, ratio, a0, a1), layer, color, penMm: penOf(g), closed: a0 == null };
    } else if (type === 'SPLINE') {
      // approximation : relie les points de lissage (11/21) ou de contrôle (10/20)
      // courbe EXACTE (B-spline / NURBS) à partir des points de contrôle, des nœuds et des poids ;
      // à défaut (données incomplètes), les points de lissage.
      const fit = []; let c = null;
      for (const x of g) { if (x.code === 11) { c = { x: parseFloat(x.val), y: 0 }; fit.push(c); } else if (x.code === 21 && c) c.y = parseFloat(x.val); }
      const ctrl = seqPts(g), knots = g.filter(x => x.code === 40).map(x => parseFloat(x.val)), w = g.filter(x => x.code === 41).map(x => parseFloat(x.val)), deg = getn(g, 71) || 3;
      const pts = (ctrl.length >= deg + 1 && knots.length === ctrl.length + deg + 1) ? bspline(ctrl, knots, deg, w.length === ctrl.length ? w : null) : (fit.length >= 2 ? fit : ctrl);
      if (pts.length >= 2) return { type: 'polyline', points: pts, layer, color, penMm: penOf(g), closed: ((getn(g, 70) || 0) & 1) === 1 };
    } else if (type === 'TEXT') {
      // AutoCAD : point 10/20 = LIGNE DE BASE à gauche ; si justifié (72/73), le point d'alignement est 11/21.
      const h = getn(g, 40) || 2.5, s = decodeU(get(g, 1)), rot = getn(g, 50) || 0, j72 = getn(g, 72) || 0, j73 = getn(g, 73) || 0;
      const just = (j72 || j73) && isFinite(getn(g, 11)), x = just ? getn(g, 11) : getn(g, 10), y = just ? getn(g, 21) : getn(g, 20);
      const align = (j72 === 1 || j72 === 4) ? 'center' : j72 === 2 ? 'right' : 'left';
      const valign = (j72 === 4 || j73 === 2) ? 'middle' : j73 === 3 ? 'top' : 'bottom';
      if (isFinite(x) && isFinite(y) && s) return { type: 'text', points: [{ x, y }], text: s, hMm: h, angleDeg: rot, align, valign, layer, color };
    } else if (type === 'MTEXT') {
      // AutoCAD 2018+ ajoute après le code 101 un « objet incorporé » qui RÉPÈTE des codes (10, 11, 40, 71…) :
      // on ne lit que la partie principale, sinon la direction (11/21) est prise pour une position -> texte incliné.
      const k101 = g.findIndex(z => z.code === 101); if (k101 >= 0) g = g.slice(0, k101);
      let x = getn(g, 10); const y = getn(g, 20), h = getn(g, 40) || 2.5, rot = getn(g, 50) || 0, wcol = getn(g, 41) || 0;
      const rawTxt = g.filter(z => z.code === 3).map(z => z.val).join('') + (get(g, 1) || '');
      const s = cleanMtext(rawTxt);
      // Point d'attache (71) : 1 haut-gauche … 5 milieu-centre … 9 bas-droite.
      const at = Math.min(9, Math.max(1, getn(g, 71) || 1));
      let align = ['left', 'center', 'right'][(at - 1) % 3]; const valign = ['top', 'middle', 'bottom'][Math.floor((at - 1) / 3)];
      let ang = rot; const dx = getn(g, 11), dy = getn(g, 21); if (!getn(g, 50) && isFinite(dx) && isFinite(dy) && (dx || dy)) ang = Math.atan2(dy, dx) * 180 / Math.PI;
      // Paragraphe centré / à droite DANS la colonne (\pxqc; / \pxqr;) : on recale le point d'ancrage.
      const pq = /\\pxq([lcr])/i.exec(rawTxt);
      if (pq && wcol > 0 && align === 'left' && pq[1].toLowerCase() !== 'l') {
        const sh = pq[1].toLowerCase() === 'c' ? wcol / 2 : wcol, ar = ang * Math.PI / 180;
        x += sh * Math.cos(ar); var yShift = sh * Math.sin(ar); align = pq[1].toLowerCase() === 'c' ? 'center' : 'right';
      }
      if (isFinite(x) && isFinite(y) && s) return { type: 'text', points: [{ x, y: y + (typeof yShift === 'number' ? yShift : 0) }], text: s, hMm: h, angleDeg: ang, align, valign, layer, color };
    } else if (type === 'SOLID' || type === '3DFACE') {
      const p0 = { x: getn(g, 10), y: getn(g, 20) }, p1 = { x: getn(g, 11), y: getn(g, 21) }, p2 = { x: getn(g, 12), y: getn(g, 22) }, p3 = { x: getn(g, 13), y: getn(g, 23) };
      let poly = (type === 'SOLID' ? [p0, p1, p3, p2] : [p0, p1, p2, p3]).filter(p => isFinite(p.x) && isFinite(p.y));
      if (poly.length >= 4 && poly[3].x === poly[2].x && poly[3].y === poly[2].y) poly.pop();
      if (poly.length >= 3) return { type: 'hatch', points: poly, pattern: 'solid', color, spacingMm: 300, angleDeg: 45, layer };
    } else if (type === 'HATCH') {
      const name = (get(g, 2) || 'SOLID').trim(), pat = hatchPattern(name), ang = 45 + (getn(g, 52) || 0);
      let zones = loopsToHatches(hatchLoops(g));
      if (!zones.length) { const pts = hatchPts(g); if (pts.length >= 3) zones = [{ points: pts, holes: [] }]; }
      const list = zones.map(z => Object.assign({ type: 'hatch', points: z.points, pattern: pat, color, spacingMm: 300, angleDeg: ang, layer }, z.holes.length ? { holes: z.holes } : {}));
      if (list.length) return list.length === 1 ? list[0] : list;
    }
    return null;
  }

  // COTE AutoCAD (linéaire : alignée 70&7=1, horizontale/verticale/tournée 70&7=0) -> VRAIE cote QlygoCAD
  // (modifiable, placement automatique). 13/23 et 14/24 = points mesurés ; 10/20 = point de la ligne de cote ;
  // 11/21 = milieu du texte ; 50 = angle (cote tournée) ; 1 = texte imposé ; 42 = mesure.
  // Autres types (angulaire, rayon, diamètre, ordonnée) ou texte non numérique : null -> on dessine le bloc
  // de la cote tel quel (traits + texte), rien n'est perdu.
  function buildDim(g) {
    const typ = (getn(g, 70) || 0) & 7; if (typ !== 0 && typ !== 1) return null;
    const a = { x: getn(g, 13), y: getn(g, 23) }, b = { x: getn(g, 14), y: getn(g, 24) }, d = { x: getn(g, 10), y: getn(g, 20) };
    if (![a.x, a.y, b.x, b.y, d.x, d.y].every(isFinite)) return null;
    let ux, uy, dimAngDeg;
    if (typ === 0) { const ang = getn(g, 50) || 0, r = ang * Math.PI / 180; ux = Math.cos(r); uy = Math.sin(r); dimAngDeg = ang; }
    else { const L = Math.hypot(b.x - a.x, b.y - a.y); if (L < 1e-9) return null; ux = (b.x - a.x) / L; uy = (b.y - a.y) / L; }
    const nx = -uy, ny = ux, off = (d.x - a.x) * nx + (d.y - a.y) * ny, proj = (b.x - a.x) * ux + (b.y - a.y) * uy;
    if (Math.abs(proj) < 1e-9) return null;
    const e = { type: 'dim', points: [a, b], offMm: off, layer: lay(g), color: dimColor(g) };
    if (dimAngDeg != null) e.dimAngDeg = dimAngDeg;
    const tx = getn(g, 11), ty = getn(g, 21);
    if (isFinite(tx) && isFinite(ty)) { const da = { x: a.x + nx * off, y: a.y + ny * off }, t = ((tx - da.x) * ux + (ty - da.y) * uy) / proj; if (isFinite(t) && Math.abs(t - 0.5) > 0.02) e.textT = Math.max(-1, Math.min(2, t)); }
    const ov = get(g, 1);
    if (ov != null && ov !== '' && ov.indexOf('<>') < 0) {
      const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(m)?\s*$/i.exec(cleanMtext(ov));
      if (!m) return null;                                   // texte libre : on garde le dessin exact du bloc
      e._valDrawing = parseFloat(m[1].replace(',', '.'));    // valeur imposée (unités du dessin), convertie plus bas
    }
    return e;
  }
  const IGNORE = { POINT: 1, VIEWPORT: 1, ATTDEF: 1, SEQEND: 1, VERTEX: 1, ENDBLK: 1, BLOCK: 1, SECTION: 1, ENDSEC: 1, EOF: 1 };

  D.parse = function (text) {
    const recs = records(tokenize(text));
    // 1) unité
    let factor = null;
    for (const r of recs) if (r.type === 'SECTION' && (get(r.g, 2) || '').trim() === 'HEADER') {
      for (let k = 0; k < r.g.length; k++) if (r.g[k].code === 9 && (r.g[k].val || '').trim() === '$INSUNITS') { const n = r.g[k + 1] && r.g[k + 1].code === 70 ? parseInt(r.g[k + 1].val, 10) : null; factor = insFactor(n); break; }
    }
    if (factor == null) factor = 1000; // défaut : mètres -> mm (cas cadastre)

    LT = {}; LAYLT = {}; DIMCLR = {};   // types de traits du fichier (remplis avec les calques)
    // 2) calques (nom + couleur, truecolor pris en compte)
    const layers = [], layerColor = {};
    { let section = null, inTables = false;
      for (const r of recs) {
        if (r.type === 'SECTION') { section = (get(r.g, 2) || '').trim(); inTables = section === 'TABLES'; continue; }
        if (r.type === 'ENDSEC') { inTables = false; continue; }
        if (inTables && r.type === 'LTYPE') {   // définition des types de traits : pointillé / tirets / mixte
          const nm = (get(r.g, 2) || '').trim().toUpperCase(), el = r.g.filter(x => x.code === 49).map(x => parseFloat(x.val));
          const dash = el.some(v => v > 1e-9), dot = el.some(v => Math.abs(v) <= 1e-9);
          if (nm && el.length) LT[nm] = dash && dot ? 'dashdot' : dot ? 'dotted' : dash ? 'dashed' : null;
          continue;
        }
        if (inTables && r.type === 'DIMSTYLE') {   // couleur des cotes définie dans le style
          const nm = (get(r.g, 2) || '').trim().toUpperCase(), d = getn(r.g, 176), t = getn(r.g, 178), c = (d > 0 && d < 256) ? d : (t > 0 && t < 256) ? t : null;
          if (nm && c) DIMCLR[nm] = c;
          continue;
        }
        if (inTables && r.type === 'LAYER') {
          const name = (get(r.g, 2) || '0').trim(); if (name === '') continue;
          { const lt = (get(r.g, 6) || '').trim(); if (lt) LAYLT[name] = lt; }
          const tc = getn(r.g, 420), col = getn(r.g, 62), lw = getn(r.g, 370);
          const hex = tc != null ? trueColorHex(tc) : aci(col != null ? Math.abs(col) : null);
          const pen = (lw != null && lw > 0) ? lw / 100 : 0.25;   // épaisseur du calque (code 370)
          const off = col != null && col < 0, frozen = ((getn(r.g, 70) || 0) & 1) === 1, noPlot = String(get(r.g, 290) || '').trim() === '0';
          if (!layerColor[name]) { layerColor[name] = hex || '#9fb0d0'; layers.push({ name, color: hex || '#9fb0d0', penMm: pen, off, frozen, noPlot }); }
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
    const ents = [], skipped = {}, counted = { dims: 0, dimsDessin: 0 };
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
          if (pts.length >= 2) pushEnt({ type: 'polyline', points: pts, layer, color, penMm: penOf(g), closed }, X);
          continue;
        }
        if (r.type === 'DIMENSION') {
          const dm = buildDim(g);
          if (dm) { pushEnt(dm, X); counted.dims++; continue; }
          const blk = blocks[(get(g, 2) || '').trim()];   // cote non convertible : son dessin exact (traits + texte)
          if (blk) { emit(blk.recs, X, depth + 1); counted.dimsDessin++; } else skipped.DIMENSION = (skipped.DIMENSION || 0) + 1;
          continue;
        }
        const e = buildEntity(r.type, g);
        if (Array.isArray(e)) e.forEach(x => pushEnt(x, X)); else if (e) pushEnt(e, X);
        else if (!IGNORE[r.type]) skipped[r.type] = (skipped[r.type] || 0) + 1;
      }
    }
    function pushEnt(e, X) {
      if (e.points) e.points = e.points.map(X.tf);
      if (e.holes) e.holes = e.holes.map(h => h.map(X.tf));
      if (e.center) e.center = X.tf(e.center);
      if (e.type === 'circle' && (X.sc !== 1 || X.rot !== 0)) { e.type = 'polyline'; e.closed = true; delete e.center; delete e.r; }
      if (e.hMm) e.hMm *= X.sc;
      if (e.type === 'text' && X.rot) e.angleDeg = (e.angleDeg || 0) + X.rot;
      if (e.type === 'dim') { if (X.rot && e.dimAngDeg != null) e.dimAngDeg += X.rot; if (X.sc !== 1) e.offMm *= X.sc; }
      ents.push(e);
    }
    { let section = null, inEnt = false; const top = [];
      for (const r of recs) {
        if (r.type === 'SECTION') { section = (get(r.g, 2) || '').trim(); inEnt = section === 'ENTITIES'; continue; }
        if (r.type === 'ENDSEC') { inEnt = false; continue; }
        // Espace OBJET uniquement : on écarte l'espace papier (code 67 = 1 : cartouche, images, fenêtres
        // de la présentation active d'AutoCAD), qui sinon se mélangerait aux plans.
        if (inEnt && String(get(r.g, 67) || '').trim() !== '1') top.push(r);
      }
      emit(top, { tf: p => ({ x: p.x, y: p.y }), sc: 1, rot: 0 }, 0);
    }

    // 5) mise à l'échelle (mm) + recentrage près de l'origine
    let minX = Infinity, minY = Infinity;
    const scalePt = p => { p.x *= factor; p.y *= factor; if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; };
    for (const e of ents) { (e.points || []).forEach(scalePt); (e.holes || []).forEach(h => h.forEach(q => { q.x *= factor; q.y *= factor; })); if (e.center) { e.center.x *= factor; e.center.y *= factor; } if (e.hMm) e.hMm *= factor; if (e.r) e.r *= factor; if (e.offMm != null) e.offMm *= factor; if (e._valDrawing != null) { e.valMm = e._valDrawing * factor; delete e._valDrawing; } }
    if (!isFinite(minX)) { minX = 0; minY = 0; }
    for (const e of ents) { (e.points || []).forEach(p => { p.x -= minX; p.y -= minY; }); (e.holes || []).forEach(h => h.forEach(p => { p.x -= minX; p.y -= minY; })); if (e.center) { e.center.x -= minX; e.center.y -= minY; } }

    // calques réellement utilisés mais absents de la table
    const used = {}; ents.forEach(e => { used[e.layer] = true; });
    Object.keys(used).forEach(name => { if (!layerColor[name]) layers.push({ name, color: '#9fb0d0' }); });

    return { layers, entities: ents, origin: { x: minX, y: minY }, units: factor, skipped, counted };
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
    // Épaisseur de trait (mm) -> code DXF 370 (lineweight, en 1/100 mm). AutoCAD la lit, QlygoCAD aussi.
    const lwVal = p => (p != null && p > 0) ? Math.max(0, Math.min(211, Math.round(p * 100))) : null;
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

    // Bornes du dessin : sans $EXTMIN/$EXTMAX ni centrage du VPORT, AutoCAD ouvre une vue VIDE
    // (la géométrie est hors champ) et il faut faire « Zoom étendu » à la main. Ici on cadre tout seul.
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const e of (scene.entities || [])) {
      const pts = e.points || (e.center ? [{ x: e.center.x, y: e.center.y }] : null);
      if (!pts) continue;
      const rr = (e.center && e.r) ? e.r : 0;
      for (const p of pts) {
        if (p.x - rr < bx0) bx0 = p.x - rr; if (p.y - rr < by0) by0 = p.y - rr;
        if (p.x + rr > bx1) bx1 = p.x + rr; if (p.y + rr > by1) by1 = p.y + rr;
      }
    }
    const hasB = isFinite(bx0) && isFinite(by0) && isFinite(bx1) && isFinite(by1) && bx1 > bx0 && by1 > by0;
    const vcx = hasB ? (bx0 + bx1) / 2 : 0, vcy = hasB ? (by0 + by1) / 2 : 0;
    // hauteur de vue : doit contenir la hauteur ET la largeur/aspect (1.5), + 10% de marge
    const vh = hasB ? Math.max((by1 - by0), (bx1 - bx0) / 1.5, 10) * 1.1 : 297;

    // ---- HEADER ----
    out(0, 'SECTION'); out(2, 'HEADER');
    out(9, '$ACADVER'); out(1, 'AC1009');       // R12
    out(9, '$INSUNITS'); out(70, 4);            // millimètres
    out(9, '$MEASUREMENT'); out(70, 1);         // système métrique
    out(9, '$DWGCODEPAGE'); out(3, 'ANSI_1252'); // page de code (texte en ASCII + \U+ de toute façon)
    if (hasB) {                                  // bornes -> cadrage auto à l'ouverture dans AutoCAD
      out(9, '$EXTMIN'); out(10, fmt(bx0)); out(20, fmt(by0)); out(30, 0);
      out(9, '$EXTMAX'); out(10, fmt(bx1)); out(20, fmt(by1)); out(30, 0);
      out(9, '$LIMMIN'); out(10, fmt(bx0)); out(20, fmt(by0));
      out(9, '$LIMMAX'); out(10, fmt(bx1)); out(20, fmt(by1));
    }
    out(0, 'ENDSEC');

    // ---- TABLES : VPORT, LTYPE (CONTINUOUS), LAYER, STYLE (STANDARD) ----
    out(0, 'SECTION'); out(2, 'TABLES');
    // VPORT actif (valeurs standard)
    out(0, 'TABLE'); out(2, 'VPORT'); out(70, 1);
    out(0, 'VPORT'); out(2, '*ACTIVE'); out(70, 0);
    out(10, 0); out(20, 0); out(11, 1); out(21, 1); out(12, fmt(vcx)); out(22, fmt(vcy)); out(13, 0); out(23, 0);
    out(14, 10); out(24, 10); out(15, 10); out(25, 10); out(16, 0); out(26, 0); out(36, 1);
    out(17, 0); out(27, 0); out(37, 0); out(40, fmt(vh)); out(41, 1.5); out(42, 50); out(43, 0); out(44, 0);
    out(50, 0); out(51, 0); out(71, 0); out(72, 100); out(73, 1); out(74, 3); out(75, 0); out(76, 1); out(77, 0); out(78, 0);
    out(0, 'ENDTAB');
    // Type de ligne continu (référencé par tous les calques)
    out(0, 'TABLE'); out(2, 'LTYPE'); out(70, 1);
    out(0, 'LTYPE'); out(2, 'CONTINUOUS'); out(70, 0); out(3, 'Solid line'); out(72, 65); out(73, 0); out(40, 0);
    out(0, 'ENDTAB');
    // Calques
    out(0, 'TABLE'); out(2, 'LAYER'); out(70, layers.length);
    layers.forEach(l => { out(0, 'LAYER'); out(2, nameOf[l.name]); out(70, 0); out(62, hexToAci(l.color) || 7); out(6, 'CONTINUOUS'); const llw = lwVal(l.penMm); if (llw != null) out(370, llw); });
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
    const poly = (pts, closed, ln, aci, lw) => {
      if (!pts || pts.length < 2) return;
      out(0, 'POLYLINE'); out(8, ln); if (aci != null) out(62, aci); if (lw != null) out(370, lw); out(66, 1); out(70, closed ? 1 : 0);
      out(10, 0); out(20, 0); out(30, 0);
      pts.forEach(p => { out(0, 'VERTEX'); out(8, ln); out(10, fmt(p.x)); out(20, fmt(p.y)); out(30, 0); });
      out(0, 'SEQEND'); out(8, ln);
    };
    const text = (x, y, h, s, ang, ln, aci) => {
      out(0, 'TEXT'); out(8, ln); if (aci != null) out(62, aci);
      out(10, fmt(x)); out(20, fmt(y)); out(30, 0); out(40, fmt(h));
      out(1, escTxt(s)); if (ang) out(50, fmt(ang)); out(7, 'STANDARD');
    };
    // Texte QlygoCAD -> MTEXT AutoCAD : même point d'ancrage (haut/milieu/bas × gauche/centre/droite),
    // plusieurs lignes (\P) -> il retombe exactement au même endroit dans AutoCAD.
    const mtext = (e, ln, aci) => {
      const p = e.points[0], h = e.hMm || 800, al = e.align || 'left', va = e.valign || 'top';
      const at = ({ top: 0, middle: 3, bottom: 6 })[va] + ({ left: 1, center: 2, right: 3 })[al];
      out(0, 'MTEXT'); out(8, ln); if (aci != null) out(62, aci);
      out(10, fmt(p.x)); out(20, fmt(p.y)); out(30, 0); out(40, fmt(h)); out(71, at || 1); out(72, 1);
      out(1, String(e.text || '').split('\n').map(escTxt).join('\\P')); if (e.angleDeg) out(50, fmt(e.angleDeg)); out(7, 'STANDARD');
    };
    for (const e of (scene.entities || [])) {
      const ln = lnameFor(e), aci = e.color ? hexToAci(e.color) : null, lw = lwVal(e.penMm);
      if (e.type === 'hatch') { poly(e.points, true, ln, aci, lw); if (e.holes) e.holes.forEach(h => poly(h, true, ln, aci, lw)); }
      else if (e.type === 'circle' && e.center) { out(0, 'CIRCLE'); out(8, ln); if (aci != null) out(62, aci); if (lw != null) out(370, lw); out(10, fmt(e.center.x)); out(20, fmt(e.center.y)); out(30, 0); out(40, fmt(e.r)); }
      else if (e.type === 'text' && e.points && e.points.length) { if (e.zone) { const h = e.hMm || 800, p = e.points[0]; text(p.x, p.y - h, h, e.text, e.angleDeg || 0, ln, aci); } else mtext(e, ln, aci); }
      else if (e.type === 'dim' && G) {
        const vaci = aci != null ? aci : hexToAci('#b9375e');
        const g = G.dimGeometry(e, (e.dec != null) ? (mm => (mm / 1000).toFixed(e.dec).replace('.', ',') + ' m') : null);
        poly([g.extA[0], g.extA[1]], false, ln, vaci, lw); poly([g.extB[0], g.extB[1]], false, ln, vaci, lw); poly([g.da, g.db], false, ln, vaci, lw);
        const h = Rr ? Rr.dimHmm(e) : 250; text(g.txt.x - (g.text.length * h * 0.3), g.txt.y + h * 0.15, h, g.text, g.angleDeg, ln, vaci);
      }
      else if (e.points && e.points.length >= 2) poly(e.points, !!e.closed, ln, aci, lw);
    }
    out(0, 'ENDSEC'); out(0, 'EOF');
    let s = ''; for (let i = 0; i < L.length; i += 2) s += L[i] + '\r\n' + L[i + 1] + '\r\n'; return s;
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.dxf = D;
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
})(typeof window !== 'undefined' ? window : globalThis);
