/* QlygoCAD — engine/dwgmap.js
 * Convertit une DwgDatabase (libredwg-web) en entités QlygoCAD natives.
 * Pur JS (navigateur + Node). Coordonnées laissées dans l'unité du dessin ;
 * la mise à l'échelle mm est appliquée par l'appelant (facteur d'unité).
 */
(function (root) {
  const M = {};
  const ACI = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 7: '#e8ebf2', 8: '#808080', 9: '#c0c0c0', 250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe', 255: '#ffffff' };
  function aci(n) { if (n == null) return null; return ACI[n] || '#9fb0d0'; }
  function entColor(e) { const c = e.colorIndex; return (c != null && c !== 256 && c !== 0) ? aci(Math.abs(c)) : null; }
  function circlePts(cx, cy, r) { const n = 48, p = []; for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; p.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return p; }
  function arcPts(cx, cy, r, a0, a1) { let s = a0 * Math.PI / 180, e = a1 * Math.PI / 180; if (e <= s) e += 2 * Math.PI; const n = Math.max(6, Math.ceil((e - s) / (Math.PI / 18))), p = []; for (let i = 0; i <= n; i++) { const a = s + (e - s) * i / n; p.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return p; }
  function ellipsePts(cx, cy, mx, my, ratio, a0, a1) { const major = Math.hypot(mx, my) || 1, minor = major * (ratio || 1), ang = Math.atan2(my, mx); let s = a0 || 0, e = (a1 == null ? 2 * Math.PI : a1); if (e <= s) e += 2 * Math.PI; const ca = Math.cos(ang), sa = Math.sin(ang), n = 48, p = []; for (let i = 0; i <= n; i++) { const t = s + (e - s) * i / n, ux = Math.cos(t) * major, uy = Math.sin(t) * minor; p.push({ x: cx + ux * ca - uy * sa, y: cy + ux * sa + uy * ca }); } return p; }
  function clean(s) { return (s || '').replace(/\\P/g, '\n').replace(/\\~/g, ' ').replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/[{}]/g, ''); }

  /* database(db) -> { layers:[{name,color}], entities:[...] } (unités du dessin) */
  M.fromDatabase = function (db) {
    const layers = [], seen = {};
    const lt = (db.tables && db.tables.LAYER) || {};
    const entries = lt.entries || (Array.isArray(lt) ? lt : []);
    (entries || []).forEach(l => { const name = (l.name || '0'); if (!seen[name]) { seen[name] = 1; layers.push({ name, color: aci(l.colorIndex != null ? Math.abs(l.colorIndex) : null) || '#9fb0d0' }); } });

    const ents = [];
    const push = e => { if (e) ents.push(e); };
    for (const e of (db.entities || [])) {
      const layer = e.layer || '0', color = entColor(e);
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
        default: break; // POINT, VIEWPORT, IMAGE, INSERT, DIMENSION, OLE2FRAME... ignorés
      }
    }
    const used = {}; ents.forEach(e => { used[e.layer] = 1; });
    Object.keys(used).forEach(n => { if (!seen[n]) layers.push({ name: n, color: '#9fb0d0' }); });
    return { layers, entities: ents };
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.dwgmap = M;
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
})(typeof window !== 'undefined' ? window : globalThis);
