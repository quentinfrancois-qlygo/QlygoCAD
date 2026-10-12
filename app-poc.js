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
  let currentLayer = 'calque-0';
  let offsetTarget = null;      // segment cible pour Décaler (si présélection)
  let gripDrag = null, hotGrip = null, hatchHover = null;
  let currentDimSize = 2.5;     // hauteur texte cote (mm papier)
  let op = null;                // opération en cours (move/copy/rotate/mirror)
  let circleCenter = null;      // centre en attente (outil Cercle)
  let opGhost = null, circlePreview = null;
  let shiftDown = false;        // Maj enfoncée (Ajuster <-> Prolonger)
  const SETTINGS_DEFAULTS = { bg: '#1b1f28', grid: '#3b4252', axisX: '#e06c75', axisY: '#98c379', crosshairColor: '#aeb6c6', crosshairSize: 'full', pickbox: true };
  let settings = loadSettings();
  let pages = [];               // présentations (DP02, DP04…) — affichent le dessin
  let activePage = 'model';     // 'model' = espace objet (dessin)
  let pageDrag = null;

  function $(id) { return document.getElementById(id); }
  const isOn = id => $(id).classList.contains('active');
  function opts() { return { color: $('color').value, penMm: parseFloat($('pen').value), layer: currentLayer }; }

  // ---------- Calques (visibilité / gel / verrou) ----------
  function layerById(id) { return scene.layers.find(l => l.id === id) || scene.layers[0]; }
  function layVisible(id) { const l = layerById(id); return l.visible && !l.frozen; }
  function layPickable(id) { const l = layerById(id); return l.visible && !l.frozen && !l.locked; }
  function visibleScene() { return { layers: scene.layers, entities: scene.entities.filter(e => layVisible(e.layer)) }; }
  function pickScene() { return { layers: scene.layers, entities: scene.entities.filter(e => layPickable(e.layer)) }; }
  function scaleDenom() { return parseInt($('scale').value, 10); }
  function tolMm() { return 12 / view.pxPerMm; }
  const M = v => v * 1000;        // mètres -> mm
  const fmtM = mm => (mm / 1000).toFixed(2).replace('.', ',');
  const fmtM3 = mm => (mm / 1000).toFixed(3).replace('.', ',');

  function activePoint() {
    if (tool === 'line' && draft.length) return draft[0];
    if (tool === 'polyline' && draft.length) return draft[draft.length - 1];
    if (tool === 'rect' && draft.length) return draft[0];
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
    return draft.concat([cursor]);
  }

  function paint() {
    if (activePage !== 'model') return paintPage();
    R.draw(ctx, visibleScene(), view, {
      dark: true, theme: theme(), ucs: true, grid: isOn('grid'), gridStepMm: 1000, axes: true,
      preview: previewPts(), snap: snapInfo, guide, dimHover, dimPreview, selected, selRect, hatchHover, hotGrip, opGhost, circlePreview,
      crosshair: overCanvas && !panning ? { x: lastScreen.x, y: lastScreen.y, color: settings.crosshairColor, size: settings.crosshairSize, pickbox: settings.pickbox } : null
    });
  }

  // Priorité façon AutoCAD : accrochage OBJET > Ortho/Polaire STRICT > aimant grille.
  // (Seul l'accrochage objet peut "sortir" de l'Ortho ; la grille, jamais.)
  function snapPoint(raw, from) {
    snapInfo = null; guide = null;
    if (isOn('osnap')) {
      const hit = SN.query(pickScene(), raw, tolMm(), { from, grid: false, types: { end: true, mid: true, inter: true, perp: true, grid: false } });
      if (hit) { snapInfo = hit; return { x: hit.x, y: hit.y }; }
    }
    if (from && (isOn('ortho') || isOn('polar'))) { const c = SN.constrain(from, raw, isOn('ortho') ? 90 : 45); guide = { from, to: c }; return c; }
    if (isOn('snap')) { snapInfo = { x: Math.round(raw.x / 100) * 100, y: Math.round(raw.y / 100) * 100, type: 'grid' }; return { x: snapInfo.x, y: snapInfo.y }; }
    return raw;
  }
  function compute(sx, sy) { const raw = R.screenToWorld(view, sx, sy); rawCursor = raw; return snapPoint(raw, activePoint()); }

  // ---------- Souris ----------
  cv.addEventListener('mouseenter', () => { overCanvas = true; });
  cv.addEventListener('mouseleave', () => { overCanvas = false; hideDyn(); paint(); });

  cv.addEventListener('mousemove', e => {
    const r = cv.getBoundingClientRect();
    lastScreen = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (activePage !== 'model') return pageMouseMove(e);
    if (panning && panStart) {
      view.panXmm = panStart.px - (e.clientX - panStart.sx) / view.pxPerMm;
      view.panYmm = panStart.py + (e.clientY - panStart.sy) / view.pxPerMm; paint(); return;
    }
    if (tool === 'select') return handleSelectMove();
    if (op) return opMove();
    if (tool === 'circle') return circleMove();
    if (tool === 'trim') return hoverTrim(e);
    if (tool === 'dim') return hoverDim();
    if (tool === 'offset') return hoverOffset();
    if (tool === 'hatch') return hoverHatch();
    cursor = compute(lastScreen.x, lastScreen.y);
    $('coords').textContent = fmtM3(cursor.x) + ' , ' + fmtM3(cursor.y) + ' m' + (snapInfo ? '  [' + frType(snapInfo.type) + ']' : '');
    if (activePoint() && !editing) showPassive(); else if (!activePoint() && !editing) hideDyn(); else if (editing) placeDyn();
    paint();
  });

  function hoverDim() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    const seg = SN.pickSegment(pickScene(), raw, 10 / view.pxPerMm);
    if (seg) {
      const side = sideOf(raw, seg);
      dimHover = { a: seg.a, b: seg.b };
      dimPreview = { type: 'dim', points: [seg.a, seg.b], offMm: side * 800, color: '#b9375e', textMm: 2.5 };
      dynread.innerHTML = '📏 <b>' + fmtM(dist(seg.a, seg.b)) + ' m</b>'; editMode(false); dyn.style.display = 'block'; placeDyn();
    } else { dimHover = dimPreview = null; hideDyn(); }
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m'; paint();
  }

  function hoverOffset() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    const seg = offsetTarget || SN.pickSegment(pickScene(), raw, 10 / view.pxPerMm);
    if (seg) {
      const side = sideOf(raw, seg);
      const off = SN.offset(seg.a, seg.b, side * offsetDist);
      dimHover = { a: seg.a, b: seg.b }; ghost = [off.a, off.b]; pendingOffset = off;
      if (!editing) { dynread.innerHTML = '⇥ Décaler : <b>' + fmtM(offsetDist) + ' m</b> — cliquez le côté'; editMode(false); dyn.style.display = 'block'; placeDyn(); }
    } else { dimHover = null; ghost = null; pendingOffset = null; if (!editing) hideDyn(); }
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m'; paint();
  }

  function hoverHatch() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    hatchHover = SN.pickClosedRegion(pickScene(), raw);
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m';
    dynread.innerHTML = hatchHover ? '▦ <b>cliquez pour hachurer</b>' : '▦ survolez une zone fermée';
    editMode(false); dyn.style.display = 'block'; placeDyn(); paint();
  }

  function handleSelectMove() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m';
    if (gripDrag) { dragGrip(raw); paint(); return; }
    if (selecting && selStart) selRect = { a: selStart.w, b: raw, crossing: lastScreen.x < selStart.sx };
    paint();
  }

  function hitGrip(sx, sy) {
    const near = (wx, wy) => { const s = R.worldToScreen(view, wx, wy); return Math.hypot(s.x - sx, s.y - sy) <= 8; };
    for (const e of selected) {
      for (let i = 0; i < e.points.length; i++) if (near(e.points[i].x, e.points[i].y)) return { ent: e, kind: 'vertex', index: i };
      if (e.type === 'dim') { const g = G.dimGeometry(e); if (near(g.mid.x, g.mid.y)) return { ent: e, kind: 'dimoff' }; }
      else if (e.type !== 'hatch' && e.points.length === 2) { const m = { x: (e.points[0].x + e.points[1].x) / 2, y: (e.points[0].y + e.points[1].y) / 2 }; if (near(m.x, m.y)) return { ent: e, kind: 'mid' }; }
    }
    return null;
  }
  function dragGrip(raw) {
    const e = gripDrag.ent;
    if (gripDrag.kind === 'vertex') {
      const from = e.points.length === 2 ? e.points[1 - gripDrag.index] : null;
      const p = snapPoint(raw, from);
      e.points[gripDrag.index].x = p.x; e.points[gripDrag.index].y = p.y; hotGrip = { x: p.x, y: p.y };
    } else if (gripDrag.kind === 'mid') {
      const p = snapPoint(raw, null);
      const dx = p.x - gripDrag.start.x, dy = p.y - gripDrag.start.y;
      e.points[0].x = gripDrag.orig[0].x + dx; e.points[0].y = gripDrag.orig[0].y + dy;
      e.points[1].x = gripDrag.orig[1].x + dx; e.points[1].y = gripDrag.orig[1].y + dy;
      hotGrip = { x: (e.points[0].x + e.points[1].x) / 2, y: (e.points[0].y + e.points[1].y) / 2 };
    } else if (gripDrag.kind === 'dimoff') {
      const a = e.points[0], b = e.points[1], dxu = b.x - a.x, dyu = b.y - a.y, L = Math.hypot(dxu, dyu) || 1;
      const nx = -dyu / L, ny = dxu / L;
      e.offMm = (raw.x - a.x) * nx + (raw.y - a.y) * ny; hotGrip = null;
    }
  }

  function finalizeSelection(add) {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    const moved = Math.hypot(lastScreen.x - selStart.sx, lastScreen.y - selStart.sy);
    let hits;
    if (moved < 4) {                       // clic simple = sélection d'un objet
      const ent = SN.pickEntity(pickScene(), selStart.w, 12 / view.pxPerMm);
      hits = ent ? [ent] : [];
      if (!add) selected = hits;
      else if (ent) { const i = selected.indexOf(ent); i >= 0 ? selected.splice(i, 1) : selected.push(ent); }
      else if (!add) selected = [];
    } else {                               // fenêtre (bleu) ou capture (vert)
      hits = SN.boxSelect(pickScene(), selStart.w, raw, lastScreen.x < selStart.sx);
      selected = add ? selected.concat(hits.filter(h => selected.indexOf(h) < 0)) : hits;
    }
    echo(selected.length + ' objet(s) sélectionné(s).');
  }

  // ---------- Transformations : Déplacer / Copier / Pivoter / Miroir ----------
  function cloneEntity(e) { const c = Object.assign({}, e); c.points = e.points.map(p => ({ x: p.x, y: p.y })); if (e.center) c.center = { x: e.center.x, y: e.center.y }; return c; }
  function eachUniquePoint(ents, fn) { const seen = new Set(); ents.forEach(e => { e.points.forEach(p => { if (!seen.has(p)) { seen.add(p); fn(p); } }); if (e.center && !seen.has(e.center)) { seen.add(e.center); fn(e.center); } }); }
  function translateEnts(ents, dx, dy) { eachUniquePoint(ents, p => { p.x += dx; p.y += dy; }); }
  function rotateEnts(ents, cx, cy, ang) { eachUniquePoint(ents, p => { const q = G.rotatePoint(p, cx, cy, ang); p.x = q.x; p.y = q.y; }); }
  function mirrorEnts(ents, ax, ay, bx, by) { eachUniquePoint(ents, p => { const q = G.mirrorPoint(p, ax, ay, bx, by); p.x = q.x; p.y = q.y; }); }
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
      }
    }
    paint();
  }
  function opClick(p) {
    if (op.step === 0) {
      if (op.cmd === 'mirror') op.p1 = { x: p.x, y: p.y }; else op.base = { x: p.x, y: p.y };
      op.step = 1; echo(OPPROMPT[op.cmd][1]); paint(); return;
    }
    commitOp(p);
  }
  function commitOp(p) {
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
    else { G.addCircle(scene, circleCenter.x, circleCenter.y, dist(circleCenter, p), opts()); echo('Cercle créé (Échap pour finir).'); circleCenter = null; circlePreview = null; }
    paint();
  }

  // ---------- Ajuster / Prolonger (Maj = Prolonger) ----------
  function pickLineEnt(raw) {
    const seg = SN.pickSegment(pickScene(), raw, 10 / view.pxPerMm);
    if (!seg) return null;
    for (const e of scene.entities) {
      if (e.type === 'dim' || e.type === 'hatch' || e.type === 'circle') continue;
      if (e.points.length === 2 && ((e.points[0] === seg.a && e.points[1] === seg.b) || (e.points[0] === seg.b && e.points[1] === seg.a))) return e;
    }
    return null;
  }
  function hoverTrim(e) {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    const ent = pickLineEnt(raw);
    dimHover = ent ? { a: ent.points[0], b: ent.points[1] } : null;
    const ext = e ? e.shiftKey : shiftDown;
    dynread.innerHTML = ext
      ? (ent ? '⤢ <b>Prolonger</b> ce trait (relâche Maj = Ajuster)' : '⤢ Prolonger — cliquez un trait')
      : (ent ? '✂️ <b>Ajuster</b> ce trait (Maj = Prolonger)' : '✂️ Ajuster — cliquez un trait (Maj = Prolonger)');
    editMode(false); dyn.style.display = 'block'; placeDyn();
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m'; paint();
  }
  function trimLine(ent, clickPt) {
    const ax = ent.points[0].x, ay = ent.points[0].y, bx = ent.points[1].x, by = ent.points[1].y;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const tP = ((clickPt.x - ax) * dx + (clickPt.y - ay) * dy) / len2;
    const ts = [];
    for (const o of pickScene().entities) {
      if (o === ent || o.type === 'dim' || o.type === 'hatch') continue;
      for (const [c, d] of SN.entitySegments(o)) { const t = SN.segParam({ x: ax, y: ay }, { x: bx, y: by }, c, d); if (t != null && t > 1e-4 && t < 1 - 1e-4) ts.push(t); }
    }
    if (!ts.length) { echo('Ajuster : aucune intersection sur ce trait.'); return; }
    ts.sort((a, b) => a - b);
    const bounds = [0, ...ts, 1];
    let i = 0; while (i < bounds.length - 1 && tP > bounds[i + 1]) i++;
    const t0 = bounds[i], t1 = bounds[i + 1];
    const P = t => ({ x: ax + dx * t, y: ay + dy * t });
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
    for (const o of pickScene().entities) {
      if (o === ent || o.type === 'dim' || o.type === 'hatch') continue;
      for (const [c, d] of SN.entitySegments(o)) { const t = SN.rayParam({ x: ax, y: ay }, { x: bx, y: by }, c, d); if (t != null) cands.push(t); }
    }
    if (tP < 0.5) { const neg = cands.filter(t => t < -1e-4); if (!neg.length) { echo('Prolonger : rien à atteindre de ce côté.'); return; } const t = Math.max.apply(null, neg); ent.points[0].x = ax + dx * t; ent.points[0].y = ay + dy * t; }
    else { const pos = cands.filter(t => t > 1 + 1e-4); if (!pos.length) { echo('Prolonger : rien à atteindre de ce côté.'); return; } const t = Math.min.apply(null, pos); ent.points[1].x = ax + dx * t; ent.points[1].y = ay + dy * t; }
    echo('Trait prolongé.');
  }

  cv.addEventListener('mousedown', e => {
    cv.focus();
    if (activePage !== 'model') { pageMouseDown(e); return; }
    if (e.button === 1 || e.button === 2 || tool === 'pan') {
      panning = true; panStart = { sx: e.clientX, sy: e.clientY, px: view.panXmm, py: view.panYmm }; e.preventDefault(); return;
    }
    stopEdit();
    if (tool === 'select') {
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      lastScreen = { x: sx, y: sy };
      if (selected.length) {
        const g = hitGrip(sx, sy);
        if (g) { gripDrag = g; if (g.kind === 'mid') { gripDrag.start = R.screenToWorld(view, sx, sy); gripDrag.orig = g.ent.points.map(p => ({ x: p.x, y: p.y })); } return; }
      }
      selecting = true; selStart = { sx, sy, w: R.screenToWorld(view, sx, sy) }; selRect = null; return;
    }
    if (tool === 'dim') { if (dimPreview) { G.addDim(scene, dimPreview.points[0], dimPreview.points[1], dimPreview.offMm, { textMm: currentDimSize, layer: 'cotation' }); echo('Cote posée : ' + fmtM(dist(dimPreview.points[0], dimPreview.points[1])) + ' m'); paint(); } return; }
    if (tool === 'offset') { if (pendingOffset) { G.addLine(scene, pendingOffset.a.x, pendingOffset.a.y, pendingOffset.b.x, pendingOffset.b.y, opts()); echo('Décalage de ' + fmtM(offsetDist) + ' m'); paint(); } return; }
    if (tool === 'hatch') { if (hatchHover) { G.addHatch(scene, hatchHover, { pattern: $('hpattern').value, spacingMm: parseFloat($('hspace').value), angleDeg: 45, layer: currentLayer, color: $('color').value }); echo('Hachure « ' + $('hpattern').value + ' » ajoutée.'); paint(); } return; }
    if (op) { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); const from = op.step >= 1 ? (op.cmd === 'mirror' ? op.p1 : op.base) : null; opClick(snapPoint(raw, from)); return; }
    if (tool === 'circle') { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); circleClick(snapPoint(raw, circleCenter)); return; }
    if (tool === 'trim') { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); const ent = pickLineEnt(raw); if (ent) { if (e.shiftKey) extendLine(ent, raw); else trimLine(ent, raw); } paint(); return; }
    const r = cv.getBoundingClientRect();
    place(compute(e.clientX - r.left, e.clientY - r.top));
  });

  function place(p) {
    if (tool === 'line') {
      // Commande LIGNE facon AutoCAD : chaque segment est cree, puis on ENCHAINE
      // depuis le dernier point jusqu'a Echap (ou Entree).
      if (!draft.length) { draft.push({ x: p.x, y: p.y }); echo('Point suivant (ou longueur en m) :'); }
      else { G.addLine(scene, draft[0].x, draft[0].y, p.x, p.y, opts()); draft = [{ x: p.x, y: p.y }]; echo('Point suivant (Échap pour terminer) :'); }
    } else if (tool === 'polyline') { draft.push({ x: p.x, y: p.y }); echo('Point suivant (Entrée pour finir) :'); }
    else if (tool === 'rect') {
      if (!draft.length) { draft.push({ x: p.x, y: p.y }); echo('Coin opposé :'); }
      else { const a = draft[0]; G.addRect(scene, Math.min(a.x, p.x), Math.min(a.y, p.y), Math.abs(p.x - a.x), Math.abs(p.y - a.y), Object.assign({ closed: true }, opts())); draft = []; hideDyn(); echo('Premier coin :'); }
    }
    paint();
  }

  cv.addEventListener('dblclick', finishPoly);
  cv.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('mouseup', e => {
    panning = false;
    if (pageDrag) { pageDrag = null; return; }
    if (gripDrag) { gripDrag = null; hotGrip = null; echo('Objet modifié.'); paint(); return; }
    if (selecting) { finalizeSelection(e.shiftKey); selecting = false; selRect = null; paint(); }
  });
  function finishPoly() { if (tool === 'polyline' && draft.length >= 2) G.addPolyline(scene, draft, opts()); draft = []; hideDyn(); paint(); }

  // ---------- Saisie dynamique (en mètres) ----------
  function editMode(on) { dynedit.style.display = on ? '' : 'none'; dynread.style.display = on ? 'none' : ''; }
  function showPassive() {
    const a = activePoint(); if (!a) return;
    dynread.innerHTML = '⟷ <b>' + fmtM(dist(a, cursor)) + ' m</b> &nbsp; ∠ ' + Math.round(angleDeg(a, cursor)) + '°';
    editMode(false); dyn.style.display = 'block'; placeDyn();
  }
  function startEdit(initial) {
    if (!activePoint() && tool !== 'offset' && !(op && op.step === 1) && !(tool === 'circle' && circleCenter)) return;
    editing = true; editMode(true); dyn.style.display = 'block'; placeDyn();
    dyninput.value = initial || ''; dyninput.focus();
    const v = dyninput.value; dyninput.value = ''; dyninput.value = v;
  }
  function stopEdit() { editing = false; editMode(false); }
  function hideDyn() { dyn.style.display = 'none'; editing = false; }
  function placeDyn() { dyn.style.left = (lastScreen.x + 16) + 'px'; dyn.style.top = (lastScreen.y + 18 + cv.offsetTop) + 'px'; }

  function commitDyn() {
    const raw = (dyninput.value || '').replace(',', '.').trim();
    if (op && op.step === 1) {
      if (op.cmd === 'rotate') { const deg = parseFloat(raw); if (isFinite(deg)) { rotateEnts(selected, op.base.x, op.base.y, deg * Math.PI / 180); echo('Pivoté de ' + deg + '°.'); endOp(); } stopEdit(); paint(); return; }
      const v = parseFloat(raw);
      if (isFinite(v) && v > 0) { const q = SN.alongDir(op.base, cursor, M(v)); if (op.cmd === 'copy') { const c = selected.map(cloneEntity); c.forEach(e => scene.entities.push(e)); translateEnts(c, q.x - op.base.x, q.y - op.base.y); echo('Copié.'); } else { translateEnts(selected, q.x - op.base.x, q.y - op.base.y); echo('Déplacé.'); endOp(); } }
      stopEdit(); paint(); return;
    }
    if (tool === 'circle' && circleCenter) { const v = parseFloat(raw); if (isFinite(v) && v > 0) { G.addCircle(scene, circleCenter.x, circleCenter.y, M(v), opts()); echo('Cercle créé.'); circleCenter = null; circlePreview = null; } stopEdit(); paint(); return; }
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
    AJUSTER: 'trim', AJ: 'trim', TR: 'trim', PROLONGER: 'trim', EX: 'trim',
    PAN: 'pan', PANO: 'pan', P: 'pan',
    SELECTION: 'select', SEL: 'select', S: 'select',
    ANNULER: undoLast, U: undoLast, H: undoLast, EFFACER: eraseSel, EF: eraseSel, SUPPR: eraseSel, EFFACERTOUT: clearAll,
    ZE: fit, ZOOM: fit, Z: fit, ETENDU: fit,
    GRILLE: () => toggle('grid'), ORTHO: () => toggle('ortho', true),
    POLAIRE: () => toggle('polar', true), ACCROBJ: () => toggle('osnap'), RESOL: () => toggle('snap'),
    CALQUES: toggleLayersPanel, CALQUE: toggleLayersPanel, CA: toggleLayersPanel, LA: toggleLayersPanel,
    OPTIONS: toggleOptions, PARAMETRES: toggleOptions, CONFIG: toggleOptions, OP: toggleOptions,
    PAGE: createPage, PRESENTATION: createPage, OBJET: () => setActivePage('model'),
    IMPRIMER: plot, PDF: plot, TRACER: plot
  };
  // Commandes AutoCAD connues, pas encore implémentées (réponse honnête "à venir")
  const SOON = ['ARC', 'A', 'ECHELLE', 'SC', 'TEXTE', 'T', 'DT'];
  const OPPROMPT = {
    move: ['DÉPLACER — cliquez le point de base :', 'Destination : clic, ou tapez la distance en m :'],
    copy: ['COPIER — cliquez le point de base :', 'Destination : clic (répété), ou distance en m · Échap pour finir :'],
    rotate: ['PIVOTER — cliquez le centre de rotation :', 'Angle : bougez + clic, ou tapez les degrés :'],
    mirror: ['MIROIR — 1er point de l’axe :', '2e point de l’axe (clic) → crée la copie miroir :']
  };
  const PROMPT = {
    select: 'SÉLECTION — cliquez un objet, ou tracez un cadre (→ bleu : englobe · ← vert : capture). Suppr pour effacer.',
    line: 'LIGNE — premier point (ou longueur en m) :', polyline: 'POLYLIGNE — premier point :',
    rect: 'RECTANGLE — premier coin :', dim: 'COTE — survolez un trait à coter :',
    offset: 'DÉCALER — tapez la distance en m, puis survolez un trait :', pan: 'PANORAMIQUE — glissez pour déplacer la vue.',
    hatch: 'HACHURES — survolez une zone fermée et cliquez pour la remplir (motif + couleur dans le ruban).',
    circle: 'CERCLE — cliquez le centre, puis le rayon (ou tapez le rayon en m).',
    trim: 'AJUSTER — cliquez la partie du trait à couper. Maintenez Maj = PROLONGER jusqu’au trait voisin.'
  };
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
    // Noun-verb (réflexe AutoCAD) : DÉCALER avec un seul trait présélectionné le cible directement.
    if (t === 'offset' && selected.length === 1 && selected[0].type !== 'dim' && selected[0].points.length === 2) {
      const p = selected[0].points; offsetTarget = { a: p[0], b: p[1] };
    }
    // Transformations : exigent une présélection (sélectionne D'ABORD, puis la commande).
    if (['move', 'copy', 'rotate', 'mirror'].indexOf(t) >= 0) {
      if (!selected.length) { echo('⚠ Sélectionnez d’abord un ou plusieurs objets, puis relancez ' + t.toUpperCase() + '.'); t = 'select'; }
      else op = { cmd: t, step: 0 };
    }
    tool = t; draft = []; dimHover = dimPreview = ghost = pendingOffset = gripDrag = hotGrip = hatchHover = null; hideDyn();
    // On vide la sélection seulement pour les outils de dessin (pas sélection/transfo/décaler).
    if (['line', 'polyline', 'rect', 'dim', 'hatch', 'pan', 'circle', 'trim'].indexOf(t) >= 0) selected = [];
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
    if (k === 'Delete') {
      if (selected.length) { selected.forEach(en => { const i = scene.entities.indexOf(en); if (i >= 0) scene.entities.splice(i, 1); }); echo(selected.length + ' objet(s) supprimé(s).'); selected = []; paint(); }
      e.preventDefault(); return;
    }
    if (k === 'Escape') { draft = []; ghost = null; selected = []; hideDyn(); echo('*Annulé*'); if (tool !== 'select') setTool('select'); else paint(); return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); if (tool === 'polyline' && draft.length >= 2) finishPoly(); else runCommand(''); return; }
    if ((/^[0-9]$/.test(k) || k === '.' || k === ',') && (activePoint() || tool === 'offset' || (op && op.step === 1) || (tool === 'circle' && circleCenter))) { startEdit(k); e.preventDefault(); return; }
    if (/^[a-zA-Z]$/.test(k)) { cmd.focus(); cmd.value += k.toUpperCase(); e.preventDefault(); } // taper = ligne de commande
  });

  // ---------- Zoom ----------
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    if (activePage !== 'model') return;
    const r = cv.getBoundingClientRect();
    const b = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
    view.pxPerMm = Math.max(0.003, Math.min(5, view.pxPerMm * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const a = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
    view.panXmm += b.x - a.x; view.panYmm += b.y - a.y; paint();
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
  ['osnap', 'grid', 'snap', 'ortho', 'polar'].forEach(id => $(id).addEventListener('click', () => toggle(id, id === 'ortho' || id === 'polar')));
  $('scale').addEventListener('change', () => { $('scaleLbl').textContent = '1:' + scaleDenom(); });
  $('layer').addEventListener('change', () => { currentLayer = $('layer').value; $('color').value = layerById(currentLayer).color; paint(); });
  { const ds = $('dimsize'); if (ds) ds.addEventListener('change', () => { currentDimSize = parseFloat(ds.value); }); }
  { const ob = $('optionsBtn'); if (ob) ob.addEventListener('click', toggleOptions); }
  $('exportBtn').addEventListener('click', () => { if (activePage !== 'model') printPage(); else plot(); });
  // Barre d'outils de page (présentations)
  { const el = $('pgScale'); if (el) el.addEventListener('change', () => { const p = pages.find(x => x.id === activePage); if (p) { p.scaleDenom = parseInt(el.value, 10); centerPage(); } }); }
  { const el = $('pgPaper'); if (el) el.addEventListener('change', () => { const p = pages.find(x => x.id === activePage); if (p) { p.paper = el.value; centerPage(); } }); }
  { const el = $('pgOrient'); if (el) el.addEventListener('change', () => { const p = pages.find(x => x.id === activePage); if (p) { p.orientation = el.value; centerPage(); } }); }
  { const el = $('pgFit'); if (el) el.addEventListener('click', fitPageScale); }
  { const el = $('pgCenter'); if (el) el.addEventListener('click', centerPage); }
  { const el = $('pgPrint'); if (el) el.addEventListener('click', printPage); }
  { const el = $('pgRename'); if (el) el.addEventListener('click', renamePage); }
  { const el = $('pgDelete'); if (el) el.addEventListener('click', deletePage); }

  function undoLast() { scene.entities.pop(); draft = []; echo('Dernier objet supprimé.'); paint(); }
  function clearAll() { scene.entities.length = 0; selected = []; draft = []; echo('Dessin effacé.'); paint(); }
  function eraseSel() {
    if (!selected.length) { echo('Rien de sélectionné — sélectionnez d’abord des objets.'); return; }
    selected.forEach(en => { const i = scene.entities.indexOf(en); if (i >= 0) scene.entities.splice(i, 1); });
    echo(selected.length + ' objet(s) supprimé(s).'); selected = []; paint();
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
  function renderLayerSelect() {
    const sel = $('layer'); if (!sel) return; sel.innerHTML = '';
    scene.layers.forEach(l => { const o = document.createElement('option'); o.value = l.id; o.textContent = l.name; if (l.id === currentLayer) o.selected = true; sel.appendChild(o); });
  }
  function renderLayersPanel() {
    const box = $('layers'); if (!box || box.style.display !== 'block') return;
    box.innerHTML = '<div class="lp-head"><b>Calques</b><span style="flex:1"></span>' +
      '<button id="lp-add" title="Nouveau calque">＋</button><button id="lp-close" title="Fermer">✕</button></div>';
    scene.layers.forEach(l => {
      const row = document.createElement('div'); row.className = 'lp-row' + (l.id === currentLayer ? ' cur' : '');
      row.innerHTML =
        '<button class="lp-cur" title="Définir courant">' + (l.id === currentLayer ? '●' : '○') + '</button>' +
        '<input type="color" class="lp-sw" value="' + l.color + '" title="Couleur du calque">' +
        '<span class="lp-name">' + l.name + '</span>' +
        '<button class="lp-t" data-k="visible" title="Afficher / Masquer">' + (l.visible ? '👁️' : '🙈') + '</button>' +
        '<button class="lp-t" data-k="frozen" title="Geler / Dégeler">' + (l.frozen ? '❄️' : '·') + '</button>' +
        '<button class="lp-t" data-k="locked" title="Verrouiller / Déverrouiller">' + (l.locked ? '🔒' : '🔓') + '</button>';
      row.querySelector('.lp-cur').onclick = () => { currentLayer = l.id; refreshLayers(); paint(); };
      row.querySelectorAll('.lp-t').forEach(btn => btn.onclick = () => {
        l[btn.dataset.k] = !l[btn.dataset.k];
        selected = selected.filter(e => layPickable(e.layer));   // désélectionne ce qui devient non modifiable
        echo('Calque « ' + l.name + ' » : ' + (l.visible ? '' : 'masqué ') + (l.frozen ? 'gelé ' : '') + (l.locked ? 'verrouillé' : '') || 'mis à jour');
        refreshLayers(); paint();
      });
      const sw = row.querySelector('.lp-sw'); if (sw) sw.onchange = ev => { l.color = ev.target.value; refreshLayers(); paint(); };
      box.appendChild(row);
    });
    $('lp-add').onclick = addLayer; $('lp-close').onclick = toggleLayersPanel;
  }
  function refreshLayers() { renderLayerSelect(); renderLayersPanel(); }
  function toggleLayersPanel() { const box = $('layers'); if (!box) return; box.style.display = box.style.display === 'block' ? 'none' : 'block'; refreshLayers(); }
  function addLayer() {
    const id = 'calque-' + Date.now();
    scene.layers.push({ id, name: 'Calque ' + scene.layers.length, color: '#9fb0d0', visible: true, locked: false, frozen: false });
    currentLayer = id; refreshLayers(); paint();
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

  // ---------- utilitaires ----------
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function angleDeg(a, b) { return (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 360) % 360; }
  function sideOf(pt, seg) { const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y; return ((pt.x - seg.a.x) * -dy + (pt.y - seg.a.y) * dx) >= 0 ? 1 : -1; }
  function frType(t) { return { end: 'extrémité', mid: 'milieu', inter: 'intersection', perp: 'perpendic.', grid: 'grille' }[t] || t; }

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
  function paintPage() {
    const page = pages.find(p => p.id === activePage); if (!page) { activePage = 'model'; return paint(); }
    const L = pageLayout(page), W = view.canvasW, H = view.canvasH;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);                         // bureau
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(L.Sx0 + 7, L.Sy0 + 7, L.sheetW, L.sheetH); // ombre
    ctx.fillStyle = '#ffffff'; ctx.fillRect(L.Sx0, L.Sy0, L.sheetW, L.sheetH);   // feuille
    const dx0 = L.Sx0 + L.margin * L.ppmPaper, dy0 = L.Sy0 + L.margin * L.ppmPaper;
    const dw = L.sheetW - 2 * L.margin * L.ppmPaper, dh = L.sheetH - 2 * L.margin * L.ppmPaper;
    ctx.save(); ctx.beginPath(); ctx.rect(dx0, dy0, dw, dh); ctx.clip();        // découpe à la zone utile
    const vs = visibleScene();
    for (const e of vs.entities) if (e.type === 'hatch') R.drawHatch(ctx, L.pageView, e, e.color || layerById(e.layer).color);
    for (const e of vs.entities) {
      if (e.type === 'hatch') continue;
      if (e.type === 'dim') R.drawDim(ctx, L.pageView, e, false, mapColor(e.color || layerById(e.layer).color));
      else R.drawEntity(ctx, L.pageView, e, mapColor(e.color));
    }
    ctx.restore();
    ctx.strokeStyle = '#9aa6bf'; ctx.lineWidth = 1; ctx.strokeRect(dx0, dy0, dw, dh); // cadre
    ctx.fillStyle = '#44506b'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(page.name + '   ·   1:' + page.scaleDenom + '   ·   ' + page.paper + ' ' + (page.orientation === 'landscape' ? 'paysage' : 'portrait'), dx0 + 6, dy0 + dh - 6);
    ctx.textAlign = 'start';
    $('coords').textContent = 'Page : ' + page.name;
  }
  function pageMouseDown(e) { pageDrag = { sx: e.clientX, sy: e.clientY }; cv.style.cursor = 'grabbing'; }
  function pageMouseMove(e) {
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
    const mk = (id, label) => { const b = document.createElement('button'); b.className = 'ptab' + (activePage === id ? ' active' : ''); b.textContent = label; b.onclick = () => setActivePage(id); return b; };
    bar.appendChild(mk('model', '📐 Objet'));
    pages.forEach(p => bar.appendChild(mk(p.id, p.name)));
    const add = document.createElement('button'); add.className = 'ptab add'; add.textContent = '＋'; add.title = 'Nouvelle page (DP…)'; add.onclick = createPage; bar.appendChild(add);
  }
  function createPage() {
    const name = (prompt('Nom de la page (ex. DP02, DP04) :', 'DP0' + (pages.length + 2)) || '').trim(); if (!name) return;
    const page = { id: 'page-' + Date.now(), name, paper: $('paper').value || 'A4', orientation: $('orient').value || 'landscape', scaleDenom: scaleDenom() || 100, offX: 0, offY: 0 };
    pages.push(page); activePage = page.id; fitPageScale(); setActivePage(page.id); echo('Page « ' + name + ' » créée — elle affiche ton dessin.');
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
    const vs = visibleScene(); if (!vs.entities.length) { echo('Page vide.'); return; }
    const doc = QCAD.exportPdf(vs, { scaleDenom: page.scaleDenom, paper: page.paper, orientation: page.orientation, title: page.name, frameX: page.offX, frameY: page.offY });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([doc.toBytes()], { type: 'application/pdf' })); a.download = 'qlygocad_' + page.name + '.pdf'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    echo('Page « ' + page.name + ' » imprimée (PDF).');
  }
  function renamePage() { const page = pages.find(p => p.id === activePage); if (!page) return; const n = (prompt('Nouveau nom de la page :', page.name) || '').trim(); if (n) { page.name = n; renderPageTabs(); syncPageBar(); } }
  function deletePage() { const page = pages.find(p => p.id === activePage); if (!page) return; if (!confirm('Supprimer la page « ' + page.name + ' » ? (le dessin n’est pas touché)')) return; pages = pages.filter(p => p !== page); setActivePage('model'); echo('Page supprimée.'); }
  function syncPageBar() {
    const page = pages.find(p => p.id === activePage); if (!page) return;
    if ($('pgPaper')) $('pgPaper').value = page.paper;
    if ($('pgOrient')) $('pgOrient').value = page.orientation;
    if ($('pgScale')) $('pgScale').value = String(page.scaleDenom);
    if ($('pgName')) $('pgName').textContent = page.name;
  }

  // ---------- Démarrage ----------
  cv.tabIndex = 0;
  echo('Bienvenue dans QlygoCAD. Unités : <b>mètres</b>. Tapez une commande (ex. <b>L</b> pour Ligne) ou utilisez le ruban.');
  G.addRect(scene, 0, 0, 10000, 8000, { color: '#e8ebf2', penMm: 0.5, layer: 'murs' });
  G.addLine(scene, 4000, 0, 4000, 8000, { color: '#e8ebf2', penMm: 0.35, layer: 'murs' });
  renderLayerSelect();
  renderPageTabs();
  setTool('select'); resize(); fit();
})();
