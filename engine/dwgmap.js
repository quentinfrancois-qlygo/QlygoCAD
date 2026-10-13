/* QlygoCAD — engine/dwgmap.js
 * Convertit une DwgDatabase (libredwg-web) en entités QlygoCAD natives.
 * Couleurs FIDÈLES à AutoCAD : palette ACI exacte (257 valeurs) + truecolor +
 * résolution BYLAYER (la grande majorité des entités héritent du calque).
 * Pur JS (navigateur + Node). Coordonnées dans l'unité du dessin (mm appliqués par l'appelant).
 */
(function (root) {
  const M = {};
  // Palette ACI officielle AutoCAD (index 0..256 ; 0 et 256 = spéciaux)
  const ACI = ['#000000','#ff0000','#ffff00','#00ff00','#00ffff','#0000ff','#ff00ff','#ffffff','#808080','#c0c0c0','#ff0000','#ff7f7f','#cc0000','#cc6666','#990000','#994c4c','#7f0000','#7f3f3f','#4c0000','#4c2626','#ff3f00','#ff9f7f','#cc3300','#cc7f66','#992600','#995f4c','#7f1f00','#7f4f3f','#4c1300','#4c2f26','#ff7f00','#ffbf7f','#cc6600','#cc9966','#994c00','#99724c','#7f3f00','#7f5f3f','#4c2600','#4c3926','#ffbf00','#ffdf7f','#cc9900','#ccb266','#997200','#99854c','#7f5f00','#7f6f3f','#4c3900','#4c4226','#ffff00','#ffff7f','#cccc00','#cccc66','#989800','#98984c','#7f7f00','#7f7f3f','#4c4c00','#4c4c26','#bfff00','#dfff7f','#99cc00','#b2cc66','#729800','#85984c','#5f7f00','#6f7f3f','#394c00','#424c26','#7fff00','#bfff7f','#66cc00','#99cc66','#4c9800','#72984c','#3f7f00','#5f7f3f','#264c00','#394c26','#3fff00','#9fff7f','#33cc00','#7fcc66','#269800','#5f984c','#1f7f00','#4f7f3f','#134c00','#2f4c26','#00ff00','#7fff7f','#00cc00','#66cc66','#009800','#4c984c','#007f00','#3f7f3f','#004c00','#264c26','#00ff3f','#7fff9f','#00cc33','#66cc7f','#009826','#4c985f','#007f1f','#3f7f4f','#004c13','#264c2f','#00ff7f','#7fffbf','#00cc66','#66cc99','#00984c','#4c9872','#007f3f','#3f7f5f','#004c26','#264c39','#00ffbf','#7fffdf','#00cc99','#66ccb2','#009872','#4c9885','#007f5f','#3f7f6f','#004c39','#264c42','#00ffff','#7fffff','#00cccc','#66cccc','#009898','#4c9898','#007f7f','#3f7f7f','#004c4c','#264c4c','#00bfff','#7fdfff','#0099cc','#66b2cc','#007298','#4c8598','#005f7f','#3f6f7f','#00394c','#26424c','#007fff','#7fbfff','#0066cc','#6699cc','#004c98','#4c7298','#003f7f','#3f5f7f','#00264c','#26394c','#003fff','#7f9fff','#0033cc','#667fcc','#002698','#4c5f98','#001f7f','#3f4f7f','#00134c','#262f4c','#0000ff','#7f7fff','#0000cc','#6666cc','#000098','#4c4c98','#00007f','#3f3f7f','#00004c','#26264c','#3f00ff','#9f7fff','#3300cc','#7f66cc','#260098','#5f4c98','#1f007f','#4f3f7f','#13004c','#2f264c','#7f00ff','#bf7fff','#6600cc','#9966cc','#4c0098','#724c98','#3f007f','#5f3f7f','#26004c','#39264c','#bf00ff','#df7fff','#9900cc','#b266cc','#720098','#854c98','#5f007f','#6f3f7f','#39004c','#42264c','#ff00ff','#ff7fff','#cc00cc','#cc66cc','#980098','#984c98','#7f007f','#7f3f7f','#4c004c','#4c264c','#ff00bf','#ff7fdf','#cc0099','#cc66b2','#980072','#984c85','#7f005f','#7f3f6f','#4c0039','#4c2642','#ff007f','#ff7fbf','#cc0066','#cc6699','#98004c','#984c72','#7f003f','#7f3f5f','#4c0026','#4c2639','#ff003f','#ff7f9f','#cc0033','#cc667f','#980026','#984c5f','#7f001f','#7f3f4f','#4c0013','#4c262f','#333333','#5b5b5b','#848484','#adadad','#d6d6d6','#ffffff','#000000'];
  function trueColorHex(n) { const v = (n >>> 0) & 0xffffff; return '#' + v.toString(16).padStart(6, '0'); }
  // Couleur d'un calque : ACI si 1..255, sinon truecolor (.color), sinon blanc.
  function layerHex(l) { const ci = l.colorIndex; if (ci >= 1 && ci <= 255) return ACI[ci]; if (l.color != null && l.color !== 16777215) return trueColorHex(l.color); return '#ffffff'; }
  // Couleur d'une entité : ACI explicite si 1..255 ; sinon null = BYLAYER (couleur du calque au rendu).
  function entHex(e) { const ci = e.colorIndex; if (ci >= 1 && ci <= 255) return ACI[ci]; return null; }

  function circlePts(cx, cy, r) { const n = 48, p = []; for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; p.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return p; }
  function arcPts(cx, cy, r, a0, a1) { let s = a0 * Math.PI / 180, e = a1 * Math.PI / 180; if (e <= s) e += 2 * Math.PI; const n = Math.max(6, Math.ceil((e - s) / (Math.PI / 18))), p = []; for (let i = 0; i <= n; i++) { const a = s + (e - s) * i / n; p.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return p; }
  function ellipsePts(cx, cy, mx, my, ratio, a0, a1) { const major = Math.hypot(mx, my) || 1, minor = major * (ratio || 1), ang = Math.atan2(my, mx); let s = a0 || 0, e = (a1 == null ? 2 * Math.PI : a1); if (e <= s) e += 2 * Math.PI; const ca = Math.cos(ang), sa = Math.sin(ang), n = 48, p = []; for (let i = 0; i <= n; i++) { const t = s + (e - s) * i / n, ux = Math.cos(t) * major, uy = Math.sin(t) * minor; p.push({ x: cx + ux * ca - uy * sa, y: cy + ux * sa + uy * ca }); } return p; }
  function clean(s) { return (s || '').replace(/\\P/g, '\n').replace(/\\~/g, ' ').replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/[{}]/g, ''); }

  M.fromDatabase = function (db) {
    const layers = [], seen = {};
    const lt = (db.tables && db.tables.LAYER) || {};
    const entries = lt.entries || (Array.isArray(lt) ? lt : []);
    (entries || []).forEach(l => { const name = (l.name || '0'); if (!seen[name]) { seen[name] = 1; layers.push({ name, color: layerHex(l) }); } });

    const ents = [];
    const push = e => { if (e) ents.push(e); };
    for (const e of (db.entities || [])) {
      const layer = e.layer || '0', color = entHex(e);
      switch (e.type) {
        case 'LINE': if (e.startPoint && e.endPoint) push({ type: 'polyline', points: [{ x: e.startPoint.x, y: e.startPoint.y }, { x: e.endPoint.x, y: e.endPoint.y }], layer, color, penMm: 0.25 }); break;
        case 'LWPOLYLINE': case 'POLYLINE': { const vs = (e.vertices || []).map(v => ({ x: v.x, y: v.y })); if (vs.length >= 2) push({ type: 'polyline', points: vs, layer, color, penMm: 0.25, closed: !!(e.closed || ((e.flag || 0) & 1)) }); break; }
        case 'CIRCLE': if (e.center) push({ type: 'circle', center: { x: e.center.x, y: e.center.y }, r: e.radius, points: circlePts(e.center.x, e.center.y, e.radius), closed: true, layer, color, penMm: 0.25 }); break;
        case 'ARC': if (e.center) push({ type: 'polyline', points: arcPts(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle), layer, color, penMm: 0.25 }); break;
        case 'ELLIPSE': if (e.center && e.majorAxisEndPoint) push({ type: 'polyline', points: ellipsePts(e.center.x, e.center.y, e.majorAxisEndPoint.x, e.majorAxisEndPoint.y, e.axisRatio != null ? e.axisRatio : e.ratio, e.startAngle, e.endAngle), layer, color, penMm: 0.25 }); break;
        case 'TEXT': { const p = e.startPoint || e.position; if (p && e.text) push({ type: 'text', points: [{ x: p.x, y: p.y }], text: e.text, hMm: e.height || e.textHeight || 2.5, angleDeg: (e.rotation || 0) * 180 / Math.PI, layer, color }); break; }
        case 'MTEXT': { const p = e.insertionPoint || e.startPoint; if (p && e.text) push({ type: 'text', points: [{ x: p.x, y: p.y }], text: clean(e.text), hMm: e.height || e.textHeight || 2.5, angleDeg: (e.rotation || 0) * 180 / Math.PI, layer, color }); break; }
        case 'SOLID': case '3DFACE': { const c = e.corners || [e.point1, e.point2, e.point3, e.point4].filter(Boolean); if (c && c.length >= 3) { let poly = (e.type === 'SOLID' && c.length >= 4) ? [c[0], c[1], c[3], c[2]] : c.slice(); poly = poly.filter(Boolean).map(p => ({ x: p.x, y: p.y })); if (poly.length >= 4 && poly[3].x === poly[2].x && poly[3].y === poly[2].y) poly.pop(); if (poly.length >= 3) push({ type: 'hatch', points: poly, pattern: 'solid', color, spacingMm: 300, angleDeg: 45, layer }); } break; }
        case 'HATCH': { const paths = e.boundaryPaths || e.paths || []; let vs = []; if (paths.length) { const pth = paths[0]; vs = (pth.vertices || pth.points || []).map(v => ({ x: v.x, y: v.y })); } if (vs.length >= 3) push({ type: 'hatch', points: vs, pattern: 'solid', color, spacingMm: 300, angleDeg: 45, layer }); break; }
        default: break;
      }
    }
    const used = {}; ents.forEach(e => { used[e.layer] = 1; });
    Object.keys(used).forEach(n => { if (!seen[n]) layers.push({ name: n, color: '#ffffff' }); });
    return { layers, entities: ents };
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.dwgmap = M;
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
})(typeof window !== 'undefined' ? window : globalThis);
