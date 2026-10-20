/* QlygoCAD — app-poc.js
 * Shell type "poste de travail CAO" (façon AutoCAD) : ruban, ligne de commande,
 * barre d'état, espace objet sombre + réticule. Pilote le moteur QCAD.*.
 * SAISIE EN MÈTRES : ce que l'utilisateur tape est en mètres (7 => 7 m) ;
 * en interne tout reste en millimètres réels (précision).
 */
(function () {
  const G = QCAD.geometry, R = QCAD.render, U = QCAD.units, SN = QCAD.snap;
  const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  const dyn = $('dyn'), dynread = $('dynread'), dynedit = $('dynedit'), dyninput = $('dyninput');
  const cmd = $('cmd'), cmdhist = $('cmdhist');

  const scene = G.createScene();
  const view = { pxPerMm: 0.05, panXmm: -3000, panYmm: -3000, canvasW: 0, canvasH: 0 };
  let tool = 'select';
  let draft = [];
  let cursor = { x: 0, y: 0 }, rawCursor = { x: 0, y: 0 };
  let snapInfo = null, guide = null, dimHover = null, dimPreview = null, ghost = null;
  let editing = false, overCanvas = false;
  let lastScreen = { x: 0, y: 0 };
  let panning = false, panStart = null;
  let offsetDist = 200;         // mm (0,20 m par défaut)
  let pendingOffset = null;
  let lastCmd = '';
  let selected = [];            // objets sélectionnés
  let selecting = false, selStart = null, selRect = null;
  let boxPending = null;        // sélection « clic → déplace → clic » (sans maintenir le bouton)
  let currentLayer = 'calque-0';   // calque EFFECTIF (temporairement celui du trait sélectionné)
  let baseLayer = 'calque-0';      // calque CHOISI par l'utilisateur (on y revient après Échap)
  let offsetTarget = null;      // segment cible pour Décaler (si présélection)
  let gripDrag = null, hotGrip = null, hatchHover = null, hoverEnt = null;
  let currentDimSize = 2.5;     // hauteur texte cote (mm papier)
  let op = null;                // opération en cours (move/copy/rotate/mirror)
  let circleCenter = null;      // centre en attente (outil Cercle)
  let opGhost = null, circlePreview = null;
  let shiftDown = false;        // Maj enfoncée (Ajuster <-> Prolonger)
  const SETTINGS_DEFAULTS = { bg: '#1b1f28', grid: '#3b4252', axisX: '#e06c75', axisY: '#98c379', crosshairColor: '#aeb6c6', crosshairSize: 'full', pickbox: true };
  let settings = loadSettings();
  let pages = [];               // présentations (DP02, DP04…) — affichent le dessin
  let activePage = 'model';     // 'model' = espace objet (dessin)
  let pageDrag = null, vpDrag = null;
  let hatchPattern = 'lines', hatchSpacing = 300; // motif + échelle (mm) des hachures
  let trimPreview = null;       // aperçu Ajuster/Prolonger (projection colorée)
  let history = [], redoStack = []; // pile d'annulation (Ctrl+Z / Ctrl+Y)
  let textPt = null, currentTextH = 800, txtEl = null; // outil Texte : point d'insertion + hauteur + champ de saisie
  let dimSeg = null;            // outil Cote : segment verrouillé (clic 1) dont on règle l'écartement
  // --- Nouveaux automatismes AutoCAD (v0.29) ---
  let polySides = 4;           // POLYGONE : nombre de côtés
  let filletRadius = 0, filletFirst = null;   // RACCORD (fillet) : rayon + 1er trait choisi
  let matchSrc = null;         // COPIERPROP : objet source dont on copie le style
  let arrayPolar = null;       // RÉSEAU POLAIRE : { count, ang } en attente du centre
  let viewStack = [];          // ZOOM précédent : pile des vues
  let stretchOp = null;        // ÉTIRER : { pts:[...], base }
  let editingText = null;      // DDEDIT : entité texte en cours d'édition in-situ
  let rightDown = null;        // clic droit : répéter la dernière commande

  function $(id) { return document.getElementById(id); }
  const isOn = id => $(id).classList.contains('active');
  function opts() { return { color: $('color').value, penMm: parseFloat($('pen').value), layer: currentLayer, dash: $('linetype') ? $('linetype').value : 'solid' }; }

  // ---------- Calques (visibilité / gel / verrou) ----------
  function layerById(id) { return scene.layers.find(l => l.id === id) || scene.layers[0]; }
  function layVisible(id) { const l = layerById(id); return l.visible && !l.frozen; }
  function layPickable(id) { const l = layerById(id); return l.visible && !l.frozen && !l.locked; }
  function visibleScene() { const m = {}; for (const l of scene.layers) m[l.id] = l.visible && !l.frozen; return { layers: scene.layers, entities: scene.entities.filter(e => m[e.layer]) }; }
  function pickScene() { return { layers: scene.layers, entities: scene.entities.filter(e => layPickable(e.layer)) }; }
  // Entités PICKABLES proches d'un point (fenêtre locale). Indispensable pour que
  // l'accrochage/osnap ne calcule pas en O(n²) sur 100k+ entités (sinon crash instantané).
  function pickFlagMap() { const m = {}; for (const l of scene.layers) m[l.id] = l.visible && !l.frozen && !l.locked; return m; }

  // ---------- Index spatial (grille de hachage) ----------
  // Sans ça, chaque survol/accroche/zoom parcourait les 135 000 entités (O(n)) =>
  // ça rame « de fou ». L'index range les entités par cellules ; une requête ne
  // regarde que les cellules proches -> survol/accroche/culling fluides (O(k)).
  let gridIndex = null, gridBuiltV = -1, gridBuiltLen = -1;
  function markSceneDirty() { scene._v = (scene._v || 0) + 1; }
  function indexStale() { return gridBuiltV !== (scene._v || 0) || gridBuiltLen !== scene.entities.length || !gridIndex; }
  function buildIndex() {
    const ents = scene.entities; gridBuiltLen = ents.length;
    let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18;
    for (let i = 0; i < ents.length; i++) { const b = R._bbox(ents[i]); if (b[0] < -1e16) continue; if (b[0] < minX) minX = b[0]; if (b[1] < minY) minY = b[1]; if (b[2] > maxX) maxX = b[2]; if (b[3] > maxY) maxY = b[3]; }
    gridBuiltV = scene._v || 0;
    if (!(maxX > minX && maxY > minY) || !ents.length) { gridIndex = null; return; }
    const cols = Math.max(1, Math.min(600, Math.round(Math.sqrt(ents.length / 3)) || 1));
    const cw = (maxX - minX) / cols || 1, ch = (maxY - minY) / cols || 1;
    const cells = new Map(), big = [];
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i], b = R._bbox(e); if (b[0] < -1e16) continue;
      const x0 = Math.floor((b[0] - minX) / cw), x1 = Math.floor((b[2] - minX) / cw), y0 = Math.floor((b[1] - minY) / ch), y1 = Math.floor((b[3] - minY) / ch);
      if ((x1 - x0) > cols * 0.5 || (y1 - y0) > cols * 0.5) { big.push(e); continue; }   // entité très étendue : liste à part
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) { const k = cx * 100000 + cy; let a = cells.get(k); if (!a) { a = []; cells.set(k, a); } a.push(e); }
    }
    gridIndex = { cells, big, minX, minY, cw, ch, cols };
  }
  // Renvoie les entités candidates recouvrant la fenêtre [x0,y0,x1,y1] (surensemble).
  function queryIndex(x0, y0, x1, y1) {
    if (indexStale()) buildIndex();
    const g = gridIndex; if (!g) return scene.entities;
    const cx0 = Math.floor((x0 - g.minX) / g.cw), cx1 = Math.floor((x1 - g.minX) / g.cw), cy0 = Math.floor((y0 - g.minY) / g.ch), cy1 = Math.floor((y1 - g.minY) / g.ch);
    // Fenêtre couvrant tout l'index : on rend directement la scène (zoom arrière).
    if (cx0 <= 0 && cy0 <= 0 && cx1 >= g.cols - 1 && cy1 >= g.cols - 1) return scene.entities;
    const out = g.big.slice(); const seen = out.length ? new Set(out) : new Set();
    for (let cx = Math.max(0, cx0); cx <= Math.min(g.cols, cx1); cx++) for (let cy = Math.max(0, cy0); cy <= Math.min(g.cols, cy1); cy++) {
      const a = g.cells.get(cx * 100000 + cy); if (!a) continue;
      for (let i = 0; i < a.length; i++) { const e = a[i]; if (!seen.has(e)) { seen.add(e); out.push(e); } }
    }
    return out;
  }
  function nearScene(pt, padMm) {
    const r = padMm != null ? padMm : (50 / view.pxPerMm);
    const x0 = pt.x - r, y0 = pt.y - r, x1 = pt.x + r, y1 = pt.y + r, out = [], pick = pickFlagMap();
    const cand = queryIndex(x0, y0, x1, y1);
    for (let i = 0; i < cand.length; i++) { const e = cand[i]; if (!pick[e.layer]) continue; const b = R._bbox(e); if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue; out.push(e); }
    return { layers: scene.layers, entities: out };
  }
  // Scène réduite aux entités visibles DANS la fenêtre d'affichage (pour le cache).
  function cullScene() {
    const W = view.canvasW, H = view.canvasH;
    const x0 = view.panXmm, y0 = view.panYmm, x1 = view.panXmm + W / view.pxPerMm, y1 = view.panYmm + H / view.pxPerMm;
    const pad = Math.max(1, (x1 - x0) * 0.04);
    const cand = queryIndex(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
    const m = {}; for (const l of scene.layers) m[l.id] = l.visible && !l.frozen;
    const out = []; for (let i = 0; i < cand.length; i++) { const e = cand[i]; if (m[e.layer]) out.push(e); }
    return { layers: scene.layers, entities: out };
  }
  function nearEnt(ent) { const b = R._bbox(ent), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, r = Math.max(b[2] - b[0], b[3] - b[1]) / 2 + 50 / view.pxPerMm; return nearScene({ x: cx, y: cy }, r).entities; }
  function scaleDenom() { return parseInt($('scale').value, 10); }
  function tolMm() { return 12 / view.pxPerMm; }
  const M = v => v * 1000;        // mètres -> mm
  const fmtM = mm => (mm / 1000).toFixed(2).replace('.', ',');
  const fmtM3 = mm => (mm / 1000).toFixed(3).replace('.', ',');

  function activePoint() {
    if (tool === 'line' && draft.length) return draft[draft.length - 1];   // chaîne : on part du dernier point posé
    if ((tool === 'polyline' || tool === 'arc' || tool === 'dist' || tool === 'area') && draft.length) return draft[draft.length - 1];
    if ((tool === 'rect' || tool === 'polygon') && draft.length) return draft[0];
    return null;
  }

  function resize() {
    const r = cv.parentElement.getBoundingClientRect();
    cv.width = r.width; cv.height = r.height;
    view.canvasW = r.width; view.canvasH = r.height; paint();
  }
  window.addEventListener('resize', resize);

  function previewPts() {
    if (ghost) return ghost;
    if (!draft.length) return null;
    if (tool === 'rect') { const a = draft[0], c = cursor; return [a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }, a]; }
    if (tool === 'polygon') { const g = G.regularPolygon(draft[0].x, draft[0].y, cursor.x, cursor.y, polySides); return g.concat([g[0]]); }
    if (tool === 'arc') { if (draft.length === 1) return [draft[0], cursor]; return G.arc3(draft[0], draft[1], cursor); }
    if (tool === 'area' && draft.length >= 2) { return draft.concat([cursor, draft[0]]); }  // aperçu fermé
    return draft.concat([cursor]);
  }

  // Cache du dessin STATIQUE : on ne le reconstruit que si la vue/les entités
  // changent. Le mouvement de souris ne redessine que la surcouche (réticule,
  // survol, aperçus) -> fluide même à 100k+ entités (comme AutoCAD).
  const cacheCv = document.createElement('canvas'); const cacheCtx = cacheCv.getContext('2d'); let cacheDirty = true;
  function sceneOpts() { return { dark: true, theme: theme(), grid: isOn('grid'), gridStepMm: 1000, axes: true }; }
  function overlayOpts() {
    return {
      dark: true, theme: theme(), ucs: true,
      preview: previewPts(), snap: snapInfo, guide, dimHover, dimPreview, selected, selRect, hatchHover, hotGrip, opGhost, circlePreview, hoverEnt: (['select', 'fillet', 'matchprop'].indexOf(tool) >= 0 ? hoverEnt : null),
      // Le réticule suit la SOURIS ; la précision vient du marqueur d'accroche (snap) placé,
      // lui, exactement sur le point. (Coller le réticule au point le « bloquait » après annulation.)
      crosshair: overCanvas && !panning ? { x: lastScreen.x, y: lastScreen.y, color: settings.crosshairColor, size: settings.crosshairSize, pickbox: settings.pickbox } : null
    };
  }
  function rebuildCache() {
    if (cacheCv.width !== cv.width || cacheCv.height !== cv.height) { cacheCv.width = cv.width; cacheCv.height = cv.height; }
    R.drawScene(cacheCtx, cullScene(), view, sceneOpts()); cacheDirty = false;
  }
  function paint() {            // changement réel (vue, entités, calques) : reconstruit le cache
    if (activePage !== 'model') return paintPage();
    rebuildCache();
    ctx.drawImage(cacheCv, 0, 0);
    R.drawOverlay(ctx, { layers: scene.layers }, view, overlayOpts());   // surcouche : pas besoin des entités
    drawTrimOverlay();
  }
  function paintOverlay() {     // mouvement souris : réutilise le cache, redessine la surcouche
    if (activePage !== 'model') return paintPage();
    if (cacheDirty || cacheCv.width !== cv.width || cacheCv.height !== cv.height) rebuildCache();
    ctx.drawImage(cacheCv, 0, 0);
    R.drawOverlay(ctx, { layers: scene.layers }, view, overlayOpts());
    drawTrimOverlay();
  }
  // Peinture coalescée : pour le pan / zoom à la molette, on ne reconstruit le cache
  // qu'une fois par frame (sinon une rafale de 10 events = 10 redessins -> saccades).
  let paintScheduled = false;
  function requestPaint() { if (paintScheduled) return; paintScheduled = true; requestAnimationFrame(() => { paintScheduled = false; paint(); }); }

  // Priorité façon AutoCAD : accrochage OBJET > Ortho/Polaire STRICT > aimant grille.
  // (Seul l'accrochage objet peut "sortir" de l'Ortho ; la grille, jamais.)
  function snapPoint(raw, from) {
    snapInfo = null; guide = null;
    if (isOn('osnap')) {
      const sc = nearScene(raw);
      // Accrochage aux points du tracé EN COURS (ligne/polyligne) : extrémités + milieux
      // des segments déjà posés -> on peut refermer une polyligne sur son 1er point.
      if (draft.length >= 2 && ['polyline', 'line', 'arc', 'polygon', 'area'].indexOf(tool) >= 0) sc.entities = sc.entities.concat([{ type: 'polyline', points: draft, closed: false, layer: '__draft' }]);
      const hit = SN.query(sc, raw, tolMm(), { from, grid: false, types: { end: true, mid: true, center: true, quadrant: true, inter: true, perp: true, near: isOn('osnapnear'), grid: false } });
      if (hit) { snapInfo = hit; return { x: hit.x, y: hit.y }; }
    }
    if (from && (isOn('ortho') || isOn('polar'))) { const c = SN.constrain(from, raw, isOn('ortho') ? 90 : 45); guide = { from, to: c }; return c; }
    if (isOn('snap')) { snapInfo = { x: Math.round(raw.x / 100) * 100, y: Math.round(raw.y / 100) * 100, type: 'grid' }; return { x: snapInfo.x, y: snapInfo.y }; }
    return raw;
  }
  function compute(sx, sy) { const raw = R.screenToWorld(view, sx, sy); rawCursor = raw; return snapPoint(raw, activePoint()); }

  // ---------- Souris ----------
  cv.addEventListener('mouseenter', () => { overCanvas = true; });
  cv.addEventListener('mouseleave', () => { overCanvas = false; hoverEnt = null; hideDyn(); paint(); });

  cv.addEventListener('mousemove', e => {
    const r = cv.getBoundingClientRect();
    lastScreen = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (activePage !== 'model') return pageMouseMove(e);
    if (panning && panStart) {
      view.panXmm = panStart.px - (e.clientX - panStart.sx) / view.pxPerMm;
      view.panYmm = panStart.py + (e.clientY - panStart.sy) / view.pxPerMm; requestPaint(); return;
    }
    if (tool === 'select') return handleSelectMove();
    if (op) return opMove();
    if (tool === 'circle') return circleMove();
    if (tool === 'trim') return hoverTrim(e);
    if (tool === 'dim') return hoverDim();
    if (tool === 'offset') return hoverOffset();
    if (tool === 'hatch') return hoverHatch();
    if (tool === 'stretch' && stretchOp && stretchOp.base) return stretchMove();
    if ((tool === 'zoomwin' || (tool === 'stretch' && !stretchOp)) && selecting && selStart) {
      const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y); selRect = { a: selStart.w, b: raw, crossing: true };
      $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m'; paintOverlay(); return;
    }
    if (tool === 'fillet' || tool === 'matchprop') {
      const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
      hoverEnt = (tool === 'fillet') ? pickLineEnt(raw) : pickAnyAt(raw);
      $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m'; paintOverlay(); return;
    }
    cursor = compute(lastScreen.x, lastScreen.y);
    $('coords').textContent = fmtM3(cursor.x) + ' , ' + fmtM3(cursor.y) + ' m' + (snapInfo ? '  [' + frType(snapInfo.type) + ']' : '');
    if (activePoint() && !editing) showPassive(); else if (!activePoint() && !editing) hideDyn(); else if (editing) placeDyn();
    paintOverlay();
  });

  function perpSigned(pt, a, b) { const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L; return (pt.x - a.x) * nx + (pt.y - a.y) * ny; }
  function hoverDim() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    if (dimSeg) {   // segment choisi : on règle l'écartement en suivant le curseur
      const off = perpSigned(raw, dimSeg.a, dimSeg.b);
      dimHover = { a: dimSeg.a, b: dimSeg.b };
      dimPreview = { type: 'dim', points: [dimSeg.a, dimSeg.b], offMm: off, color: '#b9375e', textMm: currentDimSize };
      dynread.innerHTML = '📏 <b>' + fmtM(dist(dimSeg.a, dimSeg.b)) + ' m</b> — écartement ' + fmtM(Math.abs(off)) + ' m · <b>cliquez pour poser</b>';
      editMode(false); dyn.style.display = 'block'; placeDyn();
    } else {
      const seg = SN.pickSegment(nearScene(raw), raw, 10 / view.pxPerMm);
      if (seg) {
        const side = sideOf(raw, seg);
        dimHover = { a: seg.a, b: seg.b };
        dimPreview = { type: 'dim', points: [seg.a, seg.b], offMm: side * 800, color: '#b9375e', textMm: currentDimSize };
        dynread.innerHTML = '📏 <b>' + fmtM(dist(seg.a, seg.b)) + ' m</b> — cliquez le trait à coter';
        editMode(false); dyn.style.display = 'block'; placeDyn();
      } else { dimHover = dimPreview = null; hideDyn(); }
    }
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m'; paintOverlay();
  }

  function footOnSeg(P, A, B) { const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1; let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / L2; t = Math.max(0, Math.min(1, t)); return { x: A.x + t * dx, y: A.y + t * dy }; }
  function circlePoly(c, r) { const n = 64, p = []; for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; p.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); } return p; }
  // DÉCALER : gère un segment simple, une POLYLIGNE entière (bloc) et un CERCLE.
  function hoverOffset() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    const ent = offsetTarget || SN.pickEntity(nearScene(raw), raw, 10 / view.pxPerMm);
    pendingOffset = null; ghost = null; dimHover = null;
    if (ent && ent.type === 'circle' && ent.center) {
      const side = (dist(raw, ent.center) >= ent.r) ? 1 : -1, nr = ent.r + side * offsetDist;
      if (nr > 1) { pendingOffset = { kind: 'circle', center: { x: ent.center.x, y: ent.center.y }, r: nr, src: ent }; ghost = circlePoly(ent.center, nr).concat([{ x: ent.center.x + nr, y: ent.center.y }]); }
    } else if (ent && ent.points && ent.points.length >= 2) {
      const p = ent.points, m = ent.closed ? p.length : p.length - 1; let be = null, bd = Infinity;
      for (let i = 0; i < m; i++) { const a = p[i], b = p[(i + 1) % p.length], f = footOnSeg(raw, a, b), d = dist(raw, f); if (d < bd) { bd = d; be = { a, b }; } }
      if (be) {
        const side = sideOf(raw, be);
        if (p.length > 2 || ent.closed) {
          const npts = G.offsetPolyline(p, !!ent.closed, side * offsetDist);
          if (npts) { pendingOffset = { kind: 'poly', points: npts, closed: !!ent.closed, src: ent }; ghost = ent.closed ? npts.concat([npts[0]]) : npts; }
        } else { const off = SN.offset(be.a, be.b, side * offsetDist); pendingOffset = { kind: 'seg', a: off.a, b: off.b, src: ent }; ghost = [off.a, off.b]; }
        dimHover = { a: be.a, b: be.b };
      }
    }
    if (pendingOffset) { if (!editing) { dynread.innerHTML = '⇥ Décaler : <b>' + fmtM(offsetDist) + ' m</b> — cliquez le côté (tape une distance pour changer)'; editMode(false); dyn.style.display = 'block'; placeDyn(); } }
    else if (!editing) hideDyn();
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m'; paintOverlay();
  }

  function hoverHatch() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    const poly = SN.findRegion(nearScene(raw, 120 / view.pxPerMm), raw, 2);
    hatchHover = poly ? { points: poly } : null;
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m';
    dynread.innerHTML = hatchHover ? '▦ <b>cliquez pour hachurer</b> (' + hatchPatternName() + ')' : '▦ survolez une zone fermée (délimitée par des traits)';
    editMode(false); dyn.style.display = 'block'; placeDyn(); paintOverlay();
  }
  function hatchPatternName() { return { solid: 'pleine', lines: 'lignes', cross: 'croisées', tiles: 'tuiles' }[hatchPattern] || hatchPattern; }
  function hatchColor() { const el = $('hcolor'); return el ? el.value : $('color').value; }

  function handleSelectMove() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m';
    if (gripDrag) {
      dragGrip(raw);
      if (!editing && gripDrag.kind !== 'dimoff') {
        let d0 = 0;
        if (gripDrag.kind === 'vertex' && gripDrag.ghost) d0 = dist(gripDrag.origAll[gripDrag.index], gripDrag.ghost[gripDrag.index]);
        else if (gripDrag.kind === 'mid' && gripDrag.ghost) d0 = dist(gripDrag.origAll[0], gripDrag.ghost[0]);
        dynread.innerHTML = '⟷ <b>' + fmtM(d0) + ' m</b> — ou tapez une distance (ex. 0,2) puis Entrée';
        editMode(false); dyn.style.display = 'block'; placeDyn();
      }
      paintOverlay(); return;
    }
    if (boxPending) { selRect = { a: boxPending.anchor.w, b: raw, crossing: lastScreen.x < boxPending.anchor.sx }; hoverEnt = null; paintOverlay(); return; }
    if (selecting && selStart) { selRect = { a: selStart.w, b: raw, crossing: lastScreen.x < selStart.sx }; hoverEnt = null; }
    else {
      // Rollover façon AutoCAD : l'objet sous le curseur se met en surbrillance.
      if (selected.length) { const g = hitGrip(lastScreen.x, lastScreen.y); hotGrip = g ? gripPoint(g) : null; }
      hoverEnt = SN.pickEntity(nearScene(raw), raw, 10 / view.pxPerMm) || pickTextAt(raw) || pickHatchAt(raw) || pickImageAt(raw);
    }
    paintOverlay();
  }
  function gripPoint(g) {
    const e = g.ent;
    if (g.kind === 'vertex') return { x: e.points[g.index].x, y: e.points[g.index].y };
    if (g.kind === 'mid') return { x: (e.points[0].x + e.points[1].x) / 2, y: (e.points[0].y + e.points[1].y) / 2 };
    if (g.kind === 'dimoff') { const gg = G.dimGeometry(e); return { x: gg.mid.x, y: gg.mid.y }; }
    return null;
  }

  function hitGrip(sx, sy) {
    const near = (wx, wy) => { const s = R.worldToScreen(view, wx, wy); return Math.hypot(s.x - sx, s.y - sy) <= 8; };
    for (const e of selected) {
      if (e.type === 'hatch') continue;           // une hachure se sélectionne/supprime, pas de poignées
      for (let i = 0; i < e.points.length; i++) if (near(e.points[i].x, e.points[i].y)) return { ent: e, kind: 'vertex', index: i };
      if (e.type === 'dim') { const g = G.dimGeometry(e); if (near(g.mid.x, g.mid.y)) return { ent: e, kind: 'dimoff' }; }
      else if (e.type !== 'hatch' && e.points.length === 2) { const m = { x: (e.points[0].x + e.points[1].x) / 2, y: (e.points[0].y + e.points[1].y) / 2 }; if (near(m.x, m.y)) return { ent: e, kind: 'mid' }; }
    }
    return null;
  }
  // Édition par poignée AVEC PROJECTION : le trait d'origine reste FIGÉ (surbrillance
  // bleue) et on affiche un FANTÔME orange (opGhost) à la position future. Rien n'est
  // modifié tant qu'on n'a pas déposé (2e clic) -> on voit toujours « avant / après ».
  function dragGrip(raw) {
    const e = gripDrag.ent, orig = gripDrag.origAll;
    if (gripDrag.kind === 'vertex') {
      const from = orig.length === 2 ? orig[1 - gripDrag.index] : null;
      const p = snapPoint(raw, from);
      const gp = orig.map(q => ({ x: q.x, y: q.y })); gp[gripDrag.index] = { x: p.x, y: p.y };
      opGhost = [{ points: gp, closed: e.closed }]; gripDrag.ghost = gp; hotGrip = { x: p.x, y: p.y };
    } else if (gripDrag.kind === 'mid') {
      const p = snapPoint(raw, null);
      const dx = p.x - gripDrag.start.x, dy = p.y - gripDrag.start.y;
      const gp = orig.map(q => ({ x: q.x + dx, y: q.y + dy }));
      opGhost = [{ points: gp, closed: e.closed }]; gripDrag.ghost = gp; hotGrip = { x: (gp[0].x + gp[1].x) / 2, y: (gp[0].y + gp[1].y) / 2 };
    } else if (gripDrag.kind === 'dimoff') {
      const a = orig[0], b = orig[1], dxu = b.x - a.x, dyu = b.y - a.y, L = Math.hypot(dxu, dyu) || 1;
      const nx = -dyu / L, ny = dxu / L;
      gripDrag.newOff = (raw.x - a.x) * nx + (raw.y - a.y) * ny;
      dimHover = { a: a, b: b };
      dimPreview = { type: 'dim', points: [a, b], offMm: gripDrag.newOff, color: '#eda020', textMm: e.textMm || 2.5, dec: e.dec, arrow: e.arrow };
      hotGrip = null;
    }
  }
  // Dépose : applique au vrai objet la position du fantôme, puis reconstruit le cache.
  function applyGrip() {
    const e = gripDrag.ent;
    if (gripDrag.kind === 'vertex' && gripDrag.ghost) { const i = gripDrag.index; e.points[i].x = gripDrag.ghost[i].x; e.points[i].y = gripDrag.ghost[i].y; }
    else if (gripDrag.kind === 'mid' && gripDrag.ghost) { e.points[0].x = gripDrag.ghost[0].x; e.points[0].y = gripDrag.ghost[0].y; e.points[1].x = gripDrag.ghost[1].x; e.points[1].y = gripDrag.ghost[1].y; }
    else if (gripDrag.kind === 'dimoff' && gripDrag.newOff != null) e.offMm = gripDrag.newOff;
    e._bb = null; markSceneDirty();
  }
  // Poignée + DISTANCE TAPÉE (façon AutoCAD) : on attrape un point, on tape 0,2 et
  // le point s'étire de 20 cm. Pour une extrémité, le déplacement suit la DIRECTION
  // du trait (reste aligné) -> parfait pour un débord de toit.
  function applyGripValue(vm) {   // vm en millimètres
    const e = gripDrag.ent, orig = gripDrag.origAll;
    const cur = R.screenToWorld(view, lastScreen.x, lastScreen.y);   // le curseur donne le sens
    if (gripDrag.kind === 'vertex') {
      const idx = gripDrag.index, o = orig[idx];
      let anchor = null;
      if (orig.length === 2) anchor = orig[1 - idx];
      else if (idx === 0) anchor = orig[1];
      else if (idx === orig.length - 1) anchor = orig[orig.length - 2];
      let dx, dy;
      if (anchor) {   // extrémité : on reste ALIGNÉ sur le trait
        let ux = o.x - anchor.x, uy = o.y - anchor.y; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
        const sign = ((cur.x - o.x) * ux + (cur.y - o.y) * uy) >= 0 ? 1 : -1;
        dx = ux * sign * vm; dy = uy * sign * vm;
      } else {        // sommet intérieur : direction libre (vers le curseur)
        let ux = cur.x - o.x, uy = cur.y - o.y; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
        dx = ux * vm; dy = uy * vm;
      }
      e.points[idx].x = o.x + dx; e.points[idx].y = o.y + dy;
    } else if (gripDrag.kind === 'mid') {   // milieu : déplace tout le segment dans le sens visé
      let ux = cur.x - gripDrag.start.x, uy = cur.y - gripDrag.start.y; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
      e.points[0].x = orig[0].x + ux * vm; e.points[0].y = orig[0].y + uy * vm;
      e.points[1].x = orig[1].x + ux * vm; e.points[1].y = orig[1].y + uy * vm;
    } else if (gripDrag.kind === 'dimoff') {   // cote : écartement = distance tapée
      const a = orig[0], b = orig[1], dxu = b.x - a.x, dyu = b.y - a.y, Lu = Math.hypot(dxu, dyu) || 1, nx = -dyu / Lu, ny = dxu / Lu;
      const s = ((cur.x - a.x) * nx + (cur.y - a.y) * ny) >= 0 ? 1 : -1; e.offMm = s * vm;
    }
    e._bb = null; markSceneDirty();
    gripDrag = null; hotGrip = null; opGhost = null; dimPreview = null; dimHover = null;
    echo('Trait étiré de ' + fmtM(vm) + ' m.');
  }

  function finalizeSelection(add) {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    const moved = Math.hypot(lastScreen.x - selStart.sx, lastScreen.y - selStart.sy);
    let hits;
    if (moved < 4) {                       // clic simple = sélection d'un objet
      const ent = SN.pickEntity(nearScene(selStart.w), selStart.w, 12 / view.pxPerMm) || pickTextAt(selStart.w) || pickHatchAt(selStart.w) || pickImageAt(selStart.w);
      hits = ent ? [ent] : [];
      if (!add) selected = hits;
      else if (ent) { const i = selected.indexOf(ent); i >= 0 ? selected.splice(i, 1) : selected.push(ent); }
      else if (!add) selected = [];
    } else {                               // fenêtre (bleu) ou capture (vert)
      hits = SN.boxSelect(pickScene(), selStart.w, raw, lastScreen.x < selStart.sx);
      selected = add ? selected.concat(hits.filter(h => selected.indexOf(h) < 0)) : hits;
    }
    echo(selected.length + ' objet(s) sélectionné(s).'); refreshProps(); syncCurrentLayer();
  }
  // Calque courant = celui du trait sélectionné PENDANT la sélection ; dès qu'on
  // désélectionne (Échap), on revient au calque choisi avant (baseLayer). Façon AutoCAD :
  // on voit sur quel calque est le trait cliqué, sans changer son calque de travail.
  function syncCurrentLayer() {
    const lay = (selected.length && scene.layers.some(l => l.id === selected[0].layer)) ? selected[0].layer : baseLayer;
    currentLayer = scene.layers.some(l => l.id === lay) ? lay : scene.layers[0].id;
    const col = selected.length ? (selected[0].color || layerById(selected[0].layer).color) : layerById(currentLayer).color;
    if (col) { $('color').value = col; updateSwatch('color'); }
    updateLayerButton();
  }
  function updateLayerButton() {
    const l = layerById(currentLayer), nm = $('ldd-nm'), sw = $('ldd-sw');
    if (nm) nm.textContent = l.name;
    if (sw) sw.style.background = l.color;
  }
  // Sélection d'un texte en cliquant sur sa boîte (sans rotation : boîte simple).
  // (pick* : on n'examine que les entités PROCHES via l'index spatial -> pas de
  // parcours des 135k à chaque survol, sinon lag d'une à deux secondes.)
  function pickTextAt(pt) {
    const cand = nearScene(pt, 50 / view.pxPerMm).entities;
    for (let i = cand.length - 1; i >= 0; i--) {
      const e = cand[i]; if (e.type !== 'text') continue;
      const a = e.points[0], h = e.hMm || 800, w = Math.max(1, String(e.text).length) * h * 0.6;
      if (pt.x >= a.x - h * 0.2 && pt.x <= a.x + w && pt.y >= a.y - h * 0.3 && pt.y <= a.y + h * 1.15) return e;
    }
    return null;
  }
  // Sélection d'une image (fond PDF) en cliquant dans son rectangle.
  function pickImageAt(pt) {
    const cand = nearScene(pt, 50 / view.pxPerMm).entities;
    for (let i = cand.length - 1; i >= 0; i--) {
      const e = cand[i]; if (e.type !== 'image') continue;
      const a = e.points[0], b = e.points[1], x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      if (pt.x >= x0 && pt.x <= x1 && pt.y >= y0 && pt.y <= y1) return e;
    }
    return null;
  }
  // Sélection d'une hachure en cliquant DANS son aire remplie (plus petite d'abord).
  function pickHatchAt(pt) {
    let best = null, bestArea = Infinity;
    for (const e of nearScene(pt, 50 / view.pxPerMm).entities) {
      if (e.type !== 'hatch' || !e.points || e.points.length < 3) continue;
      if (!SN.pointInPolygon(pt, e.points)) continue;
      let A = 0; for (let i = 0, j = e.points.length - 1; i < e.points.length; j = i++) A += (e.points[j].x + e.points[i].x) * (e.points[j].y - e.points[i].y);
      A = Math.abs(A / 2); if (A < bestArea) { bestArea = A; best = e; }
    }
    return best;
  }

  // Sélection générique d'un objet (trait, texte, hachure, image) au point donné.
  function pickAnyAt(raw) { return SN.pickEntity(nearScene(raw), raw, 12 / view.pxPerMm) || pickTextAt(raw) || pickHatchAt(raw) || pickImageAt(raw); }

  // ---------- RACCORD (fillet) : rejoint 2 lignes en un coin (rayon 0) ou avec arrondi ----------
  function applyFillet(f1, f2) {
    const e1 = f1.ent, e2 = f2.ent;
    if (e1 === e2) { echo('RACCORD — cliquez deux traits différents.'); return; }
    const a1 = e1.points[0], b1 = e1.points[1], a2 = e2.points[0], b2 = e2.points[1];
    const X = G.lineLineInt(a1, b1, a2, b2);
    if (!X) { echo('RACCORD impossible : traits parallèles.'); return; }
    pushHistory([e1, e2]);
    // on garde le côté CLIQUÉ : l'extrémité la plus proche du clic reste, l'autre vient au coin
    const keepEnd = (e, click) => (dist(e.points[0], click) <= dist(e.points[1], click)) ? 0 : 1;
    const k1 = keepEnd(e1, f1.click), k2 = keepEnd(e2, f2.click);
    const moveTo = (e, k, pt) => { const mi = 1 - k; e.points[mi].x = pt.x; e.points[mi].y = pt.y; e._bb = null; };
    if (filletRadius <= 0) { moveTo(e1, k1, X); moveTo(e2, k2, X); echo('Coin raccordé (rayon 0).'); }
    else {
      // rayon > 0 : on recule chaque trait de R le long de sa direction depuis le coin, puis arc
      const dirFrom = (e, k) => { const kept = e.points[k]; const L = Math.hypot(kept.x - X.x, kept.y - X.y) || 1; return { x: (kept.x - X.x) / L, y: (kept.y - X.y) / L }; };
      const d1 = dirFrom(e1, k1), d2 = dirFrom(e2, k2);
      const t1 = { x: X.x + d1.x * filletRadius, y: X.y + d1.y * filletRadius };
      const t2 = { x: X.x + d2.x * filletRadius, y: X.y + d2.y * filletRadius };
      moveTo(e1, k1, t1); moveTo(e2, k2, t2);
      // centre de l'arc = intersection des perpendiculaires (approx via bissectrice)
      const bis = { x: d1.x + d2.x, y: d1.y + d2.y }, bl = Math.hypot(bis.x, bis.y) || 1;
      const half = Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y))) / 2;
      const cdist = filletRadius / Math.sin(half || 1e-3);
      const c = { x: X.x + bis.x / bl * cdist, y: X.y + bis.y / bl * cdist };
      const arc = G.arc3(t1, { x: (t1.x + t2.x) / 2 + (c.x - (t1.x + t2.x) / 2) * 0.0001, y: (t1.y + t2.y) / 2 }, t2);
      // arc par 3 points : milieu réel sur le cercle
      const mid = { x: c.x + (((t1.x + t2.x) / 2) - c.x) / Math.hypot(((t1.x + t2.x) / 2) - c.x, ((t1.y + t2.y) / 2) - c.y) * filletRadius, y: c.y + (((t1.y + t2.y) / 2) - c.y) / Math.hypot(((t1.x + t2.x) / 2) - c.x, ((t1.y + t2.y) / 2) - c.y) * filletRadius };
      G.addPolyline(scene, G.arc3(t1, mid, t2), opts());
      echo('Raccord arrondi R=' + fmtM(filletRadius) + ' m.');
    }
    selected = []; refreshProps();
  }

  // ---------- COPIERPROP : copie calque/couleur/épaisseur/trait d'un objet source ----------
  function applyMatch(src, dst) {
    dst.layer = src.layer;
    if ('color' in src) { if (src.color == null) delete dst.color; else dst.color = src.color; } else delete dst.color;
    if (src.penMm == null) delete dst.penMm; else dst.penMm = src.penMm;
    if (src.dash) dst.dash = src.dash; else delete dst.dash;
    dst._bb = null;
  }

  // ---------- DÉCOMPOSER (explode) : polyligne/rectangle/cercle -> segments indépendants ----------
  function explodeSel() {
    if (!selected.length) { echo('Sélectionnez d’abord un ou plusieurs objets à décomposer.'); return; }
    pushHistory(); const out = [];
    selected.forEach(e => {
      const i = scene.entities.indexOf(e); if (i < 0) { out.push(e); return; }
      if ((e.type === 'polyline' || e.type === 'circle') && e.points.length > 2) {
        scene.entities.splice(i, 1);
        const segs = []; for (let k = 1; k < e.points.length; k++) segs.push([e.points[k - 1], e.points[k]]);
        if (e.closed) segs.push([e.points[e.points.length - 1], e.points[0]]);
        segs.forEach(([a, b]) => out.push(G.addLine(scene, a.x, a.y, b.x, b.y, { color: e.color, penMm: e.penMm, layer: e.layer, dash: e.dash })));
      } else out.push(e);
    });
    selected = out; echo('🧩 Décomposé : ' + selected.length + ' segment(s).'); refreshProps(); syncCurrentLayer(); paint();
  }

  // ---------- JOINDRE (join) : relie les lignes/polylignes sélectionnées en UNE polyligne ----------
  function joinSel() {
    const parts = selected.filter(e => e.type === 'polyline' && e.points.length >= 2 && !e.closed);
    if (parts.length < 2) { echo('JOINDRE — sélectionnez au moins 2 lignes/polylignes ouvertes qui se touchent.'); return; }
    const tol = 5, used = new Array(parts.length).fill(false);   // 5 mm : les extrémités doivent coïncider (indépendant du zoom)
    const ptsOf = e => e.points.map(p => ({ x: p.x, y: p.y }));
    let chain = ptsOf(parts[0]); used[0] = true; let added = true, count = 1;
    const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
    while (added) {
      added = false;
      for (let i = 0; i < parts.length; i++) {
        if (used[i]) continue; const q = ptsOf(parts[i]); const h = chain[0], t = chain[chain.length - 1];
        if (near(t, q[0])) { chain = chain.concat(q.slice(1)); used[i] = true; added = true; count++; }
        else if (near(t, q[q.length - 1])) { chain = chain.concat(q.slice().reverse().slice(1)); used[i] = true; added = true; count++; }
        else if (near(h, q[q.length - 1])) { chain = q.slice(0, -1).concat(chain); used[i] = true; added = true; count++; }
        else if (near(h, q[0])) { chain = q.slice().reverse().slice(0, -1).concat(chain); used[i] = true; added = true; count++; }
      }
    }
    if (count < 2) { echo('JOINDRE — les traits sélectionnés ne se touchent pas (extrémités trop éloignées).'); return; }
    pushHistory();
    const style = { color: parts[0].color, penMm: parts[0].penMm, layer: parts[0].layer, dash: parts[0].dash };
    const closed = near(chain[0], chain[chain.length - 1]); if (closed) chain.pop();
    parts.forEach((e, i) => { if (used[i]) { const k = scene.entities.indexOf(e); if (k >= 0) scene.entities.splice(k, 1); } });
    const ne = G.addPolyline(scene, chain, Object.assign({ closed }, style));
    selected = [ne]; echo('🔗 ' + count + ' traits joints en une polyligne' + (closed ? ' fermée' : '') + '.'); refreshProps(); paint();
  }

  // ---------- FERMER / OUVRIR une polyligne (referme les rectangles de menuiserie) ----------
  function closeSel(flag) {
    const polys = selected.filter(e => e.type === 'polyline' && e.points.length >= 3);
    if (!polys.length) { echo('Sélectionnez d’abord des polylignes (≥3 points) à ' + (flag ? 'fermer' : 'ouvrir') + '.'); return; }
    pushHistory(polys);
    polys.forEach(e => { if (flag) e.closed = true; else delete e.closed; e._bb = null; });
    echo('▢ ' + polys.length + ' polyligne(s) ' + (flag ? 'fermée(s)' : 'ouverte(s)') + '.'); paint();
  }

  // ---------- RÉSEAU (array) rectangulaire / polaire ----------
  function arrayRect() {
    if (!selected.length) { echo('RÉSEAU — sélectionnez d’abord les objets à répéter.'); return; }
    const cols = parseInt(prompt('Réseau rectangulaire — nombre de COLONNES :', '3'), 10); if (!(cols >= 1)) return;
    const rows = parseInt(prompt('Nombre de LIGNES :', '1'), 10); if (!(rows >= 1)) return;
    const dx = parseFloat((prompt('Espacement entre COLONNES (m, + vers la droite) :', '1') || '').replace(',', '.'));
    const dy = parseFloat((prompt('Espacement entre LIGNES (m, + vers le haut) :', '1') || '').replace(',', '.'));
    if (!isFinite(dx) || !isFinite(dy)) return;
    pushHistory(); const src = selected.slice(), made = [];
    for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) {
      if (r === 0 && cc === 0) continue;
      const clones = src.map(cloneEntity); clones.forEach(e => scene.entities.push(e));
      translateEnts(clones, cc * M(dx), r * M(dy)); made.push.apply(made, clones);
    }
    selected = src.concat(made); echo('🔳 Réseau ' + cols + '×' + rows + ' : ' + made.length + ' copie(s).'); refreshProps(); paint();
  }
  function arrayPolarStart() {
    if (!selected.length) { echo('RÉSEAU POLAIRE — sélectionnez d’abord les objets.'); return; }
    const count = parseInt(prompt('Réseau polaire — nombre TOTAL d’éléments (originaux inclus) :', '6'), 10); if (!(count >= 2)) return;
    const ang = parseFloat((prompt('Angle total à remplir (°, 360 = tour complet) :', '360') || '').replace(',', '.')); if (!isFinite(ang)) return;
    setTool('arraypolar'); arrayPolar = { count, ang }; echo('RÉSEAU POLAIRE — cliquez le CENTRE de rotation.');
  }
  function doArrayPolar(center) {
    if (!arrayPolar || !selected.length) { arrayPolar = null; setTool('select'); return; }
    const full = Math.abs(arrayPolar.ang) >= 359.9;
    const step = (arrayPolar.ang * Math.PI / 180) / (full ? arrayPolar.count : (arrayPolar.count - 1));
    pushHistory(); const src = selected.slice(), made = [];
    for (let i = 1; i < arrayPolar.count; i++) { const clones = src.map(cloneEntity); clones.forEach(e => scene.entities.push(e)); rotateEnts(clones, center.x, center.y, step * i); made.push.apply(made, clones); }
    selected = src.concat(made); echo('🔄 Réseau polaire : ' + made.length + ' copie(s) autour du centre.'); arrayPolar = null; refreshProps(); setTool('select'); paint();
  }

  // ---------- ZOOM fenêtre / précédent ----------
  function pushView() { viewStack.push({ pxPerMm: view.pxPerMm, panXmm: view.panXmm, panYmm: view.panYmm }); if (viewStack.length > 40) viewStack.shift(); }
  function zoomPrev() { if (!viewStack.length) { echo('Aucune vue précédente.'); return; } const v = viewStack.pop(); view.pxPerMm = v.pxPerMm; view.panXmm = v.panXmm; view.panYmm = v.panYmm; echo('↩ Zoom précédent.'); paint(); }
  function doZoomWindow(a, b) {
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < 1 || h < 1) { setTool('select'); return; }
    pushView(); const pad = Math.max(w, h) * 0.03;
    view.pxPerMm = Math.min(view.canvasW / (w + 2 * pad), view.canvasH / (h + 2 * pad));
    view.panXmm = Math.min(a.x, b.x) - pad; view.panYmm = Math.min(a.y, b.y) - pad;
    echo('🔍 Zoom fenêtre.'); setTool('select'); paint();
  }

  // ---------- ÉTIRER (stretch) : déplace les SOMMETS pris dans un cadre de capture ----------
  function buildStretch(a, b) {
    const minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x), miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
    const inside = p => p.x >= minx && p.x <= maxx && p.y >= miny && p.y <= maxy;
    const set = new Set(), ents = new Set();
    for (const e of scene.entities) {
      if (!layPickable(e.layer) || e.type === 'image' || e.type === 'hatch') continue;
      let any = false;
      for (const p of e.points) if (inside(p)) { set.add(p); any = true; }
      if (e.center && inside(e.center)) { set.add(e.center); any = true; }
      if (any) ents.add(e);
    }
    if (!set.size) { echo('ÉTIRER — aucun sommet dans le cadre. Recommencez (tracez le cadre sur des extrémités).'); stretchOp = null; return; }
    stretchOp = { ptsSet: set, ents: Array.from(ents), base: null };
    echo('ÉTIRER — ' + set.size + ' sommet(s) capturé(s). Point de base :');
  }
  function stretchGhost(dx, dy) {
    return stretchOp.ents.map(e => ({ points: e.points.map(p => stretchOp.ptsSet.has(p) ? { x: p.x + dx, y: p.y + dy } : { x: p.x, y: p.y }), closed: e.closed }));
  }
  function stretchMove() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    cursor = snapPoint(raw, stretchOp.base);
    const dx = cursor.x - stretchOp.base.x, dy = cursor.y - stretchOp.base.y;
    opGhost = stretchGhost(dx, dy);
    $('coords').textContent = fmtM3(cursor.x) + ' , ' + fmtM3(cursor.y) + ' m';
    if (!editing) { dynread.innerHTML = '↔ Étirer <b>' + fmtM(Math.hypot(dx, dy)) + ' m</b>'; editMode(false); dyn.style.display = 'block'; placeDyn(); }
    paintOverlay();
  }
  function commitStretch(dest) {
    const dx = dest.x - stretchOp.base.x, dy = dest.y - stretchOp.base.y;
    pushHistory(stretchOp.ents);
    stretchOp.ptsSet.forEach(p => { p.x += dx; p.y += dy; });
    stretchOp.ents.forEach(e => { e._bb = null; }); markSceneDirty();
    echo('Étiré de ' + fmtM(Math.hypot(dx, dy)) + ' m.');
    stretchOp = null; opGhost = null; hideDyn(); paint();
  }

  // ---------- Transformations : Déplacer / Copier / Pivoter / Miroir ----------
  function cloneEntity(e) { const c = Object.assign({}, e); c.points = e.points.map(p => ({ x: p.x, y: p.y })); if (e.center) c.center = { x: e.center.x, y: e.center.y }; return c; }
  function eachUniquePoint(ents, fn) { const seen = new Set(); ents.forEach(e => { e.points.forEach(p => { if (!seen.has(p)) { seen.add(p); fn(p); } }); if (e.center && !seen.has(e.center)) { seen.add(e.center); fn(e.center); } }); }
  function invalBB(ents) { ents.forEach(e => { e._bb = null; }); markSceneDirty(); }
  function translateEnts(ents, dx, dy) { eachUniquePoint(ents, p => { p.x += dx; p.y += dy; }); invalBB(ents); }
  function rotateEnts(ents, cx, cy, ang) { eachUniquePoint(ents, p => { const q = G.rotatePoint(p, cx, cy, ang); p.x = q.x; p.y = q.y; }); invalBB(ents); }
  function mirrorEnts(ents, ax, ay, bx, by) { eachUniquePoint(ents, p => { const q = G.mirrorPoint(p, ax, ay, bx, by); p.x = q.x; p.y = q.y; }); invalBB(ents); }
  // Mise à l'échelle autour de (cx,cy) d'un facteur f. Met aussi à l'échelle rayon,
  // hauteur de texte et écartement de cote pour rester cohérent.
  function scaleEnts(ents, cx, cy, f) {
    eachUniquePoint(ents, p => { p.x = cx + (p.x - cx) * f; p.y = cy + (p.y - cy) * f; });
    ents.forEach(e => { if (e.r != null) e.r *= f; if (e.hMm != null) e.hMm *= f; if (e.offMm != null) e.offMm *= f; });
    invalBB(ents);
  }
  function ghostOf(fn) { return selected.map(e => ({ points: e.points.map(fn), closed: e.closed })); }

  function opMove() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    const from = op.step >= 1 ? (op.cmd === 'mirror' ? op.p1 : op.base) : null;
    cursor = snapPoint(raw, from);
    $('coords').textContent = fmtM3(cursor.x) + ' , ' + fmtM3(cursor.y) + ' m';
    opGhost = null;
    if (op.step >= 1) {
      if (op.cmd === 'move' || op.cmd === 'copy') {
        const dx = cursor.x - op.base.x, dy = cursor.y - op.base.y;
        opGhost = ghostOf(p => ({ x: p.x + dx, y: p.y + dy }));
        if (!editing) { dynread.innerHTML = '⟷ <b>' + fmtM(Math.hypot(dx, dy)) + ' m</b>'; editMode(false); dyn.style.display = 'block'; placeDyn(); }
      } else if (op.cmd === 'rotate') {
        const ang = Math.atan2(cursor.y - op.base.y, cursor.x - op.base.x);
        opGhost = ghostOf(p => G.rotatePoint(p, op.base.x, op.base.y, ang));
        if (!editing) { dynread.innerHTML = '∠ <b>' + Math.round((ang * 180 / Math.PI + 360) % 360) + '°</b>'; editMode(false); dyn.style.display = 'block'; placeDyn(); }
      } else if (op.cmd === 'mirror') {
        opGhost = ghostOf(p => G.mirrorPoint(p, op.p1.x, op.p1.y, cursor.x, cursor.y));
      } else if (op.cmd === 'scale') {
        if (op.step === 1) {        // on choisit le 2e point de référence : on montre la distance mesurée
          guide = { from: op.base, to: cursor };
          if (!editing) { dynread.innerHTML = '⤢ Référence : <b>' + fmtM(dist(op.base, cursor)) + ' m</b> — cliquez le 2e point'; editMode(false); dyn.style.display = 'block'; placeDyn(); }
        } else if (op.step === 2 && op.ref) {   // on vise la nouvelle longueur : aperçu à l'échelle
          const f = dist(op.base, cursor) / op.ref;
          opGhost = ghostOf(p => ({ x: op.base.x + (p.x - op.base.x) * f, y: op.base.y + (p.y - op.base.y) * f }));
          if (!editing) { dynread.innerHTML = '⤢ ×<b>' + f.toFixed(3).replace('.', ',') + '</b> — cliquez, ou tapez la longueur réelle (m)'; editMode(false); dyn.style.display = 'block'; placeDyn(); }
        }
      }
    }
    paintOverlay();
  }
  function opClick(p) {
    if (op.cmd === 'scale') {
      if (op.step === 0) { op.base = { x: p.x, y: p.y }; op.step = 1; echo(OPPROMPT.scale[1]); paint(); return; }
      if (op.step === 1) {
        const d = dist(op.base, p);
        if (d < 1e-6) { echo('Les 2 points sont confondus — recliquez un point distinct.'); return; }
        op.ref = d; op.step = 2;
        echo('ÉTIREZ à la souris pour voir l’aperçu (avant/après), puis CLIQUEZ pour valider — ou tapez la longueur RÉELLE en m + Entrée.');
        paint(); return;
      }
      commitScale(dist(op.base, p) / op.ref); return;   // step 2 : clic = échelle graphique
    }
    if (op.step === 0) {
      if (op.cmd === 'mirror') op.p1 = { x: p.x, y: p.y }; else op.base = { x: p.x, y: p.y };
      op.step = 1; echo(OPPROMPT[op.cmd][1]); paint(); return;
    }
    commitOp(p);
  }
  function commitScale(f) {
    if (!isFinite(f) || f <= 0) { echo('Facteur d’échelle invalide.'); return; }
    pushHistory(selected);
    scaleEnts(selected, op.base.x, op.base.y, f);
    echo('✅ Mis à l’échelle ×' + f.toFixed(4).replace('.', ',') + ' (' + selected.length + ' objet(s)).');
    opGhost = null; guide = null; endOp(); paint();
  }
  function commitOp(p) {
    pushHistory(selected);
    if (op.cmd === 'move') { translateEnts(selected, p.x - op.base.x, p.y - op.base.y); echo('Déplacé.'); endOp(); }
    else if (op.cmd === 'copy') { const c = selected.map(cloneEntity); c.forEach(e => scene.entities.push(e)); translateEnts(c, p.x - op.base.x, p.y - op.base.y); echo('Copié (Échap pour finir).'); }
    else if (op.cmd === 'rotate') { const ang = Math.atan2(p.y - op.base.y, p.x - op.base.x); rotateEnts(selected, op.base.x, op.base.y, ang); echo('Pivoté de ' + Math.round(ang * 180 / Math.PI) + '°.'); endOp(); }
    else if (op.cmd === 'mirror') { const c = selected.map(cloneEntity); c.forEach(e => scene.entities.push(e)); mirrorEnts(c, op.p1.x, op.p1.y, p.x, p.y); selected = c; echo('Miroir créé.'); endOp(); }
    opGhost = null; paint();
  }
  function endOp() { op = null; opGhost = null; hideDyn(); tool = 'select'; document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select')); }

  // ---------- Cercle ----------
  function circleMove() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    cursor = snapPoint(raw, circleCenter);
    $('coords').textContent = fmtM3(cursor.x) + ' , ' + fmtM3(cursor.y) + ' m';
    if (circleCenter) { const r = dist(circleCenter, cursor); circlePreview = { cx: circleCenter.x, cy: circleCenter.y, r }; if (!editing) { dynread.innerHTML = '◯ rayon <b>' + fmtM(r) + ' m</b>'; editMode(false); dyn.style.display = 'block'; placeDyn(); } }
    else circlePreview = null;
    paint();
  }
  function circleClick(p) {
    if (!circleCenter) { circleCenter = { x: p.x, y: p.y }; echo('Rayon (clic ou valeur en m) :'); }
    else { pushHistory(); G.addCircle(scene, circleCenter.x, circleCenter.y, dist(circleCenter, p), opts()); echo('Cercle créé (Échap pour finir).'); circleCenter = null; circlePreview = null; }
    paint();
  }

  // ---------- Ajuster / Prolonger (Maj = Prolonger) ----------
  function pickLineEnt(raw) {
    const near = nearScene(raw);
    const seg = SN.pickSegment(near, raw, 10 / view.pxPerMm);
    if (!seg) return null;
    for (const e of near.entities) {
      if (e.type === 'dim' || e.type === 'hatch' || e.type === 'circle' || e.type === 'image' || e.type === 'text') continue;
      if (e.points.length === 2 && ((e.points[0] === seg.a && e.points[1] === seg.b) || (e.points[0] === seg.b && e.points[1] === seg.a))) return e;
    }
    return null;
  }
  function hoverTrim(e) {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    const ent = pickLineEnt(raw);
    dimHover = ent ? { a: ent.points[0], b: ent.points[1] } : null;
    const ext = e ? e.shiftKey : shiftDown;
    trimPreview = ent ? computeTrimPreview(ent, raw, ext) : null;
    dynread.innerHTML = ext
      ? (ent ? '⤢ <b>Prolonger</b> ce trait (relâche Maj = Ajuster)' : '⤢ Prolonger — cliquez un trait')
      : (ent ? '✂️ <b>Ajuster</b> ce trait (Maj = Prolonger)' : '✂️ Ajuster — cliquez un trait (Maj = Prolonger)');
    editMode(false); dyn.style.display = 'block'; placeDyn();
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m'; paintOverlay();
  }
  // Projection d'Ajuster/Prolonger : renvoie le segment à SUPPRIMER (trim, rouge)
  // ou le segment AJOUTÉ jusqu'à la cible (extend, vert), pour l'afficher avant le clic.
  function computeTrimPreview(ent, clickPt, extend) {
    const ax = ent.points[0].x, ay = ent.points[0].y, bx = ent.points[1].x, by = ent.points[1].y;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const tP = ((clickPt.x - ax) * dx + (clickPt.y - ay) * dy) / len2;
    const P = t => ({ x: ax + dx * t, y: ay + dy * t });
    if (extend) {
      const cands = [];
      for (const o of nearEnt(ent)) {
        if (o === ent || o.type === 'dim' || o.type === 'hatch' || o.type === 'image' || o.type === 'text') continue;
        for (const [c, d] of SN.entitySegments(o)) { const t = SN.rayParam({ x: ax, y: ay }, { x: bx, y: by }, c, d); if (t != null) cands.push(t); }
      }
      if (tP < 0.5) { const neg = cands.filter(t => t < -1e-4); if (!neg.length) return null; return { kind: 'ext', seg: [P(0), P(Math.max.apply(null, neg))] }; }
      const pos = cands.filter(t => t > 1 + 1e-4); if (!pos.length) return null; return { kind: 'ext', seg: [P(1), P(Math.min.apply(null, pos))] };
    }
    const ts = [];
    for (const o of nearEnt(ent)) {
      if (o === ent || o.type === 'dim' || o.type === 'hatch' || o.type === 'image' || o.type === 'text') continue;
      for (const [c, d] of SN.entitySegments(o)) { const t = SN.segParam({ x: ax, y: ay }, { x: bx, y: by }, c, d); if (t != null && t > 1e-4 && t < 1 - 1e-4) ts.push(t); }
    }
    if (!ts.length) return null;
    ts.sort((a, b) => a - b);
    const bounds = [0, ...ts, 1];
    let i = 0; while (i < bounds.length - 1 && tP > bounds[i + 1]) i++;
    return { kind: 'cut', seg: [P(bounds[i]), P(bounds[i + 1])] };
  }
  // Dessin de l'aperçu (overlay direct sur le canvas après le rendu de base)
  function drawTrimOverlay() {
    if (!trimPreview) return;
    const s = trimPreview.seg.map(p => R.worldToScreen(view, p.x, p.y));
    ctx.save();
    if (trimPreview.kind === 'cut') {
      ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 3; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); ctx.stroke();
      // petites croix aux bouts = ce qui disparaît
      ctx.lineWidth = 1.5; [s[0], s[1]].forEach(p => { ctx.beginPath(); ctx.moveTo(p.x - 5, p.y - 5); ctx.lineTo(p.x + 5, p.y + 5); ctx.moveTo(p.x + 5, p.y - 5); ctx.lineTo(p.x - 5, p.y + 5); ctx.stroke(); });
    } else {
      ctx.strokeStyle = '#39d353'; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
      ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = '#39d353'; const t = s[1];   // marqueur d'arrivée
      ctx.beginPath(); ctx.arc(t.x, t.y, 4, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.restore();
  }
  function trimLine(ent, clickPt) {
    const ax = ent.points[0].x, ay = ent.points[0].y, bx = ent.points[1].x, by = ent.points[1].y;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const tP = ((clickPt.x - ax) * dx + (clickPt.y - ay) * dy) / len2;
    const ts = [];
    for (const o of nearEnt(ent)) {
      if (o === ent || o.type === 'dim' || o.type === 'hatch' || o.type === 'image' || o.type === 'text') continue;
      for (const [c, d] of SN.entitySegments(o)) { const t = SN.segParam({ x: ax, y: ay }, { x: bx, y: by }, c, d); if (t != null && t > 1e-4 && t < 1 - 1e-4) ts.push(t); }
    }
    if (!ts.length) { echo('Ajuster : aucune intersection sur ce trait.'); return; }
    ts.sort((a, b) => a - b);
    const bounds = [0, ...ts, 1];
    let i = 0; while (i < bounds.length - 1 && tP > bounds[i + 1]) i++;
    const t0 = bounds[i], t1 = bounds[i + 1];
    const P = t => ({ x: ax + dx * t, y: ay + dy * t });
    pushHistory();
    const idx = scene.entities.indexOf(ent); scene.entities.splice(idx, 1);
    const o = { color: ent.color, penMm: ent.penMm, layer: ent.layer };
    if (t0 > 1e-4) { const p = P(0), q = P(t0); G.addLine(scene, p.x, p.y, q.x, q.y, o); }
    if (t1 < 1 - 1e-4) { const p = P(t1), q = P(1); G.addLine(scene, p.x, p.y, q.x, q.y, o); }
    selected = []; echo('Trait ajusté.');
  }
  function extendLine(ent, clickPt) {
    const ax = ent.points[0].x, ay = ent.points[0].y, bx = ent.points[1].x, by = ent.points[1].y;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const tP = ((clickPt.x - ax) * dx + (clickPt.y - ay) * dy) / len2;
    const cands = [];
    for (const o of nearEnt(ent)) {
      if (o === ent || o.type === 'dim' || o.type === 'hatch' || o.type === 'image' || o.type === 'text') continue;
      for (const [c, d] of SN.entitySegments(o)) { const t = SN.rayParam({ x: ax, y: ay }, { x: bx, y: by }, c, d); if (t != null) cands.push(t); }
    }
    if (tP < 0.5) { const neg = cands.filter(t => t < -1e-4); if (!neg.length) { echo('Prolonger : rien à atteindre de ce côté.'); return; } const t = Math.max.apply(null, neg); pushHistory([ent]); ent.points[0].x = ax + dx * t; ent.points[0].y = ay + dy * t; }
    else { const pos = cands.filter(t => t > 1 + 1e-4); if (!pos.length) { echo('Prolonger : rien à atteindre de ce côté.'); return; } const t = Math.min.apply(null, pos); pushHistory([ent]); ent.points[1].x = ax + dx * t; ent.points[1].y = ay + dy * t; }
    echo('Trait prolongé.');
  }

  cv.addEventListener('mousedown', e => {
    cv.focus();
    if (activePage !== 'model') { pageMouseDown(e); return; }
    if (e.button === 1 || e.button === 2 || tool === 'pan') {
      if (e.button === 2) rightDown = { sx: e.clientX, sy: e.clientY };   // pour distinguer clic droit sec / panoramique
      panning = true; panStart = { sx: e.clientX, sy: e.clientY, px: view.panXmm, py: view.panYmm }; e.preventDefault(); return;
    }
    stopEdit();
    if (tool === 'stretch') {
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top; lastScreen = { x: sx, y: sy };
      if (!stretchOp) { selecting = true; selStart = { sx, sy, w: R.screenToWorld(view, sx, sy) }; selRect = null; return; }  // phase 1 : cadre de capture
      const raw = snapPoint(R.screenToWorld(view, sx, sy), stretchOp.base || null);
      if (!stretchOp.base) { stretchOp.base = { x: raw.x, y: raw.y }; echo('ÉTIRER — point de destination (ou tapez la distance) :'); paint(); return; }
      commitStretch(raw); return;
    }
    if (tool === 'zoomwin') { const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top; lastScreen = { x: sx, y: sy }; selecting = true; selStart = { sx, sy, w: R.screenToWorld(view, sx, sy) }; selRect = null; return; }
    if (tool === 'arraypolar') { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); doArrayPolar(snapPoint(raw, null)); return; }
    if (tool === 'select') {
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      lastScreen = { x: sx, y: sy };
      // Sélection « clic → déplace → clic » : si un cadre est en attente, ce clic le VALIDE.
      if (boxPending) {
        const raw = R.screenToWorld(view, sx, sy);
        const hits = SN.boxSelect(pickScene(), boxPending.anchor.w, raw, sx < boxPending.anchor.sx);
        selected = e.shiftKey ? selected.concat(hits.filter(h => selected.indexOf(h) < 0)) : hits;
        boxPending = null; selRect = null; selecting = false;
        echo(selected.length + ' objet(s) sélectionné(s).'); refreshProps(); syncCurrentLayer(); paint(); return;
      }
      // Édition par poignée façon AutoCAD : 1er clic = attrape le point (il suit le
      // curseur SANS maintenir le bouton), 2e clic = le dépose. Échap = annule.
      if (gripDrag) { applyGrip(); gripDrag = null; hotGrip = null; opGhost = null; dimPreview = null; dimHover = null; echo('Objet modifié.'); paint(); return; }
      if (selected.length) {
        const g = hitGrip(sx, sy);
        if (g) {
          pushHistory([g.ent]);
          gripDrag = g;
          gripDrag.origAll = g.ent.points.map(p => ({ x: p.x, y: p.y }));
          if (g.ent.offMm != null) gripDrag.origOff = g.ent.offMm;
          if (g.kind === 'mid') gripDrag.start = R.screenToWorld(view, sx, sy);
          dragGrip(R.screenToWorld(view, sx, sy)); echo('Point attrapé — déplacez (fantôme orange) puis cliquez pour déposer (Échap = annuler).'); paintOverlay(); return;
        }
      }
      selecting = true; selStart = { sx, sy, w: R.screenToWorld(view, sx, sy) }; selRect = null; return;
    }
    if (tool === 'dim') {
      const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
      if (!dimSeg) { const seg = SN.pickSegment(nearScene(raw), raw, 10 / view.pxPerMm); if (seg) { dimSeg = { a: seg.a, b: seg.b }; echo('Cote : éloignez le curseur pour régler l’écartement, puis cliquez pour poser.'); hoverDim(); } else echo('Survolez un trait à coter, puis cliquez-le.'); }
      else if (dimPreview) { pushHistory(); const cotId = ensureLayer('Cotation', '#b9375e'); G.addDim(scene, dimPreview.points[0], dimPreview.points[1], dimPreview.offMm, { textMm: currentDimSize, layer: cotId, color: '#b9375e' }); renderLayerSelect(); refreshLayers(); echo('Cote posée : ' + fmtM(dist(dimPreview.points[0], dimPreview.points[1])) + ' m'); dimSeg = null; paint(); }
      return;
    }
    if (tool === 'offset') {
      if (pendingOffset) {
        pushHistory(); const s = pendingOffset.src, o = { color: s.color, penMm: s.penMm, layer: s.layer, dash: s.dash };
        if (pendingOffset.kind === 'circle') G.addCircle(scene, pendingOffset.center.x, pendingOffset.center.y, pendingOffset.r, o);
        else if (pendingOffset.kind === 'poly') G.addPolyline(scene, pendingOffset.points, Object.assign({ closed: pendingOffset.closed }, o));
        else G.addLine(scene, pendingOffset.a.x, pendingOffset.a.y, pendingOffset.b.x, pendingOffset.b.y, o);
        echo('⇥ Décalé de ' + fmtM(offsetDist) + ' m.'); paint();
      }
      return;
    }
    if (tool === 'hatch') { if (hatchHover) { pushHistory(); G.addHatch(scene, hatchHover, { pattern: hatchPattern, spacingMm: hatchSpacing, angleDeg: 45, layer: currentLayer, color: hatchColor() }); echo('Hachure « ' + hatchPatternName() + ' » ajoutée.'); paint(); } else echo('Survolez une zone fermée (délimitée par des traits) avant de cliquer.'); return; }
    if (op) { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); const from = op.step >= 1 ? (op.cmd === 'mirror' ? op.p1 : op.base) : null; opClick(snapPoint(raw, from)); return; }
    if (tool === 'circle') { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); circleClick(snapPoint(raw, circleCenter)); return; }
    if (tool === 'trim') { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); const ent = pickLineEnt(raw); if (ent) { if (e.shiftKey) extendLine(ent, raw); else trimLine(ent, raw); } paint(); return; }
    if (tool === 'fillet') {
      const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
      const ent = pickLineEnt(raw);
      if (!ent) { echo('RACCORD — cliquez une LIGNE (segment droit).'); return; }
      if (!filletFirst) { filletFirst = { ent, click: { x: raw.x, y: raw.y } }; echo('RACCORD — 2e trait :'); }
      else { applyFillet(filletFirst, { ent, click: { x: raw.x, y: raw.y } }); filletFirst = null; }
      paint(); return;
    }
    if (tool === 'matchprop') {
      const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
      const ent = pickAnyAt(raw);
      if (!matchSrc) { if (ent) { matchSrc = ent; selected = [ent]; echo('COPIERPROP — source définie. Cliquez les objets à aligner (Échap/Entrée = finir).'); refreshProps(); } else echo('COPIERPROP — cliquez l’objet SOURCE.'); }
      else if (ent && ent !== matchSrc) { pushHistory([ent]); applyMatch(matchSrc, ent); echo('✔ Style copié sur l’objet.'); }
      paint(); return;
    }
    if (tool === 'text') { const r = cv.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top; textPt = snapPoint(R.screenToWorld(view, sx, sy), null); showTextInput(sx, sy); return; }
    const r = cv.getBoundingClientRect();
    place(compute(e.clientX - r.left, e.clientY - r.top));
  });

  function place(p) {
    if (tool === 'line') {
      // Outil LIGNE façon AutoCAD : on enchaîne les points à l'infini ; CHAQUE clic
      // crée un segment INDÉPENDANT (une entité « ligne » par segment, pas un bloc).
      // Entrée/Échap termine la chaîne, et l'outil reste prêt pour une nouvelle ligne.
      // (Pour un tracé relié en un seul bloc, utiliser POLYLIGNE.)
      if (!draft.length) { draft = [{ x: p.x, y: p.y }]; echo('Point suivant — clic (Entrée/Échap pour finir) :'); }
      else { pushHistory(); G.addLine(scene, draft[draft.length - 1].x, draft[draft.length - 1].y, p.x, p.y, opts()); draft = [{ x: p.x, y: p.y }]; hideDyn(); echo('Point suivant — clic, longueur en m (Entrée/Échap pour finir) :'); }
    } else if (tool === 'polyline') {
      // Clic sur le 1er point (accroché) => on FERME la polyligne en un bloc.
      if (draft.length >= 2 && dist(p, draft[0]) < tolMm()) { finishPoly(true); return; }
      draft.push({ x: p.x, y: p.y }); echo('Point suivant (clic ; clic sur le 1er point = fermer ; Entrée/Échap = finir) :');
    }
    else if (tool === 'rect') {
      if (!draft.length) { draft.push({ x: p.x, y: p.y }); echo('Coin opposé :'); }
      else { const a = draft[0]; pushHistory(); G.addRect(scene, Math.min(a.x, p.x), Math.min(a.y, p.y), Math.abs(p.x - a.x), Math.abs(p.y - a.y), Object.assign({ closed: true }, opts())); draft = []; hideDyn(); echo('Premier coin :'); }
    }
    else if (tool === 'arc') {
      draft.push({ x: p.x, y: p.y });
      if (draft.length === 1) echo('ARC — 2e point (sur l’arc) :');
      else if (draft.length === 2) echo('ARC — point final :');
      else { const pts = G.arc3(draft[0], draft[1], draft[2]); pushHistory(); G.addPolyline(scene, pts, opts()); draft = []; hideDyn(); echo('Arc créé. ARC — premier point :'); }
    }
    else if (tool === 'polygon') {
      if (!draft.length) { draft.push({ x: p.x, y: p.y }); echo('POLYGONE (' + polySides + ' côtés) — un sommet (rayon) :'); }
      else { pushHistory(); G.addPolyline(scene, G.regularPolygon(draft[0].x, draft[0].y, p.x, p.y, polySides), Object.assign({ closed: true }, opts())); draft = []; hideDyn(); echo('Polygone ' + polySides + ' côtés créé. Centre :'); }
    }
    else if (tool === 'dist') {
      draft.push({ x: p.x, y: p.y });
      if (draft.length === 1) echo('MESURER — 2e point :');
      else { const d = dist(draft[0], draft[1]); echo('📏 Distance : <b>' + fmtM3(d) + ' m</b> · Δx ' + fmtM3(Math.abs(draft[1].x - draft[0].x)) + ' · Δy ' + fmtM3(Math.abs(draft[1].y - draft[0].y)) + ' · angle ' + angleDeg(draft[0], draft[1]).toFixed(1) + '°'); draft = []; hideDyn(); }
    }
    else if (tool === 'area') {
      draft.push({ x: p.x, y: p.y });
      if (draft.length >= 2 && dist(p, draft[0]) < tolMm() && draft.length >= 4) { draft.pop(); finishArea(); return; }
      echo('AIRE — point suivant (' + draft.length + ' pts ; Entrée = calculer, clic sur le 1er point = fermer) :');
    }
    paint();
  }
  function finishArea() {
    if (draft.length < 3) { echo('AIRE — il faut au moins 3 points.'); draft = []; hideDyn(); paint(); return; }
    const a = G.polyArea(draft), per = G.polyPerim(draft, true);
    echo('🟦 Aire : <b>' + (a / 1e6).toFixed(2).replace('.', ',') + ' m²</b> · périmètre <b>' + fmtM(per) + ' m</b> (' + draft.length + ' sommets).');
    draft = []; hideDyn(); paint();
  }

  cv.addEventListener('dblclick', e => {
    if (activePage !== 'model') return;
    if (tool === 'select') {
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      const raw = R.screenToWorld(view, sx, sy), t = pickTextAt(raw);
      if (t) { startEditText(t, sx, sy); return; }   // DDEDIT : double-clic sur un texte = le modifier
    }
    finishPoly(false);
  });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('mouseup', e => {
    panning = false;
    // Clic droit « sec » (sans glisser) = Entrée / répéter la dernière commande (réflexe AutoCAD).
    if (e.button === 2 && rightDown) { const moved = Math.hypot(e.clientX - rightDown.sx, e.clientY - rightDown.sy); rightDown = null; if (moved < 5 && activePage === 'model') { cv.focus(); acceptOrRepeat(); } }
    if (vpDrag) { vpDrag = null; cv.style.cursor = 'grab'; paintPage(); return; }
    if (pageDrag) { pageDrag = null; return; }
    // NB : on NE dépose PAS la poignée au relâchement (mode clic→déplace→clic).
    if (selecting) {
      if (tool === 'stretch' && !stretchOp) { const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y); buildStretch(selStart.w, raw); selecting = false; selRect = null; paint(); return; }
      if (tool === 'zoomwin') { const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y); doZoomWindow(selStart.w, raw); selecting = false; selRect = null; paint(); return; }
      const moved = Math.hypot(lastScreen.x - selStart.sx, lastScreen.y - selStart.sy);
      if (moved >= 5) { finalizeSelection(e.shiftKey); selecting = false; selRect = null; paint(); return; }
      // Clic « sec » : objet sous le curseur => sélection simple ; sinon on DÉMARRE un
      // cadre en attente (clic → déplace → clic) sans devoir maintenir le bouton.
      const ent = SN.pickEntity(nearScene(selStart.w), selStart.w, 12 / view.pxPerMm) || pickTextAt(selStart.w) || pickHatchAt(selStart.w) || pickImageAt(selStart.w);
      if (ent) {
        if (!e.shiftKey) selected = [ent];
        else { const i = selected.indexOf(ent); i >= 0 ? selected.splice(i, 1) : selected.push(ent); }
        boxPending = null; selecting = false; selRect = null;
        echo(selected.length + ' objet(s) sélectionné(s).'); refreshProps(); syncCurrentLayer(); paint(); return;
      }
      // vide : arme le cadre (le rectangle suivra la souris jusqu'au 2e clic)
      boxPending = { anchor: selStart }; selecting = false;
      echo('Cadre : déplacez puis cliquez pour valider (→ bleu : englobe · ← vert : capture). Échap = annuler.');
      paintOverlay();
    }
  });
  function finishPoly(closed) { if (tool === 'polyline' && draft.length >= 2) { pushHistory(); G.addPolyline(scene, draft, Object.assign({ closed: !!closed }, opts())); echo(closed ? 'Polyligne fermée créée (un bloc).' : 'Polyligne créée (un bloc).'); } draft = []; ghost = null; hideDyn(); paint(); }

  // ---------- Saisie dynamique (en mètres) ----------
  function editMode(on) { dynedit.style.display = on ? '' : 'none'; dynread.style.display = on ? 'none' : ''; }
  function showPassive() {
    const a = activePoint(); if (!a) return;
    dynread.innerHTML = '⟷ <b>' + fmtM(dist(a, cursor)) + ' m</b> &nbsp; ∠ ' + Math.round(angleDeg(a, cursor)) + '°';
    editMode(false); dyn.style.display = 'block'; placeDyn();
  }
  function startEdit(initial) {
    if (!gripDrag && !activePoint() && tool !== 'offset' && !(op && (op.step === 1 || (op.cmd === 'scale' && op.step === 2))) && !(tool === 'circle' && circleCenter) && !(tool === 'stretch' && stretchOp && stretchOp.base)) return;
    editing = true; editMode(true); dyn.style.display = 'block'; placeDyn();
    dyninput.value = initial || '';
    // Focus SYNCHRONE : le champ s'ouvre à la frappe d'un chiffre (keydown), donc
    // aucun mousedown ne vient voler le focus -> on garde tous les chiffres tapés.
    dyninput.focus(); const v = dyninput.value; dyninput.value = ''; dyninput.value = v;
  }
  function stopEdit() { editing = false; editMode(false); }
  function hideDyn() { dyn.style.display = 'none'; editing = false; }
  function placeDyn() { dyn.style.left = (lastScreen.x + 16) + 'px'; dyn.style.top = (lastScreen.y + 18 + cv.offsetTop) + 'px'; }

  // ---------- Outil Texte (saisie flottante à l'emplacement cliqué) ----------
  // Saisie WYSIWYG : le champ est transparent et calé exactement à l'emplacement,
  // à la bonne police/taille/couleur -> on voit le texte s'écrire sur le plan (façon AutoCAD).
  function ensureTextInput() {
    if (txtEl) return txtEl;
    txtEl = document.createElement('input'); txtEl.type = 'text'; txtEl.id = 'txtin';
    txtEl.style.cssText = 'position:absolute;display:none;z-index:30;background:transparent;border:none;border-left:1px dashed var(--primary);padding:0 0 0 1px;margin:0;outline:none;white-space:pre;overflow:visible';
    txtEl.style.caretColor = 'var(--primary)';
    cv.parentElement.appendChild(txtEl);
    txtEl.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') commitText(); else if (ev.key === 'Escape') { hideTextInput(); cv.focus(); paint(); } });
    txtEl.addEventListener('input', () => autoSizeText());
    return txtEl;
  }
  function textFont() { const f = $('txtfont'); return f ? f.value : 'system-ui,Segoe UI,sans-serif'; }
  function autoSizeText() { if (!txtEl) return; txtEl.style.width = '10px'; txtEl.style.width = Math.max(14, txtEl.scrollWidth + 4) + 'px'; }
  function showTextInput(sx, sy) {
    ensureTextInput();
    const px = Math.max(8, currentTextH * view.pxPerMm);
    txtEl.style.font = '600 ' + px + 'px ' + textFont();
    txtEl.style.lineHeight = px + 'px'; txtEl.style.height = Math.round(px * 1.18) + 'px';
    txtEl.style.color = $('color').value;
    txtEl.style.left = sx + 'px'; txtEl.style.top = (sy - px + cv.offsetTop) + 'px';
    txtEl.style.display = 'block'; txtEl.value = ''; autoSizeText();
    setTimeout(() => txtEl.focus(), 0);
    echo('TEXTE — tapez directement, Entrée pour valider (Échap pour annuler).');
  }
  function hideTextInput() { if (txtEl) txtEl.style.display = 'none'; editingText = null; }
  // DDEDIT : modifier un texte existant in-situ (double-clic).
  function startEditText(t, sx, sy) {
    editingText = t; ensureTextInput();
    const px = Math.max(8, (t.hMm || currentTextH) * view.pxPerMm);
    txtEl.style.font = '600 ' + px + 'px ' + (t.font || textFont());
    txtEl.style.lineHeight = px + 'px'; txtEl.style.height = Math.round(px * 1.18) + 'px';
    txtEl.style.color = t.color || layerById(t.layer).color;
    const s = R.worldToScreen(view, t.points[0].x, t.points[0].y);
    txtEl.style.left = s.x + 'px'; txtEl.style.top = (s.y - px + cv.offsetTop) + 'px';
    txtEl.style.display = 'block'; txtEl.value = t.text || ''; autoSizeText();
    setTimeout(() => { txtEl.focus(); try { txtEl.select(); } catch (e) { } }, 0);
    echo('Modifier le texte — Entrée pour valider (Échap pour annuler).');
  }
  function commitText() {
    const v = (txtEl.value || '').trim();
    if (editingText) { if (v) { pushHistory([editingText]); editingText.text = v; editingText._bb = null; echo('Texte modifié.'); } hideTextInput(); cv.focus(); paint(); return; }
    if (v && textPt) { pushHistory(); G.addText(scene, textPt.x, textPt.y, v, { hMm: currentTextH, color: $('color').value, layer: currentLayer, angleDeg: 0, font: textFont() }); echo('Texte « ' + v + ' » posé (clique ailleurs pour un autre, Échap pour finir).'); }
    hideTextInput(); cv.focus(); paint();
  }

  function commitDyn() {
    const raw = (dyninput.value || '').replace(',', '.').trim();
    if (gripDrag) { const v = parseFloat(raw); if (isFinite(v) && v > 0) applyGripValue(M(v)); stopEdit(); hideDyn(); paint(); return; }
    if (tool === 'stretch' && stretchOp && stretchOp.base) { const v = parseFloat(raw); if (isFinite(v) && v > 0) commitStretch(SN.alongDir(stretchOp.base, cursor, M(v))); stopEdit(); paint(); return; }
    if (op && op.cmd === 'scale') {
      const v = parseFloat(raw);
      if (op.step === 2) { if (isFinite(v) && v > 0) commitScale(M(v) / op.ref); }   // longueur réelle en m
      else if (op.step === 1 && isFinite(v) && v > 0) commitScale(v);                 // facteur direct tapé
      stopEdit(); paint(); return;
    }
    if (op && op.step === 1) {
      if (op.cmd === 'rotate') { const deg = parseFloat(raw); if (isFinite(deg)) { pushHistory(selected); rotateEnts(selected, op.base.x, op.base.y, deg * Math.PI / 180); echo('Pivoté de ' + deg + '°.'); endOp(); } stopEdit(); paint(); return; }
      const v = parseFloat(raw);
      if (isFinite(v) && v > 0) { pushHistory(selected); const q = SN.alongDir(op.base, cursor, M(v)); if (op.cmd === 'copy') { const c = selected.map(cloneEntity); c.forEach(e => scene.entities.push(e)); translateEnts(c, q.x - op.base.x, q.y - op.base.y); echo('Copié.'); } else { translateEnts(selected, q.x - op.base.x, q.y - op.base.y); echo('Déplacé.'); endOp(); } }
      stopEdit(); paint(); return;
    }
    if (tool === 'circle' && circleCenter) { const v = parseFloat(raw); if (isFinite(v) && v > 0) { pushHistory(); G.addCircle(scene, circleCenter.x, circleCenter.y, M(v), opts()); echo('Cercle créé.'); circleCenter = null; circlePreview = null; } stopEdit(); paint(); return; }
    if (tool === 'offset') {
      const v = parseFloat(raw);
      if (isFinite(v) && v > 0) { offsetDist = M(v); echo('Distance de décalage : ' + fmtM(offsetDist) + ' m'); }
      stopEdit(); hoverOffset(); return;
    }
    const from = activePoint(); if (!from) { stopEdit(); return; }
    let p = null;
    if (raw.indexOf('<') >= 0) {               // "longueur<angle" (longueur en m)
      const [l, a] = raw.split('<'); const len = parseFloat(l), ang = parseFloat(a);
      if (isFinite(len) && len > 0 && isFinite(ang)) p = SN.polar(from, M(len), ang);
    } else { const len = parseFloat(raw); if (isFinite(len) && len > 0) p = SN.alongDir(from, cursor, M(len)); }
    stopEdit(); if (p) place(p);
  }
  dyninput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') commitDyn();
    else if (e.key === 'Escape') { stopEdit(); paint(); }
  });

  // ---------- Ligne de commande ----------
  const CMD = {
    LIGNE: 'line', L: 'line', POLYLIGNE: 'polyline', PL: 'polyline', POLY: 'polyline',
    RECTANGLE: 'rect', REC: 'rect', RECT: 'rect', COTE: 'dim', DIM: 'dim', COT: 'dim', DLI: 'dim',
    HACHURES: 'hatch', HACH: 'hatch', HA: 'hatch', BHATCH: 'hatch', HACHURE: 'hatch',
    DECALER: 'offset', DECALAGE: 'offset', DEC: 'offset', O: 'offset', DC: 'offset',
    DEPLACER: 'move', DEPLACE: 'move', M: 'move',
    COPIER: 'copy', CO: 'copy', CP: 'copy',
    PIVOTER: 'rotate', ROTATION: 'rotate', RO: 'rotate',
    MIROIR: 'mirror', MI: 'mirror',
    CERCLE: 'circle', C: 'circle',
    ARC: 'arc', A: 'arc',
    POLYGONE: 'polygon', POL: 'polygon', PG: 'polygon',
    ECHELLE: 'scale', ECH: 'scale', SC: 'scale', MISEALECHELLE: 'scale',
    TEXTE: 'text', TXT: 'text', T: 'text', DT: 'text', MTEXT: 'text', TEXT: 'text',
    AJUSTER: 'trim', AJ: 'trim', TR: 'trim', PROLONGER: 'trim', EX: 'trim',
    RACCORD: 'fillet', RAC: 'fillet', FILLET: 'fillet', CONGE: 'fillet',
    ETIRER: 'stretch', ET: 'stretch', STRETCH: 'stretch',
    COPIERPROP: 'matchprop', COPIERPROPRIETES: 'matchprop', MATCH: 'matchprop',
    MESURER: 'dist', DISTANCE: 'dist', DI: 'dist', MES: 'dist',
    AIRE: 'area', AREA: 'area', SURFACE: 'area',
    DECOMPOSER: explodeSel, DECOMPOSE: explodeSel, X: explodeSel, EXPLODE: explodeSel,
    JOINDRE: joinSel, JOIN: joinSel, JOINT: joinSel,
    FERMER: () => closeSel(true), FERME: () => closeSel(true), CLOSE: () => closeSel(true),
    OUVRIR: () => closeSel(false), OUVRE: () => closeSel(false), OPEN: () => closeSel(false),
    RESEAU: arrayRect, RESEAURECT: arrayRect, ARRAY: arrayRect, AR: arrayRect,
    RESEAUPOLAIRE: arrayPolarStart, RESEAUP: arrayPolarStart, ARRAYPOLAR: arrayPolarStart,
    PAN: 'pan', PANO: 'pan', P: 'pan',
    SELECTION: 'select', SEL: 'select', S: 'select',
    ANNULER: undo, U: undo, H: undo, REFAIRE: redo, RETABLIR: redo, Y: redo,
    EFFACER: eraseSel, EF: eraseSel, SUPPR: eraseSel, EFFACERTOUT: clearAll,
    ZE: () => { pushView(); fit(); }, ZOOM: () => { pushView(); fit(); }, Z: () => { pushView(); fit(); }, ETENDU: () => { pushView(); fit(); },
    ZF: 'zoomwin', ZOOMFENETRE: 'zoomwin', ZW: 'zoomwin',
    ZP: zoomPrev, ZOOMPRECEDENT: zoomPrev, ZPREV: zoomPrev,
    GRILLE: () => toggle('grid'), ORTHO: () => toggle('ortho', true),
    POLAIRE: () => toggle('polar', true), ACCROBJ: () => toggle('osnap'), RESOL: () => toggle('snap'),
    CALQUES: toggleLayersPanel, CALQUE: toggleLayersPanel, CA: toggleLayersPanel, LA: toggleLayersPanel,
    OPTIONS: toggleOptions, PARAMETRES: toggleOptions, CONFIG: toggleOptions, OP: toggleOptions,
    PROPRIETES: toggleProps, PROP: toggleProps, PR: toggleProps,
    PAGE: createPage, PRESENTATION: createPage, OBJET: () => setActivePage('model'),
    IMPRIMER: plot, PDF: plot, TRACER: plot
  };
  // Commandes AutoCAD connues, pas encore implémentées (réponse honnête "à venir")
  const SOON = [];
  const OPPROMPT = {
    move: ['DÉPLACER — cliquez le point de base :', 'Destination : clic, ou tapez la distance en m :'],
    copy: ['COPIER — cliquez le point de base :', 'Destination : clic (répété), ou distance en m · Échap pour finir :'],
    rotate: ['PIVOTER — cliquez le centre de rotation :', 'Angle : bougez + clic, ou tapez les degrés :'],
    mirror: ['MIROIR — 1er point de l’axe :', '2e point de l’axe (clic) → crée la copie miroir :'],
    scale: ['ÉCHELLE — point de base (pivot + 1er point de la distance de référence) :', '2e point de la distance de référence (une longueur que vous connaissez) :']
  };
  const PROMPT = {
    select: 'SÉLECTION — cliquez un objet, ou tracez un cadre (→ bleu : englobe · ← vert : capture). Suppr pour effacer.',
    line: 'LIGNE — premier point (ou longueur en m) :', polyline: 'POLYLIGNE — premier point :',
    rect: 'RECTANGLE — premier coin :', dim: 'COTE — survolez un trait à coter :',
    offset: 'DÉCALER — tapez la distance en m, puis survolez un trait :', pan: 'PANORAMIQUE — glissez pour déplacer la vue.',
    hatch: 'HACHURES — survolez une zone fermée et cliquez pour la remplir (motif + couleur dans le ruban).',
    circle: 'CERCLE — cliquez le centre, puis le rayon (ou tapez le rayon en m).',
    trim: 'AJUSTER — cliquez la partie du trait à couper. Maintenez Maj = PROLONGER jusqu’au trait voisin.',
    text: 'TEXTE — cliquez où écrire, tapez le texte, Entrée pour valider (hauteur réglable dans le ruban).',
    scale: 'ÉCHELLE — sélectionnez d’abord les objets, puis lancez la commande.',
    arc: 'ARC — 1er point (départ) :',
    polygon: 'POLYGONE — centre (nombre de côtés réglable dans le ruban) :',
    fillet: 'RACCORD — cliquez le 1er trait (rayon réglable dans le ruban ; 0 = coin net) :',
    stretch: 'ÉTIRER — tracez un cadre de capture (droite→gauche) autour des extrémités à déplacer :',
    matchprop: 'COPIERPROP — cliquez l’objet SOURCE, puis les objets à aligner.',
    dist: 'MESURER — 1er point :',
    area: 'AIRE — 1er point du contour :',
    zoomwin: 'ZOOM FENÊTRE — tracez un cadre sur la zone à agrandir.'
  };
  // Entrée / clic droit / double-clic « vide » : valide l'action en cours, sinon répète la dernière commande (réflexe AutoCAD).
  function acceptOrRepeat() {
    if (tool === 'polyline' && draft.length >= 2) finishPoly();
    else if (tool === 'line' && draft.length) { draft = []; ghost = null; hideDyn(); echo('LIGNE — premier point (ou longueur en m) :'); paint(); }
    else if (tool === 'area' && draft.length >= 3) finishArea();
    else if (tool === 'matchprop' && matchSrc) { matchSrc = null; echo('COPIERPROP terminé.'); }
    else if (tool === 'fillet' && filletFirst) { filletFirst = null; echo('RACCORD — 1er trait :'); }
    else runCommand('');
  }
  function runCommand(rawInput) {
    let tok = (rawInput || '').trim().toUpperCase();
    if (!tok) tok = lastCmd;            // Entrée à vide = répète la dernière commande
    if (!tok) return;
    const c = CMD[tok];
    echo('<span class="echo">Commande : ' + tok + '</span>');
    lastCmd = tok;
    if (typeof c === 'string') setTool(c);
    else if (typeof c === 'function') c();
    else if (SOON.indexOf(tok) >= 0) echo('« ' + tok + ' » — commande à venir dans une prochaine version.');
    else echo('Commande inconnue « ' + tok + ' ».');
  }
  function setTool(t) {
    if (activePage !== 'model') setActivePage('model'); // prendre un outil ramène à l'espace Objet
    offsetTarget = null; op = null; circleCenter = null; opGhost = circlePreview = null;
    filletFirst = null; matchSrc = null; stretchOp = null; arrayPolar = null;
    // Noun-verb (réflexe AutoCAD) : DÉCALER avec un seul trait présélectionné le cible directement.
    if (t === 'offset' && selected.length === 1 && (selected[0].type === 'polyline' || selected[0].type === 'circle')) {
      offsetTarget = selected[0];   // objet présélectionné (ligne, polyligne entière ou cercle)
    }
    // Transformations : exigent une présélection (sélectionne D'ABORD, puis la commande).
    if (['move', 'copy', 'rotate', 'mirror', 'scale'].indexOf(t) >= 0) {
      if (!selected.length) { echo('⚠ Sélectionnez d’abord un ou plusieurs objets, puis relancez ' + t.toUpperCase() + '.'); t = 'select'; }
      else op = { cmd: t, step: 0 };
    }
    tool = t; draft = []; dimHover = dimPreview = ghost = pendingOffset = gripDrag = hotGrip = hatchHover = trimPreview = snapInfo = guide = dimSeg = hoverEnt = null; hideDyn();
    // On vide la sélection seulement pour les outils de dessin (pas sélection/transfo/décaler).
    if (['line', 'polyline', 'rect', 'dim', 'hatch', 'pan', 'circle', 'trim', 'text', 'arc', 'polygon', 'dist', 'area', 'fillet', 'stretch', 'zoomwin'].indexOf(t) >= 0) { selected = []; syncCurrentLayer(); }
    if (t !== 'text') hideTextInput();
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    if (op) echo(OPPROMPT[op.cmd][0]);
    else if (PROMPT[t]) echo(PROMPT[t]);
    if (offsetTarget) echo('→ objet présélectionné ciblé : tapez la distance (m) puis cliquez le côté.');
    paint();
  }
  function echo(html) {
    const d = document.createElement('div'); d.innerHTML = html; cmdhist.appendChild(d);
    while (cmdhist.children.length > 60) cmdhist.removeChild(cmdhist.firstChild);
    cmdhist.scrollTop = cmdhist.scrollHeight;
  }
  cmd.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { const v = cmd.value; cmd.value = ''; runCommand(v); cv.focus(); }
    else if (e.key === 'Escape') { cmd.value = ''; cv.focus(); }
  });

  // ---------- Clavier global ----------
  // Les bascules de repères (F3/F7/F8/F9/F10) fonctionnent TOUJOURS — même en
  // pleine commande ou pendant une saisie. Phase capture = priorité absolue.
  window.addEventListener('keydown', e => {
    const map = { F3: 'osnap', F7: 'grid', F8: 'ortho', F9: 'snap', F10: 'polar' };
    const id = map[e.key]; if (!id) return;
    e.preventDefault(); e.stopPropagation();
    toggle(id, id === 'ortho' || id === 'polar');
  }, true);

  // Maj : bascule Ajuster <-> Prolonger (rafraîchit l'indice à l'écran)
  window.addEventListener('keydown', e => { if (e.key === 'Shift' && !shiftDown) { shiftDown = true; if (tool === 'trim') hoverTrim(null); } }, true);
  window.addEventListener('keyup', e => { if (e.key === 'Shift') { shiftDown = false; if (tool === 'trim') hoverTrim(null); } }, true);

  window.addEventListener('keydown', e => {
    if (document.activeElement === cmd || editing) return;
    const k = e.key;
    if (e.ctrlKey || e.metaKey) {
      const kl = k.toLowerCase();
      if (kl === 'a') { e.preventDefault(); selected = scene.entities.filter(x => layPickable(x.layer)); if (tool !== 'select') setTool('select'); echo(selected.length + ' objet(s) sélectionné(s).'); refreshProps(); syncCurrentLayer(); paint(); return; }
      if (kl === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (kl === 'y') { e.preventDefault(); redo(); return; }
      if (kl === 'c') { e.preventDefault(); copySel(false); return; }
      if (kl === 'x') { e.preventDefault(); copySel(true); return; }
      if (kl === 'v') { e.preventDefault(); paste(); return; }
      if (kl === 's') { e.preventDefault(); saveCurrent(true); return; }
      return; // autres combinaisons Ctrl : ne pas les transformer en commande
    }
    if (k === 'Delete') {
      if (selected.length) { pushHistory(); selected.forEach(en => { const i = scene.entities.indexOf(en); if (i >= 0) scene.entities.splice(i, 1); }); echo(selected.length + ' objet(s) supprimé(s).'); selected = []; refreshProps(); syncCurrentLayer(); paint(); }
      e.preventDefault(); return;
    }
    if (k === 'Escape' && gripDrag) {
      // Aucune mutation n'a eu lieu (aperçu seulement) : on jette juste le fantôme.
      if (history.length) history.pop();
      gripDrag = null; hotGrip = null; opGhost = null; dimPreview = null; dimHover = null; echo('Édition annulée.'); paint(); return;
    }
    // Ligne : Échap termine la chaîne mais RESTE sur l'outil Ligne (prêt pour une nouvelle).
    if (k === 'Escape' && tool === 'line' && draft.length) { draft = []; ghost = null; hideDyn(); echo('LIGNE — premier point (ou longueur en m) :'); paint(); return; }
    // Polyligne : Échap termine (valide) le tracé en UN bloc et reste sur l'outil.
    if (k === 'Escape' && tool === 'polyline' && draft.length) { if (draft.length >= 2) finishPoly(); else { draft = []; ghost = null; hideDyn(); } echo('POLYLIGNE — premier point :'); paint(); return; }
    if (k === 'Escape') { draft = []; ghost = null; selected = []; trimPreview = null; dimSeg = null; boxPending = null; selecting = false; selRect = null; hideTextInput(); hideDyn(); syncCurrentLayer(); echo('*Annulé*'); if (tool !== 'select') setTool('select'); else paint(); return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); acceptOrRepeat(); return; }
    if ((/^[0-9]$/.test(k) || k === '.' || k === ',') && (gripDrag || activePoint() || tool === 'offset' || (op && (op.step === 1 || (op.cmd === 'scale' && op.step === 2))) || (tool === 'circle' && circleCenter) || (tool === 'stretch' && stretchOp && stretchOp.base))) { startEdit(k); e.preventDefault(); return; }
    if (/^[a-zA-Z]$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey) { cmd.focus(); cmd.value += k.toUpperCase(); e.preventDefault(); } // taper = ligne de commande
  });

  // ---------- Zoom ----------
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    if (activePage !== 'model') return;
    const r = cv.getBoundingClientRect();
    const b = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
    view.pxPerMm = Math.max(0.00002, Math.min(80, view.pxPerMm * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const a = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
    view.panXmm += b.x - a.x; view.panYmm += b.y - a.y; requestPaint();
  }, { passive: false });

  // ---------- Boutons ----------
  document.querySelectorAll('[data-cmd]').forEach(b => {
    if (b.classList.contains('soon')) return;
    b.addEventListener('click', () => { runCommand(b.dataset.cmd); cv.focus(); });
  });
  function toggle(id, exclusive) {
    const el = $(id), now = !el.classList.contains('active');
    el.classList.toggle('active', now);
    if (exclusive && now) $(id === 'ortho' ? 'polar' : 'ortho').classList.remove('active');
    paint();
  }
  ['osnap', 'osnapnear', 'grid', 'snap', 'ortho', 'polar'].forEach(id => { const el = $(id); if (el) el.addEventListener('click', () => toggle(id, false)); });
  { const el = $('lwt'); if (el) el.addEventListener('click', () => { el.classList.toggle('active'); R.lwtOn = el.classList.contains('active'); paint(); }); }
  { const el = $('menuBtn'); if (el) el.addEventListener('click', () => toggleMenuiseries()); }
  $('scale').addEventListener('change', () => { $('scaleLbl').textContent = '1:' + scaleDenom(); });
  (function initLayerDropdown() {
    const dd = $('ldd'); if (!dd) return;
    const cur = $('ldd-cur'), list = $('ldd-list');
    cur.addEventListener('click', ev => {
      ev.stopPropagation();
      const open = !dd.classList.contains('open');
      dd.classList.toggle('open', open);
      if (open) { renderLayerSelect(); const r = cur.getBoundingClientRect(); list.style.left = Math.min(r.left, window.innerWidth - 260) + 'px'; list.style.top = (r.bottom + 3) + 'px'; list.style.minWidth = Math.max(r.width, 240) + 'px'; }
    });
    document.addEventListener('click', e => { if (dd.classList.contains('open') && !list.contains(e.target) && e.target !== cur && !cur.contains(e.target)) dd.classList.remove('open'); });
  })();
  { const ds = $('dimsize'); if (ds) ds.addEventListener('change', () => { currentDimSize = parseFloat(ds.value); }); }
  { const ts = $('txtsize'); if (ts) ts.addEventListener('change', () => { currentTextH = parseFloat(ts.value); }); }
  { const ps = $('polysides'); if (ps) ps.addEventListener('change', () => { polySides = parseInt(ps.value, 10) || 4; if (tool !== 'polygon') setTool('polygon'); cv.focus(); }); }
  { const fr = $('filletr'); if (fr) fr.addEventListener('change', () => { filletRadius = parseFloat(fr.value) || 0; if (tool !== 'fillet') setTool('fillet'); cv.focus(); }); }
  { const ob = $('optionsBtn'); if (ob) ob.addEventListener('click', toggleOptions); }
  $('exportBtn').addEventListener('click', () => { if (activePage !== 'model') printPage(); else plot(); });
  // Barre d'outils de page (présentations)
  { const el = $('pgScale'); if (el) el.addEventListener('change', () => { const p = pages.find(x => x.id === activePage); if (p) { p.scaleDenom = parseInt(el.value, 10); centerPage(); } }); }
  { const el = $('pgPaper'); if (el) el.addEventListener('change', () => { const p = pages.find(x => x.id === activePage); if (p) { p.paper = el.value; centerPage(); } }); }
  { const el = $('pgOrient'); if (el) el.addEventListener('change', () => { const p = pages.find(x => x.id === activePage); if (p) { p.orientation = el.value; centerPage(); } }); }
  { const el = $('pgFit'); if (el) el.addEventListener('click', fitPageScale); }
  { const el = $('pgCenter'); if (el) el.addEventListener('click', centerPage); }
  { const el = $('pgPrint'); if (el) el.addEventListener('click', printPage); }
  { const el = $('pgFields'); if (el) el.addEventListener('click', editLayoutFields); }
  { const el = $('pgLayoutScale'); if (el) el.addEventListener('change', () => { const p = pages.find(x => x.id === activePage); if (p && p.template) { const sc = parseInt(el.value, 10) || 500; p.scaleDenom = sc; p.layoutData = p.layoutData || {}; p.layoutData.scaleDenom = sc; if (/^DP\d* 1-\d+$/.test(p.name)) { p.name = p.name.replace(/1-\d+$/, '1-' + sc); renderPageTabs(); } paintPage(); echo('Échelle de la mise en page : 1:' + sc + ' (échelle graphique mise à jour).'); } }); }
  { const el = $('pgRename'); if (el) el.addEventListener('click', renamePage); }
  { const el = $('pgDelete'); if (el) el.addEventListener('click', deletePage); }
  // Menu déroulant visuel des motifs de hachures (vignette + nom)
  (function () {
    const dd = $('hdd'); if (!dd) return;
    const cur = $('hdd-cur'), list = dd.querySelector('.hdd-list'), names = { solid: 'Pleine', lines: 'Lignes', cross: 'Croisées', tiles: 'Tuiles' };
    cur.addEventListener('click', ev => {
      ev.stopPropagation();
      const open = !dd.classList.contains('open');
      dd.classList.toggle('open', open);
      if (open) { const r = cur.getBoundingClientRect(); list.style.left = r.left + 'px'; list.style.top = (r.bottom + 3) + 'px'; list.style.width = Math.max(r.width, 170) + 'px'; }
    });
    document.addEventListener('click', () => dd.classList.remove('open'));
    dd.querySelectorAll('.hdd-opt').forEach(opt => opt.addEventListener('click', ev => {
      ev.stopPropagation(); hatchPattern = opt.dataset.pat;
      dd.querySelectorAll('.hdd-opt').forEach(o => o.classList.toggle('sel', o === opt));
      cur.querySelector('.sw').className = 'sw sw-' + hatchPattern;
      cur.querySelector('.nm').textContent = names[hatchPattern] || hatchPattern;
      dd.classList.remove('open'); setTool('hatch'); cv.focus();
    }));
  })();
  { const el = $('hspace'); if (el) el.addEventListener('change', () => { hatchSpacing = parseFloat(el.value); if (tool === 'hatch') hoverHatch(); }); }
  { const el = $('hcolor'); if (el) el.addEventListener('change', () => { if (tool !== 'hatch') setTool('hatch'); cv.focus(); }); }

  // ---------- Annuler / Rétablir (Ctrl+Z / Ctrl+Y) ----------
  // Clone des entités en PRÉSERVANT les références de points partagées (une cote
  // posée sur un trait partage ses sommets -> on garde l'associativité intacte).
  function refClone(entities) {
    const pmap = new Map();
    const mapPt = p => { let q = pmap.get(p); if (!q) { q = { x: p.x, y: p.y }; pmap.set(p, q); } return q; };
    return entities.map(e => { const c = Object.assign({}, e); c.points = e.points.map(mapPt); if (e.center) c.center = mapPt(e.center); return c; });
  }
  // Historique LÉGER (deltas) : on mémorise la LISTE des entités (références, ~1 Mo)
  // pour défaire ajouts/suppressions, et on ne CLONE que les entités réellement
  // modifiées sur place (poignées, déplacement, propriétés). Indispensable avec
  // 100k+ entités : sinon cloner tout le plan à chaque action fait exploser la mémoire.
  function snapEnt(e) {
    const d = {}; for (const k in e) { if (k === 'points' || k === 'center' || k === '_bb') continue; d[k] = e[k]; }
    return { ent: e, data: d, pts: e.points ? e.points.map(p => ({ x: p.x, y: p.y })) : null, center: e.center ? { x: e.center.x, y: e.center.y } : null };
  }
  function restoreEnt(m) {
    const e = m.ent;
    for (const k in e) { if (k === 'points' || k === 'center' || k === '_bb') continue; if (!(k in m.data)) delete e[k]; }
    for (const k in m.data) e[k] = m.data[k];
    if (m.pts && e.points) for (let i = 0; i < m.pts.length && i < e.points.length; i++) { e.points[i].x = m.pts[i].x; e.points[i].y = m.pts[i].y; }
    if (m.center && e.center) { e.center.x = m.center.x; e.center.y = m.center.y; }
    e._bb = null;
  }
  function captureState(mutEnts) { return { list: scene.entities.slice(), muts: (mutEnts || []).map(snapEnt) }; }
  function applyState(h) { scene.entities = h.list.slice(); h.muts.forEach(restoreEnt); markSceneDirty(); }
  function pushHistory(mutEnts) { history.push(captureState(mutEnts)); if (history.length > 60) history.shift(); redoStack.length = 0; markSceneDirty(); }
  function resetTransient() { selected = []; draft = []; gripDrag = hotGrip = null; op = null; opGhost = null; ghost = null; trimPreview = null; snapInfo = null; guide = null; dimHover = dimPreview = null; boxPending = null; selecting = false; selRect = null; hideDyn(); syncCurrentLayer(); }
  function undo() {
    if (!history.length) { echo('Rien à annuler.'); return; }
    const mutEnts = history[history.length - 1].muts.map(m => m.ent);
    redoStack.push(captureState(mutEnts));
    applyState(history.pop()); resetTransient();
    echo('↶ Annulé.'); refreshProps(); paint();
  }
  function redo() {
    if (!redoStack.length) { echo('Rien à rétablir.'); return; }
    const mutEnts = redoStack[redoStack.length - 1].muts.map(m => m.ent);
    history.push(captureState(mutEnts));
    applyState(redoStack.pop()); resetTransient();
    echo('↷ Rétabli.'); refreshProps(); paint();
  }
  function clearAll() { pushHistory(); scene.entities.length = 0; selected = []; draft = []; syncCurrentLayer(); echo('Dessin effacé.'); paint(); }
  function eraseSel() {
    if (!selected.length) { echo('Rien de sélectionné — sélectionnez d’abord des objets.'); return; }
    pushHistory();
    selected.forEach(en => { const i = scene.entities.indexOf(en); if (i >= 0) scene.entities.splice(i, 1); });
    echo(selected.length + ' objet(s) supprimé(s).'); selected = []; refreshProps(); syncCurrentLayer(); paint();
  }

  // ---------- Presse-papiers (Ctrl+C / Ctrl+X / Ctrl+V) ----------
  let clipboard = null;
  function copySel(cut) {
    if (!selected.length) { echo('Rien à ' + (cut ? 'couper' : 'copier') + ' — sélectionnez d’abord.'); return; }
    const ents = refClone(selected);
    let minx = Infinity, miny = Infinity;
    ents.forEach(e => e.points.forEach(p => { if (p.x < minx) minx = p.x; if (p.y < miny) miny = p.y; }));
    clipboard = { ents, base: { x: minx, y: miny } };
    if (cut) { pushHistory(); selected.forEach(en => { const i = scene.entities.indexOf(en); if (i >= 0) scene.entities.splice(i, 1); }); selected = []; echo('✂️ ' + ents.length + ' objet(s) coupé(s).'); refreshProps(); paint(); }
    else echo('⧉ ' + ents.length + ' objet(s) copié(s) — Ctrl+V pour coller.');
  }
  function paste() {
    if (!clipboard || !clipboard.ents.length) { echo('Presse-papiers vide.'); return; }
    pushHistory();
    const tx = (overCanvas ? rawCursor.x : clipboard.base.x + 500) - clipboard.base.x;
    const ty = (overCanvas ? rawCursor.y : clipboard.base.y - 500) - clipboard.base.y;
    const fresh = refClone(clipboard.ents);
    fresh.forEach(e => { e.points.forEach(p => { p.x += tx; p.y += ty; }); if (e.center) { e.center.x += tx; e.center.y += ty; } scene.entities.push(e); });
    selected = fresh; if (tool !== 'select') setTool('select');
    echo('📋 ' + fresh.length + ' objet(s) collé(s)' + (overCanvas ? ' au curseur' : '') + '.'); refreshProps(); paint();
  }
  function fit() {
    const b = G.bounds(scene);
    if (!b.w && !b.h) { view.pxPerMm = 0.05; view.panXmm = -3000; view.panYmm = -3000; return paint(); }
    const pad = Math.max(b.w, b.h) * 0.15 + 800;
    view.pxPerMm = Math.min(view.canvasW / (b.w + 2 * pad), view.canvasH / (b.h + 2 * pad));
    view.panXmm = b.minX - pad; view.panYmm = b.minY - pad; paint();
  }
  function plot() {
    const vs = visibleScene();
    if (!vs.entities.length) { echo('Rien à imprimer (dessin vide ou calques masqués).'); return; }
    const doc = QCAD.exportPdf(vs, { scaleDenom: scaleDenom(), paper: $('paper').value, orientation: $('orient').value, title: 'QlygoCAD' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([doc.toBytes()], { type: 'application/pdf' }));
    a.download = 'qlygocad_1-' + scaleDenom() + '.pdf'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    echo('PDF exporté à l’échelle 1:' + scaleDenom() + ' (' + $('paper').value + ').');
  }

  // ---------- Gestionnaire de calques ----------
  function sortedLayers() { return scene.layers.slice().sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })); }
  // Menu déroulant Calque : chaque ligne porte l'ŒIL (afficher/masquer), le GEL et le
  // VERROU — plus besoin d'ouvrir le gestionnaire à côté. Tri alphabétique.
  function renderLayerSelect() {
    updateLayerButton();
    const list = $('ldd-list'); if (!list) return;
    list.innerHTML = '';
    sortedLayers().forEach(l => {
      const row = document.createElement('div'); row.className = 'ldd-row' + (l.id === currentLayer ? ' cur' : '');
      row.innerHTML =
        '<span class="sw" style="background:' + l.color + '"></span>' +
        '<span class="nm">' + escHtml(l.name) + '</span>' +
        '<button class="ldd-t" data-k="visible" title="Afficher / Masquer">' + (l.visible ? '👁️' : '🙈') + '</button>' +
        '<button class="ldd-t" data-k="frozen" title="Geler / Dégeler">' + (l.frozen ? '❄️' : '·') + '</button>' +
        '<button class="ldd-t" data-k="locked" title="Verrouiller / Déverrouiller">' + (l.locked ? '🔒' : '🔓') + '</button>';
      const choose = ev => { ev.stopPropagation(); pickLayer(l.id); closeLayerDropdown(); };
      row.querySelector('.nm').onclick = choose; row.querySelector('.sw').onclick = choose;
      row.querySelectorAll('.ldd-t').forEach(btn => btn.onclick = ev => {
        ev.stopPropagation();
        l[btn.dataset.k] = !l[btn.dataset.k];
        selected = selected.filter(e2 => layPickable(e2.layer));
        echo('Calque « ' + l.name + ' » : ' + (l.visible ? 'visible ' : 'masqué ') + (l.frozen ? 'gelé ' : '') + (l.locked ? 'verrouillé' : ''));
        refreshLayers(); refreshProps(); syncCurrentLayer(); paint();
      });
      list.appendChild(row);
    });
  }
  // Choix explicite d'un calque : s'il y a une sélection, on déplace les objets dessus ;
  // sinon il devient le calque de travail (baseLayer).
  function pickLayer(id) {
    if (!scene.layers.some(l => l.id === id)) return;
    if (selected.length) {
      pushHistory(selected);
      // BYLAYER : en changeant de calque, le trait adopte la COULEUR et l'ÉPAISSEUR
      // du nouveau calque (on efface sa couleur/épaisseur propres). On garde la teinte
      // d'une hachure (zone remplie) pour ne pas détruire un aplat de couleur.
      selected.forEach(e => { e.layer = id; if (e.type !== 'hatch') e.color = null; e.penMm = null; e._bb = null; });
      echo(selected.length + ' objet(s) sur « ' + layerById(id).name + ' » — couleur + épaisseur du calque adoptées.'); refreshProps();
    } else { baseLayer = id; }
    currentLayer = id; $('color').value = layerById(id).color; updateSwatch('color');
    renderLayerSelect(); paint();
  }
  function closeLayerDropdown() { const dd = $('ldd'); if (dd) dd.classList.remove('open'); }
  function renderLayersPanel() {
    const box = $('layers'); if (!box || box.style.display === 'none' || box.style.display === '') return;
    // mémorise la position de défilement pour ne pas « sauter » au re-rendu
    const prev = box.querySelector('.lp-list'); const scrollY = prev ? prev.scrollTop : 0;
    box.innerHTML = '<div class="lp-head"><b>Calques</b><span style="flex:1"></span>' +
      '<button id="lp-add" title="Nouveau calque">＋</button><button id="lp-close" title="Fermer">✕</button></div>';
    const list = document.createElement('div'); list.className = 'lp-list'; box.appendChild(list);
    // MÊME ordre que le menu déroulant (alphabétique) -> les deux listes sont identiques.
    sortedLayers().forEach(l => {
      const row = document.createElement('div'); row.className = 'lp-row' + (l.id === currentLayer ? ' cur' : '');
      row.innerHTML =
        '<button class="lp-cur" title="Définir courant">' + (l.id === currentLayer ? '●' : '○') + '</button>' +
        '<input type="color" class="lp-sw" value="' + l.color + '" title="Couleur du calque">' +
        '<span class="lp-name">' + l.name + '</span>' +
        '<button class="lp-t" data-k="visible" title="Afficher / Masquer">' + (l.visible ? '👁️' : '🙈') + '</button>' +
        '<button class="lp-t" data-k="frozen" title="Geler / Dégeler">' + (l.frozen ? '❄️' : '·') + '</button>' +
        '<button class="lp-t" data-k="locked" title="Verrouiller / Déverrouiller">' + (l.locked ? '🔒' : '🔓') + '</button>' +
        '<select class="lp-pen" title="Épaisseur du calque">' + [0.18, 0.25, 0.35, 0.5, 0.7, 1].map(v => '<option value="' + v + '"' + (Math.abs((l.penMm != null ? l.penMm : 0.25) - v) < 1e-6 ? ' selected' : '') + '>' + String(v).replace('.', ',') + '</option>').join('') + '</select>';
      row.querySelector('.lp-cur').onclick = () => { baseLayer = l.id; syncCurrentLayer(); refreshLayers(); paint(); };
      const pen = row.querySelector('.lp-pen'); if (pen) pen.onchange = ev => { l.penMm = parseFloat(ev.target.value); refreshLayers(); paint(); };
      row.querySelectorAll('.lp-t').forEach(btn => btn.onclick = () => {
        l[btn.dataset.k] = !l[btn.dataset.k];
        selected = selected.filter(e => layPickable(e.layer));   // désélectionne ce qui devient non modifiable
        echo('Calque « ' + l.name + ' » : ' + (l.visible ? '' : 'masqué ') + (l.frozen ? 'gelé ' : '') + (l.locked ? 'verrouillé' : '') || 'mis à jour');
        refreshLayers(); paint();
      });
      const sw = row.querySelector('.lp-sw');
      if (sw) {
        // Couleur en DIRECT : on repeint pendant qu'on glisse dans le sélecteur,
        // et on rafraîchit la liste à la validation (sans perdre le défilement).
        sw.oninput = ev => { l.color = ev.target.value; cacheDirty = true; paint(); };
        sw.onchange = ev => {
          l.color = ev.target.value;
          // Les traits de CE calque suivent la couleur du calque (BYLAYER). C'est ce
          // qui fait que les menuiseries « blanches » reprennent la couleur choisie.
          let n = 0; scene.entities.forEach(e => { if (e.layer === l.id && e.type !== 'hatch' && e.color != null) { e.color = null; n++; } });
          cacheDirty = true; refreshLayers(); paint();
          echo('Calque « ' + l.name + ' » : couleur ' + l.color + (n ? ' (' + n + ' trait(s) alignés)' : '') + '.');
        };
      }
      list.appendChild(row);
    });
    list.scrollTop = scrollY;
    $('lp-add').onclick = addLayer; $('lp-close').onclick = toggleLayersPanel;
  }
  function refreshLayers() { renderLayerSelect(); renderLayersPanel(); }
  function toggleLayersPanel() { const box = $('layers'); if (!box) return; box.style.display = (box.style.display === 'flex') ? 'none' : 'flex'; refreshLayers(); }
  function addLayer() {
    const id = 'calque-' + Date.now();
    scene.layers.push({ id, name: 'Calque ' + scene.layers.length, color: '#9fb0d0', penMm: 0.25, visible: true, locked: false, frozen: false });
    baseLayer = currentLayer = id; refreshLayers(); paint();
  }

  // ---------- Paramètres d'affichage (couleurs, réticule) ----------
  function loadSettings() { try { const s = JSON.parse(localStorage.getItem('qlygocad.settings') || 'null'); return Object.assign({}, SETTINGS_DEFAULTS, s || {}); } catch (e) { return Object.assign({}, SETTINGS_DEFAULTS); } }
  function saveSettings() { try { localStorage.setItem('qlygocad.settings', JSON.stringify(settings)); } catch (e) { } }
  function hx(h) { h = (h || '#000000').replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function toHex(r, g, b) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
  function mixHex(a, b, t) { const A = hx(a), B = hx(b); return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }
  function theme() {
    return {
      bg: settings.bg, gridMajor: settings.grid, gridMinor: mixHex(settings.grid, settings.bg, 0.55),
      axisX: settings.axisX, axisY: settings.axisY,
      axisXLine: mixHex(settings.axisX, settings.bg, 0.62), axisYLine: mixHex(settings.axisY, settings.bg, 0.62)
    };
  }
  function toggleOptions() { const box = $('options'); if (!box) return; box.style.display = box.style.display === 'block' ? 'none' : 'block'; if (box.style.display === 'block') renderOptions(); }
  function renderOptions() {
    const box = $('options'); if (!box) return;
    box.innerHTML = '<div class="lp-head"><b>⚙️ Paramètres d’affichage</b><span style="flex:1"></span>' +
      '<button id="op-reset" title="Réinitialiser (défaut QLYGO)">↺</button><button id="op-close" title="Fermer">✕</button></div>';
    const rows = [
      ['bg', 'Couleur de fond', 'color'], ['grid', 'Couleur de la grille', 'color'],
      ['axisX', 'Couleur de l’axe X', 'color'], ['axisY', 'Couleur de l’axe Y', 'color'],
      ['crosshairColor', 'Couleur du réticule (curseur)', 'color'], ['crosshairSize', 'Taille du réticule', 'size'],
      ['pickbox', 'Afficher le carré de sélection', 'bool']
    ];
    rows.forEach(([key, label, type]) => {
      const row = document.createElement('div'); row.className = 'op-row';
      let ctrl;
      if (type === 'color') ctrl = '<input type="color" data-k="' + key + '" value="' + settings[key] + '">';
      else if (type === 'size') ctrl = '<select data-k="' + key + '"><option value="small">Petit</option><option value="medium">Moyen</option><option value="large">Grand</option><option value="full">Plein écran</option></select>';
      else ctrl = '<input type="checkbox" data-k="' + key + '"' + (settings[key] ? ' checked' : '') + '>';
      row.innerHTML = '<span class="op-name">' + label + '</span>' + ctrl;
      box.appendChild(row);
    });
    const sel = box.querySelector('select[data-k="crosshairSize"]'); if (sel) sel.value = settings.crosshairSize;
    box.querySelectorAll('[data-k]').forEach(el => {
      const k = el.dataset.k;
      const handler = () => { settings[k] = (el.type === 'checkbox') ? el.checked : el.value; saveSettings(); paint(); };
      el.addEventListener('input', handler); el.addEventListener('change', handler);
    });
    $('op-close').onclick = toggleOptions;
    $('op-reset').onclick = () => { settings = Object.assign({}, SETTINGS_DEFAULTS); saveSettings(); renderOptions(); paint(); };
  }

  // ---------- Propriétés par objet (couleur, épaisseur, type de trait, calque) ----------
  function toggleProps() { const b = $('props'); if (!b) return; b.style.display = b.style.display === 'block' ? 'none' : 'block'; renderProps(); }
  function refreshProps() { const b = $('props'); if (b && b.style.display === 'block') renderProps(); }
  function renderProps() {
    const b = $('props'); if (!b || b.style.display !== 'block') return;
    b.innerHTML = '<div class="lp-head"><b>📝 Propriétés</b><span style="flex:1"></span><button id="pr-close" title="Fermer">✕</button></div>';
    if (!selected.length) {
      const d = document.createElement('div'); d.className = 'op-row'; d.innerHTML = '<span class="op-name">Sélectionne un ou plusieurs objets pour les retravailler…</span>';
      b.appendChild(d); $('pr-close').onclick = toggleProps; return;
    }
    const e0 = selected[0];
    const info = document.createElement('div'); info.className = 'op-row'; info.innerHTML = '<span class="op-name" style="color:var(--primary)">' + selected.length + ' objet(s) sélectionné(s)</span>';
    b.appendChild(info);
    const isDim = e0.type === 'dim', isText = e0.type === 'text', isHatch = e0.type === 'hatch';
    const numKeys = { penMm: 1, textMm: 1, hMm: 1, angleDeg: 1, dec: 1 };
    const rows = [
      ['layer', 'Calque', '<select data-pk="layer">' + scene.layers.map(l => '<option value="' + l.id + '"' + (l.id === e0.layer ? ' selected' : '') + '>' + l.name + '</option>').join('') + '</select>'],
      ['color', 'Couleur' + (e0.color == null ? ' (du calque)' : ''), '<input type="color" data-pk="color" value="' + (e0.color || layerById(e0.layer).color || (isDim ? '#b9375e' : '#1b2b4b')) + '">']
    ];
    if (!isDim && !isText && !isHatch) {
      const effPen = e0.penMm != null ? e0.penMm : (layerById(e0.layer).penMm != null ? layerById(e0.layer).penMm : 0.25);
      rows.push(['penMm', 'Épaisseur' + (e0.penMm == null ? ' (du calque)' : ''), '<select data-pk="penMm">' + [0.18, 0.25, 0.35, 0.5, 0.7, 1].map(v => '<option value="' + v + '"' + (Math.abs(effPen - v) < 1e-6 ? ' selected' : '') + '>' + String(v).replace('.', ',') + ' mm</option>').join('') + '</select>']);
      rows.push(['dash', 'Type de trait', '<select data-pk="dash">' + [['solid', '——— continu'], ['dashed', '– – – tirets'], ['dotted', '· · · · pointillés'], ['dashdot', '–·–·– mixte']].map(a => '<option value="' + a[0] + '"' + (((e0.dash || 'solid') === a[0]) ? ' selected' : '') + '>' + a[1] + '</option>').join('') + '</select>']);
    }
    if (isDim) {
      rows.push(['arrow', 'Extrémités', '<select data-pk="arrow"><option value="arrow"' + (((e0.arrow || 'arrow') === 'arrow') ? ' selected' : '') + '>➤ flèches</option><option value="tick"' + (e0.arrow === 'tick' ? ' selected' : '') + '>╱ obliques</option></select>']);
      rows.push(['textMm', 'Taille du texte', '<select data-pk="textMm">' + [2, 2.5, 3.5, 5].map(v => '<option value="' + v + '"' + (Math.abs((e0.textMm || 2.5) - v) < 1e-6 ? ' selected' : '') + '>' + String(v).replace('.', ',') + ' mm</option>').join('') + '</select>']);
      rows.push(['dec', 'Décimales', '<select data-pk="dec">' + [0, 1, 2, 3].map(v => '<option value="' + v + '"' + (((e0.dec != null ? e0.dec : 2) === v) ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>']);
    }
    if (isText) {
      rows.push(['text', 'Contenu', '<input type="text" data-pk="text" value="' + escHtml(e0.text || '') + '" style="width:150px">']);
      rows.push(['hMm', 'Hauteur', '<select data-pk="hMm">' + [300, 500, 800, 1000, 2000].map(v => '<option value="' + v + '"' + (Math.abs((e0.hMm || 800) - v) < 1e-6 ? ' selected' : '') + '>' + (v / 1000).toFixed(2).replace('.', ',') + ' m</option>').join('') + '</select>']);
      const fonts = [['system-ui,Segoe UI,sans-serif', 'Standard'], ['Arial,Helvetica,sans-serif', 'Arial'], ["'Times New Roman',Georgia,serif", 'Times'], ["'Courier New',monospace", 'Courier'], ['Georgia,serif', 'Georgia'], ["'Trebuchet MS',sans-serif", 'Trebuchet']];
      rows.push(['font', 'Police', '<select data-pk="font">' + fonts.map(f => '<option value="' + escHtml(f[0]) + '"' + (((e0.font || fonts[0][0]) === f[0]) ? ' selected' : '') + '>' + f[1] + '</option>').join('') + '</select>']);
      rows.push(['angleDeg', 'Angle (°)', '<input type="number" data-pk="angleDeg" value="' + (e0.angleDeg || 0) + '" step="5" style="width:72px">']);
    }
    rows.forEach(r => { const d = document.createElement('div'); d.className = 'op-row'; d.innerHTML = '<span class="op-name">' + r[1] + '</span>' + r[2]; b.appendChild(d); });
    b.querySelectorAll('[data-pk]').forEach(el => el.addEventListener('change', () => {
      const k = el.dataset.pk; let v = el.value; if (numKeys[k]) v = parseFloat(v);
      pushHistory(selected);
      selected.forEach(e => {
        if (k === 'dash') { if (v === 'solid') delete e.dash; else e.dash = v; }
        else if (k === 'arrow') { if (v === 'arrow') delete e.arrow; else e.arrow = v; }
        else if (k === 'layer') { e.layer = v; if (e.type !== 'hatch') e.color = null; e.penMm = null; }  // BYLAYER : couleur+épaisseur du calque
        else e[k] = v;
        e._bb = null;
      });
      echo('Propriétés appliquées à ' + selected.length + ' objet(s).'); renderProps(); if (k === 'layer' || k === 'color') { refreshLayers(); syncCurrentLayer(); } paint();
    }));
    $('pr-close').onclick = toggleProps;
  }

  // ---------- utilitaires ----------
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function angleDeg(a, b) { return (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 360) % 360; }
  function sideOf(pt, seg) { const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y; return ((pt.x - seg.a.x) * -dy + (pt.y - seg.a.y) * dx) >= 0 ? 1 : -1; }
  function frType(t) { return { end: 'extrémité', mid: 'milieu', center: 'centre', quadrant: 'quadrant', inter: 'intersection', perp: 'perpendic.', near: 'proche de', grid: 'grille' }[t] || t; }

  // ---------- Pages / Présentations (Objet -> DP02, DP04…) ----------
  function mapColor(hex) { if (!hex) return '#111111'; const c = hx(hex); const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; return lum > 0.82 ? '#111111' : hex; }
  function paperMm(page) { const pp = U.PAPER[page.paper] || U.PAPER.A4; return page.orientation === 'landscape' ? { w: pp.h, h: pp.w } : { w: pp.w, h: pp.h }; }
  function pageLayout(page) {
    const paper = paperMm(page), margin = 10, pad = 46;
    const ppmPaper = Math.min((view.canvasW - 2 * pad) / paper.w, (view.canvasH - 2 * pad) / paper.h);
    const sheetW = paper.w * ppmPaper, sheetH = paper.h * ppmPaper;
    const Sx0 = (view.canvasW - sheetW) / 2, Sy0 = (view.canvasH - sheetH) / 2, Sy1 = Sy0 + sheetH;
    const ppm = ppmPaper / page.scaleDenom;
    const panX = page.offX - (Sx0 + margin * ppmPaper) / ppm;
    const panY = page.offY + (Sy1 - margin * ppmPaper - view.canvasH) / ppm;
    const pageView = { pxPerMm: ppm, panXmm: panX, panYmm: panY, canvasW: view.canvasW, canvasH: view.canvasH };
    return { paper, margin, ppmPaper, sheetW, sheetH, Sx0, Sy0, Sy1, ppm, pageView };
  }
  // ---------- Viewports (plan cadré dans les zones blanches d'une mise en page) ----------
  // Chaque zone blanche du cartouche devient une « fenêtre » qui montre une région de
  // l'espace Objet à l'échelle de la page. L'utilisateur la positionne en glissant dedans.
  // Centre « utile » du dessin = MÉDIANE des centres d'entités visibles. Robuste aux
  // points parasites très éloignés (la bbox du plan peut faire plusieurs km à cause
  // d'eux ; sa moitié tomberait dans le vide). La médiane vise le gros du dessin.
  function modelFocus() {
    const xs = [], ys = [];
    for (const e of scene.entities) { const l = layerById(e.layer); if (!l || !l.visible || l.frozen) continue; const b = R._bbox(e); if (b[0] < -1e16) continue; xs.push((b[0] + b[2]) / 2); ys.push((b[1] + b[3]) / 2); }
    if (!xs.length) return { cx: 0, cy: 0 };
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    return { cx: xs[xs.length >> 1], cy: ys[ys.length >> 1] };
  }
  function ensureViewports(page, tpl) {
    const wins = (tpl && tpl.planWindows) || [];
    page.layoutData = page.layoutData || {};
    let vps = page.layoutData.viewports; if (!Array.isArray(vps)) vps = page.layoutData.viewports = [];
    if (vps.length !== wins.length || vps.some(v => !v || !isFinite(v.cx))) {
      const f = modelFocus();
      for (let i = 0; i < wins.length; i++) if (!vps[i] || !isFinite(vps[i].cx)) vps[i] = { cx: f.cx, cy: f.cy };
      vps.length = wins.length;
    }
    return vps;
  }
  // Vue (repère monde->écran) d'un viewport : échelle de la page, centrée sur (cx,cy).
  function vpView(page, Sx0, Sy0, ppmPaper, canvasH, w, vp) {
    const sd = (vp && vp.sd) || page.scaleDenom || 500;
    const ppmView = ppmPaper / sd;
    const winCxS = Sx0 + (w.x + w.w / 2) * ppmPaper, winCyS = Sy0 + (w.y + w.h / 2) * ppmPaper;
    return { pxPerMm: ppmView, panXmm: vp.cx - winCxS / ppmView, panYmm: vp.cy + (winCyS - canvasH) / ppmView, canvasW: 0, canvasH };
  }
  // Dessine la géométrie Objet visible dans le rectangle écran `clip` (fond blanc).
  function drawModelRegion(ctx, vw, clip) {
    ctx.save(); ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
    const a = R.screenToWorld(vw, clip.x, clip.y + clip.h), b = R.screenToWorld(vw, clip.x + clip.w, clip.y);
    const mx0 = Math.min(a.x, b.x), my0 = Math.min(a.y, b.y), mx1 = Math.max(a.x, b.x), my1 = Math.max(a.y, b.y);
    const pad = Math.max(1, (mx1 - mx0) * 0.03);
    const cand = queryIndex(mx0 - pad, my0 - pad, mx1 + pad, my1 + pad);
    const m = {}; for (const l of scene.layers) m[l.id] = l.visible && !l.frozen;
    const lc = id => layerById(id).color, lp = id => { const l = layerById(id); return l.penMm != null ? l.penMm : 0.25; };
    const vis = e => { const bb = R._bbox(e); return !(bb[2] < mx0 || bb[0] > mx1 || bb[3] < my0 || bb[1] > my1); };
    for (const e of cand) if (e.type === 'image' && m[e.layer] && vis(e)) R.drawImage(ctx, vw, e);
    for (const e of cand) if (e.type === 'hatch' && m[e.layer] && vis(e)) R.drawHatch(ctx, vw, e, mapColor(e.color || lc(e.layer)));
    const grp = new Map(), dims = [], txts = [];
    for (const e of cand) {
      const t = e.type; if (t === 'hatch' || t === 'image') continue; if (!m[e.layer] || !vis(e)) continue;
      if (t === 'dim') { dims.push(e); continue; } if (t === 'text') { txts.push(e); continue; }
      if (e.dash) { R.drawEntity(ctx, vw, e, mapColor(e.color || lc(e.layer)), lp(e.layer)); continue; }
      const col = mapColor(e.color || lc(e.layer)), ww = Math.max(0.5, (e.penMm != null ? e.penMm : lp(e.layer)) * 1.2), key = col + '|' + ww;
      let g = grp.get(key); if (!g) { g = { col, w: ww, list: [] }; grp.set(key, g); } g.list.push(e);
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
    for (const g of grp.values()) { ctx.strokeStyle = g.col; ctx.lineWidth = g.w; ctx.beginPath(); for (const e of g.list) { const p = e.points; if (!p.length) continue; let s = R.worldToScreen(vw, p[0].x, p[0].y); ctx.moveTo(s.x, s.y); for (let i = 1; i < p.length; i++) { s = R.worldToScreen(vw, p[i].x, p[i].y); ctx.lineTo(s.x, s.y); } if (e.closed) ctx.closePath(); } ctx.stroke(); }
    for (const e of dims) R.drawDim(ctx, vw, e, false, mapColor(e.color || lc(e.layer)));
    for (const e of txts) R.drawText(ctx, vw, e, mapColor(e.color || lc(e.layer)));
    ctx.restore();
  }
  // Dessine une page-gabarit complète (cartouche + plans cadrés) dans un repère papier
  // donné. Utilisé À L'ÉCRAN (paintPage) ET à l'IMPRESSION -> rendu identique (WYSIWYG).
  function drawTemplatePage(ctx, page, Sx0, Sy0, ppmPaper, canvasH, highlightVp) {
    const tpl = QCAD.layouts[page.template]; if (!tpl) return;
    const T = (xmm, ymm) => ({ x: Sx0 + xmm * ppmPaper, y: Sy0 + ymm * ppmPaper });
    // 1) cartouche (bandeaux, titres, échelles, logos…) ; zones de plan laissées blanches
    QCAD.layouts[page.template].draw(ctx, T, ppmPaper, page.layoutData, paintPage);
    // 2) plans cadrés dans chaque zone blanche
    const wins = tpl.planWindows || [], vps = ensureViewports(page, tpl);
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i], vp = vps[i], a = T(w.x, w.y), c = T(w.x + w.w, w.y + w.h);
      const clip = { x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y };
      drawModelRegion(ctx, vpView(page, Sx0, Sy0, ppmPaper, canvasH, w, vp), clip);
      ctx.strokeStyle = (highlightVp === i) ? '#eda020' : '#9aa6bf'; ctx.lineWidth = (highlightVp === i) ? 2 : 1; ctx.setLineDash([]);
      ctx.strokeRect(clip.x, clip.y, clip.w, clip.h);
    }
  }

  function paintPage() {
    const page = pages.find(p => p.id === activePage); if (!page) { activePage = 'model'; return paint(); }
    const L = pageLayout(page), W = view.canvasW, H = view.canvasH;
    R._adapt = c => c;   // les pages mappent déjà leurs couleurs pour le papier blanc
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);                         // bureau
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(L.Sx0 + 7, L.Sy0 + 7, L.sheetW, L.sheetH); // ombre
    ctx.fillStyle = '#ffffff'; ctx.fillRect(L.Sx0, L.Sy0, L.sheetW, L.sheetH);   // feuille
    // MISE EN PAGE (cartouche DP…) : dessine le gabarit en espace papier, zones de plan laissées blanches.
    if (page.template && QCAD.layouts && QCAD.layouts[page.template]) {
      ctx.save(); ctx.beginPath(); ctx.rect(L.Sx0, L.Sy0, L.sheetW, L.sheetH); ctx.clip();
      drawTemplatePage(ctx, page, L.Sx0, L.Sy0, L.ppmPaper, H, vpDrag ? vpDrag.i : -1);
      ctx.restore();
      ctx.strokeStyle = '#9aa6bf'; ctx.lineWidth = 1; ctx.strokeRect(L.Sx0, L.Sy0, L.sheetW, L.sheetH);
      $('coords').textContent = 'Mise en page : ' + page.name + ' — glissez dans une zone blanche pour cadrer le plan';
      return;
    }
    const dx0 = L.Sx0 + L.margin * L.ppmPaper, dy0 = L.Sy0 + L.margin * L.ppmPaper;
    const dw = L.sheetW - 2 * L.margin * L.ppmPaper, dh = L.sheetH - 2 * L.margin * L.ppmPaper;
    ctx.save(); ctx.beginPath(); ctx.rect(dx0, dy0, dw, dh); ctx.clip();        // découpe à la zone utile
    // région MODÈLE visible sur la feuille (pour ne dessiner que ça : le plan cadré, pas toute la bibliothèque)
    const wA = R.screenToWorld(L.pageView, dx0, dy0 + dh), wB = R.screenToWorld(L.pageView, dx0 + dw, dy0);
    const mx0 = Math.min(wA.x, wB.x), my0 = Math.min(wA.y, wB.y), mx1 = Math.max(wA.x, wB.x), my1 = Math.max(wA.y, wB.y);
    const vis2 = e => { const b = R._bbox(e); return !(b[2] < mx0 || b[0] > mx1 || b[3] < my0 || b[1] > my1); };
    const lc = id => layerById(id).color;
    const lp = id => { const l = layerById(id); return l.penMm != null ? l.penMm : 0.25; };
    const vs = visibleScene();
    for (const e of vs.entities) if (e.type === 'image' && vis2(e)) R.drawImage(ctx, L.pageView, e);
    for (const e of vs.entities) if (e.type === 'hatch' && vis2(e)) R.drawHatch(ctx, L.pageView, e, mapColor(e.color || lc(e.layer)));
    const grp = new Map(), dims = [], txts = [];
    for (const e of vs.entities) {
      const t = e.type; if (t === 'hatch' || t === 'image') continue;
      if (!vis2(e)) continue;
      if (t === 'dim') { dims.push(e); continue; } if (t === 'text') { txts.push(e); continue; }
      if (e.dash) { R.drawEntity(ctx, L.pageView, e, mapColor(e.color || lc(e.layer)), lp(e.layer)); continue; }
      const col = mapColor(e.color || lc(e.layer)), w = Math.max(0.6, (e.penMm != null ? e.penMm : lp(e.layer)) * 1.4), key = col + '|' + w;
      let g = grp.get(key); if (!g) { g = { col, w, list: [] }; grp.set(key, g); } g.list.push(e);
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
    for (const g of grp.values()) {
      ctx.strokeStyle = g.col; ctx.lineWidth = g.w; ctx.beginPath();
      for (const e of g.list) { const p = e.points; if (!p.length) continue; let s = R.worldToScreen(L.pageView, p[0].x, p[0].y); ctx.moveTo(s.x, s.y); for (let i = 1; i < p.length; i++) { s = R.worldToScreen(L.pageView, p[i].x, p[i].y); ctx.lineTo(s.x, s.y); } if (e.closed) ctx.closePath(); }
      ctx.stroke();
    }
    for (const e of dims) R.drawDim(ctx, L.pageView, e, false, mapColor(e.color || lc(e.layer)));
    for (const e of txts) R.drawText(ctx, L.pageView, e, mapColor(e.color || lc(e.layer)));
    ctx.restore();
    ctx.strokeStyle = '#9aa6bf'; ctx.lineWidth = 1; ctx.strokeRect(dx0, dy0, dw, dh); // cadre
    ctx.fillStyle = '#44506b'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(page.name + '   ·   1:' + page.scaleDenom + '   ·   ' + page.paper + ' ' + (page.orientation === 'landscape' ? 'paysage' : 'portrait'), dx0 + 6, dy0 + dh - 6);
    ctx.textAlign = 'start';
    $('coords').textContent = 'Page : ' + page.name;
  }
  function pageMouseDown(e) {
    const page = pages.find(p => p.id === activePage);
    // Sur une mise en page : un clic DANS une zone blanche = cadrage du plan (glisser).
    if (page && page.template && QCAD.layouts[page.template]) {
      const L = pageLayout(page), tpl = QCAD.layouts[page.template], wins = tpl.planWindows || [];
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      const T = (xmm, ymm) => ({ x: L.Sx0 + xmm * L.ppmPaper, y: L.Sy0 + ymm * L.ppmPaper });
      const vps = ensureViewports(page, tpl);
      for (let i = 0; i < wins.length; i++) {
        const w = wins[i], a = T(w.x, w.y), b = T(w.x + w.w, w.y + w.h);
        if (sx >= a.x && sx <= b.x && sy >= a.y && sy <= b.y) {
          const sd = (vps[i].sd || page.scaleDenom);
          vpDrag = { i, sx: e.clientX, sy: e.clientY, cx: vps[i].cx, cy: vps[i].cy, ppmView: L.ppmPaper / sd };
          cv.style.cursor = 'move'; echo('🧭 Cadrage du plan (zone ' + (i + 1) + ') — glissez pour positionner, relâchez pour valider.'); paintPage(); return;
        }
      }
    }
    pageDrag = { sx: e.clientX, sy: e.clientY }; cv.style.cursor = 'grabbing';
  }
  function pageMouseMove(e) {
    if (vpDrag) {
      const page = pages.find(p => p.id === activePage); if (!page) return;
      const vps = page.layoutData.viewports; const dxs = e.clientX - vpDrag.sx, dys = e.clientY - vpDrag.sy;
      vps[vpDrag.i].cx = vpDrag.cx - dxs / vpDrag.ppmView; vps[vpDrag.i].cy = vpDrag.cy + dys / vpDrag.ppmView;
      paintPage(); return;
    }
    if (!pageDrag) return;
    const page = pages.find(p => p.id === activePage); if (!page) return;
    const L = pageLayout(page);
    const dxs = e.clientX - pageDrag.sx, dys = e.clientY - pageDrag.sy; pageDrag.sx = e.clientX; pageDrag.sy = e.clientY;
    page.offX -= dxs / L.ppm; page.offY += dys / L.ppm; paintPage();
  }
  function setActivePage(id) {
    activePage = id; renderPageTabs();
    const pb = $('pagebar');
    if (id === 'model') { cv.style.cursor = 'none'; if (pb) pb.style.display = 'none'; paint(); }
    else { cv.style.cursor = 'grab'; if (pb) { pb.style.display = 'flex'; syncPageBar(); } paintPage(); }
  }
  function renderPageTabs() {
    const bar = $('pagetabs'); if (!bar) return; bar.innerHTML = '';
    // Menu déroulant : aller DIRECTEMENT à une page sans faire défiler les onglets.
    const sel = document.createElement('select'); sel.className = 'ptab-select'; sel.title = 'Aller à une page / présentation';
    const opt = (id, label) => { const o = document.createElement('option'); o.value = id; o.textContent = label; if (id === activePage) o.selected = true; return o; };
    sel.appendChild(opt('model', '📐 Objet'));
    pages.forEach(p => sel.appendChild(opt(p.id, '📄 ' + p.name)));
    sel.onchange = () => setActivePage(sel.value);
    bar.appendChild(sel);
    const mk = (id, label) => { const b = document.createElement('button'); b.className = 'ptab' + (activePage === id ? ' active' : ''); b.textContent = label; b.onclick = () => setActivePage(id); return b; };
    bar.appendChild(mk('model', '📐 Objet'));
    pages.forEach(p => bar.appendChild(mk(p.id, p.name)));
    const add = document.createElement('button'); add.className = 'ptab add'; add.textContent = '＋'; add.title = 'Nouvelle mise en page (DP…) ou page vierge';
    add.onclick = (ev) => { ev.stopPropagation(); togglePageMenu(add); }; bar.appendChild(add);
  }
  // Menu « nouvelle mise en page » ancré AU-DESSUS du bouton ＋ (la barre des pages est en bas)
  function openPageMenu(btn) {
    const m = $('ptmenu'); if (!m) return; m.classList.add('open');
    const r = btn.getBoundingClientRect(), mw = m.offsetWidth || 240, mh = m.offsetHeight || 180;
    m.style.left = Math.max(6, Math.min(r.left, window.innerWidth - mw - 6)) + 'px';
    m.style.top = Math.max(6, r.top - mh - 4) + 'px';   // au-dessus du bouton
  }
  function closePageMenu() { const m = $('ptmenu'); if (m) m.classList.remove('open'); }
  function togglePageMenu(btn) { const m = $('ptmenu'); if (m && m.classList.contains('open')) closePageMenu(); else openPageMenu(btn); }
  function createPage() {
    const name = (prompt('Nom de la page (ex. DP02, DP04) :', 'DP0' + (pages.length + 2)) || '').trim(); if (!name) return;
    const page = { id: 'page-' + Date.now(), name, paper: $('paper').value || 'A4', orientation: $('orient').value || 'landscape', scaleDenom: scaleDenom() || 100, offX: 0, offY: 0 };
    pages.push(page); activePage = page.id; fitPageScale(); setActivePage(page.id); echo('Page « ' + name + ' » créée — elle affiche ton dessin.');
  }
  // Crée une mise en page à partir d'un gabarit (cartouche DP…), à l'échelle demandée.
  // Les zones de plan sont laissées BLANCHES : l'utilisateur y insère ses plans.
  function createLayout(key, denom) {
    const tpl = QCAD.layouts && QCAD.layouts[key]; if (!tpl) { echo('Gabarit inconnu.'); return; }
    const sc = denom || (tpl.defaults && tpl.defaults.scaleDenom) || 500;
    const base = (tpl.name.split(' ')[0] || 'DP');
    const page = { id: 'page-' + Date.now() + '-' + sc, name: base + ' 1-' + sc, paper: tpl.paper || 'A4', orientation: tpl.orientation || 'portrait', scaleDenom: sc, offX: 0, offY: 0, template: key, layoutData: Object.assign({}, tpl.defaults, { scaleDenom: sc }) };
    pages.push(page); activePage = page.id; renderPageTabs(); setActivePage(page.id);
    echo('🗂️ Mise en page « ' + page.name + ' » (1:' + sc + ') créée — zone de plan laissée BLANCHE.');
  }
  // Édition des champs du cartouche — PANNEAU INTÉGRÉ (plus de pop-up navigateur).
  function closeFieldsPanel() { const p = $('fieldsPanel'); if (p) p.style.display = 'none'; }
  function editLayoutFields() {
    const page = pages.find(p => p.id === activePage); if (!page || !page.template) { echo('Ouvre d’abord une mise en page (bouton ＋ en bas).'); return; }
    const tpl = QCAD.layouts[page.template]; const d = page.layoutData || (page.layoutData = Object.assign({}, tpl.defaults));
    const vps = ensureViewports(page, tpl);
    const box = $('fieldsPanel'); if (!box) return;
    const esc = s => String(s == null ? '' : s).replace(/"/g, '&quot;');
    const txt = (lbl, k) => '<div class="fp-row"><label>' + lbl + '</label><input type="text" data-k="' + k + '" value="' + esc(d[k]) + '"></div>';
    let html = '<div class="fp-head"><b>Modifier les champs — ' + escHtml(page.name) + '</b><button id="fp-close" title="Fermer">✕</button></div><div class="fp-body">';
    html += '<div class="fp-sec">Informations</div>';
    html += txt('Client', 'client') + txt('Numéro DP', 'dpNum') + txt('Titre', 'dpTitle');
    html += '<div class="fp-sec">Emprise au sol</div>';
    html += txt('Avant travaux (m²)', 'empAvant') + txt('Après travaux (m²)', 'empApres') + txt('Surface créée (m²)', 'empCreee');
    html += '<div class="fp-sec">Pied de page</div>' + txt('Note', 'footer');
    html += '<div class="fp-sec">Charte (société)</div>';
    html += '<div class="fp-row"><label>Couleur des bandeaux</label><input type="color" data-k="bandColor" value="' + esc(d.bandColor || '#07367e') + '"></div>';
    html += '<div class="fp-sec">Cadrage des plans</div>';
    (tpl.planWindows || []).forEach((w, i) => { html += '<div class="fp-vp"><label style="flex:0 0 150px;font-size:12px;color:var(--muted)">Zone ' + (i + 1) + '</label><button data-vp-center="' + i + '">🎯 Centrer sur le dessin</button></div>'; });
    html += '<div style="font-size:11px;color:var(--muted);margin-top:4px">Astuce : glisse directement dans une zone blanche de la feuille pour positionner le plan.</div>';
    html += '</div>';
    box.innerHTML = html; box.style.display = 'flex';
    box.querySelector('#fp-close').onclick = closeFieldsPanel;
    box.querySelectorAll('input[data-k]').forEach(inp => {
      const apply = () => { d[inp.dataset.k] = inp.value; paintPage(); };
      inp.oninput = apply; inp.onchange = apply;
    });
    box.querySelectorAll('[data-vp-center]').forEach(btn => btn.onclick = () => {
      const i = +btn.dataset.vpCenter, f = modelFocus();
      vps[i].cx = f.cx; vps[i].cy = f.cy; paintPage(); echo('Zone ' + (i + 1) + ' centrée sur le dessin.');
    });
    echo('Modifie les champs du cartouche — tout se met à jour en direct.');
  }
  function centerPage() {
    const page = pages.find(p => p.id === activePage); if (!page) return;
    const b = G.bounds(visibleScene()); const pm = paperMm(page), usableW = pm.w - 20, usableH = pm.h - 20;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    page.offX = cx - usableW / 2 * page.scaleDenom; page.offY = cy - usableH / 2 * page.scaleDenom; paintPage();
  }
  function fitPageScale() {
    const page = pages.find(p => p.id === activePage); if (!page) return;
    const b = G.bounds(visibleScene());
    if (b.w || b.h) {
      const pm = paperMm(page), usableW = pm.w - 20, usableH = pm.h - 20;
      const need = Math.max(b.w / usableW, b.h / usableH) * 1.12;
      const nice = [20, 50, 100, 200, 500, 1000, 2000]; page.scaleDenom = nice.find(x => x >= need) || Math.ceil(need);
    }
    centerPage(); syncPageBar();
  }
  function printPage() {
    const page = pages.find(p => p.id === activePage); if (!page) { plot(); return; }
    // Mise en page à gabarit (DP…) : on IMPRIME EXACTEMENT CE QUI EST À L'ÉCRAN
    // (cartouche + plans cadrés), en rasterisant la feuille haute résolution -> A4.
    if (page.template && QCAD.layouts[page.template]) { printTemplatePage(page); return; }
    const vs = visibleScene(); if (!vs.entities.length) { echo('Page vide.'); return; }
    const doc = QCAD.exportPdf(vs, { scaleDenom: page.scaleDenom, paper: page.paper, orientation: page.orientation, title: page.name, frameX: page.offX, frameY: page.offY });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([doc.toBytes()], { type: 'application/pdf' })); a.download = 'qlygocad_' + page.name + '.pdf'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    echo('Page « ' + page.name + ' » imprimée (PDF).');
  }
  // Rendu haute résolution de la feuille (identique à l'écran) puis fenêtre d'impression
  // au format A4 exact -> « Enregistrer au format PDF » sort le bon résultat.
  function printTemplatePage(page) {
    const pm = paperMm(page), K = 8;                 // 8 px/mm ≈ 200 dpi
    const cw = Math.round(pm.w * K), ch = Math.round(pm.h * K);
    const oc = document.createElement('canvas'); oc.width = cw; oc.height = ch;
    const octx = oc.getContext('2d');
    octx.fillStyle = '#ffffff'; octx.fillRect(0, 0, cw, ch);
    const prevAdapt = R._adapt; R._adapt = c => c;
    drawTemplatePage(octx, page, 0, 0, K, ch, -1);   // Sx0=Sy0=0, ppmPaper=K, canvasH=ch
    R._adapt = prevAdapt;
    const url = oc.toDataURL('image/png');
    const land = page.orientation === 'landscape';
    const win = window.open('', '_blank');
    if (!win) { echo('⚠ Autorise les fenêtres pop-up pour imprimer.'); return; }
    win.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>' + page.name + '</title>' +
      '<style>@page{size:A4 ' + (land ? 'landscape' : 'portrait') + ';margin:0}' +
      'html,body{margin:0;padding:0}img{width:' + pm.w + 'mm;height:' + pm.h + 'mm;display:block}</style></head>' +
      '<body><img src="' + url + '" onload="setTimeout(function(){window.focus();window.print();},120)"></body></html>');
    win.document.close();
    echo('🖨 Aperçu d’impression de « ' + page.name + ' » — choisis « Enregistrer au format PDF ».');
  }
  function renamePage() { const page = pages.find(p => p.id === activePage); if (!page) return; const n = (prompt('Nouveau nom de la page :', page.name) || '').trim(); if (n) { page.name = n; renderPageTabs(); syncPageBar(); } }
  function deletePage() { const page = pages.find(p => p.id === activePage); if (!page) return; if (!confirm('Supprimer la page « ' + page.name + ' » ? (le dessin n’est pas touché)')) return; pages = pages.filter(p => p !== page); setActivePage('model'); echo('Page supprimée.'); }
  function syncPageBar() {
    const page = pages.find(p => p.id === activePage); if (!page) return;
    if ($('pgPaper')) $('pgPaper').value = page.paper;
    if ($('pgOrient')) $('pgOrient').value = page.orientation;
    if ($('pgScale')) $('pgScale').value = String(page.scaleDenom);
    if ($('pgName')) $('pgName').textContent = page.name;
    if ($('pgFields')) $('pgFields').style.display = page.template ? '' : 'none';
    // Sur une mise en page (cartouche), on masque les contrôles de « vue modèle » (échelle, papier…)
    if ($('pgModelCtrls')) $('pgModelCtrls').style.display = page.template ? 'none' : 'inline-flex';
    // ... et on affiche à la place le sélecteur d'échelle du cartouche (l'échelle graphique suit)
    if ($('pgLayoutScaleWrap')) $('pgLayoutScaleWrap').style.display = page.template ? '' : 'none';
    if (page.template && $('pgLayoutScale')) $('pgLayoutScale').value = String((page.layoutData && page.layoutData.scaleDenom) || page.scaleDenom || 500);
  }

  // ---------- Couleur : pastille + popover flottant (palette + favoris) ----------
  const FAV_DEF = ['#e8ebf2', '#eda020', '#b9375e', '#39d353', '#1b2b4b', '#c0392b', '#2d6cdf', '#000000'];
  let cpTarget = null;
  function favKey(id) { return 'qlygocad.favs.' + id; }
  function loadFavs(id) { try { const a = JSON.parse(localStorage.getItem(favKey(id)) || 'null'); return Array.isArray(a) ? a : FAV_DEF.slice(); } catch (e) { return FAV_DEF.slice(); } }
  function saveFavs(id, a) { try { localStorage.setItem(favKey(id), JSON.stringify(a)); } catch (e) { } }
  function updateSwatch(id) { const sw = $('sw-' + id), input = $(id); if (sw && input) sw.style.background = input.value; }
  function applyColor(id, c) { const input = $(id); input.value = c; updateSwatch(id); input.dispatchEvent(new Event('change')); }
  function renderCpopFavs() {
    const box = $('cpop-favs'); if (!box || !cpTarget) return; const arr = loadFavs(cpTarget);
    box.innerHTML = '';
    arr.forEach((c, i) => {
      const b = document.createElement('button'); b.className = 'fav'; b.style.background = c; b.title = c + ' — clic: appliquer · clic droit: retirer';
      b.onclick = () => applyColor(cpTarget, c);
      b.oncontextmenu = ev => { ev.preventDefault(); const a = loadFavs(cpTarget); a.splice(i, 1); saveFavs(cpTarget, a); renderCpopFavs(); };
      box.appendChild(b);
    });
  }
  function openColorPopover(btn, id) {
    cpTarget = id; const pop = $('cpop'), input = $(id), native = $('cpop-native');
    native.value = input.value; renderCpopFavs();
    const r = btn.getBoundingClientRect(); pop.style.left = Math.min(r.left, window.innerWidth - 232) + 'px'; pop.style.top = (r.bottom + 4) + 'px';
    pop.classList.add('open');
  }
  function closeColorPopover() { const p = $('cpop'); if (p) p.classList.remove('open'); }
  function initColorUI() {
    document.querySelectorAll('[data-cp]').forEach(btn => {
      const id = btn.dataset.cp; updateSwatch(id);
      btn.addEventListener('click', ev => { ev.stopPropagation(); const pop = $('cpop'); if (pop.classList.contains('open') && cpTarget === id) closeColorPopover(); else openColorPopover(btn, id); });
    });
    const native = $('cpop-native'); if (native) { const h = () => { if (cpTarget) applyColor(cpTarget, native.value); }; native.addEventListener('input', h); native.addEventListener('change', h); }
    const add = $('cpop-add'); if (add) add.onclick = () => { if (!cpTarget) return; const a = loadFavs(cpTarget), input = $(cpTarget); if (a.indexOf(input.value) < 0) { a.push(input.value); saveFavs(cpTarget, a); renderCpopFavs(); echo('⭐ Couleur ' + input.value + ' ajoutée aux favoris.'); } };
    document.addEventListener('click', e => { const pop = $('cpop'); if (pop && pop.classList.contains('open') && !pop.contains(e.target) && !(e.target.closest && e.target.closest('[data-cp]'))) closeColorPopover(); });
  }

  // ---------- Accueil / Drive local (mes plans) ----------
  const DOCS_KEY = 'qlygocad.docs';
  let currentDocId = null, currentDocName = 'Sans titre';
  function escHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function loadDocs() { try { return JSON.parse(localStorage.getItem(DOCS_KEY) || '[]') || []; } catch (e) { return []; } }
  function saveDocs(a) { try { localStorage.setItem(DOCS_KEY, JSON.stringify(a)); } catch (e) { echo('⚠ Stockage plein : liste non enregistrée.'); } }
  function docKey(id) { return 'qlygocad.doc.' + id; }
  function readDoc(id) { try { return JSON.parse(localStorage.getItem(docKey(id)) || 'null'); } catch (e) { return null; } }
  function writeDoc(id, data) { try { localStorage.setItem(docKey(id), JSON.stringify(data)); return true; } catch (e) { echo('⚠ Stockage plein : plan non enregistré.'); return false; } }

  // Sérialisation en PRÉSERVANT les références de points partagées (cotes associatives)
  function serializeScene() {
    const pool = [], idx = new Map();
    const pid = p => { let i = idx.get(p); if (i == null) { i = pool.length; pool.push({ x: p.x, y: p.y }); idx.set(p, i); } return i; };
    const ents = scene.entities.map(e => { const o = {}; for (const k in e) { if (k === 'points' || k === 'center') continue; o[k] = e[k]; } o.pts = e.points.map(pid); if (e.center) o.c = pid(e.center); return o; });
    return { v: 1, pts: pool, ents, layers: scene.layers.map(l => Object.assign({}, l)), pages: pages.map(p => Object.assign({}, p)), currentLayer };
  }
  function applyDoc(d) {
    const pool = (d.pts || []).map(p => ({ x: p.x, y: p.y }));
    scene.layers = (d.layers && d.layers.length) ? d.layers.map(l => Object.assign({}, l)) : G.createScene().layers;
    scene.entities = (d.ents || []).map(o => { const e = {}; for (const k in o) { if (k === 'pts' || k === 'c') continue; e[k] = o[k]; } e.points = (o.pts || []).map(i => pool[i]).filter(Boolean); if (o.c != null) e.center = pool[o.c]; return e; });
    pages = (d.pages || []).map(p => Object.assign({}, p));
    currentLayer = (d.currentLayer && scene.layers.some(l => l.id === d.currentLayer)) ? d.currentLayer : scene.layers[0].id; baseLayer = currentLayer;
    history = []; redoStack = []; selected = []; draft = []; op = null; opGhost = null; trimPreview = null; gripDrag = hotGrip = null;
  }
  function hasContent() { return scene.entities.length > 0; }
  function autoName() { const d = new Date(), p = x => String(x).padStart(2, '0'); return 'Plan ' + p(d.getDate()) + '-' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + 'h' + p(d.getMinutes()); }
  function setDocName(n) { currentDocName = n; const f = document.querySelector('.titlebar .file'); if (f) f.textContent = n + '.qcad'; }

  // Miniature : rendu de la scène ajustée sur une petite toile (fond papier blanc)
  function fitViewFor(b, W, H) {
    if (!(b.w || b.h)) return { pxPerMm: 0.05, panXmm: -W / 0.1, panYmm: -H / 0.1, canvasW: W, canvasH: H };
    const pad = Math.max(b.w, b.h) * 0.08 + 500, ppm = Math.min(W / (b.w + 2 * pad), H / (b.h + 2 * pad));
    return { pxPerMm: ppm, panXmm: b.minX - (W / ppm - b.w) / 2, panYmm: b.minY - (H / ppm - b.h) / 2, canvasW: W, canvasH: H };
  }
  function makeThumb() {
    const W = 260, H = 150, c = document.createElement('canvas'); c.width = W; c.height = H;
    const cx = c.getContext('2d'); cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, W, H);
    const vs = visibleScene(), v = fitViewFor(G.bounds(vs), W, H);
    for (const e of vs.entities) if (e.type === 'image') R.drawImage(cx, v, e);
    for (const e of vs.entities) if (e.type === 'hatch') R.drawHatch(cx, v, e, mapColor(e.color || layerById(e.layer).color));
    for (const e of vs.entities) { if (e.type === 'hatch' || e.type === 'image') continue; if (e.type === 'dim') R.drawDim(cx, v, e, false, mapColor(e.color || layerById(e.layer).color)); else if (e.type === 'text') R.drawText(cx, v, e, mapColor(e.color || layerById(e.layer).color)); else R.drawEntity(cx, v, e, mapColor(e.color || layerById(e.layer).color), (layerById(e.layer).penMm != null ? layerById(e.layer).penMm : 0.25)); }
    try { return c.toDataURL('image/jpeg', 0.55); } catch (e) { return ''; }
  }
  function saveCurrent(ask) {
    if (!hasContent() && !currentDocId) { echo('Rien à enregistrer (plan vide).'); return false; }
    let name = currentDocName;
    if (ask) { const n = (prompt('Nom du plan :', name === 'Sans titre' ? autoName() : name) || '').trim(); if (!n) return false; name = n; }
    else if (name === 'Sans titre') name = autoName();
    if (!currentDocId) currentDocId = 'd' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    if (!writeDoc(currentDocId, serializeScene())) return false;
    const docs = loadDocs(), meta = { id: currentDocId, name, date: Date.now(), thumb: makeThumb() };
    const i = docs.findIndex(x => x.id === currentDocId); if (i >= 0) docs[i] = meta; else docs.unshift(meta);
    saveDocs(docs); setDocName(name); echo('💾 « ' + name + ' » enregistré.'); return true;
  }
  function openDoc(id) {
    const data = readDoc(id); if (!data) { echo('Plan introuvable.'); return; }
    const meta = loadDocs().find(x => x.id === id);
    applyDoc(data); currentDocId = id; setDocName(meta ? meta.name : 'Sans titre');
    renderLayerSelect(); renderPageTabs(); hideHome(); activePage = 'model'; setTool('select'); resize(); fit();
    echo('📂 Plan « ' + (meta ? meta.name : '') + ' » ouvert.');
  }
  function newPlan() {
    const fresh = G.createScene(); scene.layers = fresh.layers; scene.entities = []; pages = [];
    currentLayer = scene.layers[0].id; baseLayer = currentLayer; history = []; redoStack = []; selected = []; draft = []; op = null; currentDocId = null;
    setDocName('Sans titre'); renderLayerSelect(); renderPageTabs(); hideHome(); activePage = 'model'; setTool('select'); resize(); fit();
    echo('📄 Nouveau plan — bonne conception !');
  }
  function deleteDoc(id) { saveDocs(loadDocs().filter(x => x.id !== id)); try { localStorage.removeItem(docKey(id)); } catch (e) { } if (currentDocId === id) { currentDocId = null; setDocName('Sans titre'); } renderHomeGrid(); }
  function renameDoc(id) { const docs = loadDocs(), m = docs.find(x => x.id === id); if (!m) return; const n = (prompt('Renommer le plan :', m.name) || '').trim(); if (!n) return; m.name = n; saveDocs(docs); if (currentDocId === id) setDocName(n); renderHomeGrid(); }
  function showHome() { if (hasContent()) saveCurrent(false); renderHomeGrid(); $('home').classList.add('show'); }
  function hideHome() { $('home').classList.remove('show'); }
  function renderHomeGrid() {
    const g = $('home-grid'); if (!g) return; g.innerHTML = '';
    const nw = document.createElement('div'); nw.className = 'doc-card newc'; nw.innerHTML = '<div class="plus">＋</div><div class="lbl">Nouveau plan</div>'; nw.onclick = newPlan; g.appendChild(nw);
    const docs = loadDocs();
    docs.forEach(m => {
      const d = new Date(m.date), p = x => String(x).padStart(2, '0');
      const ds = p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      const c = document.createElement('div'); c.className = 'doc-card';
      c.innerHTML = '<div class="doc-thumb" style="background-image:url(' + (m.thumb || '') + ')"></div>' +
        '<div class="doc-meta"><span class="nm">' + escHtml(m.name) + '</span><div class="doc-act"><button data-a="ren" title="Renommer">✎</button><button data-a="del" title="Supprimer">🗑</button></div></div>' +
        '<div class="doc-meta" style="padding-top:0"><span class="dt">' + ds + '</span></div>';
      c.querySelector('.doc-thumb').onclick = () => openDoc(m.id);
      c.querySelector('.nm').onclick = () => openDoc(m.id);
      c.querySelector('[data-a="ren"]').onclick = ev => { ev.stopPropagation(); renameDoc(m.id); };
      c.querySelector('[data-a="del"]').onclick = ev => { ev.stopPropagation(); if (confirm('Supprimer « ' + m.name + ' » ? (définitif)')) deleteDoc(m.id); };
      g.appendChild(c);
    });
  }
  { const b = $('homeBtn'); if (b) b.addEventListener('click', showHome); }
  { const b = $('saveBtn'); if (b) b.addEventListener('click', () => saveCurrent(true)); }
  { const b = $('home-new'); if (b) b.addEventListener('click', newPlan); }

  // ---------- Plan de base (document chargé au démarrage) ----------
  function circleFrom(c, r) { const n = 48, p = []; for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; p.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); } return p; }
  // Désérialise le format compact v2 (pool de points partagés + entités légères).
  function applyCompact(doc) {
    scene.layers = (doc.layers || []).map((L, i) => ({ id: 'l' + i, name: L.name || ('Calque ' + i), color: L.color || '#9fb0d0', penMm: (L.pen != null ? L.pen : 0.25), visible: L.v !== false, locked: !!L.lk, frozen: !!L.fz }));
    if (!scene.layers.length) scene.layers = G.createScene().layers;
    const byName = {}; scene.layers.forEach(l => { byName[l.name] = l.id; });
    const P = doc.pool || [], pool = new Array(P.length / 2);
    for (let i = 0; i < pool.length; i++) pool[i] = { x: P[i * 2], y: P[i * 2 + 1] };
    const pt = i => pool[i];
    scene.entities = (doc.ents || []).map(o => {
      const layer = byName[o.l] || scene.layers[0].id, color = o.c || null;
      if (o.t === 'x') return { type: 'text', points: [pt(o.i)], text: o.s, hMm: o.h, angleDeg: o.a || 0, layer, color };
      if (o.t === 'o') { const c = pt(o.i); return { type: 'circle', center: c, r: o.r, points: circleFrom(c, o.r), closed: true, layer, color, penMm: 0.25 }; }
      if (o.t === 'h') return { type: 'hatch', points: o.p.map(pt), pattern: 'solid', color, spacingMm: 300, angleDeg: 45, layer };
      return { type: 'polyline', points: o.p.map(pt), layer, color, penMm: 0.25, closed: !!o.k };
    });
    // QlygoCAD = outil de PLANS : on ne garde PAS les onglets de présentation
    // hérités du fichier AutoCAD (DP5, DP7, DP8, DP11…). Seules nos mises en page
    // à gabarit (DP02/DP03/DP04, champ `template`) sont conservées. L'utilisateur
    // crée ses présentations depuis le bouton ＋ de la barre des pages.
    pages = (doc.pages || []).filter(p => p && p.template).map(p => ({ id: p.id || ('pg' + Math.random().toString(36).slice(2)), name: p.name || 'Page', paper: p.paper || 'A4', orientation: p.orientation || 'portrait', scaleDenom: p.scaleDenom || 100, offX: p.offX || 0, offY: p.offY || 0, template: p.template, layoutData: p.layoutData }));
    currentLayer = scene.layers[0].id; baseLayer = currentLayer; history = []; redoStack = []; selected = []; draft = []; op = null;
    markSceneDirty();
  }
  // Ajoute les entités d'un doc compact à la scène EXISTANTE (mappe les calques par nom).
  function appendCompact(doc) {
    const byName = {}; scene.layers.forEach(l => { byName[l.name] = l.id; });
    const P = doc.pool || [], pool = new Array(P.length / 2);
    for (let i = 0; i < pool.length; i++) pool[i] = { x: P[i * 2], y: P[i * 2 + 1] };
    const pt = i => pool[i];
    for (const o of (doc.ents || [])) {
      const layer = byName[o.l] || scene.layers[0].id, color = o.c || null;
      if (o.t === 'x') scene.entities.push({ type: 'text', points: [pt(o.i)], text: o.s, hMm: o.h, angleDeg: o.a || 0, layer, color });
      else if (o.t === 'o') { const c = pt(o.i); scene.entities.push({ type: 'circle', center: c, r: o.r, points: circleFrom(c, o.r), closed: true, layer, color, penMm: 0.25 }); }
      else if (o.t === 'h') scene.entities.push({ type: 'hatch', points: o.p.map(pt), pattern: 'solid', color, spacingMm: 300, angleDeg: 45, layer });
      else scene.entities.push({ type: 'polyline', points: o.p.map(pt), layer, color, penMm: 0.25, closed: !!o.k });
    }
    markSceneDirty();
  }
  // Catalogue de menuiseries : chargé À LA DEMANDE (pas au démarrage -> ouverture instantanée).
  let menuiseriesLoaded = false, menuiseriesLoading = false;
  const MENU_LAYERS = ['MENUISERIE-ROULANT', 'MENUISERIE-VOLET', 'MENUISERIE-BIB', 'MENUISERIE-GRILLE'];
  function setMenuFrozen(frozen) {
    scene.layers.forEach(l => { if (MENU_LAYERS.indexOf(l.name) >= 0) l.frozen = frozen; });
    refreshLayers();
  }
  function menuVisible() { return scene.layers.some(l => MENU_LAYERS.indexOf(l.name) >= 0 && !l.frozen); }
  async function loadMenuiseries() {
    if (menuiseriesLoading) return;
    if (menuiseriesLoaded) { setMenuFrozen(false); updateMenuBtn(); paint(); echo('Menuiseries affichées.'); return; }
    menuiseriesLoading = true; updateMenuBtn();
    echo('⏳ Chargement de la bibliothèque de menuiseries…');
    try {
      const doc = await fetchGzJson('assets/qlygo-menuiseries.json.gz?v=39');
      appendCompact(doc); menuiseriesLoaded = true; setMenuFrozen(false);
      echo('✅ Menuiseries chargées (' + (doc.ents ? doc.ents.length : 0) + ' éléments). Masque-les pour retrouver la fluidité maximale.');
    } catch (e) { echo('⚠ Menuiseries indisponibles (' + (e && e.message || e) + ').'); }
    menuiseriesLoading = false; updateMenuBtn(); paint();
  }
  function toggleMenuiseries() {
    if (menuiseriesLoaded && menuVisible()) { setMenuFrozen(true); updateMenuBtn(); paint(); echo('Menuiseries masquées — fluidité maximale.'); }
    else loadMenuiseries();
  }
  function updateMenuBtn() {
    const b = $('menuBtn'); if (!b) return;
    const on = menuiseriesLoaded && menuVisible();
    b.textContent = menuiseriesLoading ? '⏳ Menuiseries…' : (on ? '🪟 Menuiseries : ON' : '🪟 Menuiseries : OFF');
    b.classList.toggle('active', on);
  }
  async function fetchGzJson(url) {
    const resp = await fetch(url); if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    try {
      if (typeof DecompressionStream !== 'undefined') {
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream('gzip'));
        return JSON.parse(await new Response(stream).text());
      }
    } catch (e) { /* peut-être déjà décompressé par le serveur */ }
    return JSON.parse(new TextDecoder().decode(buf));
  }
  // Cadrage sur le CŒUR du dessin (ignore les quelques entités isolées loin, ex. près de l'origine)
  function fitContent() {
    const xs = [], ys = [];
    for (const e of scene.entities) { const b = R._bbox(e); if (b[0] < -1e16) continue; xs.push((b[0] + b[2]) / 2); ys.push((b[1] + b[3]) / 2); }
    if (!xs.length) return fit();
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
    const minX = q(xs, 0.01), maxX = q(xs, 0.99), minY = q(ys, 0.01), maxY = q(ys, 0.99);
    const w = (maxX - minX) || 1000, h = (maxY - minY) || 1000, pad = Math.max(w, h) * 0.06 + 500;
    view.pxPerMm = Math.min(view.canvasW / (w + 2 * pad), view.canvasH / (h + 2 * pad));
    view.panXmm = minX - pad; view.panYmm = minY - pad; paint();
  }
  function loadBasePlan() {
    echo('⏳ Chargement du plan de base QLYGO_CAD…');
    return fetchGzJson('assets/qlygo-base.json.gz?v=39').then(doc => {
      applyCompact(doc); currentDocId = null; setDocName(doc.name || 'QLYGO_CAD (base)');
      menuiseriesLoaded = false; menuiseriesLoading = false;
      renderLayerSelect(); renderPageTabs(); hideHome(); activePage = 'model'; setTool('select'); resize(); fitContent(); updateMenuBtn();
      echo('✅ Plan de base chargé (léger : ' + scene.entities.length + ' entités). Menuiseries : bouton « 🪟 Menuiseries » quand tu en as besoin.');
    });
  }

  // ---------- Menu Fichiers + imports (DXF cadastre, PDF fond de plan) ----------
  function openFileMenu() { const m = $('filemenu'), t = $('fileTab'); const r = t.getBoundingClientRect(); m.style.left = r.left + 'px'; m.style.top = (r.bottom + 2) + 'px'; m.classList.add('open'); }
  function closeFileMenu() { const m = $('filemenu'); if (m) m.classList.remove('open'); }
  function initFiles() {
    const tab = $('fileTab'); if (tab) tab.addEventListener('click', ev => { ev.stopPropagation(); const m = $('filemenu'); m.classList.contains('open') ? closeFileMenu() : openFileMenu(); });
    document.addEventListener('click', e => { const m = $('filemenu'); if (m && m.classList.contains('open') && !m.contains(e.target) && e.target !== $('fileTab')) closeFileMenu(); });
    document.querySelectorAll('#filemenu [data-fm]').forEach(b => b.addEventListener('click', () => {
      closeFileMenu(); const a = b.dataset.fm;
      if (a === 'base') loadBasePlan().catch(err => echo('⚠ ' + (err && err.message || err))); else if (a === 'new') newPlan(); else if (a === 'home') showHome(); else if (a === 'save') saveCurrent(true);
      else if (a === 'open') $('dxfFile').click(); else if (a === 'pdf') $('pdfFile').click();
      else if (a === 'print') { if (activePage !== 'model') printPage(); else plot(); }
    }));
    // Menu « nouvelle mise en page » (bouton ＋ de la barre des pages, en bas)
    document.querySelectorAll('#ptmenu [data-pt]').forEach(b => b.addEventListener('click', () => {
      closePageMenu(); const a = b.dataset.pt;
      if (a === 'layout-dp02-500') createLayout('dp02', 500);
      else if (a === 'layout-dp02-250') createLayout('dp02', 250);
      else if (a === 'layout-dp02-200') createLayout('dp02', 200);
      else if (a === 'layout-dp02-all') { createLayout('dp02', 500); createLayout('dp02', 250); createLayout('dp02', 200); }
      else if (a === 'layout-dp03') createLayout('dp03', 200);
      else if (a === 'layout-dp04') createLayout('dp04', 100);
      else if (a === 'blank') createPage();
    }));
    document.addEventListener('click', e => { const m = $('ptmenu'); if (m && m.classList.contains('open') && !m.contains(e.target) && !(e.target.classList && e.target.classList.contains('add'))) closePageMenu(); });
    const dx = $('dxfFile'); if (dx) dx.addEventListener('change', e => { const f = e.target.files[0]; if (f) { /\.dwg$/i.test(f.name) ? openDWGFile(f) : importDXFFile(f); } dx.value = ''; });
    const pf = $('pdfFile'); if (pf) pf.addEventListener('change', e => { const f = e.target.files[0]; if (f) importPDFFile(f); pf.value = ''; });
  }
  function ensureLayer(name, color) {
    const ex = scene.layers.find(x => x.name === name); if (ex) return ex.id;
    const id = 'dxf-' + String(name || '0').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + scene.layers.length;
    scene.layers.push({ id, name: name || 'Calque', color: color || '#9fb0d0', penMm: 0.25, visible: true, locked: false, frozen: false });
    return id;
  }
  // Cœur d'import : intègre un DXF (texte) dans la scène, calques préservés.
  function importDXFText(text, label) {
    try {
      const res = QCAD.dxf.parse(String(text));
      if (!res.entities.length) { echo('⚠ ' + (label || 'Fichier') + ' : aucune entité reconnue.'); return false; }
      pushHistory();
      const map = {}; res.layers.forEach(L => { map[L.name] = ensureLayer(L.name, L.color); });
      res.entities.forEach(e => { e.layer = map[e.layer] || ensureLayer(e.layer, '#9fb0d0'); e.penMm = e.penMm != null ? e.penMm : 0.25; scene.entities.push(e); });
      renderLayerSelect(); refreshLayers();
      echo('📐 ' + (label || 'Plan') + ' ouvert : ' + res.entities.length + ' entité(s) sur ' + res.layers.length + ' calque(s), à l’échelle réelle.');
      setActivePage('model'); fit(); return true;
    } catch (err) { echo('⚠ Ouverture échouée : ' + err.message); return false; }
  }
  function importDXFFile(file) {
    const rd = new FileReader();
    rd.onload = () => importDXFText(rd.result, file.name);
    rd.onerror = () => echo('⚠ Lecture du DXF impossible.');
    rd.readAsText(file);
  }
  // Ouverture DWG : DWG est un format binaire propriétaire. Si un convertisseur
  // DWG→DXF est branché (window.QCAD_DWG_TO_DXF, p. ex. WASM libredwg), on
  // l'utilise ; sinon on guide vers la conversion (une seule fois, gratuite).
  function openDWGFile(file) {
    if (typeof window.QCAD_DWG_TO_DXF === 'function') {
      echo('📂 Conversion de « ' + file.name +' » (DWG)…');
      const rd = new FileReader();
      rd.onload = () => { Promise.resolve(window.QCAD_DWG_TO_DXF(rd.result)).then(dxf => { if (!importDXFText(dxf, file.name)) echo('⚠ DWG non converti.'); }).catch(err => echo('⚠ Conversion DWG échouée : ' + (err && err.message || err))); };
      rd.onerror = () => echo('⚠ Lecture du DWG impossible.');
      rd.readAsArrayBuffer(file);
      return;
    }
    echo('⚠ « ' + file.name + ' » est un DWG (format binaire propriétaire Autodesk).');
    echo('→ Convertis-le en <b>DXF</b> puis réouvre-le ici — tout est conservé (lignes, calques, échelle). ' +
         'Gratuit et hors-ligne : <b>ODA File Converter</b> (convertit tout un dossier DWG→DXF d’un coup), ' +
         'ou dans AutoCAD : commande <b>DXFOUT</b> / Enregistrer sous → DXF.');
  }
  let pdfjsLoading = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsLoading) return pdfjsLoading;
    pdfjsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = () => { try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; } catch (e) { } resolve(window.pdfjsLib); };
      s.onerror = () => reject(new Error('pdf.js introuvable (connexion Internet requise pour ce chargement)'));
      document.head.appendChild(s);
    });
    return pdfjsLoading;
  }
  // --- Extraction VECTORIELLE d'un PDF (traits réels, mesurables) ---------------
  // Beaucoup de PDF d'architecture (tracés AutoCAD) contiennent les lignes en
  // vecteurs. On lit la liste d'opérateurs pdf.js, on suit la matrice courante
  // (CTM) et on convertit chemins -> polylignes QlygoCAD. Un PDF scanné (sans
  // vecteurs) retombe sur l'import image.
  function pdfRgb(a) {
    const to = v => Math.max(0, Math.min(255, Math.round(v > 1 ? v : v * 255)));
    let r = 0, g = 0, b = 0;
    if (a && a.length >= 3) { r = to(a[0]); g = to(a[1]); b = to(a[2]); }
    if (r < 32 && g < 32 && b < 32) return '#000000';   // quasi-noir -> noir pur (inversé en blanc sur fond sombre)
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function pdfGray(a) { const g = a && a.length ? Math.max(0, Math.min(255, Math.round((a[0] > 1 ? a[0] : a[0] * 255)))) : 0; return (g < 32) ? '#000000' : '#' + [g, g, g].map(v => v.toString(16).padStart(2, '0')).join(''); }
  function extractPdfVectors(opList, OPS) {
    const MM = 0.352777;                 // 1 pt PDF = 0,3527 mm
    const out = [];
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
    let strokeCol = '#000000', fillCol = '#000000';
    let sub = [], cur = null, lastX = 0, lastY = 0;
    const apply = (x, y) => ({ x: (ctm[0] * x + ctm[2] * y + ctm[4]) * MM, y: (ctm[1] * x + ctm[3] * y + ctm[5]) * MM });
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const newSub = (x, y) => { cur = { pts: [apply(x, y)], closed: false }; sub.push(cur); lastX = x; lastY = y; };
    const lineTo = (x, y) => { if (!cur) newSub(x, y); else { cur.pts.push(apply(x, y)); lastX = x; lastY = y; } };
    const bez = (x0, y0, c1x, c1y, c2x, c2y, x, y) => { const N = 8; for (let i = 1; i <= N; i++) { const t = i / N, mt = 1 - t; cur.pts.push(apply(mt * mt * mt * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x, mt * mt * mt * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y)); } lastX = x; lastY = y; };
    const flush = kind => { for (const s of sub) { if (s.pts.length < 2) continue; out.push({ points: s.pts, color: (kind === 'fill' ? fillCol : strokeCol), closed: s.closed || kind === 'fill', fill: kind === 'fill' }); if (out.length > 120000) break; } sub = []; cur = null; };
    const fn = opList.fnArray, ar = opList.argsArray;
    for (let i = 0; i < fn.length; i++) {
      const op = fn[i], a = ar[i];
      if (op === OPS.save) stack.push(ctm.slice());
      else if (op === OPS.restore) { if (stack.length) ctm = stack.pop(); }
      else if (op === OPS.transform) ctm = mul(ctm, a);
      else if (op === OPS.setStrokeRGBColor) strokeCol = pdfRgb(a);
      else if (op === OPS.setFillRGBColor) fillCol = pdfRgb(a);
      else if (op === OPS.setStrokeGray) strokeCol = pdfGray(a);
      else if (op === OPS.setFillGray) fillCol = pdfGray(a);
      else if (op === OPS.constructPath) {
        const ops2 = a[0], c = a[1]; let k = 0;
        for (let j = 0; j < ops2.length; j++) {
          const s = ops2[j];
          if (s === OPS.moveTo) newSub(c[k++], c[k++]);
          else if (s === OPS.lineTo) lineTo(c[k++], c[k++]);
          else if (s === OPS.curveTo) { const c1x = c[k++], c1y = c[k++], c2x = c[k++], c2y = c[k++], x = c[k++], y = c[k++]; if (cur) bez(lastX, lastY, c1x, c1y, c2x, c2y, x, y); else { lastX = x; lastY = y; } }
          else if (s === OPS.curveTo2) { const c2x = c[k++], c2y = c[k++], x = c[k++], y = c[k++]; if (cur) bez(lastX, lastY, lastX, lastY, c2x, c2y, x, y); else { lastX = x; lastY = y; } }
          else if (s === OPS.curveTo3) { const c1x = c[k++], c1y = c[k++], x = c[k++], y = c[k++]; if (cur) bez(lastX, lastY, c1x, c1y, x, y, x, y); else { lastX = x; lastY = y; } }
          else if (s === OPS.rectangle) { const x = c[k++], y = c[k++], w = c[k++], h = c[k++]; sub.push({ pts: [apply(x, y), apply(x + w, y), apply(x + w, y + h), apply(x, y + h)], closed: true }); cur = null; lastX = x; lastY = y; }
          else if (s === OPS.closePath) { if (cur) cur.closed = true; }
        }
      }
      else if (op === OPS.stroke || op === OPS.closeStroke) flush('stroke');
      else if (op === OPS.fill || op === OPS.eoFill || op === OPS.fillStroke || op === OPS.eoFillStroke || op === OPS.closeFillStroke) flush('fill');
      else if (op === OPS.endPath) { sub = []; cur = null; }
      if (out.length > 120000) break;
    }
    return out;
  }
  // Un aplat gris/blanc clair = fond de page (à ignorer) ; une couleur saturée
  // (jaune maison, bleu parcelle…) = vraie zone à remplir.
  function isBackgroundFill(hex) {
    const c = hx(hex), mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255, sat = mx ? (mx - mn) / mx : 0;
    return lum > 0.80 && sat < 0.12;
  }
  function placePdfVectors(vecs) {
    pushHistory();
    // bornes calculées sur les traits NON-fond (évite qu'un grand aplat de fond fausse le cadrage)
    let minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18, useful = 0;
    for (const v of vecs) { if (v.fill && isBackgroundFill(v.color)) continue; useful++; for (const p of v.points) { if (p.x < minx) minx = p.x; if (p.y < miny) miny = p.y; if (p.x > maxx) maxx = p.x; if (p.y > maxy) maxy = p.y; } }
    if (!isFinite(minx)) { for (const v of vecs) for (const p of v.points) { if (p.x < minx) minx = p.x; if (p.y < miny) miny = p.y; if (p.x > maxx) maxx = p.x; if (p.y > maxy) maxy = p.y; } }
    const wMm = (maxx - minx) || 1, hMm = (maxy - miny) || 1;
    const vcx = view.panXmm + view.canvasW / view.pxPerMm / 2, vcy = view.panYmm + view.canvasH / view.pxPerMm / 2;
    const ox = vcx - (minx + maxx) / 2, oy = vcy - (miny + maxy) / 2;      // recentrer dans la vue
    const layFill = ensureLayer('PDF - zones', '#d9b24a'), layLine = ensureLayer('PDF - traits', '#9fb0d0');
    let nFill = 0, nLine = 0;
    for (const v of vecs) {
      const pts = v.points.map(p => ({ x: p.x + ox, y: p.y + oy }));
      if (v.fill) {
        if (isBackgroundFill(v.color) || pts.length < 3) continue;          // on saute le fond de page
        // Zone PLEINE (ex. maison jaune) -> hachure pleine sélectionnable d'un bloc.
        scene.entities.push({ type: 'hatch', points: pts, pattern: 'solid', color: v.color, spacingMm: 300, angleDeg: 45, layer: layFill }); nFill++;
      } else { scene.entities.push({ type: 'polyline', points: pts, layer: layLine, color: v.color, penMm: 0.25, closed: !!v.closed }); nLine++; }
    }
    renderLayerSelect(); refreshLayers(); setActivePage('model');
    const pad = Math.max(wMm, hMm) * 0.08;
    view.pxPerMm = Math.min(view.canvasW / (wMm + 2 * pad), view.canvasH / (hMm + 2 * pad));
    view.panXmm = minx + ox - pad; view.panYmm = miny + oy - pad; paint();
    echo('✅ PDF vectorisé : <b>' + nLine + ' traits</b> + <b>' + nFill + ' zones pleines</b> (maison, parcelle…) — sélectionnables d’un bloc et mesurables.');
    echo('⚠ Plan à l’échelle du tracé papier : utilise l’outil <b>ÉCHELLE</b> (2 points dont tu connais la longueur réelle) pour le passer en taille réelle.');
  }
  function rasterizePdfPage(page, vp1) {
    const vp = page.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.then(() => {
      const src = c.toDataURL('image/png'), wMm = vp1.width * 0.352777, hMm = vp1.height * 0.352777;
      pushHistory();
      const id = ensureLayer('PDF - fond de plan', '#9fb0d0');
      const vcx = view.panXmm + view.canvasW / view.pxPerMm / 2, vcy = view.panYmm + view.canvasH / view.pxPerMm / 2;
      const x0 = vcx - wMm / 2, y0 = vcy - hMm / 2;
      scene.entities.unshift({ type: 'image', points: [{ x: x0, y: y0 }, { x: x0 + wMm, y: y0 + hMm }], src, layer: id, opacity: 0.92 });
      renderLayerSelect(); refreshLayers(); setActivePage('model');
      const pad = Math.max(wMm, hMm) * 0.1;
      view.pxPerMm = Math.min(view.canvasW / (wMm + 2 * pad), view.canvasH / (hMm + 2 * pad));
      view.panXmm = x0 - pad; view.panYmm = y0 - pad; paint();
      echo('📑 PDF importé en image (' + (wMm / 1000).toFixed(2) + ' × ' + (hMm / 1000).toFixed(2) + ' m) — déplaçable par les poignées.');
    });
  }
  function importPDFFile(file) {
    echo('📑 Lecture du PDF (extraction des traits vectoriels)…');
    const rd = new FileReader();
    rd.onload = () => {
      const buf = rd.result;
      loadPdfJs().then(pdfjsLib => pdfjsLib.getDocument({ data: buf }).promise.then(pdf => pdf.getPage(1).then(page =>
        page.getOperatorList().then(opList => {
          let vecs = [];
          try { vecs = extractPdfVectors(opList, pdfjsLib.OPS); } catch (e) { vecs = []; }
          const vp1 = page.getViewport({ scale: 1 });
          if (vecs.length >= 4) { placePdfVectors(vecs); return; }
          echo('ℹ️ Pas de traits vectoriels exploitables (PDF probablement scanné) — import en image.');
          return rasterizePdfPage(page, vp1);
        })
      ))).catch(err => echo('⚠ Import PDF échoué : ' + (err && err.message ? err.message : err)));
    };
    rd.onerror = () => echo('⚠ Lecture du PDF impossible.');
    rd.readAsArrayBuffer(file);
  }

  // Hook de debug (tests + diagnostic) : lecture seule des états internes.
  try { window.QCAD_DEBUG = { scene, view, get tool() { return tool; }, get selected() { return selected; }, get draft() { return draft; }, get op() { return op; }, get opGhost() { return opGhost; }, get snapInfo() { return snapInfo; }, get currentLayer() { return currentLayer; }, get baseLayer() { return baseLayer; }, get filletFirst() { return filletFirst; }, get matchSrc() { return matchSrc; }, get stretchOp() { return stretchOp; }, get viewStack() { return viewStack; }, nearScene, cullScene, queryIndex, markSceneDirty, tolMm, layVisible, layPickable, layerById, extractPdfVectors, placePdfVectors, isBackgroundFill, explodeSel, joinSel, closeSel, applyFillet, applyMatch, pickAnyAt, arrayRect, createLayout, editLayoutFields, ensureLayer, get pages() { return pages; }, get activePage() { return activePage; }, setTool, runCommand }; } catch (e) { }

  // ---------- Démarrage ----------
  cv.tabIndex = 0;
  echo('Bienvenue dans QlygoCAD. Unités : <b>mètres</b>. Choisis un plan ou crée-en un nouveau.');
  R.onImageLoad = paint;   // repeindre quand une image de fond (PDF) a fini de charger
  initColorUI();
  initFiles();
  renderLayerSelect();
  renderPageTabs();
  setTool('select'); resize();
  // On démarre sur le plan de base QLYGO_CAD ; si indisponible, on bascule sur l'accueil.
  loadBasePlan().catch(err => { echo('⚠ Plan de base indisponible (' + (err && err.message || err) + ').'); showHome(); });
})();
