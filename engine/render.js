/* QlygoCAD — engine/render.js
 * Rendu Canvas d'une scène (mm réels). Dépend du Canvas mais PAS d'Electron.
 * "view" décrit la caméra écran ; l'échelle d'impression n'intervient pas ici
 * (à l'écran on zoome librement, comme dans un vrai logiciel de CAO).
 */
(function (root) {
  const R = {};
  R._adapt = c => c;
  // Affichage des ÉPAISSEURS de trait à l'écran (façon « LWT » d'AutoCAD) : largeur en px
  // = épaisseur papier × échelle, bien séparée pour qu'on distingue fin / moyen / gras.
  R.lwtOn = true; R.lwtScale = 5;
  R.lockedAlpha = 0.4;   // opacité des traits sur un calque VERROUILLÉ (atténués = repérables à l'œil)
  R.penPx = function (penVal) { return (R.lwtOn === false) ? 1 : Math.max(1, (penVal != null ? penVal : 0.25) * R.lwtScale); };

  // view = { pxPerMm, panXmm, panYmm, canvasW, canvasH }
  // Repère monde : X droite, Y haut. Écran : Y vers le bas -> on inverse.
  R.worldToScreen = function (view, xmm, ymm) {
    return {
      x: (xmm - view.panXmm) * view.pxPerMm,
      y: view.canvasH - (ymm - view.panYmm) * view.pxPerMm
    };
  };
  R.screenToWorld = function (view, sx, sy) {
    return {
      x: sx / view.pxPerMm + view.panXmm,
      y: (view.canvasH - sy) / view.pxPerMm + view.panYmm
    };
  };

  // Boîte englobante d'une entité (mm réels), mise en cache sur e._bb.
  // Invalider (e._bb = null) après toute modification de géométrie.
  R._bbox = function (e) {
    if (e._bb) return e._bb;
    let a = 1e18, b = 1e18, c = -1e18, d = -1e18;
    if (e.type === 'circle' && e.center) { a = e.center.x - e.r; b = e.center.y - e.r; c = e.center.x + e.r; d = e.center.y + e.r; }
    else { const p = e.points || []; for (let i = 0; i < p.length; i++) { const q = p[i]; if (q.x < a) a = q.x; if (q.y < b) b = q.y; if (q.x > c) c = q.x; if (q.y > d) d = q.y; } if (e.type === 'text') { c += (e.hMm || 800) * Math.max(1, String(e.text || '').length) * 0.6; d += (e.hMm || 800); b -= (e.hMm || 800) * 0.3; } }
    if (a > c) { a = b = -1e17; c = d = 1e17; }
    e._bb = [a, b, c, d]; return e._bb;
  };

  // Rendu complet = dessin statique (cache) + surcouche dynamique.
  R.draw = function (ctx, scene, view, opts) { opts = opts || {}; R.drawScene(ctx, scene, view, opts); R.drawOverlay(ctx, scene, view, opts); };

  // --- PASSE STATIQUE (mise en cache) : fond, grille, axes, entités ---
  R.drawScene = function (ctx, scene, view, opts) {
    opts = opts || {};
    const W = view.canvasW, H = view.canvasH;
    const dark = !!opts.dark;
    const th = opts.theme || {};
    const gMaj = th.gridMajor || (dark ? '#3b4252' : '#d4dced');
    const gMin = th.gridMinor || (dark ? '#262b36' : '#eef2f8');
    ctx.clearRect(0, 0, W, H);
    const bg = th.bg || opts.bg || (dark ? '#1b1f28' : '#ffffff');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    // Couleurs STABLES : chaque trait garde EXACTEMENT sa couleur, quel que soit le fond.
    // (Plus d'inversion automatique blanc<->noir : une ligne blanche reste blanche, etc.)
    R._adapt = c => c;

    // --- Grille (tous les gridStepMm, gras tous les 5) ---
    if (opts.grid !== false) {
      const step = opts.gridStepMm || 1000;
      const w0 = R.screenToWorld(view, 0, H), w1 = R.screenToWorld(view, W, 0);
      const startX = Math.floor(w0.x / step) * step, endX = Math.ceil(w1.x / step) * step;
      const startY = Math.floor(w0.y / step) * step, endY = Math.ceil(w1.y / step) * step;
      let idx;
      for (let x = startX; x <= endX; x += step) {
        idx = Math.round(x / step);
        const sx = Math.round(R.worldToScreen(view, x, 0).x) + 0.5;   // demi-pixel : ligne nette 1px
        ctx.strokeStyle = (idx % 5 === 0) ? gMaj : gMin;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
      }
      for (let y = startY; y <= endY; y += step) {
        idx = Math.round(y / step);
        const sy = Math.round(R.worldToScreen(view, 0, y).y) + 0.5;
        ctx.strokeStyle = (idx % 5 === 0) ? gMaj : gMin;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
      }
    }

    // --- Axes X / Y (origine 0,0), discrets ---
    if (opts.axes !== false) {
      const o = R.worldToScreen(view, 0, 0), ox = Math.round(o.x) + 0.5, oy = Math.round(o.y) + 0.5;
      ctx.lineWidth = 1;
      ctx.strokeStyle = th.axisXLine || (dark ? '#5e3b45' : '#f3c9d4');
      ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(W, oy); ctx.stroke(); // X
      ctx.strokeStyle = th.axisYLine || (dark ? '#2f4e3d' : '#c9e8d6');
      ctx.beginPath(); ctx.moveTo(ox, 0); ctx.lineTo(ox, H); ctx.stroke(); // Y
    }

    // --- Entités (hachures en fond, puis traits, puis cotes) ---
    const lcMap = {}, lpMap = {}, lkMap = {}; if (scene.layers) for (const l of scene.layers) { lcMap[l.id] = l.color; lpMap[l.id] = l.penMm; lkMap[l.id] = !!l.locked; }
    const layerColor = id => lcMap[id] || null;
    const layerPen = id => (lpMap[id] != null ? lpMap[id] : 0.25);
    const layerLocked = id => !!lkMap[id];   // calque verrouillé -> tracé atténué (grisé)
    // Fenêtre monde visible (pour le "culling" : on ignore ce qui est hors écran)
    const wx0 = view.panXmm, wy0 = view.panYmm, wx1 = view.panXmm + W / view.pxPerMm, wy1 = view.panYmm + H / view.pxPerMm;
    const vis = e => { const b = R._bbox(e); return !(b[2] < wx0 || b[0] > wx1 || b[3] < wy0 || b[1] > wy1); };
    // Images de fond + hachures (peu nombreuses), avec culling
    for (const e of scene.entities) if (e.type === 'image' && vis(e)) R.drawImage(ctx, view, e);
    for (const e of scene.entities) if (e.type === 'hatch' && vis(e)) { const lk = layerLocked(e.layer); if (lk) ctx.globalAlpha = R.lockedAlpha; R.drawHatch(ctx, view, e, layerColor(e.layer)); if (lk) ctx.globalAlpha = 1; }
    // Traits (lignes/polylignes/cercles) : REGROUPÉS PAR COULEUR -> un seul tracé
    // par couleur (indispensable pour les gros plans à 100k+ entités).
    const groups = new Map(); const dims = [], texts = [];
    for (const e of scene.entities) {
      const t = e.type;
      if (t === 'hatch' || t === 'image') continue;
      if (t === 'dim') { if (vis(e)) dims.push(e); continue; }
      if (t === 'text') { if (vis(e)) texts.push(e); continue; }
      const bb = R._bbox(e); if (bb[2] < wx0 || bb[0] > wx1 || bb[3] < wy0 || bb[1] > wy1) continue;
      if (Math.max(bb[2] - bb[0], bb[3] - bb[1]) * view.pxPerMm < 0.7) continue; // niveau de détail : sous-pixel ignoré
      const lk = layerLocked(e.layer);
      if (e.dash) { if (lk) ctx.globalAlpha = R.lockedAlpha; R.drawEntity(ctx, view, e, null, layerPen(e.layer)); if (lk) ctx.globalAlpha = 1; continue; }   // traits spéciaux : individuels
      const col = e.color || layerColor(e.layer) || '#1b2b4b';
      // épaisseur BYLAYER : si l'entité n'a pas d'épaisseur propre, elle prend celle du calque
      const np = !!e.noPrint;   // trait « non imprimable » (guide) -> pointillés atténués à l'écran
      const w = R.penPx(e.penMm != null ? e.penMm : layerPen(e.layer)), key = col + '|' + w + (lk ? '|L' : '') + (np ? '|NP' : '');
      let g = groups.get(key); if (!g) { g = { col, w, list: [], locked: lk, noPrint: np }; groups.set(key, g); }
      g.list.push(e);
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
    for (const g of groups.values()) {
      ctx.globalAlpha = g.noPrint ? 0.5 : (g.locked ? R.lockedAlpha : 1);   // guide non imprimable -> atténué
      ctx.setLineDash(g.noPrint ? [6, 4] : []);
      ctx.strokeStyle = R._adapt(g.col); ctx.lineWidth = g.w; ctx.beginPath();
      for (const e of g.list) {
        const p = e.points; if (!p.length) continue;
        let s = R.worldToScreen(view, p[0].x, p[0].y); ctx.moveTo(s.x, s.y);
        for (let i = 1; i < p.length; i++) { s = R.worldToScreen(view, p[i].x, p[i].y); ctx.lineTo(s.x, s.y); }
        if (e.closed) ctx.closePath();
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.setLineDash([]);
    for (const e of dims) { const lk = layerLocked(e.layer); if (lk) ctx.globalAlpha = R.lockedAlpha; R.drawDim(ctx, view, e, false, layerColor(e.layer)); if (lk) ctx.globalAlpha = 1; }
    for (const e of texts) { const lk = layerLocked(e.layer); if (lk) ctx.globalAlpha = R.lockedAlpha; R.drawText(ctx, view, e, null, layerColor(e.layer)); if (lk) ctx.globalAlpha = 1; }
  };

  // --- PASSE SURCOUCHE (redessinée à chaque mouvement, par-dessus le cache) ---
  R.drawOverlay = function (ctx, scene, view, opts) {
    opts = opts || {};
    const W = view.canvasW, H = view.canvasH;
    const dark = !!opts.dark;
    const th = opts.theme || {};

    // --- Survol (rollover AutoCAD) : objet sous le curseur mis en évidence ---
    if (opts.hoverEnt && (!opts.selected || opts.selected.indexOf(opts.hoverEnt) < 0)) {
      const e = opts.hoverEnt;
      ctx.save(); ctx.strokeStyle = 'rgba(120,200,255,.9)'; ctx.lineWidth = Math.max(2.5, (e.penMm || 0.25) * 3 + 2); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
      if (e.type === 'circle' && e.center) { const c = R.worldToScreen(view, e.center.x, e.center.y); ctx.beginPath(); ctx.arc(c.x, c.y, e.r * view.pxPerMm, 0, 7); ctx.stroke(); }
      else if (e.type === 'text' || e.type === 'image') { const b = R._bbox(e), a = R.worldToScreen(view, b[0], b[1]), d = R.worldToScreen(view, b[2], b[3]); ctx.strokeRect(Math.min(a.x, d.x), Math.min(a.y, d.y), Math.abs(d.x - a.x), Math.abs(d.y - a.y)); }
      else if (e.type === 'dim') { const g = root.QCAD.geometry.dimGeometry(e); const da = R.worldToScreen(view, g.da.x, g.da.y), db = R.worldToScreen(view, g.db.x, g.db.y); ctx.beginPath(); ctx.moveTo(da.x, da.y); ctx.lineTo(db.x, db.y); ctx.stroke(); }
      else if (e.points && e.points.length) { ctx.beginPath(); e.points.forEach((p, i) => { const s = R.worldToScreen(view, p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); if (e.closed) ctx.closePath(); ctx.stroke(); }
      ctx.restore();
    }
    // --- Survol de l'outil Hachures : zone à remplir (contour orange) + îlots exclus ---
    if (opts.hatchHover && opts.hatchHover.points) {
      ctx.save();
      // remplissage orange translucide de la zone RÉELLE (trous exclus) = aperçu fidèle
      ctx.beginPath(); opts.hatchHover.points.forEach((p, i) => { const s = R.worldToScreen(view, p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.closePath();
      const holes = opts.hatchHover.holes || [];
      for (const h of holes) { if (h.length < 3) continue; h.forEach((p, i) => { const s = R.worldToScreen(view, p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.closePath(); }
      ctx.fillStyle = 'rgba(237,160,32,.18)'; ctx.fill('evenodd');
      ctx.strokeStyle = '#eda020'; ctx.lineWidth = 2.5; ctx.globalAlpha = .9; ctx.stroke();
      ctx.restore();
    }

    // --- Survol de l'outil Cote : segment mis en évidence + cotation proposée ---
    if (opts.dimHover) {
      const s1 = R.worldToScreen(view, opts.dimHover.a.x, opts.dimHover.a.y);
      const s2 = R.worldToScreen(view, opts.dimHover.b.x, opts.dimHover.b.y);
      ctx.strokeStyle = '#eda020'; ctx.lineWidth = 3; ctx.globalAlpha = .6;
      ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); ctx.stroke();
      ctx.globalAlpha = 1;
      if (opts.dimPreview) R.drawDim(ctx, view, opts.dimPreview, true);
    }

    // --- Aperçu de tracé en cours (points provisoires) ---
    if (opts.preview && opts.preview.length) {
      ctx.strokeStyle = '#eda020'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath();
      opts.preview.forEach((p, i) => {
        const s = R.worldToScreen(view, p.x, p.y);
        i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
      });
      ctx.stroke(); ctx.setLineDash([]);
      opts.preview.forEach(p => {
        const s = R.worldToScreen(view, p.x, p.y);
        ctx.fillStyle = '#eda020'; ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, 7); ctx.fill();
      });
    }

    // --- Guide Ortho/Polaire (ligne pointillée depuis le dernier point) ---
    if (opts.guide && opts.guide.from && opts.guide.to) {
      const a = R.worldToScreen(view, opts.guide.from.x, opts.guide.from.y);
      const b = R.worldToScreen(view, opts.guide.to.x, opts.guide.to.y);
      ctx.strokeStyle = '#2e8b57'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- Marqueur d'accrochage (snap) à la position courante ---
    if (opts.snap) {
      const s = R.worldToScreen(view, opts.snap.x, opts.snap.y);
      R.drawSnapMarker(ctx, s.x, s.y, opts.snap.type);
    }

    // --- Objets sélectionnés : surbrillance + poignées (grips) ---
    if (opts.selected && opts.selected.length) {
      ctx.save();
      for (const e of opts.selected) {
        if (e.type === 'circle') { // cercle : contour + 1 poignée au centre
          const c = R.worldToScreen(view, e.center.x, e.center.y);
          ctx.strokeStyle = '#1e90ff'; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
          ctx.beginPath(); ctx.arc(c.x, c.y, e.r * view.pxPerMm, 0, 7); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = '#1e90ff'; ctx.fillRect(c.x - 5, c.y - 5, 10, 10);
          continue;
        }
        ctx.strokeStyle = '#1e90ff'; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
        if (e.type === 'text' && e.zone && e.points.length >= 2) {
          // Texte en ZONE : montrer la BOÎTE (rectangle) comme sur Canva + poignées de coin.
          const a = R.worldToScreen(view, e.points[0].x, e.points[0].y), b = R.worldToScreen(view, e.points[1].x, e.points[1].y);
          ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.setLineDash([]);
        } else {
          ctx.beginPath();
          e.points.forEach((p, i) => { const s = R.worldToScreen(view, p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
          if (e.closed) ctx.closePath();
          ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.fillStyle = '#1e90ff';
        e.points.forEach(p => { const s = R.worldToScreen(view, p.x, p.y); ctx.fillRect(s.x - 5, s.y - 5, 10, 10); });
        // poignée centrale (déplace tout le trait) pour une ligne simple
        if (e.type !== 'dim' && e.type !== 'hatch' && e.points.length === 2) {
          const m = { x: (e.points[0].x + e.points[1].x) / 2, y: (e.points[0].y + e.points[1].y) / 2 };
          const s = R.worldToScreen(view, m.x, m.y); ctx.fillRect(s.x - 5, s.y - 5, 10, 10);
        }
        // poignées au MILIEU de chaque côté (déplace tout le côté) pour les polylignes / rectangles
        if (e.type !== 'dim' && e.type !== 'hatch' && e.points.length > 2) {
          const n = e.points.length, edges = e.closed ? n : n - 1;
          ctx.fillStyle = '#58d6c9';
          for (let i = 0; i < edges; i++) { const j = (i + 1) % n; const mx = (e.points[i].x + e.points[j].x) / 2, my = (e.points[i].y + e.points[j].y) / 2; const s = R.worldToScreen(view, mx, my); ctx.fillRect(s.x - 5, s.y - 5, 10, 10); }
          ctx.fillStyle = '#1e90ff';
        }
        // Cote : poignée d'ÉCARTEMENT (milieu de la ligne de cote, en turquoise).
        // Les 2 EXTRÉMITÉS sont déjà tracées (grips bleus des e.points ci-dessus).
        if (e.type === 'dim') {
          const g = root.QCAD.geometry.dimGeometry(e);
          ctx.fillStyle = '#58d6c9'; const sm = R.worldToScreen(view, g.mid.x, g.mid.y); ctx.fillRect(sm.x - 5, sm.y - 5, 10, 10);
          ctx.fillStyle = '#1e90ff';
        }
      }
      // poignée "chaude" (survolée / en cours de déplacement) : carré rouge + anneau de mise en évidence
      if (opts.hotGrip) {
        const s = R.worldToScreen(view, opts.hotGrip.x, opts.hotGrip.y);
        ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(s.x, s.y, 11, 0, 2 * Math.PI); ctx.stroke();
        ctx.fillStyle = '#e53e3e'; ctx.fillRect(s.x - 6, s.y - 6, 12, 12);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(s.x - 6, s.y - 6, 12, 12);
      }
      ctx.restore();
    }

    // --- Cadre de sélection (bleu = fenêtre, vert = capture) ---
    if (opts.selRect) {
      const a = R.worldToScreen(view, opts.selRect.a.x, opts.selRect.a.y);
      const b = R.worldToScreen(view, opts.selRect.b.x, opts.selRect.b.y);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      ctx.save();
      if (opts.selRect.crossing) { ctx.fillStyle = 'rgba(22,163,74,.13)'; ctx.strokeStyle = '#16a34a'; ctx.setLineDash([6, 4]); }
      else { ctx.fillStyle = 'rgba(59,130,246,.13)'; ctx.strokeStyle = '#3b82f6'; }
      ctx.lineWidth = 1; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    // --- Aperçu d'une transformation (Déplacer/Copier/Pivoter/Miroir) ---
    if (opts.opGhost && opts.opGhost.length) {
      ctx.save(); ctx.strokeStyle = '#eda020'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      for (const g of opts.opGhost) {
        if (!g.points || !g.points.length) continue;
        ctx.beginPath(); g.points.forEach((p, i) => { const s = R.worldToScreen(view, p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
        if (g.closed) ctx.closePath(); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.restore();
    }
    // --- Aperçu de cercle (outil Cercle) ---
    if (opts.circlePreview) {
      const c = R.worldToScreen(view, opts.circlePreview.cx, opts.circlePreview.cy);
      ctx.save(); ctx.strokeStyle = '#eda020'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.arc(c.x, c.y, opts.circlePreview.r * view.pxPerMm, 0, 7); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
    }

    // --- Icône SCU (repère X/Y à l'origine), façon AutoCAD ---
    if (opts.ucs !== false) R.drawUCS(ctx, view, dark, th.axisX, th.axisY);

    // --- Réticule (crosshair) paramétrable : couleur, taille, carré ---
    if (opts.crosshair) {
      const c = opts.crosshair;
      ctx.strokeStyle = c.color || (dark ? 'rgba(230,235,245,.55)' : 'rgba(40,50,80,.5)');
      ctx.lineWidth = 1;
      const sizes = { small: 16, medium: 55, large: 120 };
      const len = (c.size === 'full' || c.size == null) ? Math.max(W, H) : (sizes[c.size] || 55);
      ctx.beginPath();
      ctx.moveTo(c.x - len, c.y + .5); ctx.lineTo(c.x + len, c.y + .5);
      ctx.moveTo(c.x + .5, c.y - len); ctx.lineTo(c.x + .5, c.y + len); ctx.stroke();
      if (c.pickbox !== false) { const pb = 5; ctx.strokeRect(c.x - pb, c.y - pb, pb * 2, pb * 2); }
    }
  };

  // Icône SCU : flèches X (rouge) et Y (vert) à l'origine
  R.drawUCS = function (ctx, view, dark, axisX, axisY) {
    const o = R.worldToScreen(view, 0, 0);
    const L = 42;
    ctx.save();
    ctx.lineWidth = 1.6; ctx.font = '11px system-ui'; ctx.textBaseline = 'middle';
    // X ->
    ctx.strokeStyle = ctx.fillStyle = axisX || '#e06c75';
    ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + L, o.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(o.x + L, o.y); ctx.lineTo(o.x + L - 6, o.y - 3); ctx.lineTo(o.x + L - 6, o.y + 3); ctx.closePath(); ctx.fill();
    ctx.fillText('X', o.x + L + 4, o.y);
    // Y ^ (écran : vers le haut = -y)
    ctx.strokeStyle = ctx.fillStyle = axisY || '#98c379';
    ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x, o.y - L); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(o.x, o.y - L); ctx.lineTo(o.x - 3, o.y - L + 6); ctx.lineTo(o.x + 3, o.y - L + 6); ctx.closePath(); ctx.fill();
    ctx.fillText('Y', o.x - 3, o.y - L - 6);
    // petit carré à l'origine
    ctx.strokeStyle = dark ? '#8892b0' : '#64748b';
    ctx.strokeRect(o.x - 4, o.y - 4, 8, 8);
    ctx.restore();
  };

  // Marqueurs façon AutoCAD, par type d'accrochage
  R.drawSnapMarker = function (ctx, x, y, type) {
    ctx.save();
    ctx.strokeStyle = '#16a34a'; ctx.fillStyle = 'rgba(22,163,74,.15)'; ctx.lineWidth = 1.6;
    const r = 6;
    ctx.beginPath();
    if (type === 'end') {                 // carré
      ctx.rect(x - r, y - r, r * 2, r * 2); ctx.fill(); ctx.stroke();
    } else if (type === 'mid') {          // triangle
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (type === 'inter') {        // croix (X)
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
    } else if (type === 'perp') {         // équerre
      ctx.moveTo(x - r, y - r); ctx.lineTo(x - r, y + r); ctx.lineTo(x + r, y + r);
      ctx.moveTo(x - r, y); ctx.lineTo(x, y); ctx.lineTo(x, y + r); ctx.stroke();
    } else if (type === 'near') {         // "proche de" : sablier (deux triangles pointe à pointe)
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y - r); ctx.lineTo(x - r, y + r);
      ctx.lineTo(x + r, y + r); ctx.closePath(); ctx.stroke();
    } else if (type === 'center') {       // centre : cercle + point
      ctx.arc(x, y, r, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 7); ctx.fillStyle = '#16a34a'; ctx.fill();
    } else if (type === 'quadrant') {     // quadrant : losange
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else {                              // grille : petit losange
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
      ctx.closePath(); ctx.stroke();
    }
    ctx.restore();
  };

  R.drawEntity = function (ctx, view, e, colOverride, penFallback) {
    if (!e.points.length) return;
    ctx.strokeStyle = R._adapt(colOverride || e.color || '#1b2b4b');
    // épaisseur écran : propre à l'entité, sinon celle du calque (BYLAYER), min 1 px
    ctx.lineWidth = R.penPx(e.penMm != null ? e.penMm : penFallback);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash({ dashed: [9, 6], dotted: [2, 5], dashdot: [9, 5, 2, 5] }[e.dash] || []);
    if (e.type === 'circle') { // cercle lissé
      const c = R.worldToScreen(view, e.center.x, e.center.y);
      ctx.beginPath(); ctx.arc(c.x, c.y, e.r * view.pxPerMm, 0, 7); ctx.stroke(); ctx.setLineDash([]); return;
    }
    ctx.beginPath();
    e.points.forEach((p, i) => {
      const s = R.worldToScreen(view, p.x, p.y);
      i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
    });
    if (e.closed) ctx.closePath();
    ctx.stroke(); ctx.setLineDash([]);
  };

  // Cotation. TOUT (texte, flèches, ticks, décalage du texte) est exprimé en mm RÉELS
  // puis converti en px par view.pxPerMm -> la cote garde EXACTEMENT la même taille
  // apparente à l'écran, dans une case DP et à l'impression (zoom = taille réelle,
  // plus de « fausse information » entre la zone de dessin et le résultat).
  // Hauteur de texte d'une cote (mm RÉELS). Si hMm est imposé, on le respecte ;
  // sinon la cote S'ADAPTE À CE QU'ELLE MESURE : au-delà d'1 m -> taille « normale »
  // classique (constante), en-deçà -> réduite proportionnellement (une cote de 3 mm
  // reste à l'échelle de 3 mm, pas démesurée).
  R.COTE_NORM_MM = 250;
  R.dimHmm = function (e) {
    if (e.hMm != null) return e.hMm;
    const p = e.points;
    const len = (p && p.length >= 2) ? (Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) || 1) : 1000;
    return Math.max(0.5, R.COTE_NORM_MM * Math.min(1, len / 1000));
  };
  R.drawDim = function (ctx, view, e, preview, fallback) {
    const fmt = (e.dec != null) ? (mm => (mm / 1000).toFixed(e.dec).replace('.', ',') + ' m') : null;
    const g = root.QCAD.geometry.dimGeometry(e, fmt);
    const col = R._adapt(preview ? '#eda020' : (e.color || fallback || '#b9375e'));
    const toS = p => R.worldToScreen(view, p.x, p.y);
    const da = toS(g.da), db = toS(g.db), mid = toS(g.mid);
    const ppm = view.pxPerMm, h = R.dimHmm(e);     // hauteur de texte en mm réels -> px
    const fs = Math.max(1, h * ppm);
    ctx.save();
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.lineWidth = R.penPx(e.penMm != null ? e.penMm : 0.25);
    if (preview) ctx.setLineDash([5, 4]);
    // lignes d'attache (chaque côté peut être masqué : e.extA / e.extB === false)
    if (e.extA !== false) { const a0 = toS(g.extA[0]), a1 = toS(g.extA[1]); ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.stroke(); }
    if (e.extB !== false) { const b0 = toS(g.extB[0]), b1 = toS(g.extB[1]); ctx.beginPath(); ctx.moveTo(b0.x, b0.y); ctx.lineTo(b1.x, b1.y); ctx.stroke(); }
    // ---- ligne de cote, INTERROMPUE au centre pour y loger la valeur (look AutoCAD) ----
    const L = Math.hypot(db.x - da.x, db.y - da.y) || 1, ux = (db.x - da.x) / L, uy = (db.y - da.y) / L, px = -uy, py = ux;
    ctx.font = '600 ' + fs + 'px system-ui,Segoe UI,sans-serif';
    const tw = ctx.measureText(g.text).width;
    const inline = (e.textPos !== 'above');                 // défaut : valeur SUR la ligne
    const halfGap = inline ? (tw / 2 + 0.4 * fs) : 0;        // trou pour le texte
    const gapFits = inline && halfGap > 2 && halfGap < L / 2 - 2;
    ctx.beginPath();
    if (gapFits) {
      ctx.moveTo(da.x, da.y); ctx.lineTo(mid.x - ux * halfGap, mid.y - uy * halfGap);
      ctx.moveTo(mid.x + ux * halfGap, mid.y + uy * halfGap); ctx.lineTo(db.x, db.y);
    } else { ctx.moveTo(da.x, da.y); ctx.lineTo(db.x, db.y); }
    ctx.stroke();
    ctx.setLineDash([]);
    if (e.arrow === 'tick') {
      // ticks d'architecte (obliques à 45°) aux deux extrémités — taille réelle
      ctx.lineWidth = Math.max(1, 0.08 * h * ppm);
      const ang = Math.atan2(db.y - da.y, db.x - da.x) + Math.PI / 4;
      const t = Math.max(2, 0.6 * h * ppm), cx = Math.cos(ang) * t, cy = Math.sin(ang) * t;
      ctx.beginPath();
      ctx.moveTo(da.x - cx, da.y - cy); ctx.lineTo(da.x + cx, da.y + cy);
      ctx.moveTo(db.x - cx, db.y - cy); ctx.lineTo(db.x + cx, db.y + cy);
      ctx.stroke();
    } else {
      // flèches pleines pointant vers l'extérieur (taille réelle)
      const al = Math.max(3, 0.8 * h * ppm), aw = Math.max(1, 0.28 * h * ppm);   // longueur / demi-largeur
      ctx.beginPath(); ctx.moveTo(da.x, da.y); ctx.lineTo(da.x + ux * al + px * aw, da.y + uy * al + py * aw); ctx.lineTo(da.x + ux * al - px * aw, da.y + uy * al - py * aw); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(db.x, db.y); ctx.lineTo(db.x - ux * al + px * aw, db.y - uy * al + py * aw); ctx.lineTo(db.x - ux * al - px * aw, db.y - uy * al - py * aw); ctx.closePath(); ctx.fill();
    }
    // texte : CENTRÉ sur la ligne (dans le trou) ou juste au-dessus si e.textPos==='above'
    ctx.translate(mid.x, mid.y);
    ctx.rotate(-g.angleDeg * Math.PI / 180);
    ctx.textAlign = 'center';
    if (inline && gapFits) { ctx.textBaseline = 'middle'; ctx.fillText(g.text, 0, 0); }
    else { ctx.textBaseline = 'bottom'; ctx.fillText(g.text, 0, -0.35 * fs); }
    ctx.restore();
  };

  // Texte annotation (hauteur en mm RÉELS -> suit le zoom et l'échelle d'impression)
  // Alignement : e.align = left|center|right (horizontal), e.valign = top|middle|bottom (vertical).
  // Zone : si e.zone, e.points[0]/[1] = coins du rectangle ; le texte s'aligne DANS la zone.
  R.drawText = function (ctx, view, e, colOverride, fallback) {
    if (!e.points || !e.points.length || !e.text) return;
    // Taille À L'ÉCHELLE DU PLAN (comme un trait) : hauteur réelle × zoom, SANS plancher
    // visible. L'ancien plancher de 5 px « gonflait » le texte quand on dézoomait (il
    // restait à 5 px pendant que le dessin rétrécissait). Plancher ramené à 1 px (sous le
    // seuil lisible) -> le texte grossit/rétrécit proportionnellement au zoom. Le PDF, lui,
    // utilise la taille réelle en mm (inchangé).
    const px = Math.max(1, (e.hMm || 800) * view.pxPerMm), lineH = px * 1.2;
    const lines = String(e.text).split('\n'), totalH = lines.length * lineH;
    const align = e.align || 'left', valign = e.valign || 'top';
    ctx.save();
    ctx.fillStyle = R._adapt(colOverride || e.color || fallback || '#e8ebf2');
    ctx.font = '600 ' + px + 'px ' + (e.font || 'system-ui,Segoe UI,sans-serif');
    ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
    ctx.textBaseline = 'alphabetic';
    if (e.zone && e.points.length >= 2) {
      const a = R.worldToScreen(view, e.points[0].x, e.points[0].y), b = R.worldToScreen(view, e.points[1].x, e.points[1].y);
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const ax = align === 'center' ? (x0 + x1) / 2 : align === 'right' ? x1 : x0;
      const topY = valign === 'middle' ? (y0 + y1) / 2 - totalH / 2 : valign === 'bottom' ? (y1 - totalH) : y0;
      lines.forEach((ln, i) => ctx.fillText(ln, ax, topY + px + i * lineH));
    } else {
      const s = R.worldToScreen(view, e.points[0].x, e.points[0].y);
      ctx.translate(s.x, s.y); if (e.angleDeg) ctx.rotate(-e.angleDeg * Math.PI / 180);
      const topOff = valign === 'middle' ? -totalH / 2 : valign === 'bottom' ? -totalH : 0;
      lines.forEach((ln, i) => ctx.fillText(ln, 0, topOff + px + i * lineH));
    }
    ctx.restore();
  };

  // Image de fond (calque PDF/plan importé) : points = [coin bas-gauche, coin haut-droit]
  R._imgCache = {};
  R.drawImage = function (ctx, view, e) {
    if (!e.src || !e.points || e.points.length < 2) return;
    let img = R._imgCache[e.src];
    if (!img) { img = new Image(); img.onload = () => { if (typeof R.onImageLoad === 'function') R.onImageLoad(); }; img.src = e.src; R._imgCache[e.src] = img; }
    if (!img.complete || !img.naturalWidth) return;
    const a = R.worldToScreen(view, e.points[0].x, e.points[0].y), b = R.worldToScreen(view, e.points[1].x, e.points[1].y);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.save(); ctx.globalAlpha = e.opacity != null ? e.opacity : 1; try { ctx.drawImage(img, x, y, w, h); } catch (err) { } ctx.restore();
  };

  // Lignes parallèles couvrant un rectangle, à un angle donné
  function hatchLines(ctx, minx, miny, maxx, maxy, sp, angDeg) {
    const a = angDeg * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
    const nx = -dy, ny = dx, cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    const diag = Math.hypot(maxx - minx, maxy - miny) || 1;
    const n = Math.ceil(diag / sp) + 2;
    ctx.beginPath();
    for (let i = -n; i <= n; i++) {
      const ox = cx + nx * i * sp, oy = cy + ny * i * sp;
      ctx.moveTo(ox - dx * diag, oy - dy * diag);
      ctx.lineTo(ox + dx * diag, oy + dy * diag);
    }
    ctx.stroke();
  }
  // Motif "tuiles" : rangées horizontales + joints verticaux décalés
  function hatchTiles(ctx, minx, miny, maxx, maxy, sp) {
    const h = sp, w = sp * 1.6;
    ctx.beginPath();
    let row = 0;
    for (let y = miny; y <= maxy + h; y += h) {
      ctx.moveTo(minx, y); ctx.lineTo(maxx, y);
      const off = (row % 2) * (w / 2);
      for (let x = minx + off; x <= maxx; x += w) { ctx.moveTo(x, y); ctx.lineTo(x, y + h); }
      row++;
    }
    ctx.stroke();
  }
  // Motif « tuiles » (toiture) : rangées d'écailles (demi-cercles) décalées -> effet tuile.
  function hatchRoof(ctx, minx, miny, maxx, maxy, sp) {
    const r = Math.max(4, sp * 0.55);
    ctx.beginPath();
    let row = 0;
    for (let y = miny; y <= maxy + r; y += r) {
      const off = (row % 2) ? r : 0;
      for (let x = minx - r + off; x <= maxx + r; x += 2 * r) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI, false); }
      row++;
    }
    ctx.stroke();
  }

  // Motif « pierre » (moellons de soubassement) : rangées décalées de pierres
  // irrégulières (quasi-aléatoires mais DÉTERMINISTES -> stables au rafraîchissement).
  // Rend une liste de polygones {x,y} dans l'espace (minx..maxy) reçu ; partagé par
  // l'écran (render), le PDF (export) et l'aperçu (panneau).
  function _h2(i, j) { const n = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return n - Math.floor(n); }
  function hatchStone(minx, miny, maxx, maxy, sp) {
    const out = [], rowH = Math.max(4, sp), mg = sp * 0.14;
    let row = 0;
    for (let y = miny; y < maxy + rowH; y += rowH, row++) {
      const off = (_h2(row, 2.3) - 0.5) * sp * 0.7;          // décalage de rangée
      let x = minx - sp + off, col = 0;
      while (x < maxx + sp) {
        const w = sp * (0.9 + _h2(row, col) * 0.9);          // largeur 0.9..1.8 sp
        const x0 = x + mg, x1 = x + w - mg, y0 = y + mg, y1 = y + rowH - mg;
        if (x1 > x0 && y1 > y0) {
          const jx = sp * 0.18, jy = rowH * 0.16, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
          const r = (a, b) => (_h2(row * 31 + a, col * 17 + b) - 0.5);
          out.push([
            { x: x0 + r(1, 1) * jx, y: y0 + r(1, 2) * jy },
            { x: mx + r(1, 3) * jx, y: y0 + r(1, 4) * jy * 0.7 },
            { x: x1 + r(1, 5) * jx, y: y0 + r(1, 6) * jy },
            { x: x1 + r(1, 7) * jx * 0.7, y: my + r(1, 8) * jy },
            { x: x1 + r(1, 9) * jx, y: y1 + r(1, 10) * jy },
            { x: mx + r(1, 11) * jx, y: y1 + r(1, 12) * jy * 0.7 },
            { x: x0 + r(1, 13) * jx, y: y1 + r(1, 14) * jy },
            { x: x0 + r(1, 15) * jx * 0.7, y: my + r(1, 16) * jy }
          ]);
        }
        x += w; col++;
      }
    }
    return out;
  }

  // Hachure d'une zone fermée (clip au contour puis motif)
  R.drawHatch = function (ctx, view, e, fallback) {
    if (!e.points || e.points.length < 3) return;
    const col = R._adapt(e.color || fallback || '#8892b0');
    const pts = e.points.map(p => R.worldToScreen(view, p.x, p.y));
    ctx.save();
    // Contour + ÎLOTS (trous) -> découpe en règle "evenodd" : la hachure contourne
    // les zones fermées intérieures (fenêtres…) au lieu de les recouvrir.
    ctx.beginPath(); pts.forEach((s, i) => i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y)); ctx.closePath();
    if (e.holes && e.holes.length) for (const h of e.holes) { if (h.length < 3) continue; const hp = h.map(p => R.worldToScreen(view, p.x, p.y)); hp.forEach((s, i) => i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y)); ctx.closePath(); }
    ctx.clip('evenodd');
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    pts.forEach(s => { if (s.x < minx) minx = s.x; if (s.y < miny) miny = s.y; if (s.x > maxx) maxx = s.x; if (s.y > maxy) maxy = s.y; });
    const sp = Math.max(4, (e.spacingMm || 300) * view.pxPerMm);
    if (e.pattern === 'solid') { ctx.globalAlpha = 0.85; ctx.fillStyle = col; ctx.fillRect(minx, miny, maxx - minx, maxy - miny); }
    else {
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      const p = e.pattern;
      if (p === 'briques' || p === 'tiles') hatchTiles(ctx, minx, miny, maxx, maxy, sp);   // 'tiles' = ancien nom des briques (compat)
      else if (p === 'pierre') { const polys = hatchStone(minx, miny, maxx, maxy, sp); ctx.beginPath(); for (const poly of polys) { poly.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.closePath(); } ctx.stroke(); }
      else if (p === 'tuiles') hatchRoof(ctx, minx, miny, maxx, maxy, sp);
      else if (p === 'vert') hatchLines(ctx, minx, miny, maxx, maxy, sp, 90);
      else if (p === 'horiz') hatchLines(ctx, minx, miny, maxx, maxy, sp, 0);
      else { hatchLines(ctx, minx, miny, maxx, maxy, sp, e.angleDeg || 45); if (p === 'cross') hatchLines(ctx, minx, miny, maxx, maxy, sp, (e.angleDeg || 45) + 90); }
    }
    ctx.restore();
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.render = R;
  root.QCAD.hatchStone = hatchStone;   // partagé avec export PDF + aperçu panneau
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
