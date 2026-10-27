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
  let lastSelBox = null;   // dernière zone de sélection (cadre) — sert à ÉTIRER : seuls les sommets DEDANS bougent
  let boxPending = null;        // sélection « clic → déplace → clic » (sans maintenir le bouton)
  let pasteOp = null;           // collage en cours : l'objet suit le curseur jusqu'au clic
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
  let pageDrag = null, vpDrag = null, lastMidDown = 0;
  let selVp = -1;   // zone de plan sélectionnée sur une mise en page (contour jaune, zoom ciblé)
  let hatchPattern = 'lines', hatchSpacing = 300; // motif + échelle (mm) des hachures
  let trimPreview = null;       // aperçu Ajuster/Prolonger (projection colorée)
  let trimDrag = null;          // Ajuster « au lasso » : clic gauche maintenu + glisser pour effacer les traits croisés
  let history = [], redoStack = []; // pile d'annulation (Ctrl+Z / Ctrl+Y)
  let textPt = null, currentTextH = 800, txtEl = null; // outil Texte : point d'insertion + hauteur + champ de saisie
  let textStart = null, textZone = null, textZoneGhost = null; // Texte : tracé d'une ZONE (rectangle) + alignement
  function curTxtAlign() { const el = $('txtalign'); return el ? el.value : 'left'; }
  function curTxtVAlign() { const el = $('txtvalign'); return el ? el.value : 'top'; }
  let dimSeg = null;            // outil Cote : segment verrouillé (clic 1) dont on règle l'écartement
  let dimPts = [];              // outil Cote « point à point » : 1er point capturé (clic hors trait)
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
  // SÉLECTIONNABLE : même verrouillé, on peut le sélectionner (pour voir son calque)
  // et s'y accrocher. MODIFIABLE : seulement si non verrouillé (déplacement/édition).
  function layPickable(id) { const l = layerById(id); return l.visible && !l.frozen; }
  function layMovable(id) { const l = layerById(id); return l.visible && !l.frozen && !l.locked; }
  function visibleScene() { const m = {}; for (const l of scene.layers) m[l.id] = l.visible && !l.frozen; return { layers: scene.layers, entities: scene.entities.filter(e => m[e.layer] && !e._lib) }; }
  function pickScene() { return { layers: scene.layers, entities: scene.entities.filter(e => layPickable(e.layer) && entInView(e)) }; }
  // Entités PICKABLES proches d'un point (fenêtre locale). Indispensable pour que
  // l'accrochage/osnap ne calcule pas en O(n²) sur 100k+ entités (sinon crash instantané).
  function pickFlagMap() { const m = {}; for (const l of scene.layers) m[l.id] = l.visible && !l.frozen; return m; }

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
      const e = ents[i]; e._ix = i;   // ordre d'insertion (pour « le plus récent sélectionnable en premier »)
      const b = R._bbox(e); if (b[0] < -1e16) continue;
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
    for (let i = 0; i < cand.length; i++) { const e = cand[i]; if (!pick[e.layer] || !entInView(e)) continue; const b = R._bbox(e); if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue; out.push(e); }
    return { layers: scene.layers, entities: out };
  }
  // Scène réduite aux entités visibles DANS la fenêtre d'affichage (pour le cache).
  function cullScene() {
    const W = view.canvasW, H = view.canvasH;
    const x0 = view.panXmm, y0 = view.panYmm, x1 = view.panXmm + W / view.pxPerMm, y1 = view.panYmm + H / view.pxPerMm;
    const pad = Math.max(1, (x1 - x0) * 0.04);
    const cand = queryIndex(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
    const m = {}; for (const l of scene.layers) m[l.id] = l.visible && !l.frozen;   // en Objet, on voit tout (y compris le calque « Zones liées »)
    const out = []; for (let i = 0; i < cand.length; i++) { const e = cand[i]; if (m[e.layer] && entInView(e)) out.push(e); }
    return { layers: scene.layers, entities: out };
  }
  function nearEnt(ent) { const b = R._bbox(ent), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, r = Math.max(b[2] - b[0], b[3] - b[1]) / 2 + 50 / view.pxPerMm; return nearScene({ x: cx, y: cy }, r).entities; }
  function scaleDenom() { return parseInt($('scale').value, 10); }
  function tolMm() { return 12 / view.pxPerMm; }
  // Tolérance de SÉLECTION serrée (précision au pixel près) : on ne capte qu'un seul
  // trait, celui réellement sous le curseur, même quand plusieurs se côtoient.
  function selTolMm() { return 3 / view.pxPerMm; }
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
  // Ruban à l'ÉCHELLE : on garde une seule rangée de sections et on la réduit
  // proportionnellement pour tenir sur toute la largeur -> mêmes proportions sur
  // petit et grand écran, et la zone de travail garde toute la place qui reste.
  function fitRibbon() {
    const rp = $('rpanels'); if (!rp) { resize(); return; }
    rp.style.transform = 'none'; rp.style.height = 'auto';
    const natW = rp.scrollWidth || rp.offsetWidth, natH = rp.scrollHeight || rp.offsetHeight;
    const avail = document.documentElement.clientWidth || window.innerWidth;
    let s = natW > 0 ? Math.min(1, avail / natW) : 1; if (!isFinite(s) || s <= 0) s = 1;
    rp.style.transform = 'scale(' + s + ')';
    rp.style.height = Math.ceil(natH * s) + 'px';
    resize();
  }
  window.addEventListener('resize', fitRibbon);

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
    if (pasteOp) { cursor = compute(lastScreen.x, lastScreen.y); $('coords').textContent = fmtM3(cursor.x) + ' , ' + fmtM3(cursor.y) + ' m'; updatePasteGhost(); paintOverlay(); return; }
    if (tool === 'select') return handleSelectMove();
    if (op) return opMove();
    if (tool === 'circle') return circleMove();
    if (tool === 'text' && textStart) { const raw = snapPoint(R.screenToWorld(view, lastScreen.x, lastScreen.y), null); textZoneGhost = { a: textStart.w, b: raw }; $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m'; paintOverlay(); return; }
    if (tool === 'trim') return trimDrag ? trimDragMove(e) : hoverTrim(e);
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
    // Survol en mode Sélection : on met en évidence le SEUL trait sous le curseur
    // (pick au pixel près) pour montrer exactement ce qui sera sélectionné au clic.
    if (tool === 'select' && !gripDrag && !boxPending && !selecting && !pasteOp) {
      hoverEnt = pickAnyAt(R.screenToWorld(view, lastScreen.x, lastScreen.y));
    } else if (tool === 'select') { hoverEnt = null; }
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
    } else if (dimPts.length) {   // mode « point à point » : 2e point en cours (accroché)
      const p = snapPoint(raw, dimPts[0]);
      dimHover = { a: dimPts[0], b: p };
      dimPreview = null;
      dynread.innerHTML = '📏 point à point : <b>' + fmtM(dist(dimPts[0], p)) + ' m</b> — cliquez le 2e point';
      editMode(false); dyn.style.display = 'block'; placeDyn();
    } else {
      // Maj enfoncée -> on N'ACCROCHE PAS le trait : mode « point à point » (on vise un point).
      const seg = shiftDown ? null : SN.pickSegment(nearScene(raw), raw, 10 / view.pxPerMm);
      if (seg) {
        const side = sideOf(raw, seg);
        dimHover = { a: seg.a, b: seg.b };
        dimPreview = { type: 'dim', points: [seg.a, seg.b], offMm: side * 800, color: '#b9375e', textMm: currentDimSize };
        dynread.innerHTML = '📏 <b>' + fmtM(dist(seg.a, seg.b)) + ' m</b> — cliquez le trait à coter · <b>Maj</b> = point à point';
        editMode(false); dyn.style.display = 'block'; placeDyn();
      } else {
        // mode point : on montre l'accroche du 1er point (Maj force ce mode même sur un trait)
        snapPoint(raw, null); dimHover = dimPreview = null;
        dynread.innerHTML = '📏 ' + (shiftDown ? '<b>Maj</b> — ' : '') + 'cliquez un point (cote point à point)';
        editMode(false); dyn.style.display = 'block'; placeDyn();
      }
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

  // ---------- Hachures : masquage temporaire du quadrillage + calques de zones ----------
  // Pendant qu'on hachure, on masque le quadrillage de fond et les calques de
  // « zones »/guides (ex. Zones liées, un calque « Quadrillage »…) : ils n'entrent
  // plus dans la détection du contour et ne gênent plus le remplissage. Tout est
  // rétabli dès qu'on quitte l'outil Hachures.
  let hatchHidden = null;
  function enterHatchHide() {
    if (hatchHidden) return;
    const rec = { grid: isOn('grid'), layers: [] };
    if (rec.grid) { const g = $('grid'); if (g) g.classList.remove('active'); }
    scene.layers.forEach(l => {
      const nm = l.name || '';
      const hideIt = l.id === MEP_LAYER_ID || /quadrill/i.test(nm) || /zones?\s*li/i.test(nm) || /zone.*trait|trait.*zone/i.test(nm);
      if (hideIt && l.visible) { rec.layers.push(l.id); l.visible = false; }
    });
    hatchHidden = rec;
    if (rec.grid || rec.layers.length) { renderLayerSelect(); renderLayersPanel(); paint(); echo('▦ Quadrillage et calques de zones masqués le temps de hachurer (rétablis en quittant l’outil).'); }
  }
  function exitHatchHide() {
    if (!hatchHidden) return;
    const rec = hatchHidden; hatchHidden = null;
    if (rec.grid && !isOn('grid')) { const g = $('grid'); if (g) g.classList.add('active'); }
    rec.layers.forEach(id => { const l = scene.layers.find(x => x.id === id); if (l) l.visible = true; });
    if (rec.grid || rec.layers.length) { renderLayerSelect(); renderLayersPanel(); paint(); }
  }
  function hoverHatch() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    // La zone à hachurer peut être GRANDE (toute une façade) : on cherche le contour
    // sur toute l'étendue VISIBLE, pas juste autour du curseur (sinon les bords
    // éloignés de la zone manquent et aucun contour fermé n'est trouvé).
    const padMm = Math.max(view.canvasW, view.canvasH) / view.pxPerMm;
    const reg = SN.findRegion(nearScene(raw, padMm), raw, 2);
    hatchHover = (reg && reg.outer) ? { points: reg.outer, holes: reg.holes || [] } : null;
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m';
    dynread.innerHTML = hatchHover ? '▦ <b>cliquez pour hachurer</b> (' + hatchPatternName() + ')' : '▦ survolez une zone fermée (délimitée par des traits)';
    editMode(false); dyn.style.display = 'block'; placeDyn(); paintOverlay();
  }
  function hatchPatternName() { return { solid: 'pleine', lines: 'lignes 45°', vert: 'verticales', horiz: 'horizontales', cross: 'croisées', briques: 'briques', tiles: 'briques', tuiles: 'tuiles' }[hatchPattern] || hatchPattern; }
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
    if (g.kind === 'edge') return { x: (e.points[g.i].x + e.points[g.j].x) / 2, y: (e.points[g.i].y + e.points[g.j].y) / 2 };
    if (g.kind === 'dimoff') { const gg = G.dimGeometry(e); return { x: gg.mid.x, y: gg.mid.y }; }
    if (g.kind === 'dimend') return { x: e.points[g.index].x, y: e.points[g.index].y };
    return null;
  }

  function hitGrip(sx, sy) {
    const near = (wx, wy) => { const s = R.worldToScreen(view, wx, wy); return Math.hypot(s.x - sx, s.y - sy) <= 11; };
    for (const e of selected) {
      if (e.type === 'hatch' || !layMovable(e.layer)) continue;   // verrouillé : pas de poignées (non déplaçable)
      // Une COTE expose 3 poignées : son ÉCARTEMENT (milieu de la ligne de cote) + ses
      // DEUX EXTRÉMITÉS. Déplacer une extrémité DÉTACHE ce point du trait (copie
      // indépendante) : la cote bouge, le trait non. Redimensionner le trait par SES
      // propres poignées met la cote à jour tant qu'on n'a pas détaché l'extrémité.
      if (e.type === 'dim') {
        const g = G.dimGeometry(e);
        if (near(g.mid.x, g.mid.y)) return { ent: e, kind: 'dimoff' };
        for (let i = 0; i < e.points.length; i++) if (near(e.points[i].x, e.points[i].y)) return { ent: e, kind: 'dimend', index: i };
        continue;
      }
      for (let i = 0; i < e.points.length; i++) if (near(e.points[i].x, e.points[i].y)) return { ent: e, kind: 'vertex', index: i };
      else if (e.type !== 'hatch' && e.points.length === 2) { const m = { x: (e.points[0].x + e.points[1].x) / 2, y: (e.points[0].y + e.points[1].y) / 2 }; if (near(m.x, m.y)) return { ent: e, kind: 'mid' }; }
      else if (e.type !== 'dim' && e.type !== 'hatch' && e.points.length > 2) {   // milieu de côté : déplace tout le côté
        const n = e.points.length, edges = e.closed ? n : n - 1;
        for (let i = 0; i < edges; i++) { const j = (i + 1) % n; const mx = (e.points[i].x + e.points[j].x) / 2, my = (e.points[i].y + e.points[j].y) / 2; if (near(mx, my)) return { ent: e, kind: 'edge', i, j }; }
      }
    }
    return null;
  }
  // Édition par poignée AVEC PROJECTION : le trait d'origine reste FIGÉ (surbrillance
  // bleue) et on affiche un FANTÔME orange (opGhost) à la position future. Rien n'est
  // modifié tant qu'on n'a pas déposé (2e clic) -> on voit toujours « avant / après ».
  function dragGrip(raw) {
    const e = gripDrag.ent, orig = gripDrag.origAll;
    if (gripDrag.kind === 'vertex') {
      // Ortho (F8) : contrainte H/V. Trait = par rapport à l'autre extrémité ; polyligne = par rapport à la position d'origine du sommet.
      const from = orig.length === 2 ? orig[1 - gripDrag.index] : orig[gripDrag.index];
      const p = snapPoint(raw, from);
      const gp = orig.map(q => ({ x: q.x, y: q.y })); gp[gripDrag.index] = { x: p.x, y: p.y };
      opGhost = [{ points: gp, closed: e.closed }]; gripDrag.ghost = gp; hotGrip = { x: p.x, y: p.y };
    } else if (gripDrag.kind === 'mid') {
      const p = snapPoint(raw, gripDrag.start);   // ortho F8 = par rapport au point saisi
      const dx = p.x - gripDrag.start.x, dy = p.y - gripDrag.start.y;
      const gp = orig.map(q => ({ x: q.x + dx, y: q.y + dy }));
      opGhost = [{ points: gp, closed: e.closed }]; gripDrag.ghost = gp; hotGrip = { x: (gp[0].x + gp[1].x) / 2, y: (gp[0].y + gp[1].y) / 2 };
    } else if (gripDrag.kind === 'edge') {   // déplace le côté entier (2 sommets) -> étire le rectangle
      const p = snapPoint(raw, gripDrag.start);   // ortho F8 = étire bien droit (H/V)
      const dx = p.x - gripDrag.start.x, dy = p.y - gripDrag.start.y;
      const gp = orig.map(q => ({ x: q.x, y: q.y })); const i = gripDrag.i, j = gripDrag.j;
      gp[i] = { x: orig[i].x + dx, y: orig[i].y + dy }; gp[j] = { x: orig[j].x + dx, y: orig[j].y + dy };
      opGhost = [{ points: gp, closed: e.closed }]; gripDrag.ghost = gp; hotGrip = { x: (gp[i].x + gp[j].x) / 2, y: (gp[i].y + gp[j].y) / 2 };
    } else if (gripDrag.kind === 'dimoff') {
      const a = orig[0], b = orig[1], dxu = b.x - a.x, dyu = b.y - a.y, L = Math.hypot(dxu, dyu) || 1;
      const nx = -dyu / L, ny = dxu / L;
      gripDrag.newOff = (raw.x - a.x) * nx + (raw.y - a.y) * ny;
      dimHover = { a: a, b: b };
      dimPreview = { type: 'dim', points: [a, b], offMm: gripDrag.newOff, color: '#eda020', textMm: e.textMm || 2.5, dec: e.dec, arrow: e.arrow };
      hotGrip = null;
    } else if (gripDrag.kind === 'dimend') {   // déplacer une EXTRÉMITÉ de la cote (fantôme)
      const i = gripDrag.index, orig = gripDrag.origAll, other = orig[1 - i];
      const p = snapPoint(raw, other);         // accrochage + ortho par rapport à l'autre extrémité
      const pts = (i === 0) ? [{ x: p.x, y: p.y }, { x: orig[1].x, y: orig[1].y }] : [{ x: orig[0].x, y: orig[0].y }, { x: p.x, y: p.y }];
      dimHover = { a: pts[0], b: pts[1] };
      dimPreview = { type: 'dim', points: pts, offMm: e.offMm, color: '#eda020', hMm: e.hMm, valMm: e.valMm, dec: e.dec, arrow: e.arrow };
      gripDrag.newPt = { i, x: p.x, y: p.y }; hotGrip = { x: p.x, y: p.y };
    }
    // Texte en ZONE : fantôme = RECTANGLE (les 2 points sont des coins opposés).
    if (e.type === 'text' && e.zone && gripDrag.ghost && gripDrag.ghost.length >= 2) {
      const g0 = gripDrag.ghost[0], g1 = gripDrag.ghost[1];
      opGhost = [{ points: [{ x: g0.x, y: g0.y }, { x: g1.x, y: g0.y }, { x: g1.x, y: g1.y }, { x: g0.x, y: g1.y }], closed: true }];
    }
  }
  // Dépose : applique au vrai objet la position du fantôme, puis reconstruit le cache.
  function applyGrip() {
    const e = gripDrag.ent;
    if (gripDrag.kind === 'vertex' && gripDrag.ghost) { const i = gripDrag.index; e.points[i].x = gripDrag.ghost[i].x; e.points[i].y = gripDrag.ghost[i].y; }
    else if (gripDrag.kind === 'mid' && gripDrag.ghost) { e.points[0].x = gripDrag.ghost[0].x; e.points[0].y = gripDrag.ghost[0].y; e.points[1].x = gripDrag.ghost[1].x; e.points[1].y = gripDrag.ghost[1].y; }
    else if (gripDrag.kind === 'edge' && gripDrag.ghost) { const i = gripDrag.i, j = gripDrag.j; e.points[i].x = gripDrag.ghost[i].x; e.points[i].y = gripDrag.ghost[i].y; e.points[j].x = gripDrag.ghost[j].x; e.points[j].y = gripDrag.ghost[j].y; }
    else if (gripDrag.kind === 'dimoff' && gripDrag.newOff != null) e.offMm = gripDrag.newOff;
    else if (gripDrag.kind === 'dimend' && gripDrag.newPt) {
      // on REMPLACE la référence du point par une copie indépendante -> la cote se
      // déplace sans toucher au trait (détachement propre).
      e.points[gripDrag.newPt.i] = { x: gripDrag.newPt.x, y: gripDrag.newPt.y };
    }
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
    } else if (gripDrag.kind === 'edge') {   // côté : déplace les 2 sommets dans le sens visé (étire de vm)
      let ux = cur.x - gripDrag.start.x, uy = cur.y - gripDrag.start.y; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
      const i = gripDrag.i, j = gripDrag.j;
      e.points[i].x = orig[i].x + ux * vm; e.points[i].y = orig[i].y + uy * vm;
      e.points[j].x = orig[j].x + ux * vm; e.points[j].y = orig[j].y + uy * vm;
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
      lastSelBox = null;                   // clic = pas de zone -> Étirer se comporterait comme Déplacer
    } else {                               // fenêtre (bleu) ou capture (vert)
      hits = SN.boxSelect(pickScene(), selStart.w, raw, lastScreen.x < selStart.sx);
      selected = add ? selected.concat(hits.filter(h => selected.indexOf(h) < 0)) : hits;
      // mémorise la ZONE : pour ÉTIRER, seuls les sommets situés DEDANS se déplaceront.
      lastSelBox = { x0: Math.min(selStart.w.x, raw.x), y0: Math.min(selStart.w.y, raw.y), x1: Math.max(selStart.w.x, raw.x), y1: Math.max(selStart.w.y, raw.y) };
    }
    echo(selMsg()); refreshProps(); syncCurrentLayer(); syncTextControls();
  }
  // Message de sélection : indique le calque (et s'il est verrouillé = non déplaçable).
  function selMsg() {
    const n = selected.length; if (!n) return '*Aucune sélection*';
    if (n === 1) { const l = layerById(selected[0].layer); return '1 objet — calque « ' + l.name + ' »' + (l.locked ? ' 🔒 verrouillé (sélectionnable, non déplaçable)' : ''); }
    const lk = selected.filter(e => !layMovable(e.layer)).length;
    return n + ' objets sélectionnés' + (lk ? ' (dont ' + lk + ' 🔒 verrouillé(s))' : '') + '.';
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
  // Canvas de mesure (largeur réelle des glyphes) pour ne sélectionner un texte
  // QUE si le curseur est sur les CARACTÈRES, pas sur la zone vide autour.
  let _txtMeasCtx = null;
  function txtMeasure(txt, font) { if (!_txtMeasCtx) _txtMeasCtx = document.createElement('canvas').getContext('2d'); _txtMeasCtx.font = font; return _txtMeasCtx.measureText(txt).width; }
  // Rectangles-glyphes (en pixels écran) d'un texte, ligne par ligne — même mise en
  // page que R.drawText (alignement + zone), avec marge de tolérance de PAD px.
  function textGlyphRects(e, PAD) {
    const px = Math.max(5, (e.hMm || 800) * view.pxPerMm), lineH = px * 1.2;
    const lines = String(e.text).split('\n'), totalH = lines.length * lineH;
    const align = e.align || 'left', valign = e.valign || 'top';
    const font = '600 ' + px + 'px ' + (e.font || 'system-ui,Segoe UI,sans-serif');
    let ax, topY;
    if (e.zone && e.points.length >= 2) {
      const a = R.worldToScreen(view, e.points[0].x, e.points[0].y), b = R.worldToScreen(view, e.points[1].x, e.points[1].y);
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      ax = align === 'center' ? (x0 + x1) / 2 : align === 'right' ? x1 : x0;
      topY = valign === 'middle' ? (y0 + y1) / 2 - totalH / 2 : valign === 'bottom' ? (y1 - totalH) : y0;
    } else {
      const s = R.worldToScreen(view, e.points[0].x, e.points[0].y);
      ax = s.x; topY = valign === 'middle' ? s.y - totalH / 2 : valign === 'bottom' ? s.y - totalH : s.y;
    }
    const rects = [];
    lines.forEach((ln, i) => {
      if (!ln) return;
      const w = txtMeasure(ln, font);
      const lx = align === 'center' ? ax - w / 2 : align === 'right' ? ax - w : ax;
      const top = topY + i * lineH;          // haut de cellule (≈ sommet des capitales)
      rects.push({ x0: lx - PAD, x1: lx + w + PAD, y0: top - PAD, y1: top + px * 1.15 + PAD });
    });
    return rects;
  }
  function pickTextAt(pt) {
    const cand = nearScene(pt, 50 / view.pxPerMm).entities;
    const ps = R.worldToScreen(view, pt.x, pt.y);
    for (let i = cand.length - 1; i >= 0; i--) {
      const e = cand[i]; if (e.type !== 'text' || !e.text) continue;
      const rects = textGlyphRects(e, 4);     // 4 px de tolérance autour des glyphes
      for (const r of rects) if (ps.x >= r.x0 && ps.x <= r.x1 && ps.y >= r.y0 && ps.y <= r.y1) return e;
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
  function pickAnyAt(raw) { return pickDimAt(raw) || SN.pickEntity(nearScene(raw), raw, selTolMm()) || pickTextAt(raw) || pickHatchAt(raw) || pickImageAt(raw); }
  // Sélection d'une COTE par sa géométrie VISIBLE (ligne de cote décalée, lignes
  // d'attache, zone du texte) -> on clique vraiment « sur la cote », indépendamment
  // du trait qu'elle mesure.
  function pickDimAt(raw) {
    const tol = selTolMm(); let best = null;
    for (const e of scene.entities) {
      if (e.type !== 'dim' || e._lib || !layPickable(e.layer)) continue;
      const g = G.dimGeometry(e);
      let dmin = Infinity;
      const segs = [[g.da, g.db], [g.extA[0], g.extA[1]], [g.extB[0], g.extB[1]]];
      for (const [a, b] of segs) { const f = footOnSeg(raw, a, b); const d = dist(raw, f); if (d < dmin) dmin = d; }
      // zone du texte (au milieu de la ligne de cote)
      const h = R.dimHmm ? R.dimHmm(e) : 400; if (dist(raw, g.mid) < h * 1.4) dmin = 0;
      if (dmin <= tol && (!best || dmin < best.d)) best = { e, d: dmin };
    }
    return best ? best.e : null;
  }

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
      if (!layMovable(e.layer) || e.type === 'image' || e.type === 'hatch') continue;   // verrouillé = non étirable
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
  // Sous-ensemble DÉPLAÇABLE de la sélection : on peut sélectionner des traits
  // verrouillés (pour voir leur calque), mais ils ne bougent pas — seuls les traits
  // non verrouillés se déplacent. Le trait verrouillé reste en place.
  function movableSel() { return selected.filter(e => layMovable(e.layer)); }
  function ghostOf(fn) { return movableSel().map(e => ({ points: e.points.map(fn), closed: e.closed })); }

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
    const mv = movableSel(); pushHistory(mv.length ? mv : selected);
    scaleEnts(mv, op.base.x, op.base.y, f);
    echo('✅ Mis à l’échelle ×' + f.toFixed(4).replace('.', ',') + ' (' + mv.length + ' objet(s)).');
    opGhost = null; guide = null; endOp(); paint();
  }
  function commitOp(p) {
    const mv = movableSel(); const lockedN = selected.length - mv.length;
    pushHistory(mv.length ? mv : selected);
    const note = lockedN ? ' (' + lockedN + ' verrouillé(s) non déplacé(s))' : '';
    if (op.cmd === 'move') { translateEnts(mv, p.x - op.base.x, p.y - op.base.y); echo('Déplacé.' + note); endOp(); }
    else if (op.cmd === 'copy') { const c = mv.map(cloneEntity); c.forEach(e => scene.entities.push(e)); translateEnts(c, p.x - op.base.x, p.y - op.base.y); echo('Copié (Échap pour finir).' + note); }
    else if (op.cmd === 'rotate') { const ang = Math.atan2(p.y - op.base.y, p.x - op.base.x); rotateEnts(mv, op.base.x, op.base.y, ang); echo('Pivoté de ' + Math.round(ang * 180 / Math.PI) + '°.' + note); endOp(); }
    else if (op.cmd === 'mirror') { const c = mv.map(cloneEntity); c.forEach(e => scene.entities.push(e)); mirrorEnts(c, op.p1.x, op.p1.y, p.x, p.y); selected = c; echo('Miroir créé.' + note); endOp(); }
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
      : (ent ? '✂️ <b>Ajuster</b> ce trait · maintiens & glisse = effacer plusieurs traits' : '✂️ Ajuster — clique un trait, ou <b>maintiens le clic et glisse</b> sur les traits à effacer (Maj = Prolonger)');
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
    if (textZoneGhost) {   // zone de texte en cours de tracé
      const a = R.worldToScreen(view, textZoneGhost.a.x, textZoneGhost.a.y), b = R.worldToScreen(view, textZoneGhost.b.x, textZoneGhost.b.y);
      ctx.save(); ctx.strokeStyle = '#eda020'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.restore();
    }
    if (trimDrag && trimDrag.path.length > 1) {   // traînée du lasso : vert = prolonger (Maj), rouge = effacer
      ctx.save(); ctx.strokeStyle = (shiftDown || trimDrag.shift) ? '#39d353' : '#ff3b30'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.lineJoin = 'round';
      ctx.beginPath(); const s0 = R.worldToScreen(view, trimDrag.path[0].x, trimDrag.path[0].y); ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < trimDrag.path.length; i++) { const s = R.worldToScreen(view, trimDrag.path[i].x, trimDrag.path[i].y); ctx.lineTo(s.x, s.y); }
      ctx.stroke(); ctx.restore();
    }
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
  // Prolonge un trait vers le bord le plus proche. `noHist` : pour le prolonger au lasso (une seule pile).
  function extendCore(ent, clickPt, noHist) {
    if (!ent.points || ent.points.length !== 2) return false;   // seulement les traits droits
    const ax = ent.points[0].x, ay = ent.points[0].y, bx = ent.points[1].x, by = ent.points[1].y;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const tP = ((clickPt.x - ax) * dx + (clickPt.y - ay) * dy) / len2;
    const cands = [];
    for (const o of nearEnt(ent)) {
      if (o === ent || o.type === 'dim' || o.type === 'hatch' || o.type === 'image' || o.type === 'text') continue;
      for (const [c, d] of SN.entitySegments(o)) { const t = SN.rayParam({ x: ax, y: ay }, { x: bx, y: by }, c, d); if (t != null) cands.push(t); }
    }
    if (tP < 0.5) { const neg = cands.filter(t => t < -1e-4); if (!neg.length) return false; const t = Math.max.apply(null, neg); if (!noHist) pushHistory([ent]); ent.points[0].x = ax + dx * t; ent.points[0].y = ay + dy * t; }
    else { const pos = cands.filter(t => t > 1 + 1e-4); if (!pos.length) return false; const t = Math.min.apply(null, pos); if (!noHist) pushHistory([ent]); ent.points[1].x = ax + dx * t; ent.points[1].y = ay + dy * t; }
    ent._bb = null; return true;
  }
  function extendLine(ent, clickPt) {
    if (extendCore(ent, clickPt)) echo('Trait prolongé.');
    else echo('Prolonger : rien à atteindre de ce côté.');
  }
  // ---------- Ajuster « au lasso » : glisser le clic gauche pour effacer les traits croisés ----------
  function segCross(p1, p2, p3, p4) {   // deux segments se croisent-ils ?
    const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }
  function splitRuns(pts, n, closed, kill) {   // reconstruit les suites de segments survivants
    const segN = closed ? n : n - 1, order = [];
    if (closed) { let s = 0; for (const k of kill) { s = k; break; } for (let j = 1; j <= segN; j++) order.push((s + j) % segN); }
    else { for (let j = 0; j < segN; j++) order.push(j); }
    const runs = []; let cur = null;
    for (const j of order) { const a = pts[j], b = pts[(j + 1) % n]; if (kill.has(j)) { cur = null; continue; } if (!cur) { cur = [{ x: a.x, y: a.y }]; runs.push(cur); } cur.push({ x: b.x, y: b.y }); }
    return runs;
  }
  function trimDragErase(a, b) {   // AJUSTER au lasso : coupe le trait croisé ENTRE ses deux intersections voisines
    let changed = false;
    const P = (p0, p1, t) => ({ x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t });
    for (const o of scene.entities.slice()) {
      if (o._lib || !o.points || o.points.length < 2) continue;
      if (o.type === 'dim' || o.type === 'hatch' || o.type === 'image' || o.type === 'text') continue;
      if (!layMovable(o.layer)) continue;            // on ne touche pas aux calques verrouillés/gelés
      const pts = o.points, n = pts.length, closed = !!o.closed, segN = closed ? n : n - 1, cuts = {};
      for (let j = 0; j < segN; j++) {
        const p0 = pts[j], p1 = pts[(j + 1) % n];
        if (!segCross(a, b, p0, p1)) continue;
        const tc = SN.segParam(p0, p1, a, b);        // où le lasso croise ce segment
        if (tc == null) continue;
        const ts = [];                               // intersections du segment avec les AUTRES traits
        for (const other of nearEnt(o)) {
          if (other === o || other.type === 'dim' || other.type === 'hatch' || other.type === 'image' || other.type === 'text') continue;
          for (const [c, d] of SN.entitySegments(other)) { const t = SN.segParam(p0, p1, c, d); if (t != null && t > 1e-4 && t < 1 - 1e-4) ts.push(t); }
        }
        let t0 = 0, t1 = 1;                           // portion à retirer = autour de tc, bornée par les intersections
        for (const t of ts) { if (t <= tc && t > t0) t0 = t; if (t >= tc && t < t1) t1 = t; }
        cuts[j] = [t0, t1];
      }
      if (!Object.keys(cuts).length) continue;
      if (!trimDrag.committed) { pushHistory(); trimDrag.committed = true; }
      const idx = scene.entities.indexOf(o); if (idx < 0) continue;
      scene.entities.splice(idx, 1);
      const base = { color: o.color, penMm: o.penMm, layer: o.layer, dash: o.dash };
      const runs = []; let cur = null;
      for (let j = 0; j < segN; j++) {
        const p0 = pts[j], p1 = pts[(j + 1) % n];
        if (cuts[j]) {
          const [t0, t1] = cuts[j];
          if (t0 > 1e-4) { if (!cur) { cur = [{ x: p0.x, y: p0.y }]; runs.push(cur); } cur.push(P(p0, p1, t0)); }
          cur = null;                                // trou : on coupe ici
          if (t1 < 1 - 1e-4) { cur = [P(p0, p1, t1)]; runs.push(cur); cur.push({ x: p1.x, y: p1.y }); }
        } else { if (!cur) { cur = [{ x: p0.x, y: p0.y }]; runs.push(cur); } cur.push({ x: p1.x, y: p1.y }); }
      }
      for (const run of runs) if (run.length >= 2) G.addPolyline(scene, run, Object.assign({ closed: false }, base));
      changed = true;
    }
    if (changed) { selected = []; markSceneDirty(); }
    return changed;
  }
  function trimDragExtend(a, b) {   // PROLONGE au lasso : chaque trait droit croisé est étiré vers le bord voisin
    let changed = false; const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (const o of scene.entities.slice()) {
      if (o._lib || !o.points || o.points.length !== 2) continue;
      if (!layMovable(o.layer)) continue;
      if (trimDrag.done && trimDrag.done.has(o)) continue;
      if (!segCross(a, b, o.points[0], o.points[1])) continue;
      if (!trimDrag.committed) { pushHistory(); trimDrag.committed = true; }
      if (extendCore(o, mid, true)) { changed = true; (trimDrag.done || (trimDrag.done = new Set())).add(o); }
    }
    if (changed) markSceneDirty();
    return changed;
  }
  function trimDragMove(e) {
    const r = cv.getBoundingClientRect(), raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
    const prev = trimDrag.path[trimDrag.path.length - 1];
    trimDrag.path.push(raw); if (trimDrag.path.length > 600) trimDrag.path.shift();
    if (Math.hypot(raw.x - trimDrag.path[0].x, raw.y - trimDrag.path[0].y) > 3 / view.pxPerMm) trimDrag.moved = true;
    // Maj maintenu = PROLONGER (ne supprime pas) ; sinon = AJUSTER/effacer.
    const ext = shiftDown || trimDrag.shift;
    const changed = ext ? trimDragExtend(prev, raw) : trimDragErase(prev, raw);
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m';
    if (changed) paint(); else paintOverlay();
  }
  function trimDragEnd() {
    const td = trimDrag; trimDrag = null;
    if (td && !td.moved) { const p = td.path[0], ent = pickLineEnt(p); if (ent) { if (td.shift) extendLine(ent, p); else trimLine(ent, p); } }
    else if (td && td.committed) echo('✂️ Traits ajustés.');
    paint();
  }

  cv.addEventListener('mousedown', e => {
    cv.focus();
    if (activePage !== 'model') { pageMouseDown(e); return; }
    if (e.button === 1 || e.button === 2 || tool === 'pan') {
      // Double-clic MOLETTE = recentrer sur la zone de dessin (zoom étendu), façon AutoCAD.
      if (e.button === 1) {
        const now = Date.now();
        if (now - lastMidDown < 400) { lastMidDown = 0; panning = false; fitContent(); echo('🔍 Recentré sur la zone de dessin.'); e.preventDefault(); return; }
        lastMidDown = now;
      }
      if (e.button === 2) rightDown = { sx: e.clientX, sy: e.clientY };   // pour distinguer clic droit sec / panoramique
      panning = true; panStart = { sx: e.clientX, sy: e.clientY, px: view.panXmm, py: view.panYmm }; e.preventDefault(); return;
    }
    stopEdit();
    if (pasteOp && e.button === 0) { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); commitPaste(snapPoint(raw, null)); return; }
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
        echo(selMsg()); refreshProps(); syncCurrentLayer(); paint(); return;
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
          // base du déplacement = le POINT EXACT de la poignée (milieu réel), pas le
          // point cliqué -> « centre sur centre » tombe PILE, sans décalage.
          if (g.kind === 'mid' || g.kind === 'edge') gripDrag.start = gripPoint(g);
          dragGrip(R.screenToWorld(view, sx, sy)); echo('Point attrapé — déplacez (fantôme orange) puis cliquez pour déposer (Échap = annuler).'); paintOverlay(); return;
        }
      }
      selecting = true; selStart = { sx, sy, w: R.screenToWorld(view, sx, sy) }; selRect = null; return;
    }
    if (tool === 'dim') {
      const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
      if (dimSeg) {
        // phase « écartement » : clic = pose la cote
        if (dimPreview) { pushHistory(); const cotId = ensureLayer('Cotation', '#b9375e'); G.addDim(scene, dimPreview.points[0], dimPreview.points[1], dimPreview.offMm, { textMm: currentDimSize, layer: cotId, color: '#b9375e' }); renderLayerSelect(); refreshLayers(); echo('Cote posée : ' + fmtM(dist(dimPreview.points[0], dimPreview.points[1])) + ' m'); dimSeg = null; dimPts = []; paint(); }
      } else if (dimPts.length) {
        // mode « point à point » : ce clic fige le 2e point -> on passe au réglage de l'écartement
        const p = snapPoint(raw, dimPts[0]);
        if (dist(dimPts[0], p) < 1) { echo('Les deux points sont confondus — choisissez un autre point.'); return; }
        dimSeg = { a: { x: dimPts[0].x, y: dimPts[0].y }, b: { x: p.x, y: p.y } }; dimPts = [];
        echo('Cote : éloignez le curseur pour régler l’écartement, puis cliquez pour poser.'); hoverDim();
      } else {
        // Maj -> on ignore l'accroche au trait et on force le mode « point à point ».
        const seg = shiftDown ? null : SN.pickSegment(nearScene(raw), raw, 10 / view.pxPerMm);
        if (seg) { dimSeg = { a: seg.a, b: seg.b }; echo('Cote : éloignez le curseur pour régler l’écartement, puis cliquez pour poser.'); hoverDim(); }
        else { const p = snapPoint(raw, null); dimPts = [{ x: p.x, y: p.y }]; echo('Cote point à point — cliquez le 2e point (le point s’accroche aux extrémités/milieux).'); hoverDim(); }
      }
      return;
    }
    if (tool === 'offset') {
      if (pendingOffset) {
        pushHistory(); const s = pendingOffset.src, o = { color: s.color, penMm: s.penMm, layer: s.layer, dash: s.dash };
        if (pendingOffset.kind === 'circle') G.addCircle(scene, pendingOffset.center.x, pendingOffset.center.y, pendingOffset.r, o);
        else if (pendingOffset.kind === 'poly') G.addPolyline(scene, pendingOffset.points, Object.assign({ closed: pendingOffset.closed }, o));
        else G.addLine(scene, pendingOffset.a.x, pendingOffset.a.y, pendingOffset.b.x, pendingOffset.b.y, o);
        // On DÉSÉLECTIONNE après le décalage : on reste sur l'outil Décaler, prêt à
        // cibler un AUTRE trait (survol) sans rester collé au trait précédent.
        offsetTarget = null; selected = []; pendingOffset = null; ghost = null;
        echo('⇥ Décalé de ' + fmtM(offsetDist) + ' m — survolez un autre trait pour le décaler.'); refreshProps(); paint();
      }
      return;
    }
    if (tool === 'hatch') { if (hatchHover) { pushHistory(); G.addHatch(scene, hatchHover, { pattern: hatchPattern, spacingMm: hatchSpacing, angleDeg: 45, layer: currentLayer, color: hatchColor(), holes: hatchHover.holes }); const nh = (hatchHover.holes || []).length; echo('Hachure « ' + hatchPatternName() + ' » ajoutée' + (nh ? ' (' + nh + ' zone(s) intérieure(s) contournée(s))' : '') + '.'); paint(); } else echo('Survolez une zone fermée (délimitée par des traits) avant de cliquer.'); return; }
    if (op) { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); const from = op.step >= 1 ? (op.cmd === 'mirror' ? op.p1 : op.base) : null; opClick(snapPoint(raw, from)); return; }
    if (tool === 'circle') { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); circleClick(snapPoint(raw, circleCenter)); return; }
    if (tool === 'trim') { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); trimDrag = { path: [raw], moved: false, committed: false, shift: e.shiftKey }; trimPreview = null; return; }
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
    if (tool === 'text' && e.button === 0) {
      // Zone de texte en DEUX CLICS (pas besoin de maintenir le bouton) :
      // 1er clic = 1er coin ; 2e clic = coin opposé (ou même point => texte simple).
      const r = cv.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const w = snapPoint(R.screenToWorld(view, sx, sy), null);
      if (!textStart) { textStart = { w, sx, sy }; textZone = null; textZoneGhost = null; echo('TEXTE — 2e clic : coin opposé de la zone (ou même point = texte simple).'); return; }
      const moved = Math.hypot(sx - textStart.sx, sy - textStart.sy);
      let inSx = textStart.sx, inSy = textStart.sy;
      if (moved >= 5) { textZone = { a: textStart.w, b: w }; textPt = null; inSx = Math.min(textStart.sx, sx); inSy = Math.min(textStart.sy, sy); }
      else { textPt = textStart.w; textZone = null; }
      textStart = null; textZoneGhost = null;
      showTextInput(inSx, inSy);
      return;
    }
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
      else { const a = draft[0]; pushHistory(); const re = G.addRect(scene, Math.min(a.x, p.x), Math.min(a.y, p.y), Math.abs(p.x - a.x), Math.abs(p.y - a.y), Object.assign({ closed: true }, opts())); draft = []; hideDyn(); echo('Premier coin :'); if (re && re.layer === MEP_LAYER_ID) { paint(); openMepLinkDialog(re, true); return; } }
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
      const raw = R.screenToWorld(view, sx, sy);
      const dm = pickDimAt(raw);
      if (dm) {   // double-clic sur une COTE = la sélectionner + ouvrir les Propriétés
        // (le 2e clic du double-clic a pu amorcer un déplacement de poignée : on l'annule)
        gripDrag = null; hotGrip = null; opGhost = null; dimPreview = null; dimHover = null;
        selected = [dm]; syncCurrentLayer();
        const pb = $('props');
        if (pb && pb.style.display !== 'block') toggleProps(); else renderProps();
        echo('Cote sélectionnée — modifie-la dans les Propriétés (valeur, hauteur, lignes d’attache, écartement…).');
        paint(); return;
      }
      const t = pickTextAt(raw);
      if (t) {   // double-clic sur un texte = le modifier (sauf calque verrouillé)
        if (!layMovable(t.layer)) { echo('✎ Texte sur un calque verrouillé — déverrouille-le pour le modifier.'); return; }
        startEditText(t, sx, sy); return;
      }
    }
    finishPoly(false);
  });
  // Modifier la valeur EXACTE d'une cote (indépendante de la longueur mesurée).
  // Vide -> on revient à la valeur mesurée automatiquement.
  function editDimValue(e) {
    // le 2e clic du double-clic a pu amorcer un déplacement de poignée : on l'annule.
    gripDrag = null; hotGrip = null; opGhost = null; dimPreview = null; dimHover = null;
    const measured = G.dimValue(e);
    const cur = (e.valMm != null ? e.valMm : measured) / 1000;
    appInput({
      title: 'Valeur de la cote',
      hint: 'En mètres. Vide = mesure réelle (' + fmtM(measured) + ' m). La taille du trait et de la cote ne change PAS : seul le nombre affiché change.',
      value: String(cur).replace('.', ','),
      placeholder: fmtM(measured),
      onok: ans => {
        const s = String(ans).trim().replace(',', '.');
        pushHistory([e]);
        if (s === '') { delete e.valMm; echo('Cote : valeur remise sur la mesure réelle (' + fmtM(measured) + ' m).'); }
        else { const v = parseFloat(s); if (!isFinite(v)) { echo('Valeur invalide.'); return; } e.valMm = Math.round(v * 1000); echo('Cote : valeur affichée forcée à ' + fmtM(e.valMm) + ' m (le trait garde sa taille réelle).'); }
        e._bb = null; markSceneDirty(); refreshProps(); paint();
      }
    });
  }
  // Petite boîte de saisie INTERNE (remplace prompt() du navigateur).
  function appInput(opts) {
    const ov = $('dlg'); if (!ov) return;
    $('dlg-title').textContent = opts.title || '';
    const hintEl = $('dlg-hint'); hintEl.textContent = opts.hint || ''; hintEl.style.display = opts.hint ? '' : 'none';
    const inp = $('dlg-input'); inp.value = opts.value != null ? opts.value : ''; inp.placeholder = opts.placeholder || '';
    ov.classList.add('open'); setTimeout(() => { inp.focus(); inp.select(); }, 20);
    const close = () => { ov.classList.remove('open'); inp.onkeydown = null; $('dlg-ok').onclick = null; $('dlg-cancel').onclick = null; ov.onclick = null; cv.focus(); };
    const ok = () => { const v = inp.value; close(); if (opts.onok) opts.onok(v); };
    $('dlg-ok').onclick = ok; $('dlg-cancel').onclick = close;
    ov.onclick = ev => { if (ev.target === ov) close(); };   // clic hors de la boîte = annuler
    inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); ok(); } else if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  }
  cv.addEventListener('contextmenu', e => e.preventDefault());
  // Aucun menu contextuel du NAVIGATEUR dans l'application (sauf champs de saisie, pour copier/coller).
  document.addEventListener('contextmenu', e => { const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; e.preventDefault(); }, true);
  // ---------- Menu contextuel au style de l'application (clic droit sur le plan) ----------
  function closeCtxMenu() { const m = $('ctxmenu'); if (m) m.classList.remove('open'); }
  function showCtxMenu(sx, sy) {
    const m = $('ctxmenu'); if (!m) return; m.innerHTML = '';
    const item = (label, fn, kbd) => { const b = document.createElement('button'); b.innerHTML = label + (kbd ? '<span class="k">' + kbd + '</span>' : ''); b.onclick = () => { closeCtxMenu(); fn(); }; m.appendChild(b); };
    const sep = () => { const d = document.createElement('div'); d.className = 'sep'; m.appendChild(d); };
    const head = t => { const d = document.createElement('div'); d.className = 'pt-head'; d.textContent = t; m.appendChild(d); };
    if (selected.length) {
      head(selected.length + ' objet' + (selected.length > 1 ? 's' : '') + ' sélectionné' + (selected.length > 1 ? 's' : ''));
      item('📋 Copier', () => copySel(false), 'Ctrl+C');
      item('✂️ Couper', () => copySel(true), 'Ctrl+X');
      item('↔️ Déplacer', () => setTool('move'));
      item('⟳ Pivoter', () => setTool('rotate'));
      item('⇲ Étirer', () => setTool('stretch'));
      item('⚖️ Échelle', () => setTool('scale'));
      item('🗑️ Supprimer', () => eraseSel(), 'Suppr');
      sep();
      item('⚙️ Propriétés', () => { const b = $('props'); if (b && b.style.display !== 'block') toggleProps(); });
    } else {
      if (lastCmd) item('↩️ Répéter : ' + lastCmd, () => acceptOrRepeat(), 'Entrée');
      if (clipboard && clipboard.ents && clipboard.ents.length) item('📌 Coller', () => paste(), 'Ctrl+V');
      item('▦ Tout sélectionner', () => { selected = scene.entities.filter(x => layPickable(x.layer)); if (tool !== 'select') setTool('select'); echo(selected.length + ' objet(s) sélectionné(s).'); refreshProps(); syncCurrentLayer(); paint(); }, 'Ctrl+A');
      sep();
      item('🔍 Zoom étendu', () => { pushView(); fitContent(); });
      item('🔍 Zoom fenêtre', () => setTool('zoomwin'));
    }
    m.classList.add('open');
    const mw = m.offsetWidth || 230, mh = m.offsetHeight || 220;
    m.style.left = Math.max(6, Math.min(sx, window.innerWidth - mw - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(sy, window.innerHeight - mh - 6)) + 'px';
  }
  document.addEventListener('mousedown', e => { const m = $('ctxmenu'); if (m && m.classList.contains('open') && !m.contains(e.target)) closeCtxMenu(); }, true);
  window.addEventListener('mouseup', e => {
    panning = false;
    if (trimDrag && e.button === 0) { trimDragEnd(); return; }
    // (Le texte se crée désormais en deux clics via le mousedown — rien à faire au relâchement.)
    // Clic droit « sec » (sans glisser) sur le plan = menu contextuel au style de l'appli.
    if (e.button === 2 && rightDown) { const moved = Math.hypot(e.clientX - rightDown.sx, e.clientY - rightDown.sy); rightDown = null; if (moved < 5 && activePage === 'model') { cv.focus(); showCtxMenu(e.clientX, e.clientY); return; } }
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
      const ent = pickDimAt(selStart.w) || SN.pickEntity(nearScene(selStart.w), selStart.w, selTolMm()) || pickTextAt(selStart.w) || pickHatchAt(selStart.w) || pickImageAt(selStart.w);
      if (ent) {
        // Chaque clic AJOUTE l'objet à la sélection (ou le retire s'il y est déjà) :
        // on cumule les objets d'un clic à l'autre (textes, traits…). Échap vide tout.
        const i = selected.indexOf(ent);
        if (i >= 0) selected.splice(i, 1); else selected.push(ent);
        boxPending = null; selecting = false; selRect = null; lastSelBox = null;
        echo(selMsg()); refreshProps(); syncCurrentLayer(); syncTextControls(); paint(); return;
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
  function textColor() { const c = $('txtcolor'); return c ? c.value : ($('color') ? $('color').value : '#e8ebf2'); }
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
    const opts = { hMm: currentTextH, color: textColor(), layer: currentLayer, angleDeg: 0, font: textFont(), align: curTxtAlign(), valign: curTxtVAlign() };
    let posed = false;
    if (v && textZone) { pushHistory(); const z = textZone; G.addText(scene, z.a.x, z.a.y, v, Object.assign({ zone: true, p2: z.b }, opts)); echo('Texte « ' + v + ' » posé dans la zone (aligné ' + curTxtAlign() + '/' + curTxtVAlign() + ').'); posed = true; }
    else if (v && textPt) { pushHistory(); G.addText(scene, textPt.x, textPt.y, v, opts); echo('Texte « ' + v + ' » posé.'); posed = true; }
    textZone = null; textPt = null;
    hideTextInput(); cv.focus(); paint();
    // Après validation, on quitte l'outil Texte (évite d'en ajouter plusieurs par mégarde).
    if (posed) setTool('select');
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
      if (op.cmd === 'rotate') { const deg = parseFloat(raw); if (isFinite(deg)) { const mv = movableSel(); pushHistory(mv.length ? mv : selected); rotateEnts(mv, op.base.x, op.base.y, deg * Math.PI / 180); echo('Pivoté de ' + deg + '°.'); endOp(); } stopEdit(); paint(); return; }
      const v = parseFloat(raw);
      if (isFinite(v) && v > 0) { const mv = movableSel(); pushHistory(mv.length ? mv : selected); const q = SN.alongDir(op.base, cursor, M(v)); if (op.cmd === 'copy') { const c = mv.map(cloneEntity); c.forEach(e => scene.entities.push(e)); translateEnts(c, q.x - op.base.x, q.y - op.base.y); echo('Copié.'); } else { translateEnts(mv, q.x - op.base.x, q.y - op.base.y); echo('Déplacé.'); endOp(); } }
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
    CLIENT: toggleClient, CLIENTS: toggleClient,
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
    rect: 'RECTANGLE — premier coin :', dim: 'COTE — survolez un trait (cote auto) · maintenez Maj pour coter point à point :',
    offset: 'DÉCALER — tapez la distance en m, puis survolez un trait :', pan: 'PANORAMIQUE — glissez pour déplacer la vue.',
    hatch: 'HACHURES — survolez une zone fermée et cliquez pour la remplir (motif + couleur dans le ruban).',
    circle: 'CERCLE — cliquez le centre, puis le rayon (ou tapez le rayon en m).',
    trim: 'AJUSTER — cliquez la partie du trait à couper, ou MAINTENEZ le clic gauche et GLISSEZ sur les traits à effacer (lasso). Maj = PROLONGER jusqu’au trait voisin.',
    text: 'TEXTE — cliquez un point, OU glissez un rectangle = ZONE (le texte s’aligne dedans : Aligner H/V dans le ruban). Tapez, Entrée valide.',
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
    // Hachures : masque/rétablit le quadrillage + les calques de zones (voir enterHatchHide).
    if (tool === 'hatch' && t !== 'hatch') exitHatchHide();
    if (t === 'hatch' && tool !== 'hatch') enterHatchHide();
    offsetTarget = null; op = null; circleCenter = null; opGhost = circlePreview = null;
    filletFirst = null; matchSrc = null; stretchOp = null; arrayPolar = null;
    // Noun-verb (réflexe AutoCAD) : DÉCALER avec un seul trait présélectionné le cible directement.
    if (t === 'offset' && selected.length === 1 && (selected[0].type === 'line' || selected[0].type === 'polyline' || selected[0].type === 'circle')) {
      offsetTarget = selected[0];   // trait présélectionné (ligne, polyligne entière ou cercle)
    }
    // Transformations : exigent une présélection (sélectionne D'ABORD, puis la commande).
    if (['move', 'copy', 'rotate', 'mirror', 'scale'].indexOf(t) >= 0) {
      if (!selected.length) { echo('⚠ Sélectionnez d’abord un ou plusieurs objets, puis relancez ' + t.toUpperCase() + '.'); t = 'select'; }
      else op = { cmd: t, step: 0 };
    }
    // ÉTIRER façon AutoCAD : si des objets sont présélectionnés, on étire DIRECTEMENT leurs sommets
    // (sélectionne les traits à étirer → Étirer → clique le point de base → la destination).
    let stretchFromSel = false;
    if (t === 'stretch' && selected.length) {
      // VRAI étirement : si la sélection vient d'un CADRE, seuls les sommets DANS ce cadre bougent
      // (la partie hors cadre reste fixe). Sinon (clic), tous les sommets bougent (= déplacement).
      const bx = lastSelBox, inBox = p => bx && p.x >= bx.x0 && p.x <= bx.x1 && p.y >= bx.y0 && p.y <= bx.y1;
      stretchOp = { ptsSet: new Set(), ents: selected.slice(), base: null };
      selected.forEach(e => { if (e.points) e.points.forEach(p => { if (!bx || inBox(p)) stretchOp.ptsSet.add(p); }); });
      stretchFromSel = true;
    }
    tool = t; draft = []; dimPts = []; dimHover = dimPreview = ghost = pendingOffset = gripDrag = hotGrip = hatchHover = trimPreview = snapInfo = guide = dimSeg = hoverEnt = null; hideDyn();
    // On vide la sélection seulement pour les outils de dessin (pas sélection/transfo/décaler/étirer présélectionné).
    const clearSel = ['line', 'polyline', 'rect', 'dim', 'hatch', 'pan', 'circle', 'trim', 'text', 'arc', 'polygon', 'dist', 'area', 'fillet', 'zoomwin'];
    if (!stretchFromSel && t === 'stretch') clearSel.push('stretch');
    if (clearSel.indexOf(t) >= 0) { selected = []; syncCurrentLayer(); }
    if (t !== 'text') hideTextInput();
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    if (op) echo(OPPROMPT[op.cmd][0]);
    else if (stretchFromSel) echo('ÉTIRER — cliquez le POINT DE BASE (origine de l’étirement), puis la destination (ou tapez la distance).');
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
    // Prise en compte IMMÉDIATE pendant une édition en cours (sans bouger la souris).
    if (lastScreen) { const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
      if (gripDrag) { dragGrip(raw); paintOverlay(); }
      else if (tool === 'stretch' && stretchOp && stretchOp.base) { stretchMove(); }
      else if (op && op.step >= 1) { opMove(); } }
  }, true);

  // Maj : bascule Ajuster <-> Prolonger (rafraîchit l'indice à l'écran)
  window.addEventListener('keydown', e => { if (e.key === 'Shift' && !shiftDown) { shiftDown = true; if (tool === 'trim') hoverTrim(null); else if (tool === 'dim') hoverDim(); } }, true);
  window.addEventListener('keyup', e => { if (e.key === 'Shift') { shiftDown = false; if (tool === 'trim') hoverTrim(null); else if (tool === 'dim') hoverDim(); } }, true);

  window.addEventListener('keydown', e => {
    // Quand le focus est dans un champ de saisie (zone de texte #txtin, cote, etc.),
    // on laisse le navigateur gérer les touches : copier/coller/sélection NATIFS du
    // champ, pas les raccourcis du plan. -> le collage de texte « d'ailleurs » marche.
    const ae = document.activeElement;
    if (ae === cmd || editing || (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable))) return;
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
      const mv = movableSel(), lockedN = selected.length - mv.length;
      if (mv.length) { pushHistory(); mv.forEach(en => { const i = scene.entities.indexOf(en); if (i >= 0) scene.entities.splice(i, 1); }); echo(mv.length + ' objet(s) supprimé(s)' + (lockedN ? ' (' + lockedN + ' verrouillé(s) conservé(s))' : '') + '.'); selected = []; refreshProps(); syncCurrentLayer(); paint(); }
      else if (lockedN) echo('Trait(s) verrouillé(s) : déverrouille le calque pour pouvoir supprimer.');
      e.preventDefault(); return;
    }
    if (k === 'Escape' && pasteOp) { cancelPaste(); return; }
    if (k === 'Escape' && gripDrag) {
      // Aucune mutation n'a eu lieu (aperçu seulement) : on jette juste le fantôme.
      if (history.length) history.pop();
      gripDrag = null; hotGrip = null; opGhost = null; dimPreview = null; dimHover = null; echo('Édition annulée.'); paint(); return;
    }
    // Ligne : Échap termine la chaîne mais RESTE sur l'outil Ligne (prêt pour une nouvelle).
    if (k === 'Escape' && tool === 'line' && draft.length) { draft = []; ghost = null; hideDyn(); echo('LIGNE — premier point (ou longueur en m) :'); paint(); return; }
    // Polyligne : Échap termine (valide) le tracé en UN bloc et reste sur l'outil.
    if (k === 'Escape' && tool === 'polyline' && draft.length) { if (draft.length >= 2) finishPoly(); else { draft = []; ghost = null; hideDyn(); } echo('POLYLIGNE — premier point :'); paint(); return; }
    if (k === 'Escape') { closeCtxMenu(); draft = []; ghost = null; selected = []; trimPreview = null; trimDrag = null; textStart = textZone = textZoneGhost = null; dimSeg = null; dimPts = []; boxPending = null; selecting = false; selRect = null; hideTextInput(); hideDyn(); syncCurrentLayer(); echo('*Annulé*'); if (tool !== 'select') setTool('select'); else paint(); return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); acceptOrRepeat(); return; }
    if ((/^[0-9]$/.test(k) || k === '.' || k === ',') && (gripDrag || activePoint() || tool === 'offset' || (op && (op.step === 1 || (op.cmd === 'scale' && op.step === 2))) || (tool === 'circle' && circleCenter) || (tool === 'stretch' && stretchOp && stretchOp.base))) { startEdit(k); e.preventDefault(); return; }
    if (/^[a-zA-Z]$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey) { cmd.focus(); cmd.value += k.toUpperCase(); e.preventDefault(); } // taper = ligne de commande
  });

  // ---------- Zoom ----------
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    if (activePage !== 'model') {
      const page = pages.find(p => p.id === activePage);
      if (page && page.template) {
        const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
        const L = pageLayout(page);
        // Molette DANS une zone de plan (si non verrouillée) : zoom du PLAN de la zone
        // (change l'échelle du viewport), le point sous le curseur reste fixe.
        if (!(page.layoutData && page.layoutData.vpLocked)) {
          const tpl = QCAD.layouts[page.template], wins = tpl.planWindows || [], vps = ensureViewports(page, tpl);
          const T = (xmm, ymm) => ({ x: L.Sx0 + xmm * L.ppmPaper, y: L.Sy0 + ymm * L.ppmPaper });
          for (let i = 0; i < wins.length; i++) {
            const w = wins[i], a = T(w.x, w.y), b = T(w.x + w.w, w.y + w.h);
            if (sx >= a.x && sx <= b.x && sy >= a.y && sy <= b.y) {
              selVp = i;
              if (mepRectFor(page.template, page.scaleDenom, page.facade || '', i)) { echo('🔗 Zone ' + (i + 1) + ' pilotée par un rectangle (calque « Zones liées ») — ajuste le rectangle en Objet.'); paintPage(); return; }
              const vp = vps[i];
              const vw1 = vpView(page, L.Sx0, L.Sy0, L.ppmPaper, view.canvasH, w, vp);
              const W = R.screenToWorld(vw1, sx, sy);                       // point monde sous le curseur
              const sd0 = vp.sd || page.scaleDenom || 500;
              vp.sd = Math.max(5, Math.min(20000, sd0 * (e.deltaY < 0 ? 1 / 1.15 : 1.15)));  // molette avant = zoom in (sd ↓)
              const vw2 = vpView(page, L.Sx0, L.Sy0, L.ppmPaper, view.canvasH, w, vp);
              const Wn = R.screenToWorld(vw2, sx, sy);
              vp.cx += (W.x - Wn.x); vp.cy += (W.y - Wn.y);                 // garde le point sous le curseur
              syncViewports(page, i);   // zones liées : même échelle/centre partout
              echo('🔍 Zoom dans la zone ' + (i + 1) + ' — échelle ≈ 1:' + Math.round(vp.sd) + ((page.layoutData && page.layoutData.vpSync) ? ' (zones liées)' : ''));
              paintPage(); return;
            }
          }
        }
        // Sinon : molette = zoom de la FEUILLE autour du curseur.
        const paperX = (sx - L.Sx0) / L.ppmPaper, paperY = (sy - L.Sy0) / L.ppmPaper;   // mm papier sous le curseur
        const fit = L.ppmPaper / (page._z || 1);
        let z = (page._z || 1) * (e.deltaY < 0 ? 1.15 : 1 / 1.15); z = Math.max(0.4, Math.min(16, z)); page._z = z;
        const ppm2 = fit * z, pm = paperMm(page);
        const baseSx0 = (view.canvasW - pm.w * ppm2) / 2, baseSy0 = (view.canvasH - pm.h * ppm2) / 2;
        page._ox = (sx - paperX * ppm2) - baseSx0; page._oy = (sy - paperY * ppm2) - baseSy0;   // garde le point sous le curseur
        requestPaint();
      }
      return;
    }
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
    // Sortir la liste du ruban : le ruban est mis à l'échelle (transform), ce qui
    // « piège » une liste position:fixed à l'intérieur et la rogne. En la rattachant
    // au <body>, elle s'affiche bien par-dessus tout, à la bonne position.
    if (list && list.parentElement !== document.body) document.body.appendChild(list);
    cur.addEventListener('click', ev => {
      ev.stopPropagation();
      const open = !dd.classList.contains('open');
      dd.classList.toggle('open', open);
      if (list) list.style.display = open ? 'block' : 'none';
      if (open) {
        renderLayerSelect();
        const r = cur.getBoundingClientRect();
        list.style.minWidth = Math.max(r.width, 240) + 'px';
        list.style.top = (r.bottom + 3) + 'px';
        // On place d'abord, puis on mesure la largeur réelle pour recaler dans le
        // viewport (la largeur peut dépasser le minimum selon les noms de calques).
        list.style.left = r.left + 'px';
        const w = list.getBoundingClientRect().width;
        list.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
      }
    });
    document.addEventListener('click', e => { if (dd.classList.contains('open') && !list.contains(e.target) && e.target !== cur && !cur.contains(e.target)) { dd.classList.remove('open'); list.style.display = 'none'; } });
  })();
  { const ds = $('dimsize'); if (ds) ds.addEventListener('change', () => { currentDimSize = parseFloat(ds.value); }); }
  // Contrôles texte du ruban : règlent le PROCHAIN texte ET modifient en direct le texte SÉLECTIONNÉ (façon Canva).
  function selectedTexts() { return selected.filter(e => e.type === 'text' && layMovable(e.layer)); }
  function applyTextCtrl(key, value) {
    const ts = selectedTexts();
    if (ts.length) { pushHistory(ts); ts.forEach(e => { e[key] = value; e._bb = null; }); markSceneDirty(); refreshProps(); paint(); }
  }
  function syncTextControls() {
    const t = selected.find(e => e.type === 'text'); if (!t) return;
    const sz = $('txtsize'); if (sz) { const v = String(t.hMm || 800); if ([...sz.options].some(o => o.value === v)) sz.value = v; currentTextH = t.hMm || 800; }
    const fo = $('txtfont'); if (fo && t.font) { if ([...fo.options].some(o => o.value === t.font)) fo.value = t.font; }
    const al = $('txtalign'); if (al) al.value = t.align || 'left';
    const va = $('txtvalign'); if (va) va.value = t.valign || 'top';
    const co = $('txtcolor'); if (co) { const c = t.color || (layerById(t.layer) && layerById(t.layer).color) || '#e8ebf2'; if (/^#[0-9a-fA-F]{6}$/.test(c)) { co.value = c; updateSwatch('txtcolor'); } }
  }
  { const ts = $('txtsize'); if (ts) ts.addEventListener('change', () => { currentTextH = parseFloat(ts.value); applyTextCtrl('hMm', currentTextH); cv.focus(); }); }
  { const tf = $('txtfont'); if (tf) tf.addEventListener('change', () => { applyTextCtrl('font', tf.value); cv.focus(); }); }
  { const ta = $('txtalign'); if (ta) ta.addEventListener('change', () => { applyTextCtrl('align', ta.value); cv.focus(); }); }
  { const tv = $('txtvalign'); if (tv) tv.addEventListener('change', () => { applyTextCtrl('valign', tv.value); cv.focus(); }); }
  { const tc = $('txtcolor'); if (tc) tc.addEventListener('change', () => { applyTextCtrl('color', tc.value); cv.focus(); }); }
  { const ps = $('polysides'); if (ps) ps.addEventListener('change', () => { polySides = parseInt(ps.value, 10) || 4; if (tool !== 'polygon') setTool('polygon'); cv.focus(); }); }
  { const fr = $('filletr'); if (fr) fr.addEventListener('change', () => { filletRadius = parseFloat(fr.value) || 0; if (tool !== 'fillet') setTool('fillet'); cv.focus(); }); }
  { const ob = $('optionsBtn'); if (ob) ob.addEventListener('click', toggleOptions); }
  { const cb = $('clientBtn'); if (cb) cb.addEventListener('click', toggleClient); }
  $('exportBtn').addEventListener('click', () => { if (activePage !== 'model') printPage(); else plot(); });
  // Barre d'outils de page (présentations)
  { const el = $('pgScale'); if (el) el.addEventListener('change', () => { const p = pages.find(x => x.id === activePage); if (p) { p.scaleDenom = parseInt(el.value, 10); centerPage(); } }); }
  { const el = $('pgPaper'); if (el) el.addEventListener('change', () => { const p = pages.find(x => x.id === activePage); if (p) { p.paper = el.value; centerPage(); } }); }
  { const el = $('pgOrient'); if (el) el.addEventListener('change', () => { const p = pages.find(x => x.id === activePage); if (p) { p.orientation = el.value; centerPage(); } }); }
  { const el = $('pgFit'); if (el) el.addEventListener('click', fitPageScale); }
  { const el = $('pgCenter'); if (el) el.addEventListener('click', centerPage); }
  { const el = $('pgPrint'); if (el) el.addEventListener('click', printPage); }
  { const el = $('pgFields'); if (el) el.addEventListener('click', editLayoutFields); }
  { const el = $('pgVpLock'); if (el) el.addEventListener('click', () => { const p = pages.find(x => x.id === activePage); if (!p || !p.template) return; p.layoutData = p.layoutData || {}; p.layoutData.vpLocked = !p.layoutData.vpLocked; syncPageBar(); echo(p.layoutData.vpLocked ? '🔒 Cases verrouillées — tes plans se placeront automatiquement sans bouger les cases.' : '🔓 Cases libres — glisse dans une zone pour la recentrer.'); }); }
  { const el = $('pgVpSync'); if (el) el.addEventListener('click', () => { const p = pages.find(x => x.id === activePage); if (!p || !p.template) return; p.layoutData = p.layoutData || {}; p.layoutData.vpSync = !p.layoutData.vpSync; if (p.layoutData.vpSync) { ensureViewports(p, QCAD.layouts[p.template]); syncViewports(p, selVp >= 0 ? selVp : 0); } syncPageBar(); paintPage(); echo(p.layoutData.vpSync ? '🔗 Zones liées — avant/après montrent le même cadrage (pas de décalage).' : '✂️ Zones indépendantes — chaque case se cadre séparément.'); }); }
  { const el = $('pgVpRect'); if (el) el.addEventListener('click', () => {
    const p = pages.find(x => x.id === activePage); if (!p || !p.template) return;
    const i = selVp; if (i < 0) { echo('Clique d’abord une zone de plan (elle se cadre en jaune), puis « Cadrer par un rectangle ».'); return; }
    const tpl = QCAD.layouts[p.template], w = (tpl.planWindows || [])[i]; if (!w) return;
    const layer = ensureMepLayer();
    let rect = mepRectFor(p.template, p.scaleDenom, p.facade || '', i), created = false;
    if (!rect) {
      const rv = resolvedVp(p, i, w);                                 // cadrage actuel de la case
      const rw = w.w * rv.sd, rh = w.h * rv.sd;                       // taille monde = taille case (papier) × échelle
      const x0 = rv.cx - rw / 2, x1 = rv.cx + rw / 2, y0 = rv.cy - rh / 2, y1 = rv.cy + rh / 2;
      rect = { type: 'polyline', points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], closed: true, layer, color: null, penMm: null, mepTarget: { template: p.template, scale: p.scaleDenom, facade: p.facade || '', win: i } };
      pushHistory(); scene.entities.push(rect); markSceneDirty(); created = true;
    }
    // Passe en Objet, sélectionne et cadre le rectangle pour l’ajuster tout de suite.
    setActivePage('model'); selected = [rect]; baseLayer = currentLayer = layer; syncCurrentLayer();
    const bb = R._bbox(rect); doZoomWindow({ x: bb[0], y: bb[1] }, { x: bb[2], y: bb[3] });
    refreshProps();
    echo((created ? '🔲 Rectangle de cadrage créé' : '🔗 Rectangle de cadrage existant') + ' (calque « Zones liées », ' + slotLabel(p.template, p.scaleDenom, p.facade || '', i) + ') — ajuste-le : la case suivra à la bonne taille/échelle.');
  }); }
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
  { const el = $('hspace'); if (el) el.addEventListener('change', () => { hatchSpacing = parseFloat(el.value); if (tool === 'hatch') hoverHatch(); renderHatchGrid(); }); }
  { const el = $('hcolor'); if (el) el.addEventListener('change', () => { if (tool !== 'hatch') setTool('hatch'); renderHatchGrid(); cv.focus(); }); }

  // ---------- Fenêtre HACHURES (façon bibliothèque : une case = un motif, aperçu live) ----------
  const HATCH_PATTERNS = [{ pat: 'solid', name: 'Pleine (aplat)' }, { pat: 'lines', name: 'Lignes 45°' }, { pat: 'vert', name: 'Lignes verticales' }, { pat: 'horiz', name: 'Lignes horizontales' }, { pat: 'cross', name: 'Croisées' }, { pat: 'briques', name: 'Briques' }, { pat: 'tuiles', name: 'Tuiles (toiture)' }];
  function hpLines(ctx, w, h, sp, angDeg) {
    const a = angDeg * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    const cx = w / 2, cy = h / 2, diag = Math.hypot(w, h), n = Math.ceil(diag / sp) + 2;
    ctx.beginPath();
    for (let i = -n; i <= n; i++) { const ox = cx + nx * i * sp, oy = cy + ny * i * sp; ctx.moveTo(ox - dx * diag, oy - dy * diag); ctx.lineTo(ox + dx * diag, oy + dy * diag); }
    ctx.stroke();
  }
  function hpTiles(ctx, w, h, sp) {
    const hh = sp, ww = sp * 1.6; ctx.beginPath(); let row = 0;
    for (let y = 0; y <= h + hh; y += hh) { ctx.moveTo(0, y); ctx.lineTo(w, y); const off = (row % 2) * (ww / 2); for (let x = off; x <= w; x += ww) { ctx.moveTo(x, y); ctx.lineTo(x, y + hh); } row++; }
    ctx.stroke();
  }
  function hpRoof(ctx, w, h, sp) {
    const r = Math.max(3, sp * 0.55); ctx.beginPath(); let row = 0;
    for (let y = 0; y <= h + r; y += r) { const off = (row % 2) ? r : 0; for (let x = -r + off; x <= w + r; x += 2 * r) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI, false); } row++; }
    ctx.stroke();
  }
  function drawHatchPreview(cvEl, pat, spMm, color, wM, hM) {
    const cssW = cvEl.clientWidth || 160, cssH = cvEl.clientHeight || 120, dpr = Math.min(2, window.devicePixelRatio || 1);
    cvEl.width = Math.round(cssW * dpr); cvEl.height = Math.round(cssH * dpr);
    const ctx = cvEl.getContext('2d'), W = cvEl.width, H = cvEl.height;
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#cbd3e0'; ctx.lineWidth = dpr; ctx.strokeRect(dpr, dpr, W - 2 * dpr, H - 2 * dpr);
    const wMm = Math.max(200, (wM || 3) * 1000), hMm = Math.max(200, (hM || 2.4) * 1000);
    const pxmm = Math.min(W / wMm, H / hMm), sp = Math.max(3 * dpr, spMm * pxmm);
    ctx.save(); ctx.beginPath(); ctx.rect(2 * dpr, 2 * dpr, W - 4 * dpr, H - 4 * dpr); ctx.clip();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(1, dpr);
    if (pat === 'solid') { ctx.globalAlpha = 0.85; ctx.fillRect(0, 0, W, H); }
    else if (pat === 'briques' || pat === 'tiles') hpTiles(ctx, W, H, sp);
    else if (pat === 'tuiles') hpRoof(ctx, W, H, sp);
    else if (pat === 'vert') hpLines(ctx, W, H, sp, 90);
    else if (pat === 'horiz') hpLines(ctx, W, H, sp, 0);
    else { hpLines(ctx, W, H, sp, 45); if (pat === 'cross') hpLines(ctx, W, H, sp, 135); }
    ctx.restore();
  }
  function hatchDims() { return { w: parseFloat($('ht-w') && $('ht-w').value) || 3, h: parseFloat($('ht-h') && $('ht-h').value) || 2.4 }; }
  let hatchView = 'patterns';   // 'patterns' = bibliothèque de motifs · 'favs' = mes favoris
  function hatchSpLabel(mm) { return (mm >= 1000) ? (mm / 1000).toString().replace('.', ',') + ' m' : Math.round(mm / 10) + ' cm'; }
  function setHatchView(v) {
    hatchView = v;
    const tp = $('ht-tab-pat'), tf = $('ht-tab-fav'); if (tp) tp.classList.toggle('on', v === 'patterns'); if (tf) tf.classList.toggle('on', v === 'favs');
    if (tf) tf.textContent = '★ Favoris' + (hatchFavs.length ? ' (' + hatchFavs.length + ')' : '');
    const fv = $('ht-favs'); if (fv) fv.style.display = (v === 'favs') ? 'none' : '';   // la vue dédiée remplace la barre rapide
    renderHatchGrid();
  }
  function renderHatchGrid() {
    const grid = $('ht-grid'); if (!grid || !$('hatchPanel') || !$('hatchPanel').classList.contains('open')) return;
    const spMm = parseFloat($('hspace') && $('hspace').value) || 300, color = ($('hcolor') && $('hcolor').value) || '#8892b0', dims = hatchDims();
    grid.innerHTML = '';
    if (hatchView === 'favs') {   // --- page dédiée aux FAVORIS (motif + couleur + échelle) ---
      if (!hatchFavs.length) { const e = document.createElement('div'); e.className = 'lb-empty'; e.textContent = 'Aucun favori pour l’instant. Règle un motif + une couleur + une échelle, puis clique « ★ Favori » pour l’ajouter ici.'; grid.appendChild(e); return; }
      hatchFavs.forEach((f, idx) => {
        const card = document.createElement('div'); card.className = 'lb-card'; card.style.position = 'relative';
        const del = document.createElement('button'); del.className = 'lb-del'; del.textContent = '✕'; del.title = 'Retirer ce favori';
        const cv2 = document.createElement('canvas'); const dim = document.createElement('div'); dim.className = 'lb-dim';
        dim.innerHTML = '<b>' + patLabel(f.pat) + '</b><br><span style="color:var(--muted)">' + hatchSpLabel(f.spacingMm || 300) + ' · ' + (f.color || '') + '</span>';
        card.appendChild(del); card.appendChild(cv2); card.appendChild(dim); grid.appendChild(card);
        drawHatchPreview(cv2, f.pat, f.spacingMm || 300, f.color || '#8892b0', dims.w, dims.h);
        card.onclick = ev => { if (ev.target === del) return; applyHatchFav(f); };
        del.onclick = ev => { ev.stopPropagation(); hatchFavs.splice(idx, 1); saveHatchFavs(); renderHatchFavs(); setHatchView('favs'); };
      });
      return;
    }
    HATCH_PATTERNS.forEach(p => {
      const card = document.createElement('div'); card.className = 'lb-card' + (p.pat === hatchPattern ? ' sel' : '');
      const cv2 = document.createElement('canvas'); const dim = document.createElement('div'); dim.className = 'lb-dim'; dim.textContent = p.name;
      card.appendChild(cv2); card.appendChild(dim); grid.appendChild(card);
      drawHatchPreview(cv2, p.pat, spMm, color, dims.w, dims.h);
      card.onclick = () => { hatchPattern = p.pat; hatchSpacing = spMm; setTool('hatch'); grid.querySelectorAll('.lb-card').forEach(c => c.classList.toggle('sel', c === card)); const hint = $('ht-hint'); if (hint) hint.textContent = '« ' + p.name + ' » — clique une zone fermée pour la remplir'; echo('▦ Motif « ' + p.name + ' » sélectionné — survole une zone fermée et clique pour la remplir.'); cv.focus(); };
    });
  }
  // --- Favoris de hachures (motif + couleur + échelle), mémorisés dans le navigateur ---
  let hatchFavs = [];
  try { hatchFavs = JSON.parse(localStorage.getItem('qlygocad.hatchFavs') || '[]') || []; } catch (e) { hatchFavs = []; }
  function saveHatchFavs() { try { localStorage.setItem('qlygocad.hatchFavs', JSON.stringify(hatchFavs)); } catch (e) { } }
  function patLabel(pat) { return (HATCH_PATTERNS.find(p => p.pat === pat) || {}).name || pat; }
  function renderHatchFavs() {
    const box = $('ht-favs'); if (!box) return; box.innerHTML = '';
    if (!hatchFavs.length) { const e = document.createElement('span'); e.className = 'ht-empty'; e.textContent = '★ Favoris : règle un motif + couleur puis clique « ★ Favori » pour l’enregistrer.'; box.appendChild(e); return; }
    hatchFavs.forEach((f, idx) => {
      const chip = document.createElement('div'); chip.className = 'ht-fav'; chip.title = 'Appliquer ce favori';
      const cvF = document.createElement('canvas'); const nm = document.createElement('span'); nm.textContent = patLabel(f.pat);
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.title = 'Retirer ce favori';
      chip.appendChild(cvF); chip.appendChild(nm); chip.appendChild(x); box.appendChild(chip);
      drawHatchPreview(cvF, f.pat, f.spacingMm || 300, f.color || '#8892b0', 3, 2.4);
      chip.onclick = ev => { if (ev.target === x) return; applyHatchFav(f); };
      x.onclick = ev => { ev.stopPropagation(); hatchFavs.splice(idx, 1); saveHatchFavs(); renderHatchFavs(); };
    });
  }
  function applyHatchFav(f) {
    hatchPattern = f.pat; hatchSpacing = f.spacingMm || hatchSpacing;
    if ($('hcolor')) $('hcolor').value = f.color || $('hcolor').value;
    if ($('hspace')) { const opt = [...$('hspace').options].find(o => +o.value === +f.spacingMm); if (opt) $('hspace').value = String(f.spacingMm); }
    setTool('hatch'); renderHatchGrid();
    const hint = $('ht-hint'); if (hint) hint.textContent = 'Favori « ' + patLabel(f.pat) + ' » — clique une zone fermée pour la remplir';
    echo('★ Favori appliqué : ' + patLabel(f.pat) + ' — survole une zone fermée et clique pour la remplir.');
    cv.focus();
  }
  { const b = $('ht-fav-add'); if (b) b.addEventListener('click', () => {
    const color = ($('hcolor') && $('hcolor').value) || '#8892b0', spacingMm = parseFloat($('hspace') && $('hspace').value) || hatchSpacing;
    if (hatchFavs.some(f => f.pat === hatchPattern && (f.color || '').toLowerCase() === color.toLowerCase() && +f.spacingMm === +spacingMm)) { echo('Ce favori existe déjà.'); return; }
    hatchFavs.unshift({ pat: hatchPattern, color, spacingMm }); if (hatchFavs.length > 48) hatchFavs.length = 48;
    saveHatchFavs(); renderHatchFavs(); setHatchView(hatchView); echo('★ Favori enregistré : ' + patLabel(hatchPattern) + ' (' + hatchFavs.length + ' au total).');
  }); }
  function openHatchPanel() { const pan = $('hatchPanel'); if (!pan) return; pan.classList.add('open'); if ($('hspace')) hatchSpacing = parseFloat($('hspace').value) || hatchSpacing; renderHatchFavs(); setHatchView(hatchView); requestAnimationFrame(() => { renderHatchFavs(); setHatchView(hatchView); }); clampPanelToViewport(pan); }
  function closeHatchPanel() { const pan = $('hatchPanel'); if (pan) pan.classList.remove('open'); }
  { const b = $('hatchOpen'); if (b) b.addEventListener('click', () => { const pan = $('hatchPanel'); if (pan && pan.classList.contains('open')) closeHatchPanel(); else openHatchPanel(); }); }
  { const b = $('ht-close'); if (b) b.addEventListener('click', closeHatchPanel); }
  { const b = $('ht-tab-pat'); if (b) b.addEventListener('click', () => setHatchView('patterns')); }
  { const b = $('ht-tab-fav'); if (b) b.addEventListener('click', () => setHatchView('favs')); }
  { ['ht-w', 'ht-h'].forEach(id => { const el = $(id); if (el) el.addEventListener('input', renderHatchGrid); }); }
  { const head = $('ht-head'), panel = $('hatchPanel');
    if (head && panel) head.addEventListener('mousedown', e => {
      if (e.target.closest('select,button,input')) return;
      const sx = e.clientX, sy = e.clientY, ox = panel.offsetLeft, oy = panel.offsetTop;
      const mv = ev => { panel.style.left = Math.max(0, ox + ev.clientX - sx) + 'px'; panel.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); e.preventDefault();
    });
  }

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
  function resetTransient() { selected = []; draft = []; gripDrag = hotGrip = null; op = null; opGhost = null; ghost = null; trimPreview = null; trimDrag = null; textStart = textZone = textZoneGhost = null; snapInfo = null; guide = null; dimHover = dimPreview = null; boxPending = null; pasteOp = null; selecting = false; selRect = null; hideDyn(); syncCurrentLayer(); }
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
  // Coller = MODE PLACEMENT : l'objet suit le curseur (accroché par clipboard.base),
  // on CLIQUE pour le poser où on veut (Échap = annuler). Pour une menuiserie, base =
  // centre-haut -> c'est ce point qui est collé au curseur.
  function paste() {
    if (!clipboard || !clipboard.ents.length) { echo('Presse-papiers vide.'); return; }
    pasteOp = { ents: refClone(clipboard.ents), base: { x: clipboard.base.x, y: clipboard.base.y } };
    pasteOp.ents.forEach(e => delete e._lib);
    selected = []; if (tool !== 'select') setTool('select');
    echo('📋 Déplace puis CLIQUE pour poser la menuiserie (Échap = annuler).');
    cursor = compute(lastScreen.x, lastScreen.y); updatePasteGhost(); paintOverlay();
  }
  function updatePasteGhost() {
    if (!pasteOp) { opGhost = null; return; }
    const dx = cursor.x - pasteOp.base.x, dy = cursor.y - pasteOp.base.y;
    opGhost = pasteOp.ents.map(e => ({ points: e.points.map(p => ({ x: p.x + dx, y: p.y + dy })), closed: e.closed }));
    hotGrip = { x: cursor.x, y: cursor.y };   // marque le point d'accroche (centre-haut)
  }
  function commitPaste(pt) {
    pushHistory();
    const dx = pt.x - pasteOp.base.x, dy = pt.y - pasteOp.base.y;
    const fresh = refClone(pasteOp.ents);
    fresh.forEach(e => { delete e._lib; e.points.forEach(p => { p.x += dx; p.y += dy; }); if (e.center) { e.center.x += dx; e.center.y += dy; } e._bb = null; scene.entities.push(e); });
    selected = fresh; pasteOp = null; opGhost = null; hotGrip = null; markSceneDirty();
    echo('📋 ' + fresh.length + ' objet(s) posé(s).'); refreshProps(); paint();
  }
  function cancelPaste() { if (pasteOp) { pasteOp = null; opGhost = null; hotGrip = null; echo('Collage annulé.'); paint(); } }
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
    ensureMepLayer();   // le calque « Zones liées » est toujours présent dans la liste
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
      // Cliquer N'IMPORTE OÙ sur la ligne (sauf les boutons œil/gel/verrou) choisit le
      // calque ET ferme le menu tout de suite — au plus simple, pas besoin d'Échap.
      const choose = ev => { ev.stopPropagation(); pickLayer(l.id); };
      row.onclick = choose; row.style.cursor = 'pointer';
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
      const mv = movableSel();
      pushHistory(mv.length ? mv : selected);
      // BYLAYER : en changeant de calque, le trait adopte la COULEUR et l'ÉPAISSEUR
      // du nouveau calque (on efface sa couleur/épaisseur propres). On garde la teinte
      // d'une hachure (zone remplie) pour ne pas détruire un aplat de couleur.
      mv.forEach(e => { e.layer = id; if (e.type !== 'hatch') e.color = null; e.penMm = null; e._bb = null; });
      echo(mv.length + ' objet(s) sur « ' + layerById(id).name + ' » — couleur + épaisseur du calque adoptées.'); refreshProps();
    } else { baseLayer = id; }
    currentLayer = id; $('color').value = layerById(id).color; updateSwatch('color');
    // Choisir un calque ferme le menu déroulant. On ferme maintenant ET à la frame
    // suivante (le clic qui a servi à choisir peut, sinon, rouvrir le menu juste après).
    renderLayerSelect(); closeLayerDropdown(); requestAnimationFrame(closeLayerDropdown); paint();
  }
  function closeLayerDropdown() { const dd = $('ldd'); if (dd) dd.classList.remove('open'); const list = $('ldd-list'); if (list) list.style.display = 'none'; }
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
          l.color = ev.target.value; pushRecentColor(l.color);
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
    const rz = document.createElement('div'); rz.className = 'lp-resize'; rz.title = 'Redimensionner'; box.appendChild(rz);
    rz.addEventListener('mousedown', e => {
      const sx = e.clientX, sy = e.clientY, ow = box.offsetWidth, oh = box.offsetHeight;
      const mv = ev => { box.style.width = Math.max(260, ow + ev.clientX - sx) + 'px'; box.style.height = Math.max(180, oh + ev.clientY - sy) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); e.preventDefault(); e.stopPropagation();
    });
    $('lp-add').onclick = addLayer; $('lp-close').onclick = toggleLayersPanel;
  }
  // Panneau Calques DÉPLAÇABLE (comme la bibliothèque / les hachures) : on glisse l'en-tête.
  (function initLayersDrag() {
    const box = $('layers'); if (!box) return;
    box.addEventListener('mousedown', e => {
      const head = e.target.closest('.lp-head'); if (!head || !box.contains(head)) return;
      if (e.target.closest('button,input,select')) return;
      const sx = e.clientX, sy = e.clientY, ox = box.offsetLeft, oy = box.offsetTop;
      box.style.right = 'auto'; box.style.left = ox + 'px'; box.style.top = oy + 'px';
      const mv = ev => { box.style.left = Math.max(0, ox + ev.clientX - sx) + 'px'; box.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); e.preventDefault();
    });
  })();
  function refreshLayers() { renderLayerSelect(); renderLayersPanel(); }
  function toggleLayersPanel() { const box = $('layers'); if (!box) return; const opening = box.style.display !== 'flex'; box.style.display = opening ? 'flex' : 'none'; refreshLayers(); if (opening) clampPanelToViewport(box); }
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

  // ---------- Informations client (centralisées, appliquées à TOUTES les pages) ----------
  // À terme ces infos viendront de Qlygo ; pour l'instant on les saisit ici une seule
  // fois. Le nom affiché dans le cartouche de chaque page vient de clientLabel().
  // Si tout est vide -> le cartouche affiche un nom vide.
  function loadClientInfo() {
    try { const s = JSON.parse(localStorage.getItem('qlygocad.clientInfo') || 'null'); if (s && typeof s === 'object') return { civ: s.civ || '', nom: s.nom || '', prenom: s.prenom || '' }; } catch (e) { }
    return { civ: 'Mme', nom: 'CAZEAUX', prenom: 'Nicole' };   // exemple de départ — modifiable / effaçable
  }
  let clientInfo = loadClientInfo();
  function saveClientInfo() { try { localStorage.setItem('qlygocad.clientInfo', JSON.stringify(clientInfo)); } catch (e) { } }
  function clientLabel() {
    return [clientInfo.civ, clientInfo.nom, clientInfo.prenom].map(s => (s || '').trim()).filter(Boolean).join(' ');
  }
  function toggleClient() { const box = $('client'); if (!box) return; const opn = box.style.display !== 'block'; box.style.display = opn ? 'block' : 'none'; if (opn) { const o = $('options'); if (o) o.style.display = 'none'; renderClient(); } }
  function renderClient() {
    const box = $('client'); if (!box) return;
    box.innerHTML = '<div class="lp-head"><b>👤 Informations client</b><span style="flex:1"></span>' +
      '<button id="cl-clear" title="Tout vider">↺</button><button id="cl-close" title="Fermer">✕</button></div>';
    const civ = document.createElement('div'); civ.className = 'op-row';
    civ.innerHTML = '<span class="op-name">Genre</span><select data-k="civ">' +
      ['', 'Mme', 'M.', 'Mme et M.'].map(v => '<option value="' + v + '"' + (clientInfo.civ === v ? ' selected' : '') + '>' + (v || '—') + '</option>').join('') + '</select>';
    box.appendChild(civ);
    const nom = document.createElement('div'); nom.className = 'op-row';
    nom.innerHTML = '<span class="op-name">Nom</span><input type="text" data-k="nom" value="' + escAttr(clientInfo.nom) + '" placeholder="CAZEAUX">';
    box.appendChild(nom);
    const prenom = document.createElement('div'); prenom.className = 'op-row';
    prenom.innerHTML = '<span class="op-name">Prénom</span><input type="text" data-k="prenom" value="' + escAttr(clientInfo.prenom) + '" placeholder="Nicole">';
    box.appendChild(prenom);
    const note = document.createElement('div'); note.className = 'cl-note';
    note.textContent = 'Aperçu cartouche : « ' + (clientLabel() || '(vide)') + ' ». Appliqué automatiquement à toutes les pages (DP2/DP3/DP4).';
    box.appendChild(note);
    box.querySelectorAll('[data-k]').forEach(el => {
      const k = el.dataset.k;
      const handler = () => { clientInfo[k] = el.value; saveClientInfo(); note.textContent = 'Aperçu cartouche : « ' + (clientLabel() || '(vide)') + ' ». Appliqué automatiquement à toutes les pages (DP2/DP3/DP4).'; if (activePage !== 'model') paintPage(); };
      el.addEventListener('input', handler); el.addEventListener('change', handler);
    });
    $('cl-close').onclick = toggleClient;
    $('cl-clear').onclick = () => { clientInfo = { civ: '', nom: '', prenom: '' }; saveClientInfo(); renderClient(); if (activePage !== 'model') paintPage(); };
  }
  function escAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

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
      ['color', 'Couleur' + (e0.color == null ? ' (du calque)' : ''), '<input type="color" data-pk="color" value="' + (e0.color || layerById(e0.layer).color || (isDim ? '#b9375e' : '#1b2b4b')) + '">'],
      ['noPrint', 'Impression', '<select data-pk="noPrint"><option value="0"' + (!e0.noPrint ? ' selected' : '') + '>🖨 Imprimé</option><option value="1"' + (e0.noPrint ? ' selected' : '') + '>🚫 Guide (non imprimé)</option></select>']
    ];
    if (!isDim && !isText && !isHatch) {
      const effPen = e0.penMm != null ? e0.penMm : (layerById(e0.layer).penMm != null ? layerById(e0.layer).penMm : 0.25);
      rows.push(['penMm', 'Épaisseur' + (e0.penMm == null ? ' (du calque)' : ''), '<select data-pk="penMm">' + [0.18, 0.25, 0.35, 0.5, 0.7, 1].map(v => '<option value="' + v + '"' + (Math.abs(effPen - v) < 1e-6 ? ' selected' : '') + '>' + String(v).replace('.', ',') + ' mm</option>').join('') + '</select>']);
      rows.push(['dash', 'Type de trait', '<select data-pk="dash">' + [['solid', '——— continu'], ['dashed', '– – – tirets'], ['dotted', '· · · · pointillés'], ['dashdot', '–·–·– mixte']].map(a => '<option value="' + a[0] + '"' + (((e0.dash || 'solid') === a[0]) ? ' selected' : '') + '>' + a[1] + '</option>').join('') + '</select>']);
    }
    if (isDim) {
      rows.push(['arrow', 'Extrémités', '<select data-pk="arrow"><option value="arrow"' + (((e0.arrow || 'arrow') === 'arrow') ? ' selected' : '') + '>➤ flèches</option><option value="tick"' + (e0.arrow === 'tick' ? ' selected' : '') + '>╱ obliques</option></select>']);
      // Hauteur : Auto = s'adapte à la longueur mesurée ; sinon hauteur forcée (m réels).
      const dimHv = (e0.hMm == null) ? 'auto' : String(e0.hMm);
      const hOpts = [['auto', 'Auto (selon la taille)'], ['100', '0,10 m'], ['250', '0,25 m'], ['500', '0,50 m'], ['1000', '1,00 m']];
      rows.push(['dimH', 'Hauteur du texte', '<select data-pk="dimH">' + hOpts.map(o => '<option value="' + o[0] + '"' + (o[0] === dimHv ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>']);
      rows.push(['dec', 'Décimales', '<select data-pk="dec">' + [0, 1, 2, 3].map(v => '<option value="' + v + '"' + (((e0.dec != null ? e0.dec : 2) === v) ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>']);
      // Position de la valeur : SUR la ligne (centrée, dans un trou) ou au-dessus.
      const tp = (e0.textPos === 'above') ? 'above' : 'inline';
      rows.push(['textPos', 'Valeur', '<select data-pk="textPos"><option value="inline"' + (tp === 'inline' ? ' selected' : '') + '>centrée sur la ligne</option><option value="above"' + (tp === 'above' ? ' selected' : '') + '>au-dessus</option></select>']);
      // Lignes d'attache : les deux / une seule / aucune (traits reliant la cote au trait mesuré).
      const extV = (e0.extA === false && e0.extB === false) ? 'none' : (e0.extA === false ? 'b' : (e0.extB === false ? 'a' : 'both'));
      rows.push(['extSides', 'Lignes d’attache', '<select data-pk="extSides">' + [['both', 'les deux'], ['a', 'gauche seule'], ['b', 'droite seule'], ['none', 'aucune']].map(o => '<option value="' + o[0] + '"' + (o[0] === extV ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>']);
      // Dépassement des lignes d'attache au-delà de la ligne de cote.
      const ebV = (e0.extBeyondMm == null) ? 'auto' : String(e0.extBeyondMm);
      rows.push(['extBeyond', 'Dépassement', '<select data-pk="extBeyond">' + [['auto', 'auto'], ['0', 'aucun'], ['100', '0,10 m'], ['200', '0,20 m'], ['500', '0,50 m']].map(o => '<option value="' + o[0] + '"' + (o[0] === ebV ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>']);
      // Valeur exacte : vide = mesure automatique ; sinon valeur forcée (en mètres).
      const vcur = (e0.valMm != null) ? String(e0.valMm / 1000).replace('.', ',') : '';
      rows.push(['valMm', 'Valeur exacte (m)', '<input type="text" data-pk="valMm" value="' + vcur + '" placeholder="auto : ' + fmtM(G.dimValue(e0)) + '" style="width:92px">']);
    }
    if (isText) {
      rows.push(['text', 'Contenu', '<input type="text" data-pk="text" value="' + escHtml(e0.text || '') + '" style="width:150px">']);
      rows.push(['hMm', 'Hauteur', '<select data-pk="hMm">' + [300, 500, 800, 1000, 2000].map(v => '<option value="' + v + '"' + (Math.abs((e0.hMm || 800) - v) < 1e-6 ? ' selected' : '') + '>' + (v / 1000).toFixed(2).replace('.', ',') + ' m</option>').join('') + '</select>']);
      const fonts = [['system-ui,Segoe UI,sans-serif', 'Standard'], ['Arial,Helvetica,sans-serif', 'Arial'], ["'Times New Roman',Georgia,serif", 'Times'], ["'Courier New',monospace", 'Courier'], ['Georgia,serif', 'Georgia'], ["'Trebuchet MS',sans-serif", 'Trebuchet']];
      rows.push(['font', 'Police', '<select data-pk="font">' + fonts.map(f => '<option value="' + escHtml(f[0]) + '"' + (((e0.font || fonts[0][0]) === f[0]) ? ' selected' : '') + '>' + f[1] + '</option>').join('') + '</select>']);
      rows.push(['align', 'Aligner H', '<select data-pk="align">' + [['left', '⬅ Gauche'], ['center', '⬌ Centré'], ['right', '➡ Droite']].map(a => '<option value="' + a[0] + '"' + (((e0.align || 'left') === a[0]) ? ' selected' : '') + '>' + a[1] + '</option>').join('') + '</select>']);
      rows.push(['valign', 'Aligner V', '<select data-pk="valign">' + [['top', '⬆ Haut'], ['middle', '⬍ Milieu'], ['bottom', '⬇ Bas']].map(a => '<option value="' + a[0] + '"' + (((e0.valign || 'top') === a[0]) ? ' selected' : '') + '>' + a[1] + '</option>').join('') + '</select>']);
      rows.push(['angleDeg', 'Angle (°)', '<input type="number" data-pk="angleDeg" value="' + (e0.angleDeg || 0) + '" step="5" style="width:72px">']);
    }
    rows.forEach(r => { const d = document.createElement('div'); d.className = 'op-row'; d.innerHTML = '<span class="op-name">' + r[1] + '</span>' + r[2]; b.appendChild(d); });
    // --- Zone liée (mise en page) : relier un rectangle Objet à une case DP ---
    const canLink = !!e0.mepTarget || e0.layer === MEP_LAYER_ID || (e0.closed && (e0.type === 'polyline' || e0.type === 'rect') && e0.points && e0.points.length === 4);
    if (selected.length === 1 && canLink) {
      const cur = e0.mepTarget ? [e0.mepTarget.template, e0.mepTarget.scale, e0.mepTarget.facade || '', e0.mepTarget.win].join('|') : '';
      const opts = mepSlotOptions();
      const html = '<select data-mep="1"><option value="">— non reliée —</option>' + opts.map(o => '<option value="' + o.key + '"' + (o.key === cur ? ' selected' : '') + '>' + o.label + '</option>').join('') + '</select>';
      const d = document.createElement('div'); d.className = 'op-row'; d.innerHTML = '<span class="op-name">🔗 Reliée à la case</span>' + html; b.appendChild(d);
      d.querySelector('[data-mep]').addEventListener('change', ev => {
        const v = ev.target.value; pushHistory([e0]);
        if (!v) { delete e0.mepTarget; echo('Rectangle détaché (plus relié à une case).'); }
        else { const [t, sc, fac, win] = v.split('|'); e0.mepTarget = { template: t, scale: +sc, facade: fac, win: +win }; e0.layer = ensureMepLayer(); e0.color = null; e0.penMm = null; echo('🔗 Rectangle relié à ' + slotLabel(t, +sc, fac, +win) + '.'); }
        e0._bb = null; markSceneDirty(); refreshLayers(); renderProps(); paint();
      });
    }
    b.querySelectorAll('[data-pk]').forEach(el => el.addEventListener('change', () => {
      const k = el.dataset.pk; let v = el.value; if (numKeys[k]) v = parseFloat(v);
      pushHistory(selected);
      selected.forEach(e => {
        if (k === 'dash') { if (v === 'solid') delete e.dash; else e.dash = v; }
        else if (k === 'arrow') { if (v === 'arrow') delete e.arrow; else e.arrow = v; }
        else if (k === 'layer') { e.layer = v; if (e.type !== 'hatch') e.color = null; e.penMm = null; }  // BYLAYER : couleur+épaisseur du calque
        else if (k === 'noPrint') { if (v === '1') e.noPrint = true; else delete e.noPrint; }
        else if (k === 'dimH') { if (el.value === 'auto') delete e.hMm; else e.hMm = parseFloat(el.value); }   // cote : hauteur auto ou forcée
        else if (k === 'valMm') { const s = String(el.value).trim().replace(',', '.'); if (s === '') delete e.valMm; else { const n = parseFloat(s); if (isFinite(n)) e.valMm = Math.round(n * 1000); } }   // cote : valeur exacte forcée
        else if (k === 'textPos') { if (el.value === 'above') e.textPos = 'above'; else delete e.textPos; }   // cote : valeur sur la ligne / au-dessus
        else if (k === 'extSides') { const vv = el.value; if (vv === 'both') { delete e.extA; delete e.extB; } else if (vv === 'a') { delete e.extA; e.extB = false; } else if (vv === 'b') { e.extA = false; delete e.extB; } else { e.extA = false; e.extB = false; } }   // cote : lignes d'attache par côté
        else if (k === 'extBeyond') { if (el.value === 'auto') delete e.extBeyondMm; else e.extBeyondMm = parseFloat(el.value); }   // cote : dépassement des lignes d'attache
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
  // Couleur FIDÈLE sur papier blanc : une couleur grisâtre ou très claire (le « crayon
  // de bois gommé ») devient un noir net ; une couleur bien saturée (rouge terrain,
  // bleu, vert…) est conservée telle quelle. -> traits bien visibles, couleurs justes.
  function mapColor(hex) {
    if (!hex) return '#111111';
    const c = hx(hex); const max = Math.max(c[0], c[1], c[2]), min = Math.min(c[0], c[1], c[2]);
    const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    const sat = max === 0 ? 0 : (max - min) / max;
    return (sat < 0.28 || lum > 0.85) ? '#111111' : hex;
  }
  function paperMm(page) { const pp = U.PAPER[page.paper] || U.PAPER.A4; return page.orientation === 'landscape' ? { w: pp.h, h: pp.w } : { w: pp.w, h: pp.h }; }
  function pageLayout(page) {
    const paper = paperMm(page), margin = 10, pad = 46;
    // zoom (molette) + décalage (pan) de la FEUILLE à l'écran -> on peut zoomer pour
    // placer précisément les plans dans les cases, tout en gardant l'échelle 1:xxx.
    const fitPpm = Math.min((view.canvasW - 2 * pad) / paper.w, (view.canvasH - 2 * pad) / paper.h);
    const ppmPaper = fitPpm * (page._z || 1);
    const sheetW = paper.w * ppmPaper, sheetH = paper.h * ppmPaper;
    const Sx0 = (view.canvasW - sheetW) / 2 + (page._ox || 0), Sy0 = (view.canvasH - sheetH) / 2 + (page._oy || 0), Sy1 = Sy0 + sheetH;
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
    // Zones « liées » (accrochées) par défaut : avant/après montrent le MÊME cadrage.
    if (page.layoutData.vpSync === undefined) page.layoutData.vpSync = true;
    let vps = page.layoutData.viewports; if (!Array.isArray(vps)) vps = page.layoutData.viewports = [];
    if (vps.length !== wins.length || vps.some(v => !v || !isFinite(v.cx))) {
      const f = modelFocus();
      for (let i = 0; i < wins.length; i++) if (!vps[i] || !isFinite(vps[i].cx)) vps[i] = { cx: f.cx, cy: f.cy };
      vps.length = wins.length;
    }
    return vps;
  }
  // Zones liées : recopie le cadrage (centre + échelle) de la zone source sur toutes
  // les autres -> avant/après (et toute case) montrent exactement la même région.
  function syncViewports(page, srcI) {
    if (!(page.layoutData && page.layoutData.vpSync)) return;
    const vps = page.layoutData.viewports; if (!vps || !vps[srcI]) return;
    const s = vps[srcI];
    for (let j = 0; j < vps.length; j++) if (j !== srcI && vps[j]) { vps[j].cx = s.cx; vps[j].cy = s.cy; vps[j].sd = s.sd; }
  }
  // ---- Zones liées par RECTANGLE (mise en page pilotée depuis l'espace Objet) ----
  // Un rectangle dessiné sur le calque « Zones liées » est relié à une case précise
  // d'une page DP (template + échelle + façade + n° de case). La case affiche alors
  // EXACTEMENT la région du rectangle (centre + échelle ajustée à sa taille), quel
  // que soit le niveau de zoom choisi. Ces rectangles ne s'impriment pas.
  const MEP_LAYER_ID = 'mep-zones';
  function ensureMepLayer() {
    let l = scene.layers.find(x => x.id === MEP_LAYER_ID);
    if (!l) { l = { id: MEP_LAYER_ID, name: 'Zones liées', color: '#e0409a', penMm: 0.25, visible: true, locked: false, frozen: false, mep: true }; scene.layers.push(l); }
    // Migration : le calque n'est PLUS « non imprimé » globalement. Seuls les
    // rectangles de cadrage (mepTarget) sont des guides exclus des cases ; tout
    // AUTRE contenu de ce calque se projette normalement.
    if (l.noPrint) delete l.noPrint;
    return MEP_LAYER_ID;
  }
  function mepRectFor(template, scale, facade, win) {
    const fac = facade || '';
    for (const e of scene.entities) {
      const t = e.mepTarget; if (!t || e.layer !== MEP_LAYER_ID || !e.points || e.points.length < 3) continue;
      if (t.template === template && +t.scale === +scale && (t.facade || '') === fac && +t.win === +win) return e;
    }
    return null;
  }
  // Cadre résolu d'une case : depuis le rectangle lié s'il existe, sinon le vp stocké.
  function resolvedVp(page, i, w) {
    const vps = ensureViewports(page, QCAD.layouts[page.template]);
    const rect = mepRectFor(page.template, page.scaleDenom, page.facade || '', i);
    if (rect) {
      const bb = R._bbox(rect), rw = Math.max(1, bb[2] - bb[0]);
      // Ajustement à la LARGEUR de la case : toutes les cases d'une page ont la même
      // largeur, donc deux rectangles de même largeur donnent EXACTEMENT la même
      // échelle -> l'avant et l'après sont alignés (plus de décalage dû aux hauteurs
      // de cases différentes, ex. 104 vs 98 mm).
      const sd = rw / Math.max(1, w.w);
      return { cx: (bb[0] + bb[2]) / 2, cy: (bb[1] + bb[3]) / 2, sd, linked: true, rect };
    }
    const vp = vps[i] || { cx: 0, cy: 0 };
    return { cx: vp.cx, cy: vp.cy, sd: vp.sd || page.scaleDenom || 500, linked: false };
  }
  // Fenêtre « À quelle case relier cette zone ? » (ouverte après avoir tracé un
  // rectangle sur le calque « Zones liées »). Style appli, pas de prompt navigateur.
  function closeMepLinkDialog() { const d = $('mepDlg'); if (d) d.remove(); }
  function openMepLinkDialog(rect, justCreated) {
    closeMepLinkDialog();
    const ov = document.createElement('div'); ov.id = 'mepDlg';
    ov.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 16px 12px;min-width:360px;max-width:460px;max-height:78vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.5)';
    const curKey = rect.mepTarget ? [rect.mepTarget.template, rect.mepTarget.scale, rect.mepTarget.facade || '', rect.mepTarget.win].join('|') : '';
    let html = '<div style="font-weight:700;color:var(--primary);font-size:15px;margin-bottom:4px">🔗 Relier cette zone à une case</div>'
      + '<div style="color:var(--muted);font-size:12px;margin-bottom:10px">Choisis la case que ce rectangle va cadrer (centre + échelle déduits du rectangle). <span style="color:#22c55e">●</span> = case déjà implémentée.</div>'
      + '<div style="overflow:auto;flex:1;display:flex;flex-direction:column;gap:3px">';
    const opts = mepSlotOptions(); let lastTpl = '';
    opts.forEach(o => {
      const tpl = o.key.split('|')[0];
      if (tpl !== lastTpl) { lastTpl = tpl; html += '<div style="color:var(--muted);font-size:11px;font-weight:700;margin:8px 0 2px">' + ({ dp02: 'DP02 — Plan de masse', dp03: 'DP03 — Plan de coupe', dp04: 'DP04 — Plan de façade' }[tpl] || tpl) + '</div>'; }
      const on = o.key === curKey;
      const kp = o.key.split('|'); const taken = mepRectFor(kp[0], +kp[1], kp[2], +kp[3]);
      // Petit point VERT sur les cases déjà implémentées (un rectangle y est relié).
      const dot = (taken && taken !== rect) ? '<span style="color:#22c55e;font-size:13px;line-height:1">●</span>' : '<span style="color:transparent;font-size:13px;line-height:1">●</span>';
      html += '<button data-key="' + o.key + '" style="display:flex;align-items:center;gap:8px;text-align:left;background:' + (on ? 'var(--primary)' : 'var(--surface2)') + ';color:' + (on ? '#13131a' : 'var(--text)') + ';border:1px solid var(--border);border-radius:6px;padding:7px 10px;cursor:pointer;font:inherit">' + dot + '<span>' + escHtml(o.label) + '</span></button>';
    });
    html += '</div><div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">'
      + '<button data-act="none" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 12px;cursor:pointer;font:inherit">Ne pas relier</button>'
      + (justCreated ? '<button data-act="del" style="background:var(--surface2);color:var(--danger);border:1px solid var(--border);border-radius:6px;padding:7px 12px;cursor:pointer;font:inherit">🗑 Supprimer</button>' : '')
      + '</div>';
    panel.innerHTML = html; ov.appendChild(panel); document.body.appendChild(ov);
    const close = () => closeMepLinkDialog();
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    panel.querySelectorAll('button[data-key]').forEach(btn => btn.onclick = () => {
      const [t, sc, fac, win] = btn.dataset.key.split('|');
      pushHistory([rect]);
      // une seule zone par case : on détache tout autre rectangle visant la même case
      const dup = mepRectFor(t, +sc, fac, +win); if (dup && dup !== rect) delete dup.mepTarget;
      rect.mepTarget = { template: t, scale: +sc, facade: fac, win: +win };
      rect.layer = ensureMepLayer(); rect.color = null; rect.penMm = null; rect._bb = null;
      markSceneDirty(); refreshLayers(); refreshProps(); paint(); close();
      echo('🔗 Zone reliée à ' + slotLabel(t, +sc, fac, +win) + '. (La case cadrera ce rectangle.)');
    });
    const noneBtn = panel.querySelector('[data-act="none"]'); if (noneBtn) noneBtn.onclick = close;
    const delBtn = panel.querySelector('[data-act="del"]'); if (delBtn) delBtn.onclick = () => { pushHistory(); const i = scene.entities.indexOf(rect); if (i >= 0) scene.entities.splice(i, 1); selected = []; markSceneDirty(); refreshProps(); paint(); close(); echo('Rectangle supprimé.'); };
  }
  // Vue (repère monde->écran) d'un viewport : échelle de la page, centrée sur (cx,cy).
  function vpView(page, Sx0, Sy0, ppmPaper, canvasH, w, vp) {
    const sd = (vp && vp.sd) || page.scaleDenom || 500;
    const ppmView = ppmPaper / sd;
    const winCxS = Sx0 + (w.x + w.w / 2) * ppmPaper, winCyS = Sy0 + (w.y + w.h / 2) * ppmPaper;
    return { pxPerMm: ppmView, panXmm: vp.cx - winCxS / ppmView, panYmm: vp.cy + (winCyS - canvasH) / ppmView, canvasW: 0, canvasH };
  }
  // Dessine la géométrie Objet visible dans le rectangle écran `clip` (fond blanc).
  function drawModelRegion(ctx, vw, clip, ppmPaper) {
    ctx.save(); ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
    // Épaisseur de trait FIDÈLE AU PAPIER : on cale l'échelle des plumes sur le
    // nombre de px/mm papier -> une plume 0,25 mm fait vraiment 0,25 mm (≈2 px à
    // l'impression), 0,5 mm est 2× plus épaisse, etc. (fini le rendu « crayon gommé »).
    const prevLwt = R.lwtScale; if (ppmPaper) R.lwtScale = ppmPaper;
    const a = R.screenToWorld(vw, clip.x, clip.y + clip.h), b = R.screenToWorld(vw, clip.x + clip.w, clip.y);
    const mx0 = Math.min(a.x, b.x), my0 = Math.min(a.y, b.y), mx1 = Math.max(a.x, b.x), my1 = Math.max(a.y, b.y);
    const pad = Math.max(1, (mx1 - mx0) * 0.03);
    const cand = queryIndex(mx0 - pad, my0 - pad, mx1 + pad, my1 + pad);
    const m = {}; for (const l of scene.layers) m[l.id] = l.visible && !l.frozen && !l.noPrint;  // calque « Zones liées » = guide, jamais dessiné dans une case
    const lc = id => layerById(id).color, lp = id => { const l = layerById(id); return l.penMm != null ? l.penMm : 0.25; };
    const vis = e => { const bb = R._bbox(e); return !(bb[2] < mx0 || bb[0] > mx1 || bb[3] < my0 || bb[1] > my1); };
    for (const e of cand) if (e.type === 'image' && m[e.layer] && !e._lib && !e.noPrint && !e.mepTarget && vis(e)) R.drawImage(ctx, vw, e);
    for (const e of cand) if (e.type === 'hatch' && m[e.layer] && !e._lib && !e.noPrint && !e.mepTarget && vis(e)) R.drawHatch(ctx, vw, e, mapColor(e.color || lc(e.layer)));
    const grp = new Map(), dims = [], txts = [];
    for (const e of cand) {
      const t = e.type; if (t === 'hatch' || t === 'image') continue; if (!m[e.layer] || e._lib || e.noPrint || e.mepTarget || !vis(e)) continue;
      if (t === 'dim') { dims.push(e); continue; } if (t === 'text') { txts.push(e); continue; }
      if (e.dash) { R.drawEntity(ctx, vw, e, mapColor(e.color || lc(e.layer)), lp(e.layer)); continue; }
      const col = mapColor(e.color || lc(e.layer)), ww = R.penPx(e.penMm != null ? e.penMm : lp(e.layer)), key = col + '|' + ww;
      let g = grp.get(key); if (!g) { g = { col, w: ww, list: [] }; grp.set(key, g); } g.list.push(e);
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
    for (const g of grp.values()) { ctx.strokeStyle = g.col; ctx.lineWidth = g.w; ctx.beginPath(); for (const e of g.list) { const p = e.points; if (!p.length) continue; let s = R.worldToScreen(vw, p[0].x, p[0].y); ctx.moveTo(s.x, s.y); for (let i = 1; i < p.length; i++) { s = R.worldToScreen(vw, p[i].x, p[i].y); ctx.lineTo(s.x, s.y); } if (e.closed) ctx.closePath(); } ctx.stroke(); }
    for (const e of dims) R.drawDim(ctx, vw, e, false, mapColor(e.color || lc(e.layer)));
    for (const e of txts) R.drawText(ctx, vw, e, mapColor(e.color || lc(e.layer)));
    R.lwtScale = prevLwt;   // on rétablit l'échelle des plumes écran
    ctx.restore();
  }
  // Dessine une page-gabarit complète (cartouche + plans cadrés) dans un repère papier
  // donné. Utilisé À L'ÉCRAN (paintPage) ET à l'IMPRESSION -> rendu identique (WYSIWYG).
  function drawTemplatePage(ctx, page, Sx0, Sy0, ppmPaper, canvasH, highlightVp, printMode) {
    const tpl = QCAD.layouts[page.template]; if (!tpl) return;
    const T = (xmm, ymm) => ({ x: Sx0 + xmm * ppmPaper, y: Sy0 + ymm * ppmPaper });
    // 1) cartouche (bandeaux, titres, échelles, logos…) ; zones de plan laissées blanches
    // Pour DP03/DP04 : on injecte l'orientation de la vue (Face avant, Pignon droit…)
    // dans le cartouche comme sous-titre (dpSub), sans toucher aux données enregistrées.
    // Nom client CENTRALISÉ : clientLabel() prime sur le client enregistré par page
    // (une seule saisie -> toutes les pages). Vide si aucune info saisie.
    let drawData = Object.assign({}, page.layoutData, { client: clientLabel() });
    if ((page.template === 'dp03' || page.template === 'dp04') && page.facade) {
      drawData.dpSub = dirLabel(page.facade);
    }
    if (printMode) drawData.hideZoneGuides = true;   // cases totalement blanches à l'impression
    QCAD.layouts[page.template].draw(ctx, T, ppmPaper, drawData, paintPage);
    // 2) plans cadrés dans chaque zone blanche
    const wins = tpl.planWindows || [], vps = ensureViewports(page, tpl);
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i], vp = resolvedVp(page, i, w), a = T(w.x, w.y), c = T(w.x + w.w, w.y + w.h);
      const clip = { x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y };
      drawModelRegion(ctx, vpView(page, Sx0, Sy0, ppmPaper, canvasH, w, vp), clip, ppmPaper);
      // Cadre de case : repère d'ÉDITION seulement. À l'impression (printMode) on ne le
      // trace PAS -> la case reste blanche/transparente dans le rendu final.
      if (!printMode) {
        ctx.strokeStyle = (highlightVp === i) ? '#ffcc00' : '#9aa6bf'; ctx.lineWidth = (highlightVp === i) ? 3 : 1; ctx.setLineDash([]);
        ctx.strokeRect(clip.x, clip.y, clip.w, clip.h);
      }
    }
    // 3) calques « par-dessus » de la mise en page (boussole du plan de masse…),
    // dessinés APRÈS les cases pour rester visibles sans « E » parasite.
    if (tpl.overlay) tpl.overlay(ctx, T, ppmPaper, drawData);
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
      drawTemplatePage(ctx, page, L.Sx0, L.Sy0, L.ppmPaper, H, vpDrag ? vpDrag.i : selVp);
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
    for (const e of vs.entities) if (e.type === 'image' && !e.noPrint && !e.mepTarget && vis2(e)) R.drawImage(ctx, L.pageView, e);
    for (const e of vs.entities) if (e.type === 'hatch' && !e.noPrint && !e.mepTarget && vis2(e)) R.drawHatch(ctx, L.pageView, e, mapColor(e.color || lc(e.layer)));
    const grp = new Map(), dims = [], txts = [];
    for (const e of vs.entities) {
      const t = e.type; if (t === 'hatch' || t === 'image') continue;
      if (e.noPrint || e.mepTarget || !vis2(e)) continue;
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
    // Titre cohérent : « DP04 1-100 · Plan de façade · Façade avant ».
    const planN = PLAN_NAME[page.template];
    const dir = (page.template === 'dp03' || page.template === 'dp04') && page.facade ? '   ·   ' + facadeLabel(page.template, page.facade) : '';
    const planLbl = planN ? '   ·   ' + planN : '';
    ctx.fillText(page.name + planLbl + dir + '   ·   1:' + page.scaleDenom + '   ·   ' + page.paper + ' ' + (page.orientation === 'landscape' ? 'paysage' : 'portrait'), dx0 + 6, dy0 + dh - 6);
    ctx.textAlign = 'start';
    $('coords').textContent = 'Page : ' + page.name;
  }
  function pageMouseDown(e) {
    const page = pages.find(p => p.id === activePage);
    // Double-clic molette = réinitialiser la vue de la feuille (zoom/pan).
    if (e.button === 1) { const now = Date.now(); if (now - lastMidDown < 400 && page) { lastMidDown = 0; page._z = 1; page._ox = 0; page._oy = 0; paintPage(); echo('Vue de la feuille réinitialisée.'); e.preventDefault(); return; } lastMidDown = now; }
    // Sur une mise en page : un clic DANS une zone blanche = cadrage du plan (glisser).
    // Sauf si les cases sont VERROUILLÉES (positions figées : les plans se placent tout seuls).
    if (page && page.template && QCAD.layouts[page.template] && !(page.layoutData && page.layoutData.vpLocked)) {
      const L = pageLayout(page), tpl = QCAD.layouts[page.template], wins = tpl.planWindows || [];
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      const T = (xmm, ymm) => ({ x: L.Sx0 + xmm * L.ppmPaper, y: L.Sy0 + ymm * L.ppmPaper });
      const vps = ensureViewports(page, tpl);
      for (let i = 0; i < wins.length; i++) {
        const w = wins[i], a = T(w.x, w.y), b = T(w.x + w.w, w.y + w.h);
        if (sx >= a.x && sx <= b.x && sy >= a.y && sy <= b.y) {
          selVp = i;   // zone sélectionnée : contour jaune
          if (mepRectFor(page.template, page.scaleDenom, page.facade || '', i)) { cv.style.cursor = 'default'; echo('🔗 Zone ' + (i + 1) + ' pilotée par un rectangle (calque « Zones liées ») — ajuste le rectangle en Objet.'); paintPage(); return; }
          const sd = (vps[i].sd || page.scaleDenom);
          vpDrag = { i, sx: e.clientX, sy: e.clientY, cx: vps[i].cx, cy: vps[i].cy, ppmView: L.ppmPaper / sd };
          cv.style.cursor = 'move'; echo('🟡 Zone ' + (i + 1) + ' sélectionnée — glissez pour cadrer, molette pour zoomer dans la zone.'); paintPage(); return;
        }
      }
    }
    selVp = -1;   // clic hors zone : on désélectionne
    pageDrag = { sx: e.clientX, sy: e.clientY }; cv.style.cursor = 'grabbing';
  }
  function pageMouseMove(e) {
    if (vpDrag) {
      const page = pages.find(p => p.id === activePage); if (!page) return;
      const vps = page.layoutData.viewports; const dxs = e.clientX - vpDrag.sx, dys = e.clientY - vpDrag.sy;
      vps[vpDrag.i].cx = vpDrag.cx - dxs / vpDrag.ppmView; vps[vpDrag.i].cy = vpDrag.cy + dys / vpDrag.ppmView;
      syncViewports(page, vpDrag.i);   // zones liées : l'autre case suit le même cadrage
      paintPage(); return;
    }
    if (!pageDrag) return;
    const page = pages.find(p => p.id === activePage); if (!page) return;
    const dxs = e.clientX - pageDrag.sx, dys = e.clientY - pageDrag.sy; pageDrag.sx = e.clientX; pageDrag.sy = e.clientY;
    if (page.template) { page._ox = (page._ox || 0) + dxs; page._oy = (page._oy || 0) + dys; paintPage(); return; }   // déplace la FEUILLE
    const L = pageLayout(page);
    page.offX -= dxs / L.ppm; page.offY += dys / L.ppm; paintPage();
  }
  function setActivePage(id) {
    activePage = id; selVp = -1; renderPageTabs();
    const pb = $('pagebar');
    if (id === 'model') { cv.style.cursor = 'none'; if (pb) pb.style.display = 'none'; paint(); }
    else { cv.style.cursor = 'grab'; if (pb) { pb.style.display = 'flex'; syncPageBar(); } paintPage(); }
  }
  function renderPageTabs() {
    const bar = $('pagetabs'); if (!bar) return; bar.innerHTML = '';
    const objetActive = activePage === 'model';
    // Menu déroulant : aller DIRECTEMENT à une page sans faire défiler les onglets.
    const sel = document.createElement('select'); sel.className = 'ptab-select'; sel.title = 'Aller à une page / présentation';
    const opt = (val, label, on) => { const o = document.createElement('option'); o.value = val; o.textContent = label; if (on) o.selected = true; return o; };
    sel.appendChild(opt('model', '📐 Objet', objetActive));
    pages.forEach(p => sel.appendChild(opt(p.id, '📄 ' + p.name, activePage === p.id)));
    sel.onchange = () => setActivePage(sel.value);
    bar.appendChild(sel);
    const mk = (label, on, fn) => { const b = document.createElement('button'); b.className = 'ptab' + (on ? ' active' : ''); b.textContent = label; b.onclick = fn; return b; };
    bar.appendChild(mk('📐 Objet', objetActive, () => setActivePage('model')));
    pages.forEach(p => {
      if (p.template === 'dp03' || p.template === 'dp04') bar.appendChild(mkFacadeTab(p));
      else bar.appendChild(mk(p.name, activePage === p.id, () => setActivePage(p.id)));
    });
    const add = document.createElement('button'); add.className = 'ptab add'; add.textContent = '＋'; add.title = 'Nouvelle mise en page (DP…) ou page vierge';
    add.onclick = (ev) => { ev.stopPropagation(); togglePageMenu(add); }; bar.appendChild(add);
  }
  // DP03 (plan de coupe) et DP04 (plan de façade) : plusieurs façades/pignons par échelle,
  // sélectionnées via un menu déroulant au survol de l'onglet (évite 1 onglet par façade).
  // Noms cohérents : DP02 = plan de masse · DP03 = plan de coupe · DP04 = plan de façade.
  const DIRS = ['avant', 'arriere', 'pignon-d', 'pignon-g'];
  const PLAN_NAME = { dp02: 'Plan de masse', dp03: 'Plan de coupe', dp04: 'Plan de façade' };
  // Libellé d'une vue : « Façade avant », « Coupe arrière », « Pignon droit »…
  function facadeLabel(template, k) {
    if (k === 'pignon-d') return 'Pignon droit';
    if (k === 'pignon-g') return 'Pignon gauche';
    const prefix = template === 'dp03' ? 'Coupe' : 'Façade';
    return prefix + ' ' + (k === 'arriere' ? 'arrière' : 'avant');
  }
  function facadeShort(p) { return facadeLabel(p.template, p.facade || 'avant'); }
  // Orientation de la vue, indépendante du type de plan : « Face avant / arrière »,
  // « Pignon gauche / droit » — pour le sous-titre du cartouche DP03/DP04.
  function dirLabel(k) {
    if (k === 'pignon-d') return 'Pignon droit';
    if (k === 'pignon-g') return 'Pignon gauche';
    return k === 'arriere' ? 'Façade arrière' : 'Façade avant';
  }
  // Libellé d'une « case » reliable : « DP04 · Façade avant · 1:100 · Zone 1 ».
  function slotLabel(template, scale, facade, win) {
    const dpN = { dp02: 'DP02', dp03: 'DP03', dp04: 'DP04' }[template] || template;
    return dpN + (facade ? ' · ' + dirLabel(facade) : '') + ' · 1:' + scale + ' · Zone ' + (win + 1);
  }
  // Toutes les cases reliables, à partir des pages DP existantes (× façades × 2 zones).
  function mepSlotOptions() {
    const scales = { dp02: new Set(), dp03: new Set(), dp04: new Set() };
    pages.forEach(p => { if (p.template && scales[p.template]) scales[p.template].add(p.scaleDenom); });
    const facFor = t => t === 'dp02' ? [''] : DIRS;
    const opts = [];
    ['dp02', 'dp03', 'dp04'].forEach(t => {
      [...scales[t]].sort((a, b) => b - a).forEach(sc => {
        facFor(t).forEach(fac => { [0, 1].forEach(win => { opts.push({ key: [t, sc, fac, win].join('|'), label: slotLabel(t, sc, fac, win) }); }); });
      });
    });
    return opts;
  }
  function mkFacadeTab(p) {
    if (!p.facade) p.facade = 'avant';
    const wrap = document.createElement('div'); wrap.className = 'ptab-wrap';
    const b = document.createElement('button'); b.className = 'ptab' + (activePage === p.id ? ' active' : '');
    b.innerHTML = escHtml(p.name) + ' · <b>' + escHtml(facadeShort(p)) + '</b> ▾';
    b.onclick = () => setActivePage(p.id);
    wrap.appendChild(b);
    const menu = document.createElement('div'); menu.className = 'ptab-fac';
    DIRS.forEach(k => {
      const lbl = facadeLabel(p.template, k);
      const it = document.createElement('div'); it.className = 'ptab-fac-it' + (p.facade === k ? ' on' : '');
      it.textContent = lbl;
      it.onclick = (e) => { e.stopPropagation(); p.facade = k; renderPageTabs(); setActivePage(p.id); echo('Vue « ' + p.name + ' · ' + lbl + ' ».'); };
      menu.appendChild(it);
    });
    wrap.appendChild(menu);
    // Position FIXE au survol : le menu s'affiche AU-DESSUS de l'onglet sans être coupé par la barre.
    let hideT = null;
    const show = () => { if (hideT) { clearTimeout(hideT); hideT = null; } menu.style.display = 'block'; const r = b.getBoundingClientRect(); const mh = menu.offsetHeight; menu.style.left = Math.max(6, r.left) + 'px'; menu.style.top = Math.max(6, r.top - mh - 4) + 'px'; };
    const hide = () => { hideT = setTimeout(() => { menu.style.display = 'none'; }, 120); };
    wrap.addEventListener('mouseenter', show); wrap.addEventListener('mouseleave', hide);
    menu.addEventListener('mouseenter', show); menu.addEventListener('mouseleave', hide);
    return wrap;
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
  // Pages standard DP02/DP03/DP04 aux échelles demandées (créées à l'ouverture du plan de base).
  const DP_PAGES = [
    ['dp02', [1000, 500, 250, 200]],
    ['dp03', [200, 150, 100]],
    ['dp04', [150, 100]],
  ];
  function ensureDpPages() {
    pages = [];
    for (const [key, scales] of DP_PAGES) {
      const tpl = QCAD.layouts && QCAD.layouts[key]; if (!tpl) continue;
      const baseN = (tpl.name.split(' ')[0] || 'DP');
      for (const sc of scales) {
        pages.push({ id: 'page-' + key + '-' + sc, name: baseN + ' 1-' + sc, paper: tpl.paper || 'A4', orientation: tpl.orientation || 'portrait', scaleDenom: sc, offX: 0, offY: 0, template: key, layoutData: Object.assign({}, tpl.defaults, { scaleDenom: sc }) });
      }
    }
  }
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
    // Le nom client est CENTRALISÉ (bouton « 👤 Client » en haut) et s'applique à
    // toutes les pages -> plus de champ par page ici.
    html += '<div class="fp-row" style="font-size:11px;color:var(--muted)">Client : « ' + escHtml(clientLabel() || '(vide)') + ' » — modifiable via le bouton 👤 Client (appliqué à toutes les pages).</div>';
    html += txt('Numéro DP', 'dpNum') + txt('Titre', 'dpTitle');
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
    drawTemplatePage(octx, page, 0, 0, K, ch, -1, true);   // printMode=true -> pas de cadre de case
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
    // Matérialise les valeurs par défaut (dont vpSync) avant d'afficher les boutons.
    if (page.template && QCAD.layouts[page.template]) ensureViewports(page, QCAD.layouts[page.template]);
    if ($('pgPaper')) $('pgPaper').value = page.paper;
    if ($('pgOrient')) $('pgOrient').value = page.orientation;
    if ($('pgScale')) $('pgScale').value = String(page.scaleDenom);
    if ($('pgName')) $('pgName').textContent = page.name;
    if ($('pgFields')) $('pgFields').style.display = page.template ? '' : 'none';
    if ($('pgVpLock')) { const b = $('pgVpLock'); b.style.display = page.template ? '' : 'none'; const lk = !!(page.layoutData && page.layoutData.vpLocked); b.textContent = lk ? '🔒 Cases verrouillées' : '🔓 Cases libres'; b.classList.toggle('pg-print', lk); }
    if ($('pgVpSync')) { const b = $('pgVpSync'); const lockedNow = !!(page.layoutData && page.layoutData.vpLocked); b.style.display = (page.template && !lockedNow) ? '' : 'none'; const sy = !!(page.layoutData && page.layoutData.vpSync); b.textContent = sy ? '🔗 Zones liées' : '✂️ Zones indépendantes'; b.classList.toggle('pg-print', sy); }
    if ($('pgVpRect')) { const b = $('pgVpRect'); const lockedNow = !!(page.layoutData && page.layoutData.vpLocked); b.style.display = (page.template && !lockedNow) ? '' : 'none'; }
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
  // ---- Couleurs RÉCENTES (mémorisées dans le navigateur, communes à tous les sélecteurs) ----
  let recentColors = [];
  try { recentColors = JSON.parse(localStorage.getItem('qlygocad.recentColors') || '[]') || []; } catch (e) { recentColors = []; }
  function pushRecentColor(c) {
    if (!c || !/^#[0-9a-fA-F]{6}$/.test(c)) return;
    c = c.toLowerCase();
    recentColors = recentColors.filter(x => x !== c); recentColors.unshift(c);
    if (recentColors.length > 16) recentColors.length = 16;
    try { localStorage.setItem('qlygocad.recentColors', JSON.stringify(recentColors)); } catch (e) { }
  }
  function renderCpopRecent() {
    const box = $('cpop-recent'), lbl = $('cpop-recent-lbl'); if (!box) return;
    box.innerHTML = '';
    const list = recentColors.slice(0, 8);
    if (lbl) lbl.style.display = list.length ? '' : 'none';
    list.forEach(c => { const b = document.createElement('button'); b.className = 'fav'; b.style.background = c; b.title = c + ' — clic : appliquer'; b.onclick = () => { if (cpTarget) applyColor(cpTarget, c); }; box.appendChild(b); });
  }
  function applyColor(id, c) { const input = $(id); input.value = c; updateSwatch(id); pushRecentColor(c); const p = $('cpop'); if (p && p.classList.contains('open')) { renderCpopRecent(); cpFill(c); } input.dispatchEvent(new Event('change')); }
  // --- Saisie couleur : HTML (hex) + RVB + pipette, tous synchronisés ---
  let cpopSync = false;
  function cpHexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function cpNorm(h) { h = (h || '').trim(); if (h && h[0] !== '#') h = '#' + h; if (/^#[0-9a-fA-F]{3}$/.test(h)) h = '#' + h.slice(1).split('').map(c => c + c).join(''); return /^#[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : null; }
  function cpRgbToHex(r, g, b) { const t = x => Math.max(0, Math.min(255, parseInt(x, 10) || 0)).toString(16).padStart(2, '0'); return '#' + t(r) + t(g) + t(b); }
  function cpFill(hex) {   // remplit native + hex + RVB SANS ré-appliquer (anti-boucle)
    const h = cpNorm(hex); if (!h) return; cpopSync = true;
    const [r, g, b] = cpHexToRgb(h);
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('cpop-native', h); set('cpop-hex', h); set('cpop-r', r); set('cpop-g', g); set('cpop-b', b);
    cpopSync = false;
  }
  function cpSet(hex) { const h = cpNorm(hex); if (!h) return; cpFill(h); if (cpTarget) applyColor(cpTarget, h); }
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
    cpTarget = id; const pop = $('cpop'), input = $(id);
    cpFill(input.value); renderCpopRecent(); renderCpopFavs();
    const r = btn.getBoundingClientRect(); pop.style.left = Math.min(r.left, window.innerWidth - 232) + 'px'; pop.style.top = (r.bottom + 4) + 'px';
    pop.classList.add('open');
  }
  function closeColorPopover() { const p = $('cpop'); if (p) p.classList.remove('open'); }
  function initColorUI() {
    document.querySelectorAll('[data-cp]').forEach(btn => {
      const id = btn.dataset.cp; updateSwatch(id);
      btn.addEventListener('click', ev => { ev.stopPropagation(); const pop = $('cpop'); if (pop.classList.contains('open') && cpTarget === id) closeColorPopover(); else openColorPopover(btn, id); });
    });
    const native = $('cpop-native'); if (native) { const h = () => { if (!cpopSync && cpTarget) cpSet(native.value); }; native.addEventListener('input', h); native.addEventListener('change', h); }
    // HTML (hex) : on applique à la validation (Entrée / perte de focus) si valide
    const hexIn = $('cpop-hex'); if (hexIn) {
      const apply = () => { if (cpopSync) return; const h = cpNorm(hexIn.value); if (h) cpSet(h); else if (cpTarget) hexIn.value = $(cpTarget).value; };
      hexIn.addEventListener('change', apply);
      hexIn.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); apply(); } });
    }
    // RVB : on applique en direct
    ['cpop-r', 'cpop-g', 'cpop-b'].forEach(id => { const el = $(id); if (el) { const h = () => { if (cpopSync) return; cpSet(cpRgbToHex($('cpop-r').value, $('cpop-g').value, $('cpop-b').value)); }; el.addEventListener('input', h); el.addEventListener('keydown', ev => ev.stopPropagation()); } });
    // Pipette ÉCRAN (EyeDropper) : récupère un pixel n'importe où sur l'écran
    const eye = $('cpop-eye');
    if (eye) {
      if (!('EyeDropper' in window)) { eye.style.display = 'none'; }
      else eye.onclick = () => { try { new window.EyeDropper().open().then(res => { if (res && res.sRGBHex) cpSet(res.sRGBHex); }).catch(() => { }); } catch (e) { } };
    }
    const add = $('cpop-add'); if (add) add.onclick = () => { if (!cpTarget) return; const a = loadFavs(cpTarget), input = $(cpTarget); if (a.indexOf(input.value) < 0) { a.push(input.value); saveFavs(cpTarget, a); renderCpopFavs(); echo('⭐ Couleur ' + input.value + ' ajoutée aux favoris.'); } };
    document.addEventListener('click', e => { const pop = $('cpop'); if (pop && pop.classList.contains('open') && !pop.contains(e.target) && !(e.target.closest && e.target.closest('[data-cp]'))) closeColorPopover(); });
  }

  // ---------- Bibliothèque d'OBJETS (pompe à chaleur, barrières, escaliers, volets solaires…) ----------
  function objCirc(cx, cy, r, n) { n = n || 40; const p = []; for (let i = 0; i <= n; i++) { const a = i / n * 2 * Math.PI; p.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return p; }
  const OBJ_LIB = [
    { key: 'pac', name: 'Pompe à chaleur', build: () => {
      const e = [];
      e.push({ pts: [{ x: -450, y: -175 }, { x: 450, y: -175 }, { x: 450, y: 175 }, { x: -450, y: 175 }], closed: true });   // caisson
      e.push({ pts: objCirc(-120, 0, 140), closed: true });                                                                   // ventilateur
      for (let i = 0; i < 3; i++) { const a = i / 3 * 2 * Math.PI; e.push({ pts: [{ x: -120, y: 0 }, { x: -120 + Math.cos(a) * 120, y: Math.sin(a) * 120 }] }); }  // pales
      for (let i = 0; i < 4; i++) { const x = 150 + i * 70; e.push({ pts: [{ x, y: -140 }, { x, y: 140 }] }); }                // ouïes
      return e;
    } },
    { key: 'barriere', name: 'Barrière', build: () => {
      const e = [], x0 = -1000, x1 = 1000, yt = 400, yb = -400;
      e.push({ pts: [{ x: x0, y: yt }, { x: x1, y: yt }] }); e.push({ pts: [{ x: x0, y: yb }, { x: x1, y: yb }] });
      for (let x = x0; x <= x1; x += 400) e.push({ pts: [{ x, y: yb - 100 }, { x, y: yt + 100 }] });
      return e;
    } },
    { key: 'escalier', name: 'Escalier', build: () => {
      const e = [], w = 500, L = 1000;
      e.push({ pts: [{ x: -w, y: -L }, { x: w, y: -L }, { x: w, y: L }, { x: -w, y: L }], closed: true });
      for (let y = -L + 200; y < L; y += 200) e.push({ pts: [{ x: -w, y }, { x: w, y }] });                   // marches
      e.push({ pts: [{ x: 0, y: -L + 100 }, { x: 0, y: L - 100 }] });                                          // flèche montée
      e.push({ pts: [{ x: -120, y: L - 300 }, { x: 0, y: L - 100 }, { x: 120, y: L - 300 }] });
      return e;
    } },
    { key: 'volet-solaire', name: 'Volet roulant solaire', build: () => {
      const e = [], w = 600, ht = 600;
      e.push({ pts: [{ x: -w, y: -ht }, { x: w, y: -ht }, { x: w, y: ht }, { x: -w, y: ht }], closed: true }); // tablier
      for (let y = -ht + 150; y < ht; y += 150) e.push({ pts: [{ x: -w, y }, { x: w, y }] });                  // lames
      e.push({ pts: [{ x: -450, y: ht + 40 }, { x: 450, y: ht + 40 }, { x: 450, y: ht + 280 }, { x: -450, y: ht + 280 }], closed: true }); // panneau solaire
      for (let x = -300; x < 450; x += 150) e.push({ pts: [{ x, y: ht + 40 }, { x, y: ht + 280 }] });
      e.push({ pts: [{ x: -450, y: ht + 160 }, { x: 450, y: ht + 160 }] });
      return e;
    } },
  ];
  function objBBox(ents) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; ents.forEach(e => (e.points || e.pts).forEach(p => { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; })); return { x0, y0, x1, y1 }; }
  // Objets PERSONNELS de l'utilisateur, enregistrés dans le navigateur (à partir d'une sélection).
  let customObjects = [];
  try { customObjects = JSON.parse(localStorage.getItem('qlygocad.customObjects') || '[]') || []; } catch (e) { customObjects = []; }
  function saveCustomObjects() { try { localStorage.setItem('qlygocad.customObjects', JSON.stringify(customObjects)); } catch (e) { echo('⚠ Stockage plein : objet non enregistré.'); } }
  // Segments dessinables (aperçu) d'un objet, qu'il soit intégré ou personnel.
  function objSegs(o) {
    if (o.custom) return (o.ents || []).filter(e => e.pts && e.pts.length).map(e => ({ points: e.pts, closed: e.closed }));
    return o.build().map(s => ({ points: s.pts, closed: s.closed }));
  }
  // Entités réelles à poser (sur le calque courant), en préservant les types pour les personnels.
  function objToEntities(o) {
    const layer = currentLayer;
    if (o.custom) return (o.ents || []).map(e => {
      const ent = { type: e.type || 'polyline', closed: !!e.closed, layer, color: null, penMm: null, points: (e.pts || []).map(p => ({ x: p.x, y: p.y })) };
      if (e.center) ent.center = { x: e.center.x, y: e.center.y }; if (e.r != null) ent.r = e.r;
      if (e.type === 'text') { ent.text = e.text; ent.hMm = e.hMm; ent.align = e.align; ent.valign = e.valign; ent.angleDeg = e.angleDeg; ent.font = e.font; if (e.zone) ent.zone = true; }
      return ent;
    });
    return o.build().map(s => ({ type: 'polyline', points: s.pts.map(p => ({ x: p.x, y: p.y })), closed: !!s.closed, layer, penMm: null, color: null }));
  }
  // Entités RÉELLES d'un objet, en coordonnées locales (pour l'aperçu) : on garde les
  // vrais TYPES (texte, cercle…) -> l'aperçu est fidèle (plus de « diagonale » parasite
  // issue d'un texte rendu comme une polyligne).
  function objEntitiesLocal(o) {
    if (o.custom) return (o.ents || []).map(e => {
      const ent = { type: e.type || 'polyline', closed: !!e.closed, color: '#1b2b4b', penMm: 0.25, points: (e.pts || []).map(p => ({ x: p.x, y: p.y })) };
      if (e.center) ent.center = { x: e.center.x, y: e.center.y }; if (e.r != null) ent.r = e.r;
      if (e.type === 'text') { ent.text = e.text; ent.hMm = e.hMm; ent.align = e.align; ent.valign = e.valign; ent.angleDeg = e.angleDeg; ent.font = e.font; if (e.zone) ent.zone = true; }
      return ent;
    });
    return o.build().map(s => ({ type: 'polyline', points: s.pts.map(p => ({ x: p.x, y: p.y })), closed: !!s.closed, color: '#1b2b4b', penMm: 0.25 }));
  }
  function drawObjPreview(cvEl, o) {
    const cssW = cvEl.clientWidth || 170, cssH = cvEl.clientHeight || 130, dpr = Math.min(2, window.devicePixelRatio || 1);
    cvEl.width = Math.round(cssW * dpr); cvEl.height = Math.round(cssH * dpr);
    const ctx = cvEl.getContext('2d'), W = cvEl.width, H = cvEl.height;
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const ents = objEntitiesLocal(o); if (!ents.length) return;
    // bbox FIDÈLE (R._bbox tient compte de l'étendue du texte, des cercles…)
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    ents.forEach(e => { const b = R._bbox(e); if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1]; if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3]; });
    const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0), pad = 0.14 * Math.max(W, H);
    const s = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const view = { pxPerMm: s, panXmm: cx - W / (2 * s), panYmm: cy - H / (2 * s), canvasW: W, canvasH: H };
    const prevAdapt = R._adapt, prevLwt = R.lwtScale; R._adapt = c => c; R.lwtScale = Math.max(2, 6 * dpr);
    ents.forEach(e => {
      if (e.type === 'text') R.drawText(ctx, view, e, '#1b2b4b');
      else if (e.type === 'hatch') R.drawHatch(ctx, view, e, '#8892b0');
      else R.drawEntity(ctx, view, e, '#1b2b4b', 0.25);
    });
    R._adapt = prevAdapt; R.lwtScale = prevLwt;
  }
  // --- Gestion (trier / supprimer) de la bibliothèque d'objets ---
  let objManage = false;
  const objSel = new Set();   // indices (ci) des objets PERSONNELS sélectionnés
  function updateObjManageBtn() { const b = $('obj-manage'); if (b) b.classList.toggle('on', objManage); }
  function renderObjBar() {
    const bar = $('obj-bar'); if (!bar) return;
    bar.classList.toggle('on', objManage);
    if (!objManage) { bar.innerHTML = ''; return; }
    const n = objSel.size;
    bar.innerHTML = '<span>Gestion — clique un objet perso pour le (dé)sélectionner · ↑ ↓ pour réordonner.</span><span style="flex:1"></span>' +
      '<button class="ob-del" id="ob-del"' + (n ? '' : ' disabled') + '>🗑 Supprimer' + (n ? ' (' + n + ')' : '') + '</button><button id="ob-done">✓ Terminer</button>';
    $('ob-del').onclick = () => { if (!objSel.size) return; const idxs = [...objSel].sort((a, b) => b - a); idxs.forEach(ci => customObjects.splice(ci, 1)); objSel.clear(); saveCustomObjects(); renderObjGrid(); echo('🗑 ' + idxs.length + ' objet(s) supprimé(s).'); };
    $('ob-done').onclick = () => { objManage = false; objSel.clear(); updateObjManageBtn(); renderObjGrid(); };
  }
  function moveCustom(ci, dir) { const j = ci + dir; if (j < 0 || j >= customObjects.length) return; const t = customObjects[ci]; customObjects[ci] = customObjects[j]; customObjects[j] = t; objSel.clear(); saveCustomObjects(); renderObjGrid(); }
  function renderObjGrid() {
    const grid = $('obj-grid'); if (!grid || !$('objPanel') || !$('objPanel').classList.contains('open')) return;
    renderObjBar();
    grid.innerHTML = '';
    if (!objManage) {   // Carte « + » (hors mode gestion) : enregistrer la sélection courante.
      const add = document.createElement('div'); add.className = 'lb-card obj-add'; add.title = 'Sélectionne les traits de ton objet sur le plan, puis clique ici pour l’ajouter';
      add.innerHTML = '<div class="obj-add-plus">+</div><div class="lb-dim">Nouvel objet</div>';
      add.onclick = saveSelectionAsObject; grid.appendChild(add);
    }
    const all = OBJ_LIB.concat(customObjects.map(c => Object.assign({ custom: true }, c)));
    all.forEach((o, i) => {
      const card = document.createElement('div'); card.className = 'lb-card';
      const cv2 = document.createElement('canvas'); const dim = document.createElement('div'); dim.className = 'lb-dim'; dim.textContent = o.name;
      card.appendChild(cv2); card.appendChild(dim);
      const ci = o.custom ? i - OBJ_LIB.length : -1;
      if (objManage) {
        if (!o.custom) { card.style.opacity = '.4'; card.title = 'Objet intégré (non modifiable)'; }
        else {
          if (objSel.has(ci)) card.classList.add('obj-sel');
          const chk = document.createElement('div'); chk.className = 'obj-chk'; chk.textContent = objSel.has(ci) ? '✓' : ''; card.appendChild(chk);
          const mv = document.createElement('div'); mv.className = 'obj-move';
          const up = document.createElement('button'); up.textContent = '↑'; up.title = 'Monter'; up.onclick = ev => { ev.stopPropagation(); moveCustom(ci, -1); };
          const dn = document.createElement('button'); dn.textContent = '↓'; dn.title = 'Descendre'; dn.onclick = ev => { ev.stopPropagation(); moveCustom(ci, 1); };
          mv.appendChild(up); mv.appendChild(dn); card.appendChild(mv);
          card.onclick = () => { if (objSel.has(ci)) objSel.delete(ci); else objSel.add(ci); renderObjGrid(); };
        }
      } else {
        if (o.custom) { const x = document.createElement('button'); x.className = 'lb-cbtn'; x.textContent = '🗑'; x.title = 'Supprimer cet objet'; x.onclick = ev => { ev.stopPropagation(); customObjects.splice(ci, 1); saveCustomObjects(); renderObjGrid(); echo('Objet supprimé.'); }; card.appendChild(x); }
        card.onclick = () => placeObject(o);
      }
      grid.appendChild(card);
      drawObjPreview(cv2, o);
    });
  }
  function placeObject(o) {
    const ents = objToEntities(o); if (!ents.length) { echo('Objet vide.'); return; }
    const bb = objBBox(ents);
    clipboard = { ents, base: { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 } };
    paste();
    const hint = $('obj-hint'); if (hint) hint.textContent = '« ' + o.name + ' » — clique sur le plan pour le poser';
    echo('🧰 « ' + o.name + ' » — clique sur le plan pour le poser (Échap = annuler).');
  }
  function saveSelectionAsObject() {
    const sel = selected.filter(e => e.points && e.points.length);
    if (!sel.length) { echo('🧰 Sélectionne d’abord les traits de ton objet sur le plan, puis clique « + Nouvel objet ».'); const hint = $('obj-hint'); if (hint) hint.textContent = 'Sélectionne les traits sur le plan, puis re-clique « + »'; return; }
    const name = (prompt('Nom du nouvel objet :', 'Mon objet ' + (customObjects.length + 1)) || '').trim(); if (!name) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; sel.forEach(e => e.points.forEach(p => { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const ents = sel.map(e => {
      const o = { type: e.type, closed: !!e.closed, pts: e.points.map(p => ({ x: p.x - cx, y: p.y - cy })) };
      if (e.center) o.center = { x: e.center.x - cx, y: e.center.y - cy }; if (e.r != null) o.r = e.r;
      if (e.type === 'text') { o.text = e.text; o.hMm = e.hMm; o.align = e.align; o.valign = e.valign; o.angleDeg = e.angleDeg; o.font = e.font; if (e.zone) o.zone = true; }
      return o;
    });
    customObjects.push({ name, ents }); saveCustomObjects(); renderObjGrid();
    echo('🧰 Objet « ' + name + ' » ajouté à ta bibliothèque d’objets (' + sel.length + ' trait(s)).');
  }
  // Replace une fenêtre flottante DANS l'écran (petits écrans : jamais hors-champ).
  function clampPanelToViewport(el) {
    if (!el) return;
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect(); if (!r.width) return;
      const maxL = Math.max(6, window.innerWidth - r.width - 6), maxT = Math.max(48, window.innerHeight - r.height - 6);
      let left = Math.min(Math.max(6, r.left), maxL), top = Math.min(Math.max(48, r.top), maxT);
      el.style.right = 'auto'; el.style.left = left + 'px'; el.style.top = top + 'px';
    });
  }
  function openObjPanel() { const p = $('objPanel'); if (!p) return; p.classList.add('open'); renderObjGrid(); requestAnimationFrame(renderObjGrid); clampPanelToViewport(p); }
  function closeObjPanel() { const p = $('objPanel'); if (p) p.classList.remove('open'); }
  { const b = $('objBtn'); if (b) b.addEventListener('click', () => { const p = $('objPanel'); if (p && p.classList.contains('open')) closeObjPanel(); else openObjPanel(); }); }
  { const b = $('obj-close'); if (b) b.addEventListener('click', closeObjPanel); }
  { const b = $('obj-manage'); if (b) b.addEventListener('click', () => { objManage = !objManage; objSel.clear(); updateObjManageBtn(); renderObjGrid(); if (objManage) echo('🗂 Gestion des objets — clique tes objets persos pour les sélectionner, puis Supprimer, ou ↑↓ pour réordonner.'); }); }
  { const head = $('obj-head'), panel = $('objPanel');
    if (head && panel) head.addEventListener('mousedown', e => { if (e.target.closest('button,input,select')) return; const sx = e.clientX, sy = e.clientY, ox = panel.offsetLeft, oy = panel.offsetTop; const mv = ev => { panel.style.left = Math.max(0, ox + ev.clientX - sx) + 'px'; panel.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; }; const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); e.preventDefault(); }); }

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
    return { v: 1, pts: pool, ents, layers: scene.layers.map(l => Object.assign({}, l)), pages: pages.map(p => Object.assign({}, p)), currentLayer, clientInfo: Object.assign({}, clientInfo) };
  }
  function applyDoc(d) {
    const pool = (d.pts || []).map(p => ({ x: p.x, y: p.y }));
    scene.layers = (d.layers && d.layers.length) ? d.layers.map(l => Object.assign({}, l)) : G.createScene().layers;
    scene.entities = (d.ents || []).map(o => { const e = {}; for (const k in o) { if (k === 'pts' || k === 'c') continue; e[k] = o[k]; } e.points = (o.pts || []).map(i => pool[i]).filter(Boolean); if (o.c != null) e.center = pool[o.c]; return e; });
    pages = (d.pages || []).map(p => Object.assign({}, p));
    currentLayer = (d.currentLayer && scene.layers.some(l => l.id === d.currentLayer)) ? d.currentLayer : scene.layers[0].id; baseLayer = currentLayer;
    if (d.clientInfo && typeof d.clientInfo === 'object') { clientInfo = { civ: d.clientInfo.civ || '', nom: d.clientInfo.nom || '', prenom: d.clientInfo.prenom || '' }; saveClientInfo(); }
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
    saveDocs(docs); setDocName(name);
    // Ta version enregistrée devient CELLE qui prime au prochain démarrage (priorité
    // sur le plan de base généré par le code).
    try { localStorage.setItem('qlygocad.lastDoc', currentDocId); } catch (e) { }
    echo('💾 « ' + name + ' » enregistré — c’est cette version qui s’ouvrira au prochain lancement.'); return true;
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
  // `tag` marque les entités (ex. _lib pour le catalogue de la bibliothèque, retirable).
  function appendCompact(doc, tag) {
    const byName = {}; scene.layers.forEach(l => { byName[l.name] = l.id; });
    const P = doc.pool || [], pool = new Array(P.length / 2);
    for (let i = 0; i < pool.length; i++) pool[i] = { x: P[i * 2], y: P[i * 2 + 1] };
    const pt = i => pool[i];
    for (const o of (doc.ents || [])) {
      const layer = byName[o.l] || scene.layers[0].id, color = o.c || null;
      let e;
      if (o.t === 'x') e = { type: 'text', points: [pt(o.i)], text: o.s, hMm: o.h, angleDeg: o.a || 0, layer, color };
      else if (o.t === 'o') { const c = pt(o.i); e = { type: 'circle', center: c, r: o.r, points: circleFrom(c, o.r), closed: true, layer, color, penMm: 0.25 }; }
      else if (o.t === 'h') e = { type: 'hatch', points: o.p.map(pt), pattern: 'solid', color, spacingMm: 300, angleDeg: 45, layer };
      else e = { type: 'polyline', points: o.p.map(pt), layer, color, penMm: 0.25, closed: !!o.k };
      if (tag) e._lib = true;
      scene.entities.push(e);
    }
    markSceneDirty();
  }
  // ---------- Bibliothèque de menuiseries = TABLEUR flottant (vignettes + dimensions) ----------
  // Catalogue PRÉ-DÉCOUPÉ (asset items) : chaque menuiserie = 1 vignette avec ses
  // dimensions (L×H) et un bouton « Copier ». Filtre par catégorie + recherche par
  // dimensions. Rien n'est posé sur l'Objet tant qu'on ne colle pas (Ctrl+V).
  let libLoaded = false, libLoading = false, libPanelOpen = false, libData = null;
  // 3 axes de filtre : TYPE de menuiserie × VOLET (overlay) × VANTAUX, + recherche L/H.
  let libType = 'all', libVolet = 'vierge', libVant = 'all', libW = '', libH = '';
  const TYPE_ORDER = ['all', 'fenetre', 'pf', 'porte', 'garage'];
  const TYPE_LABEL = { all: 'Tous types', fenetre: 'Fenêtre', pf: 'Porte-fenêtre', porte: 'Porte d\'entrée', garage: 'Porte de garage' };
  const TYPE_VANT = { fenetre: 1, pf: 1 };   // types où le nb de vantaux est pertinent à afficher
  const VOLET_LABEL = { vierge: 'Vierge', battant: 'Volet battant', roulant: 'Volet roulant' };
  function entInView(e) { return !e._lib; }   // (plus de catalogue brut dans la scène)
  // --- Géométrie RÉELLE issue de la bibliothèque (copie L = +volet battant, copie R = +volet roulant).
  //     On ne redessine rien : on utilise les traits exacts du fichier source. {p, k?closed} ---
  function libGeom(it) {   // traits à afficher/coller selon le volet choisi (repli sur vierge si absent)
    if (libVolet === 'battant') return it.battant || it.vierge;
    if (libVolet === 'roulant') return it.roulant || it.vierge;
    return it.vierge;
  }
  function libBase(it) {   // point d'accroche au curseur = centre-haut du cadre
    if (libVolet === 'roulant' && it.roulant && it.rbx != null) return { x: it.rbx, y: it.rby };
    return { x: it.bx, y: it.by };
  }
  // La vignette est IDENTIQUE à ce qui sera collé.
  function libCompose(it) { return libGeom(it); }
  function libMatch(it) {
    if (libType !== 'all' && it.type !== libType) return false;
    if (libVant !== 'all' && it.v !== +libVant) return false;
    const w = parseFloat(libW), h = parseFloat(libH);   // cm
    if (!isNaN(w) && Math.abs(it.w / 10 - w) > 2.5) return false;
    if (!isNaN(h) && Math.abs(it.h / 10 - h) > 2.5) return false;
    return true;
  }
  function libFiltered() { return libData ? libData.filter(libMatch) : []; }
  function libDrawThumb(cv, it) {
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, pad = 8;
    // Bibliothèque : fond BLANC + traits NOIRs (inverse de la scène) — demande utilisateur.
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    const ents = libCompose(it);
    let a = 1e18, b = 1e18, c = -1e18, d = -1e18;   // bbox de la géométrie composée
    for (const o of ents) for (let i = 0; i < o.p.length; i += 2) { const x = o.p[i], y = o.p[i + 1]; if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
    const gw = (c - a) || 1, gh = (d - b) || 1;
    const sc = Math.min((W - 2 * pad) / gw, (H - 2 * pad) / gh);
    const ox = (W - gw * sc) / 2, oy = (H - gh * sc) / 2;
    ctx.lineWidth = 1; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const o of ents) {
      const p = o.p; if (p.length < 4) continue; ctx.beginPath();
      ctx.moveTo(ox + (p[0] - a) * sc, H - (oy + (p[1] - b) * sc));
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(ox + (p[i] - a) * sc, H - (oy + (p[i + 1] - b) * sc));
      if (o.k) ctx.closePath();
      if (o.f) { ctx.fillStyle = o.f; ctx.fill(); }
      ctx.strokeStyle = o.c || '#111111'; ctx.stroke();
    }
  }
  function libCopyItem(it) {
    const layId = ensureLayer('MENUISERIE-BIB', '#cfd6e4');
    const ents = libCompose(it).map(o => { const pts = []; for (let i = 0; i < o.p.length; i += 2) pts.push({ x: o.p[i], y: o.p[i + 1] }); return { type: 'polyline', points: pts, layer: layId, color: o.c || null, penMm: 0.25, closed: !!o.k }; });
    clipboard = { ents, base: libBase(it) };   // accroche = centre-haut du cadre
    renderLayerSelect(); refreshLayers();
    const vl = libVolet === 'vierge' ? '' : ' + ' + VOLET_LABEL[libVolet].toLowerCase();
    echo('⧉ ' + (TYPE_LABEL[it.type] || 'Menuiserie') + ' ' + (it.w / 10) + '×' + (it.h / 10) + ' cm' + vl + ' copiée — Ctrl+V, place au curseur puis clique.');
  }
  function libRenderGrid() {
    const grid = $('lb-grid'); if (!grid) return; grid.innerHTML = '';
    if (!libData) { grid.innerHTML = '<div class="lb-empty">Chargement…</div>'; return; }
    const list = libFiltered(); const CAP = 300;
    const cnt = $('lb-count'); if (cnt) cnt.textContent = list.length + ' menuiserie' + (list.length > 1 ? 's' : '');
    if (!list.length) { grid.innerHTML = '<div class="lb-empty">Aucune menuiserie pour ce filtre. Change de type ou de dimensions.</div>'; return; }
    const frag = document.createDocumentFragment();
    list.slice(0, CAP).forEach(it => {
      const card = document.createElement('div'); card.className = 'lb-card'; card.title = 'Cliquer pour copier — puis Ctrl+V pour poser sur le plan';
      // Toute la case est cliquable : survol = orange, clic = copie directe (plus besoin de viser l'icône).
      card.onclick = () => libCopyItem(it);
      const cv = document.createElement('canvas'); cv.width = 264; cv.height = 220; card.appendChild(cv); libDrawThumb(cv, it);
      const dim = document.createElement('div'); dim.className = 'lb-dim'; dim.textContent = (it.w / 10) + ' × ' + (it.h / 10) + ' cm'; card.appendChild(dim);
      const sub = document.createElement('div'); sub.className = 'lb-sub';
      const vtxt = TYPE_VANT[it.type] ? ' · ' + it.v + (it.v > 1 ? ' vantaux' : ' vantail') : '';
      sub.textContent = (TYPE_LABEL[it.type] || it.type) + vtxt + (libVolet !== 'vierge' ? ' · ' + VOLET_LABEL[libVolet].toLowerCase() : ''); card.appendChild(sub);
      const btn = document.createElement('button'); btn.className = 'lb-cbtn'; btn.textContent = '⧉'; btn.title = 'Copier cette menuiserie'; btn.onclick = e => { e.stopPropagation(); libCopyItem(it); }; card.appendChild(btn);
      frag.appendChild(card);
    });
    grid.appendChild(frag);
    if (list.length > CAP) { const m = document.createElement('div'); m.className = 'lb-empty'; m.textContent = '… et ' + (list.length - CAP) + ' autres — affine avec la largeur / hauteur.'; grid.appendChild(m); }
  }
  function libSyncControls() { const c = $('lb-cat'); if (c) c.value = libType; const v = $('lb-volet'); if (v) v.value = libVolet; const n = $('lb-vant'); if (n) n.value = libVant; }
  function initLibPanel() {
    const cat = $('lb-cat'); if (cat) {
      cat.onchange = () => { libType = cat.value; libRenderGrid(); };
      // molette sur le sélecteur de type = changer de type sans ouvrir le menu
      cat.addEventListener('wheel', e => { e.preventDefault(); const i = TYPE_ORDER.indexOf(libType); const ni = Math.max(0, Math.min(TYPE_ORDER.length - 1, i + (e.deltaY > 0 ? 1 : -1))); libType = TYPE_ORDER[ni]; libSyncControls(); libRenderGrid(); }, { passive: false });
    }
    const vol = $('lb-volet'); if (vol) vol.onchange = () => { libVolet = vol.value; libRenderGrid(); };
    const vant = $('lb-vant'); if (vant) vant.onchange = () => { libVant = vant.value; libRenderGrid(); };
    const wIn = $('lb-w'); if (wIn) wIn.oninput = () => { libW = wIn.value; libRenderGrid(); };
    const hIn = $('lb-h'); if (hIn) hIn.oninput = () => { libH = hIn.value; libRenderGrid(); };
    const close = $('lb-close'); if (close) close.onclick = () => closeLibPanel();
    const head = $('lb-head'), panel = $('libPanel');
    if (head && panel) head.addEventListener('mousedown', e => {
      if (e.target.closest('select,button,input')) return;
      const sx = e.clientX, sy = e.clientY, ox = panel.offsetLeft, oy = panel.offsetTop;
      const mv = ev => { panel.style.left = Math.max(0, ox + ev.clientX - sx) + 'px'; panel.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); e.preventDefault();
    });
    const rz = $('lb-resize');
    if (rz && panel) rz.addEventListener('mousedown', e => {
      const sx = e.clientX, sy = e.clientY, ow = panel.offsetWidth, oh = panel.offsetHeight;
      // largeur mini = 4 colonnes toujours visibles (demande utilisateur)
      const mv = ev => { panel.style.width = Math.max(680, ow + ev.clientX - sx) + 'px'; panel.style.height = Math.max(300, oh + ev.clientY - sy) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); e.preventDefault(); e.stopPropagation();
    });
  }
  async function openLibPanel() {
    if (libLoading) return;
    if (!libData) {
      libLoading = true; updateMenuBtn();
      const panel0 = $('libPanel'); if (panel0) panel0.classList.add('open'); libPanelOpen = true;
      const g = $('lb-grid'); if (g) g.innerHTML = '<div class="lb-empty">⏳ Chargement de la bibliothèque…</div>';
      try { const doc = await fetchGzJson('assets/qlygo-menuiseries-items.json.gz?v=54'); libData = doc.items || []; libLoaded = true; }
      catch (e) { echo('⚠ Bibliothèque indisponible (' + (e && e.message || e) + ').'); libLoading = false; updateMenuBtn(); return; }
      libLoading = false;
    }
    const panel = $('libPanel'); if (panel) { panel.classList.add('open'); clampPanelToViewport(panel); }
    libPanelOpen = true; updateMenuBtn(); libSyncControls(); libRenderGrid();
    // Curseur directement dans « Largeur » : ouvrir → taper largeur → Tab → hauteur, sans viser à la souris.
    const wIn = $('lb-w'); if (wIn) { try { wIn.focus(); wIn.select(); } catch (e) { } }
    echo('📚 Bibliothèque : tape la Largeur (Tab → Hauteur) · Type (molette) · Volet · Vantaux, clique la case puis Ctrl+V pour poser.');
  }
  function closeLibPanel() { const panel = $('libPanel'); if (panel) panel.classList.remove('open'); libPanelOpen = false; updateMenuBtn(); }
  function toggleMenuiseries() { if (libPanelOpen) closeLibPanel(); else openLibPanel(); }
  function updateMenuBtn() {
    const b = $('menuBtn'); if (!b) return;
    b.textContent = libLoading ? '⏳ Bibliothèque…' : '📚 Bibliothèque';
    b.classList.toggle('active', libPanelOpen);
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
    for (const e of scene.entities) { if (!layVisible(e.layer) || !entInView(e)) continue; const b = R._bbox(e); if (b[0] < -1e16) continue; xs.push((b[0] + b[2]) / 2); ys.push((b[1] + b[3]) / 2); }
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
    return fetchGzJson('assets/qlygo-base.json.gz?v=40').then(doc => {
      applyCompact(doc); currentDocId = null; setDocName(doc.name || 'QLYGO_CAD (base)');
      ensureDpPages();   // DP02 (1:1000/500/250/200) · DP03 (1:200/150/100) · DP04 (1:150/100)
      libLoaded = false; libLoading = false; libPanelOpen = false; const lp = $('libPanel'); if (lp) lp.classList.remove('open');
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
      if (a === 'base') { try { localStorage.removeItem('qlygocad.lastDoc'); } catch (e) { } loadBasePlan().catch(err => echo('⚠ ' + (err && err.message || err))); }
      else if (a === 'new') { try { localStorage.removeItem('qlygocad.lastDoc'); } catch (e) { } newPlan(); } else if (a === 'home') showHome(); else if (a === 'save') saveCurrent(true);
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
  try { window.QCAD_DEBUG = { scene, view, get tool() { return tool; }, get selected() { return selected; }, get draft() { return draft; }, get op() { return op; }, get opGhost() { return opGhost; }, get snapInfo() { return snapInfo; }, get currentLayer() { return currentLayer; }, get baseLayer() { return baseLayer; }, get filletFirst() { return filletFirst; }, get matchSrc() { return matchSrc; }, get stretchOp() { return stretchOp; }, get viewStack() { return viewStack; }, nearScene, cullScene, queryIndex, markSceneDirty, tolMm, layVisible, layPickable, layMovable, toggleMenuiseries, openLibPanel, closeLibPanel, libCopyItem, get libPanelOpen() { return libPanelOpen; }, get libData() { return libData; }, get libItemsCount() { return libFiltered().length; }, get clipboard() { return clipboard; }, libCompose, hitGrip, pickTextAt, get gripDrag() { return gripDrag; }, layerById, extractPdfVectors, placePdfVectors, isBackgroundFill, explodeSel, joinSel, closeSel, applyFillet, applyMatch, pickAnyAt, arrayRect, createLayout, editLayoutFields, ensureLayer, get pages() { return pages; }, get activePage() { return activePage; }, get selVp() { return selVp; }, setActivePage, paintPage, pageLayout, ensureViewports, ensureMepLayer, mepRectFor, resolvedVp, MEP_LAYER_ID, openMepLinkDialog, pickLayer, toggleProps, openHatchPanel, closeHatchPanel, get hatchPattern() { return hatchPattern; }, openObjPanel, closeObjPanel, get pasteOp() { return pasteOp; }, saveCurrent, openDoc, setTool, runCommand, drawTemplatePage, clientLabel, get clientInfo() { return clientInfo; }, pickDimAt, editDimValue, hitGrip, get dimPts() { return dimPts; }, get dimSeg() { return dimSeg; }, mapColor }; } catch (e) { }

  // ---------- Démarrage ----------
  cv.tabIndex = 0;
  echo('Bienvenue dans QlygoCAD. Unités : <b>mètres</b>. Choisis un plan ou crée-en un nouveau.');
  R.onImageLoad = paint;   // repeindre quand une image de fond (PDF) a fini de charger
  // --- Sections du ruban déplaçables (poignée = le titre de la section) ---
  function panelOrderList() { return Array.from(document.querySelectorAll('#rpanels .panel')); }
  function savePanelOrder() { try { localStorage.setItem('qlygocad.panelOrder', JSON.stringify(panelOrderList().map(p => p.dataset.panel))); } catch (e) { } fitRibbon(); }
  function restorePanelOrder() {
    try { const ord = JSON.parse(localStorage.getItem('qlygocad.panelOrder') || 'null'); if (!Array.isArray(ord)) return;
      const bar = document.getElementById('rpanels'); const map = {}; bar.querySelectorAll('.panel').forEach(p => { map[p.dataset.panel] = p; });
      ord.forEach(k => { if (map[k]) bar.appendChild(map[k]); }); } catch (e) { }
  }
  function initPanelDrag() {
    const bar = document.getElementById('rpanels'); if (!bar) return;
    let dragEl = null;
    bar.querySelectorAll('.panel').forEach(p => {
      const title = p.querySelector('.panel-title');
      // le drag ne démarre QUE depuis le titre de la section
      p.addEventListener('mousedown', e => { p.draggable = (e.target === title); });
      p.addEventListener('dragstart', e => { if (!p.draggable) { e.preventDefault(); return; } dragEl = p; p.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p.dataset.panel || ''); } catch (_) { } });
      p.addEventListener('dragend', () => { p.classList.remove('dragging'); p.draggable = false; panelOrderList().forEach(x => x.classList.remove('drag-over')); dragEl = null; savePanelOrder(); });
      p.addEventListener('dragover', e => { if (!dragEl || dragEl === p) return; e.preventDefault(); p.classList.add('drag-over'); });
      p.addEventListener('dragleave', () => p.classList.remove('drag-over'));
      p.addEventListener('drop', e => { e.preventDefault(); p.classList.remove('drag-over'); if (!dragEl || dragEl === p) return; const ps = panelOrderList(), di = ps.indexOf(dragEl), ti = ps.indexOf(p); if (di < ti) p.after(dragEl); else p.before(dragEl); savePanelOrder(); });
    });
    restorePanelOrder();
  }
  initColorUI();
  initFiles();
  initPanelDrag();
  initLibPanel();
  renderLayerSelect();
  renderPageTabs();
  setTool('select'); fitRibbon();
  requestAnimationFrame(fitRibbon);   // re-mesure une fois les polices/icônes chargées
  // Démarrage : si l'utilisateur a DÉJÀ enregistré une version, c'est la SIENNE qui
  // prime (sa mise en page / son espace Objet) ; sinon on charge le plan de base.
  (function bootPlan() {
    let last = null; try { last = localStorage.getItem('qlygocad.lastDoc'); } catch (e) { }
    if (last && readDoc(last)) {
      try { openDoc(last); echo('📂 Ta dernière version enregistrée a été rouverte (elle prime sur le plan de base).'); return; }
      catch (e) { /* lecture impossible -> on retombe sur le plan de base */ }
    }
    loadBasePlan().catch(err => { echo('⚠ Plan de base indisponible (' + (err && err.message || err) + ').'); showHome(); });
  })();
})();
