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
  let hatchPattern = 'lines', hatchSpacing = 300; // motif + échelle (mm) des hachures
  let trimPreview = null;       // aperçu Ajuster/Prolonger (projection colorée)
  let history = [], redoStack = []; // pile d'annulation (Ctrl+Z / Ctrl+Y)
  let textPt = null, currentTextH = 800, txtEl = null; // outil Texte : point d'insertion + hauteur + champ de saisie
  let dimSeg = null;            // outil Cote : segment verrouillé (clic 1) dont on règle l'écartement

  function $(id) { return document.getElementById(id); }
  const isOn = id => $(id).classList.contains('active');
  function opts() { return { color: $('color').value, penMm: parseFloat($('pen').value), layer: currentLayer, dash: $('linetype') ? $('linetype').value : 'solid' }; }

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
    drawTrimOverlay();
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
      const seg = SN.pickSegment(pickScene(), raw, 10 / view.pxPerMm);
      if (seg) {
        const side = sideOf(raw, seg);
        dimHover = { a: seg.a, b: seg.b };
        dimPreview = { type: 'dim', points: [seg.a, seg.b], offMm: side * 800, color: '#b9375e', textMm: currentDimSize };
        dynread.innerHTML = '📏 <b>' + fmtM(dist(seg.a, seg.b)) + ' m</b> — cliquez le trait à coter';
        editMode(false); dyn.style.display = 'block'; placeDyn();
      } else { dimHover = dimPreview = null; hideDyn(); }
    }
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
    const poly = SN.findRegion(pickScene(), raw, 2);
    hatchHover = poly ? { points: poly } : null;
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m';
    dynread.innerHTML = hatchHover ? '▦ <b>cliquez pour hachurer</b> (' + hatchPatternName() + ')' : '▦ survolez une zone fermée (délimitée par des traits)';
    editMode(false); dyn.style.display = 'block'; placeDyn(); paint();
  }
  function hatchPatternName() { return { solid: 'pleine', lines: 'lignes', cross: 'croisées', tiles: 'tuiles' }[hatchPattern] || hatchPattern; }
  function hatchColor() { const el = $('hcolor'); return el ? el.value : $('color').value; }

  function handleSelectMove() {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m';
    if (gripDrag) { dragGrip(raw); paint(); return; }
    if (selecting && selStart) selRect = { a: selStart.w, b: raw, crossing: lastScreen.x < selStart.sx };
    else if (selected.length) { const g = hitGrip(lastScreen.x, lastScreen.y); hotGrip = g ? gripPoint(g) : null; }
    paint();
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
    gripDrag.ent._bb = null;
  }

  function finalizeSelection(add) {
    const raw = R.screenToWorld(view, lastScreen.x, lastScreen.y);
    const moved = Math.hypot(lastScreen.x - selStart.sx, lastScreen.y - selStart.sy);
    let hits;
    if (moved < 4) {                       // clic simple = sélection d'un objet
      const ent = SN.pickEntity(pickScene(), selStart.w, 12 / view.pxPerMm) || pickTextAt(selStart.w) || pickHatchAt(selStart.w) || pickImageAt(selStart.w);
      hits = ent ? [ent] : [];
      if (!add) selected = hits;
      else if (ent) { const i = selected.indexOf(ent); i >= 0 ? selected.splice(i, 1) : selected.push(ent); }
      else if (!add) selected = [];
    } else {                               // fenêtre (bleu) ou capture (vert)
      hits = SN.boxSelect(pickScene(), selStart.w, raw, lastScreen.x < selStart.sx);
      selected = add ? selected.concat(hits.filter(h => selected.indexOf(h) < 0)) : hits;
    }
    echo(selected.length + ' objet(s) sélectionné(s).'); refreshProps();
  }
  // Sélection d'un texte en cliquant sur sa boîte (sans rotation : boîte simple).
  function pickTextAt(pt) {
    for (let i = scene.entities.length - 1; i >= 0; i--) {
      const e = scene.entities[i];
      if (e.type !== 'text' || !layPickable(e.layer)) continue;
      const a = e.points[0], h = e.hMm || 800, w = Math.max(1, String(e.text).length) * h * 0.6;
      if (pt.x >= a.x - h * 0.2 && pt.x <= a.x + w && pt.y >= a.y - h * 0.3 && pt.y <= a.y + h * 1.15) return e;
    }
    return null;
  }
  // Sélection d'une image (fond PDF) en cliquant dans son rectangle.
  function pickImageAt(pt) {
    for (let i = scene.entities.length - 1; i >= 0; i--) {
      const e = scene.entities[i]; if (e.type !== 'image' || !layPickable(e.layer)) continue;
      const a = e.points[0], b = e.points[1], x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      if (pt.x >= x0 && pt.x <= x1 && pt.y >= y0 && pt.y <= y1) return e;
    }
    return null;
  }
  // Sélection d'une hachure en cliquant DANS son aire remplie (plus petite d'abord).
  function pickHatchAt(pt) {
    let best = null, bestArea = Infinity;
    for (const e of pickScene().entities) {
      if (e.type !== 'hatch' || !e.points || e.points.length < 3) continue;
      if (!SN.pointInPolygon(pt, e.points)) continue;
      let A = 0; for (let i = 0, j = e.points.length - 1; i < e.points.length; j = i++) A += (e.points[j].x + e.points[i].x) * (e.points[j].y - e.points[i].y);
      A = Math.abs(A / 2); if (A < bestArea) { bestArea = A; best = e; }
    }
    return best;
  }

  // ---------- Transformations : Déplacer / Copier / Pivoter / Miroir ----------
  function cloneEntity(e) { const c = Object.assign({}, e); c.points = e.points.map(p => ({ x: p.x, y: p.y })); if (e.center) c.center = { x: e.center.x, y: e.center.y }; return c; }
  function eachUniquePoint(ents, fn) { const seen = new Set(); ents.forEach(e => { e.points.forEach(p => { if (!seen.has(p)) { seen.add(p); fn(p); } }); if (e.center && !seen.has(e.center)) { seen.add(e.center); fn(e.center); } }); }
  function invalBB(ents) { ents.forEach(e => { e._bb = null; }); }
  function translateEnts(ents, dx, dy) { eachUniquePoint(ents, p => { p.x += dx; p.y += dy; }); invalBB(ents); }
  function rotateEnts(ents, cx, cy, ang) { eachUniquePoint(ents, p => { const q = G.rotatePoint(p, cx, cy, ang); p.x = q.x; p.y = q.y; }); invalBB(ents); }
  function mirrorEnts(ents, ax, ay, bx, by) { eachUniquePoint(ents, p => { const q = G.mirrorPoint(p, ax, ay, bx, by); p.x = q.x; p.y = q.y; }); invalBB(ents); }
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
    pushHistory();
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
    const seg = SN.pickSegment(pickScene(), raw, 10 / view.pxPerMm);
    if (!seg) return null;
    for (const e of scene.entities) {
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
    $('coords').textContent = fmtM3(raw.x) + ' , ' + fmtM3(raw.y) + ' m'; paint();
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
      for (const o of pickScene().entities) {
        if (o === ent || o.type === 'dim' || o.type === 'hatch' || o.type === 'image' || o.type === 'text') continue;
        for (const [c, d] of SN.entitySegments(o)) { const t = SN.rayParam({ x: ax, y: ay }, { x: bx, y: by }, c, d); if (t != null) cands.push(t); }
      }
      if (tP < 0.5) { const neg = cands.filter(t => t < -1e-4); if (!neg.length) return null; return { kind: 'ext', seg: [P(0), P(Math.max.apply(null, neg))] }; }
      const pos = cands.filter(t => t > 1 + 1e-4); if (!pos.length) return null; return { kind: 'ext', seg: [P(1), P(Math.min.apply(null, pos))] };
    }
    const ts = [];
    for (const o of pickScene().entities) {
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
    for (const o of pickScene().entities) {
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
    for (const o of pickScene().entities) {
      if (o === ent || o.type === 'dim' || o.type === 'hatch' || o.type === 'image' || o.type === 'text') continue;
      for (const [c, d] of SN.entitySegments(o)) { const t = SN.rayParam({ x: ax, y: ay }, { x: bx, y: by }, c, d); if (t != null) cands.push(t); }
    }
    if (tP < 0.5) { const neg = cands.filter(t => t < -1e-4); if (!neg.length) { echo('Prolonger : rien à atteindre de ce côté.'); return; } const t = Math.max.apply(null, neg); pushHistory(); ent.points[0].x = ax + dx * t; ent.points[0].y = ay + dy * t; }
    else { const pos = cands.filter(t => t > 1 + 1e-4); if (!pos.length) { echo('Prolonger : rien à atteindre de ce côté.'); return; } const t = Math.min.apply(null, pos); pushHistory(); ent.points[1].x = ax + dx * t; ent.points[1].y = ay + dy * t; }
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
      // Édition par poignée façon AutoCAD : 1er clic = attrape le point (il suit le
      // curseur SANS maintenir le bouton), 2e clic = le dépose. Échap = annule.
      if (gripDrag) { gripDrag = null; hotGrip = null; echo('Objet modifié.'); paint(); return; }
      if (selected.length) {
        const g = hitGrip(sx, sy);
        if (g) {
          pushHistory();
          gripDrag = g;
          gripDrag.origAll = g.ent.points.map(p => ({ x: p.x, y: p.y }));
          if (g.ent.offMm != null) gripDrag.origOff = g.ent.offMm;
          if (g.kind === 'mid') { gripDrag.start = R.screenToWorld(view, sx, sy); gripDrag.orig = g.ent.points.map(p => ({ x: p.x, y: p.y })); }
          dragGrip(R.screenToWorld(view, sx, sy)); echo('Point attrapé — déplacez puis cliquez pour déposer (Échap = annuler).'); paint(); return;
        }
      }
      selecting = true; selStart = { sx, sy, w: R.screenToWorld(view, sx, sy) }; selRect = null; return;
    }
    if (tool === 'dim') {
      const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top);
      if (!dimSeg) { const seg = SN.pickSegment(pickScene(), raw, 10 / view.pxPerMm); if (seg) { dimSeg = { a: seg.a, b: seg.b }; echo('Cote : éloignez le curseur pour régler l’écartement, puis cliquez pour poser.'); hoverDim(); } else echo('Survolez un trait à coter, puis cliquez-le.'); }
      else if (dimPreview) { pushHistory(); G.addDim(scene, dimPreview.points[0], dimPreview.points[1], dimPreview.offMm, { textMm: currentDimSize, layer: 'cotation' }); echo('Cote posée : ' + fmtM(dist(dimPreview.points[0], dimPreview.points[1])) + ' m'); dimSeg = null; paint(); }
      return;
    }
    if (tool === 'offset') { if (pendingOffset) { pushHistory(); G.addLine(scene, pendingOffset.a.x, pendingOffset.a.y, pendingOffset.b.x, pendingOffset.b.y, opts()); echo('Décalage de ' + fmtM(offsetDist) + ' m'); paint(); } return; }
    if (tool === 'hatch') { if (hatchHover) { pushHistory(); G.addHatch(scene, hatchHover, { pattern: hatchPattern, spacingMm: hatchSpacing, angleDeg: 45, layer: currentLayer, color: hatchColor() }); echo('Hachure « ' + hatchPatternName() + ' » ajoutée.'); paint(); } else echo('Survolez une zone fermée (délimitée par des traits) avant de cliquer.'); return; }
    if (op) { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); const from = op.step >= 1 ? (op.cmd === 'mirror' ? op.p1 : op.base) : null; opClick(snapPoint(raw, from)); return; }
    if (tool === 'circle') { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); circleClick(snapPoint(raw, circleCenter)); return; }
    if (tool === 'trim') { const r = cv.getBoundingClientRect(); const raw = R.screenToWorld(view, e.clientX - r.left, e.clientY - r.top); const ent = pickLineEnt(raw); if (ent) { if (e.shiftKey) extendLine(ent, raw); else trimLine(ent, raw); } paint(); return; }
    if (tool === 'text') { const r = cv.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top; textPt = snapPoint(R.screenToWorld(view, sx, sy), null); showTextInput(sx, sy); return; }
    const r = cv.getBoundingClientRect();
    place(compute(e.clientX - r.left, e.clientY - r.top));
  });

  function place(p) {
    if (tool === 'line') {
      // Outil LIGNE : un segment droit par deux clics (1er point -> 2e point), puis
      // l'outil reste prêt pour une NOUVELLE ligne indépendante (= une ligne, pas un
      // crayon qui enchaîne). Pour un tracé continu relié, utiliser POLYLIGNE.
      if (!draft.length) { draft.push({ x: p.x, y: p.y }); echo('Deuxième point (ou longueur en m) :'); }
      else { pushHistory(); G.addLine(scene, draft[0].x, draft[0].y, p.x, p.y, opts()); draft = []; hideDyn(); echo('LIGNE — premier point :'); }
    } else if (tool === 'polyline') { draft.push({ x: p.x, y: p.y }); echo('Point suivant (Entrée pour finir) :'); }
    else if (tool === 'rect') {
      if (!draft.length) { draft.push({ x: p.x, y: p.y }); echo('Coin opposé :'); }
      else { const a = draft[0]; pushHistory(); G.addRect(scene, Math.min(a.x, p.x), Math.min(a.y, p.y), Math.abs(p.x - a.x), Math.abs(p.y - a.y), Object.assign({ closed: true }, opts())); draft = []; hideDyn(); echo('Premier coin :'); }
    }
    paint();
  }

  cv.addEventListener('dblclick', finishPoly);
  cv.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('mouseup', e => {
    panning = false;
    if (pageDrag) { pageDrag = null; return; }
    // NB : on NE dépose PAS la poignée au relâchement (mode clic→déplace→clic).
    if (selecting) { finalizeSelection(e.shiftKey); selecting = false; selRect = null; paint(); }
  });
  function finishPoly() { if (tool === 'polyline' && draft.length >= 2) { pushHistory(); G.addPolyline(scene, draft, opts()); } draft = []; hideDyn(); paint(); }

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
  function hideTextInput() { if (txtEl) txtEl.style.display = 'none'; }
  function commitText() { const v = (txtEl.value || '').trim(); if (v && textPt) { pushHistory(); G.addText(scene, textPt.x, textPt.y, v, { hMm: currentTextH, color: $('color').value, layer: currentLayer, angleDeg: 0, font: textFont() }); echo('Texte « ' + v + ' » posé (clique ailleurs pour un autre, Échap pour finir).'); } hideTextInput(); cv.focus(); paint(); }

  function commitDyn() {
    const raw = (dyninput.value || '').replace(',', '.').trim();
    if (op && op.step === 1) {
      if (op.cmd === 'rotate') { const deg = parseFloat(raw); if (isFinite(deg)) { pushHistory(); rotateEnts(selected, op.base.x, op.base.y, deg * Math.PI / 180); echo('Pivoté de ' + deg + '°.'); endOp(); } stopEdit(); paint(); return; }
      const v = parseFloat(raw);
      if (isFinite(v) && v > 0) { pushHistory(); const q = SN.alongDir(op.base, cursor, M(v)); if (op.cmd === 'copy') { const c = selected.map(cloneEntity); c.forEach(e => scene.entities.push(e)); translateEnts(c, q.x - op.base.x, q.y - op.base.y); echo('Copié.'); } else { translateEnts(selected, q.x - op.base.x, q.y - op.base.y); echo('Déplacé.'); endOp(); } }
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
    TEXTE: 'text', TXT: 'text', T: 'text', DT: 'text', MTEXT: 'text', TEXT: 'text',
    AJUSTER: 'trim', AJ: 'trim', TR: 'trim', PROLONGER: 'trim', EX: 'trim',
    PAN: 'pan', PANO: 'pan', P: 'pan',
    SELECTION: 'select', SEL: 'select', S: 'select',
    ANNULER: undo, U: undo, H: undo, REFAIRE: redo, RETABLIR: redo, Y: redo,
    EFFACER: eraseSel, EF: eraseSel, SUPPR: eraseSel, EFFACERTOUT: clearAll,
    ZE: fit, ZOOM: fit, Z: fit, ETENDU: fit,
    GRILLE: () => toggle('grid'), ORTHO: () => toggle('ortho', true),
    POLAIRE: () => toggle('polar', true), ACCROBJ: () => toggle('osnap'), RESOL: () => toggle('snap'),
    CALQUES: toggleLayersPanel, CALQUE: toggleLayersPanel, CA: toggleLayersPanel, LA: toggleLayersPanel,
    OPTIONS: toggleOptions, PARAMETRES: toggleOptions, CONFIG: toggleOptions, OP: toggleOptions,
    PROPRIETES: toggleProps, PROP: toggleProps, PR: toggleProps,
    PAGE: createPage, PRESENTATION: createPage, OBJET: () => setActivePage('model'),
    IMPRIMER: plot, PDF: plot, TRACER: plot
  };
  // Commandes AutoCAD connues, pas encore implémentées (réponse honnête "à venir")
  const SOON = ['ARC', 'A', 'ECHELLE', 'SC'];
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
    trim: 'AJUSTER — cliquez la partie du trait à couper. Maintenez Maj = PROLONGER jusqu’au trait voisin.',
    text: 'TEXTE — cliquez où écrire, tapez le texte, Entrée pour valider (hauteur réglable dans le ruban).'
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
    tool = t; draft = []; dimHover = dimPreview = ghost = pendingOffset = gripDrag = hotGrip = hatchHover = trimPreview = snapInfo = guide = dimSeg = null; hideDyn();
    // On vide la sélection seulement pour les outils de dessin (pas sélection/transfo/décaler).
    if (['line', 'polyline', 'rect', 'dim', 'hatch', 'pan', 'circle', 'trim', 'text'].indexOf(t) >= 0) selected = [];
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
      if (kl === 'a') { e.preventDefault(); selected = scene.entities.filter(x => layPickable(x.layer)); if (tool !== 'select') setTool('select'); echo(selected.length + ' objet(s) sélectionné(s).'); refreshProps(); paint(); return; }
      if (kl === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (kl === 'y') { e.preventDefault(); redo(); return; }
      if (kl === 'c') { e.preventDefault(); copySel(false); return; }
      if (kl === 'x') { e.preventDefault(); copySel(true); return; }
      if (kl === 'v') { e.preventDefault(); paste(); return; }
      if (kl === 's') { e.preventDefault(); saveCurrent(true); return; }
      return; // autres combinaisons Ctrl : ne pas les transformer en commande
    }
    if (k === 'Delete') {
      if (selected.length) { pushHistory(); selected.forEach(en => { const i = scene.entities.indexOf(en); if (i >= 0) scene.entities.splice(i, 1); }); echo(selected.length + ' objet(s) supprimé(s).'); selected = []; refreshProps(); paint(); }
      e.preventDefault(); return;
    }
    if (k === 'Escape' && gripDrag) {
      const g = gripDrag, en = g.ent;
      if (g.origAll) en.points.forEach((p, i) => { p.x = g.origAll[i].x; p.y = g.origAll[i].y; });
      if (g.origOff != null) en.offMm = g.origOff;
      if (history.length) history.pop();           // la modification est annulée : pas d'entrée d'historique
      gripDrag = null; hotGrip = null; echo('Édition annulée.'); paint(); return;
    }
    if (k === 'Escape') { draft = []; ghost = null; selected = []; trimPreview = null; dimSeg = null; hideTextInput(); hideDyn(); echo('*Annulé*'); if (tool !== 'select') setTool('select'); else paint(); return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); if (tool === 'polyline' && draft.length >= 2) finishPoly(); else runCommand(''); return; }
    if ((/^[0-9]$/.test(k) || k === '.' || k === ',') && (activePoint() || tool === 'offset' || (op && op.step === 1) || (tool === 'circle' && circleCenter))) { startEdit(k); e.preventDefault(); return; }
    if (/^[a-zA-Z]$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey) { cmd.focus(); cmd.value += k.toUpperCase(); e.preventDefault(); } // taper = ligne de commande
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
  $('layer').addEventListener('change', () => { currentLayer = $('layer').value; $('color').value = layerById(currentLayer).color; updateSwatch('color'); paint(); });
  { const ds = $('dimsize'); if (ds) ds.addEventListener('change', () => { currentDimSize = parseFloat(ds.value); }); }
  { const ts = $('txtsize'); if (ts) ts.addEventListener('change', () => { currentTextH = parseFloat(ts.value); }); }
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
  function pushHistory() { history.push(refClone(scene.entities)); if (history.length > 80) history.shift(); redoStack.length = 0; }
  function resetTransient() { selected = []; draft = []; gripDrag = hotGrip = null; op = null; opGhost = null; ghost = null; trimPreview = null; hideDyn(); }
  function undo() {
    if (!history.length) { echo('Rien à annuler.'); return; }
    redoStack.push(refClone(scene.entities));
    scene.entities = history.pop(); resetTransient();
    echo('↶ Annulé.'); refreshProps(); paint();
  }
  function redo() {
    if (!redoStack.length) { echo('Rien à rétablir.'); return; }
    history.push(refClone(scene.entities));
    scene.entities = redoStack.pop(); resetTransient();
    echo('↷ Rétabli.'); refreshProps(); paint();
  }
  function clearAll() { pushHistory(); scene.entities.length = 0; selected = []; draft = []; echo('Dessin effacé.'); paint(); }
  function eraseSel() {
    if (!selected.length) { echo('Rien de sélectionné — sélectionnez d’abord des objets.'); return; }
    pushHistory();
    selected.forEach(en => { const i = scene.entities.indexOf(en); if (i >= 0) scene.entities.splice(i, 1); });
    echo(selected.length + ' objet(s) supprimé(s).'); selected = []; refreshProps(); paint();
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
      ['color', 'Couleur', '<input type="color" data-pk="color" value="' + (e0.color || (isDim ? '#b9375e' : '#1b2b4b')) + '">']
    ];
    if (!isDim && !isText && !isHatch) {
      rows.push(['penMm', 'Épaisseur', '<select data-pk="penMm">' + [0.18, 0.25, 0.35, 0.5, 0.7, 1].map(v => '<option value="' + v + '"' + (Math.abs((e0.penMm || 0.25) - v) < 1e-6 ? ' selected' : '') + '>' + String(v).replace('.', ',') + ' mm</option>').join('') + '</select>']);
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
      pushHistory();
      selected.forEach(e => {
        if (k === 'dash') { if (v === 'solid') delete e.dash; else e.dash = v; }
        else if (k === 'arrow') { if (v === 'arrow') delete e.arrow; else e.arrow = v; }
        else e[k] = v;
      });
      echo('Propriétés appliquées à ' + selected.length + ' objet(s).'); renderProps(); paint();
    }));
    $('pr-close').onclick = toggleProps;
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
    R._adapt = c => c;   // les pages mappent déjà leurs couleurs pour le papier blanc
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);                         // bureau
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(L.Sx0 + 7, L.Sy0 + 7, L.sheetW, L.sheetH); // ombre
    ctx.fillStyle = '#ffffff'; ctx.fillRect(L.Sx0, L.Sy0, L.sheetW, L.sheetH);   // feuille
    const dx0 = L.Sx0 + L.margin * L.ppmPaper, dy0 = L.Sy0 + L.margin * L.ppmPaper;
    const dw = L.sheetW - 2 * L.margin * L.ppmPaper, dh = L.sheetH - 2 * L.margin * L.ppmPaper;
    ctx.save(); ctx.beginPath(); ctx.rect(dx0, dy0, dw, dh); ctx.clip();        // découpe à la zone utile
    // région MODÈLE visible sur la feuille (pour ne dessiner que ça : le plan cadré, pas toute la bibliothèque)
    const wA = R.screenToWorld(L.pageView, dx0, dy0 + dh), wB = R.screenToWorld(L.pageView, dx0 + dw, dy0);
    const mx0 = Math.min(wA.x, wB.x), my0 = Math.min(wA.y, wB.y), mx1 = Math.max(wA.x, wB.x), my1 = Math.max(wA.y, wB.y);
    const vis2 = e => { const b = R._bbox(e); return !(b[2] < mx0 || b[0] > mx1 || b[3] < my0 || b[1] > my1); };
    const lc = id => layerById(id).color;
    const vs = visibleScene();
    for (const e of vs.entities) if (e.type === 'image' && vis2(e)) R.drawImage(ctx, L.pageView, e);
    for (const e of vs.entities) if (e.type === 'hatch' && vis2(e)) R.drawHatch(ctx, L.pageView, e, mapColor(e.color || lc(e.layer)));
    const grp = new Map(), dims = [], txts = [];
    for (const e of vs.entities) {
      const t = e.type; if (t === 'hatch' || t === 'image') continue;
      if (!vis2(e)) continue;
      if (t === 'dim') { dims.push(e); continue; } if (t === 'text') { txts.push(e); continue; }
      if (e.dash) { R.drawEntity(ctx, L.pageView, e, mapColor(e.color || lc(e.layer))); continue; }
      const col = mapColor(e.color || lc(e.layer)), w = Math.max(0.6, (e.penMm || 0.25) * 1.4), key = col + '|' + w;
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
    currentLayer = (d.currentLayer && scene.layers.some(l => l.id === d.currentLayer)) ? d.currentLayer : scene.layers[0].id;
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
    for (const e of vs.entities) { if (e.type === 'hatch' || e.type === 'image') continue; if (e.type === 'dim') R.drawDim(cx, v, e, false, mapColor(e.color || layerById(e.layer).color)); else if (e.type === 'text') R.drawText(cx, v, e, mapColor(e.color || layerById(e.layer).color)); else R.drawEntity(cx, v, e, mapColor(e.color)); }
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
    currentLayer = scene.layers[0].id; history = []; redoStack = []; selected = []; draft = []; op = null; currentDocId = null;
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
    scene.layers = (doc.layers || []).map((L, i) => ({ id: 'l' + i, name: L.name || ('Calque ' + i), color: L.color || '#9fb0d0', visible: true, locked: false, frozen: false }));
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
    pages = (doc.pages || []).map(p => ({ id: p.id || ('pg' + Math.random().toString(36).slice(2)), name: p.name || 'Page', paper: p.paper || 'A4', orientation: p.orientation || 'portrait', scaleDenom: p.scaleDenom || 100, offX: p.offX || 0, offY: p.offY || 0 }));
    currentLayer = scene.layers[0].id; history = []; redoStack = []; selected = []; draft = []; op = null;
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
    return fetchGzJson('assets/qlygo-base.json.gz?v=21').then(doc => {
      applyCompact(doc); currentDocId = null; setDocName(doc.name || 'QLYGO_CAD (base)');
      renderLayerSelect(); renderPageTabs(); hideHome(); activePage = 'model'; setTool('select'); resize(); fitContent();
      echo('✅ Plan de base chargé : ' + scene.entities.length + ' entités sur ' + scene.layers.length + ' calques.');
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
    const dx = $('dxfFile'); if (dx) dx.addEventListener('change', e => { const f = e.target.files[0]; if (f) { /\.dwg$/i.test(f.name) ? openDWGFile(f) : importDXFFile(f); } dx.value = ''; });
    const pf = $('pdfFile'); if (pf) pf.addEventListener('change', e => { const f = e.target.files[0]; if (f) importPDFFile(f); pf.value = ''; });
  }
  function ensureLayer(name, color) {
    const ex = scene.layers.find(x => x.name === name); if (ex) return ex.id;
    const id = 'dxf-' + String(name || '0').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + scene.layers.length;
    scene.layers.push({ id, name: name || 'Calque', color: color || '#9fb0d0', visible: true, locked: false, frozen: false });
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
  function importPDFFile(file) {
    echo('📑 Lecture du PDF…');
    const rd = new FileReader();
    rd.onload = () => {
      const buf = rd.result;
      loadPdfJs().then(pdfjsLib => pdfjsLib.getDocument({ data: buf }).promise.then(pdf => pdf.getPage(1).then(page => {
        const vp = page.getViewport({ scale: 2 });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.then(() => {
          const src = c.toDataURL('image/png');
          const vp1 = page.getViewport({ scale: 1 }), wMm = vp1.width * 0.352777, hMm = vp1.height * 0.352777;
          pushHistory();
          const id = ensureLayer('PDF - fond de plan', '#9fb0d0');
          scene.entities.unshift({ type: 'image', points: [{ x: 0, y: 0 }, { x: wMm, y: hMm }], src, layer: id, opacity: 0.92 });
          renderLayerSelect(); refreshLayers(); setActivePage('model'); fit();
          echo('📑 PDF importé en fond (' + (wMm / 1000).toFixed(2) + ' × ' + (hMm / 1000).toFixed(2) + ' m). Déplace/redimensionne par les poignées des coins.');
        });
      })).catch(err => echo('⚠ Import PDF échoué : ' + (err && err.message ? err.message : err))));
    };
    rd.onerror = () => echo('⚠ Lecture du PDF impossible.');
    rd.readAsArrayBuffer(file);
  }

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
