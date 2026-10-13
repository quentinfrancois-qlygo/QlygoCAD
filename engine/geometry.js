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
        { id: 'calque-0', name: 'Calque 0', color: '#9fb0d0', visible: true, locked: false, frozen: false },
        { id: 'murs', name: 'Murs', color: '#e8ebf2', visible: true, locked: false, frozen: false },
        { id: 'cotation', name: 'Cotation', color: '#b9375e', visible: true, locked: false, frozen: false },
        { id: 'mobilier', name: 'Mobilier', color: '#eda020', visible: true, locked: false, frozen: false }
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
