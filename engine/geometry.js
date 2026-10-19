/* QlygoCAD — engine/geometry.js
 * Modèle de scène (dessin) + entités, en MILLIMÈTRES RÉELS.
 * Repère : X vers la droite, Y vers le HAUT (comme en maths / en CAO),
 * origine (0,0) en bas à gauche de la zone utile.
 * Fonctions pures : aucune dépendance au Canvas ni à Electron.
 */
(function (root) {
  const G = {};

  // --- Création d'une scène ---
  G.createScene = function () {
    return {
      units: 'mm',
      layers: [
        { id: 'calque-0', name: 'Calque 0', color: '#9fb0d0', penMm: 0.25, visible: true, locked: false, frozen: false },
        { id: 'murs', name: 'Murs', color: '#e8ebf2', penMm: 0.35, visible: true, locked: false, frozen: false },
        { id: 'cotation', name: 'Cotation', color: '#b9375e', penMm: 0.18, visible: true, locked: false, frozen: false },
        { id: 'mobilier', name: 'Mobilier', color: '#eda020', penMm: 0.25, visible: true, locked: false, frozen: false }
      ],
      entities: [] // { type:'polyline', points:[{x,y},...], layer, color, penMm }
    };
  };

  // --- Ajout d'entités (retourne l'entité créée) ---
  G.addPolyline = function (scene, points, opts) {
    opts = opts || {};
    const e = {
      type: 'polyline',
      points: points.map(p => ({ x: p.x, y: p.y })),
      layer: opts.layer || scene.layers[0].id,
      color: opts.color || '#1b2b4b',
      penMm: opts.penMm != null ? opts.penMm : 0.25, // épaisseur de trait PAPIER (mm)
      closed: !!opts.closed
    };
    if (opts.dash && opts.dash !== 'solid') e.dash = opts.dash; // continu / tirets / pointillés / mixte
    scene.entities.push(e);
    return e;
  };

  G.addLine = function (scene, x1, y1, x2, y2, opts) {
    return G.addPolyline(scene, [{ x: x1, y: y1 }, { x: x2, y: y2 }], opts);
  };

  G.addRect = function (scene, x, y, w, h, opts) {
    return G.addPolyline(scene, [
      { x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + h }, { x: x, y: y + h }
    ], Object.assign({ closed: true }, opts || {}));
  };

  // --- Cotation linéaire entre deux points (offMm signé = décalage perpendiculaire) ---
  // IMPORTANT : on stocke les RÉFÉRENCES des points a et b (pas des copies).
  // Si la cote est posée sur un trait, elle partage ses sommets -> elle SUIT le
  // trait quand on l'édite par poignées (la longueur se recalcule toute seule).
  G.addDim = function (scene, a, b, offMm, opts) {
    opts = opts || {};
    const e = {
      type: 'dim',
      points: [a, b],
      offMm: offMm || 800,
      layer: opts.layer || scene.layers[0].id,
      color: opts.color || null,   // null = couleur du calque (Cotation)
      penMm: 0.25,
      textMm: opts.textMm || 2.5 // hauteur de texte PAPIER (mm)
    };
    scene.entities.push(e);
    return e;
  };

  // Valeur mesurée d'une cote (mm réels)
  G.dimValue = function (e) {
    return Math.hypot(e.points[1].x - e.points[0].x, e.points[1].y - e.points[0].y);
  };

  // Format par défaut d'une cote : mètres, 2 décimales, virgule française
  G.formatDim = function (mm) { return (mm / 1000).toFixed(2).replace('.', ',') + ' m'; };

  /* Géométrie PURE d'une cotation, en mm réels. Les deux moteurs de rendu
   * (écran + PDF) consomment ce même résultat pour rester identiques.
   * Renvoie les positions ; chaque moteur dessine ses décorations (ticks, texte)
   * à sa propre taille (px à l'écran, points sur le PDF).
   */
  G.dimGeometry = function (e, fmt) {
    fmt = fmt || G.formatDim;
    const a = e.points[0], b = e.points[1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;        // le long de la cote
    const nx = -uy, ny = ux;                    // normale
    const off = e.offMm || 800;
    const u = off >= 0 ? 1 : -1;
    const beyond = 200;                          // dépassement des lignes d'attache (mm réels)
    const da = { x: a.x + nx * off, y: a.y + ny * off };
    const db = { x: b.x + nx * off, y: b.y + ny * off };
    let ang = Math.atan2(uy, ux) * 180 / Math.PI;
    if (ang > 90 || ang <= -90) ang += 180;     // texte toujours lisible
    return {
      a, b, da, db,
      extA: [{ x: a.x, y: a.y }, { x: da.x + nx * u * beyond, y: da.y + ny * u * beyond }],
      extB: [{ x: b.x, y: b.y }, { x: db.x + nx * u * beyond, y: db.y + ny * u * beyond }],
      mid: { x: (da.x + db.x) / 2, y: (da.y + db.y) / 2 },
      along: { x: ux, y: uy }, normal: { x: nx, y: ny },
      text: fmt(len), angleDeg: ang
    };
  };

  // --- Texte d'annotation (hauteur hMm en mm RÉELS ; point = coin bas-gauche) ---
  G.addText = function (scene, x, y, str, opts) {
    opts = opts || {};
    const e = {
      type: 'text',
      points: [{ x: x, y: y }],
      text: String(str || ''),
      hMm: opts.hMm != null ? opts.hMm : 800,  // ~0,80 m par défaut
      angleDeg: opts.angleDeg || 0,
      font: opts.font || null,                 // null = police par défaut
      color: opts.color || null,               // null = couleur du calque
      layer: opts.layer || scene.layers[0].id
    };
    scene.entities.push(e);
    return e;
  };

  // --- Cercle (approché par un polygone fin, réutilise tout le moteur) ---
  G.addCircle = function (scene, cx, cy, r, opts) {
    opts = opts || {};
    const n = 64, pts = [];
    for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
    const e = {
      type: 'circle', center: { x: cx, y: cy }, r: r,
      points: pts, closed: true,
      color: opts.color || '#1b2b4b', penMm: opts.penMm != null ? opts.penMm : 0.25,
      layer: opts.layer || scene.layers[0].id
    };
    if (opts.dash && opts.dash !== 'solid') e.dash = opts.dash;
    scene.entities.push(e);
    return e;
  };

  // --- Transformations géométriques pures (un point -> un point) ---
  G.rotatePoint = function (p, cx, cy, ang) {
    const c = Math.cos(ang), s = Math.sin(ang), x = p.x - cx, y = p.y - cy;
    return { x: cx + x * c - y * s, y: cy + x * s + y * c };
  };
  G.mirrorPoint = function (p, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = ((p.x - ax) * dx + (p.y - ay) * dy) / l2, rx = ax + t * dx, ry = ay + t * dy;
    return { x: 2 * rx - p.x, y: 2 * ry - p.y };
  };

  // --- Hachure d'une zone fermée ---
  // `boundary` = tableau de points du contour (copié). pattern : 'solid' | 'lines' | 'cross' | 'tiles'.
  G.addHatch = function (scene, boundary, opts) {
    opts = opts || {};
    const pts = (boundary.points || boundary).map(p => ({ x: p.x, y: p.y }));
    const e = {
      type: 'hatch',
      points: pts,
      pattern: opts.pattern || 'solid',
      color: opts.color || null,    // null = couleur du calque
      spacingMm: opts.spacingMm != null ? opts.spacingMm : 300,
      angleDeg: opts.angleDeg != null ? opts.angleDeg : 45,
      layer: opts.layer || scene.layers[0].id
    };
    scene.entities.unshift(e); // en fond (dessiné en premier)
    return e;
  };

  // --- Cercle passant par 3 points (circonscrit) -> {cx,cy,r} ou null si alignés ---
  G.circleFrom3 = function (a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-9) return null;
    const ux = ((a.x * a.x + a.y * a.y) * (b.y - c.y) + (b.x * b.x + b.y * b.y) * (c.y - a.y) + (c.x * c.x + c.y * c.y) * (a.y - b.y)) / d;
    const uy = ((a.x * a.x + a.y * a.y) * (c.x - b.x) + (b.x * b.x + b.y * b.y) * (a.x - c.x) + (c.x * c.x + c.y * c.y) * (b.x - a.x)) / d;
    return { cx: ux, cy: uy, r: Math.hypot(a.x - ux, a.y - uy) };
  };
  // --- Arc par 3 points (de a à c en passant par b) -> liste de points ---
  G.arc3 = function (a, b, c) {
    const circ = G.circleFrom3(a, b, c);
    if (!circ) return [{ x: a.x, y: a.y }, { x: c.x, y: c.y }];   // alignés : segment
    const ang = p => Math.atan2(p.y - circ.cy, p.x - circ.cx);
    let a0 = ang(a), a1 = ang(c), ab = ang(b);
    const norm = t => { while (t < 0) t += 2 * Math.PI; while (t >= 2 * Math.PI) t -= 2 * Math.PI; return t; };
    // sens (horaire/trigo) tel que b soit sur l'arc a->c
    let span = norm(a1 - a0), bspan = norm(ab - a0);
    let dir = 1; if (bspan > span) { dir = -1; span = 2 * Math.PI - span; }
    const n = Math.max(8, Math.ceil(span / (Math.PI / 36))), pts = [];
    for (let i = 0; i <= n; i++) { const t = a0 + dir * span * i / n; pts.push({ x: circ.cx + Math.cos(t) * circ.r, y: circ.cy + Math.sin(t) * circ.r }); }
    return pts;
  };
  // --- Polygone régulier à n côtés : centre + un sommet (vx,vy) ---
  G.regularPolygon = function (cx, cy, vx, vy, n) {
    n = Math.max(3, Math.min(120, n | 0));
    const r = Math.hypot(vx - cx, vy - cy) || 1, a0 = Math.atan2(vy - cy, vx - cx), pts = [];
    for (let i = 0; i < n; i++) { const a = a0 + i * 2 * Math.PI / n; pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
    return pts;
  };
  // --- Intersection des DROITES (infinies) (a,b) et (c,d) -> point ou null (parallèles) ---
  G.lineLineInt = function (a, b, c, d) {
    const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y, den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    return { x: a.x + t * rx, y: a.y + t * ry };
  };
  // --- Décalage parallèle d'une POLYLIGNE (offset) d'une distance signée ---
  // Chaque arête est décalée perpendiculairement puis les arêtes voisines sont
  // réintersectées (coins d'onglet). Gère ouvert / fermé. dist>0 = côté gauche du tracé.
  G.offsetPolyline = function (pts, closed, dist) {
    const n = pts.length; if (n < 2) return null;
    const m = closed ? n : n - 1, edges = [];
    for (let i = 0; i < m; i++) {
      const a = pts[i], b = pts[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
      edges.push({ a: { x: a.x + nx * dist, y: a.y + ny * dist }, b: { x: b.x + nx * dist, y: b.y + ny * dist } });
    }
    const out = [];
    if (closed) {
      for (let i = 0; i < m; i++) { const e1 = edges[(i - 1 + m) % m], e2 = edges[i]; const X = G.lineLineInt(e1.a, e1.b, e2.a, e2.b); out.push(X || { x: e2.a.x, y: e2.a.y }); }
    } else {
      out.push({ x: edges[0].a.x, y: edges[0].a.y });
      for (let i = 1; i < m; i++) { const e1 = edges[i - 1], e2 = edges[i]; const X = G.lineLineInt(e1.a, e1.b, e2.a, e2.b); out.push(X || { x: e2.a.x, y: e2.a.y }); }
      out.push({ x: edges[m - 1].b.x, y: edges[m - 1].b.y });
    }
    return out;
  };

  // --- Aire (m²->mm²) et périmètre d'un polygone (lacet) ---
  G.polyArea = function (p) { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j].x + p[i].x) * (p[j].y - p[i].y); return Math.abs(s / 2); };
  G.polyPerim = function (p, closed) { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); if (closed && p.length > 2) L += Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y); return L; };

  // --- Boîte englobante de la scène (mm réels) ---
  G.bounds = function (scene) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of scene.entities) {
      for (const p of e.points) {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  };

  // --- Longueur réelle d'une polyligne (mm) ---
  G.length = function (entity) {
    let L = 0;
    const pts = entity.points;
    for (let i = 1; i < pts.length; i++) {
      L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    if (entity.closed && pts.length > 2) {
      L += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
    }
    return L;
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.geometry = G;
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(typeof window !== 'undefined' ? window : globalThis);
