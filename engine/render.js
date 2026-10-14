/* QlygoCAD — engine/render.js
 * Rendu Canvas d'une scène (mm réels). Dépend du Canvas mais PAS d'Electron.
 * "view" décrit la caméra écran ; l'échelle d'impression n'intervient pas ici
 * (à l'écran on zoome librement, comme dans un vrai logiciel de CAO).
 */
(function (root) {
  const R = {};
  R._adapt = c => c;

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
    // Inversion façon AutoCAD de la couleur 7 (blanc<->noir) selon la clarté du fond.
    const bl = (h => { h = (h || '#000').replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; })(bg);
    const bgLight = bl > 0.5;
    R._adapt = c => bgLight ? (c === '#ffffff' || c === '#fff' || c === '#e8ebf2' ? '#000000' : c) : (c === '#000000' || c === '#000' ? '#ffffff' : c);

    // --- Grille (tous les gridStepMm, gras tous les 5) ---
    if (opts.grid !== false) {
      const step = opts.gridStepMm || 1000;
      const w0 = R.screenToWorld(view, 0, H), w1 = R.screenToWorld(view, W, 0);
      const startX = Math.floor(w0.x / step) * step, endX = Math.ceil(w1.x / step) * step;
      const startY = Math.floor(w0.y / step) * step, endY = Math.ceil(w1.y / step) * step;
      let idx;
      for (let x = startX; x <= endX; x += step) {
        idx = Math.round(x / step);
        const s = R.worldToScreen(view, x, 0);
        ctx.strokeStyle = (idx % 5 === 0) ? gMaj : gMin;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, H); ctx.stroke();
      }
      for (let y = startY; y <= endY; y += step) {
        idx = Math.round(y / step);
        const s = R.worldToScreen(view, 0, y);
        ctx.strokeStyle = (idx % 5 === 0) ? gMaj : gMin;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(W, s.y); ctx.stroke();
      }
    }

    // --- Axes X / Y (origine 0,0), discrets ---
    if (opts.axes !== false) {
      const o = R.worldToScreen(view, 0, 0);
      ctx.lineWidth = 1;
      ctx.strokeStyle = th.axisXLine || (dark ? '#5e3b45' : '#f3c9d4');
      ctx.beginPath(); ctx.moveTo(0, o.y); ctx.lineTo(W, o.y); ctx.stroke(); // X
      ctx.strokeStyle = th.axisYLine || (dark ? '#2f4e3d' : '#c9e8d6');
      ctx.beginPath(); ctx.moveTo(o.x, 0); ctx.lineTo(o.x, H); ctx.stroke(); // Y
    }

    // --- Entités (hachures en fond, puis traits, puis cotes) ---
    const lcMap = {}; if (scene.layers) for (const l of scene.layers) lcMap[l.id] = l.color;
    const layerColor = id => lcMap[id] || null;
    // Fenêtre monde visible (pour le "culling" : on ignore ce qui est hors écran)
    const wx0 = view.panXmm, wy0 = view.panYmm, wx1 = view.panXmm + W / view.pxPerMm, wy1 = view.panYmm + H / view.pxPerMm;
    const vis = e => { const b = R._bbox(e); return !(b[2] < wx0 || b[0] > wx1 || b[3] < wy0 || b[1] > wy1); };
    // Images de fond + hachures (peu nombreuses), avec culling
    for (const e of scene.entities) if (e.type === 'image' && vis(e)) R.drawImage(ctx, view, e);
    for (const e of scene.entities) if (e.type === 'hatch' && vis(e)) R.drawHatch(ctx, view, e, layerColor(e.layer));
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
      if (e.dash) { R.drawEntity(ctx, view, e); continue; }   // traits spéciaux : individuels
      const col = e.color || layerColor(e.layer) || '#1b2b4b';
      const w = Math.max(1, (e.penMm || 0.25) * 3), key = col + '|' + w;
      let g = groups.get(key); if (!g) { g = { col, w, list: [] }; groups.set(key, g); }
      g.list.push(e);
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
    for (const g of groups.values()) {
      ctx.strokeStyle = R._adapt(g.col); ctx.lineWidth = g.w; ctx.beginPath();
      for (const e of g.list) {
        const p = e.points; if (!p.length) continue;
        let s = R.worldToScreen(view, p[0].x, p[0].y); ctx.moveTo(s.x, s.y);
        for (let i = 1; i < p.length; i++) { s = R.worldToScreen(view, p[i].x, p[i].y); ctx.lineTo(s.x, s.y); }
        if (e.closed) ctx.closePath();
      }
      ctx.stroke();
    }
    for (const e of dims) R.drawDim(ctx, view, e, false, layerColor(e.layer));
    for (const e of texts) R.drawText(ctx, view, e, null, layerColor(e.layer));
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
      else if (e.points && e.points.length) { ctx.beginPath(); e.points.forEach((p, i) => { const s = R.worldToScreen(view, p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); if (e.closed) ctx.closePath(); ctx.stroke(); }
      ctx.restore();
    }
    // --- Survol de l'outil Hachures : zone fermée proposée (contour orange) ---
    if (opts.hatchHover && opts.hatchHover.points) {
      ctx.save(); ctx.strokeStyle = '#eda020'; ctx.lineWidth = 2.5; ctx.globalAlpha = .8;
      ctx.beginPath(); opts.hatchHover.points.forEach((p, i) => { const s = R.worldToScreen(view, p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.closePath(); ctx.stroke(); ctx.restore();
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
          ctx.fillStyle = '#1e90ff'; ctx.fillRect(c.x - 3, c.y - 3, 6, 6);
          continue;
        }
        ctx.strokeStyle = '#1e90ff'; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
        ctx.beginPath();
        e.points.forEach((p, i) => { const s = R.worldToScreen(view, p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
        if (e.closed) ctx.closePath();
        ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#1e90ff';
        e.points.forEach(p => { const s = R.worldToScreen(view, p.x, p.y); ctx.fillRect(s.x - 3, s.y - 3, 6, 6); });
        // poignée centrale (déplace tout le trait) pour une ligne simple
        if (e.type !== 'dim' && e.type !== 'hatch' && e.points.length === 2) {
          const m = { x: (e.points[0].x + e.points[1].x) / 2, y: (e.points[0].y + e.points[1].y) / 2 };
          const s = R.worldToScreen(view, m.x, m.y); ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
        }
        // poignée de décalage de la cote (déplace la ligne de cote)
        if (e.type === 'dim') { const g = root.QCAD.geometry.dimGeometry(e); const s = R.worldToScreen(view, g.mid.x, g.mid.y); ctx.fillRect(s.x - 3, s.y - 3, 6, 6); }
      }
      // poignée "chaude" (en cours de déplacement) en rouge
      if (opts.hotGrip) { const s = R.worldToScreen(view, opts.hotGrip.x, opts.hotGrip.y); ctx.fillStyle = '#e53e3e'; ctx.fillRect(s.x - 4, s.y - 4, 8, 8); }
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
    } else {                              // grille : petit losange
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
      ctx.closePath(); ctx.stroke();
    }
    ctx.restore();
  };

  R.drawEntity = function (ctx, view, e, colOverride) {
    if (!e.points.length) return;
    ctx.strokeStyle = R._adapt(colOverride || e.color || '#1b2b4b');
    // épaisseur écran : au moins 1 px, sinon proportionnelle au pen papier * zoom indicatif
    ctx.lineWidth = Math.max(1, (e.penMm || 0.25) * 3);
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

  // Cotation à l'écran (ticks d'architecte + texte)
  R.drawDim = function (ctx, view, e, preview, fallback) {
    const fmt = (e.dec != null) ? (mm => (mm / 1000).toFixed(e.dec).replace('.', ',') + ' m') : null;
    const g = root.QCAD.geometry.dimGeometry(e, fmt);
    const col = R._adapt(preview ? '#eda020' : (e.color || fallback || '#b9375e'));
    const toS = p => R.worldToScreen(view, p.x, p.y);
    const da = toS(g.da), db = toS(g.db);
    const eA0 = toS(g.extA[0]), eA1 = toS(g.extA[1]);
    const eB0 = toS(g.extB[0]), eB1 = toS(g.extB[1]);
    ctx.save();
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    if (preview) ctx.setLineDash([5, 4]);
    // lignes d'attache
    ctx.beginPath(); ctx.moveTo(eA0.x, eA0.y); ctx.lineTo(eA1.x, eA1.y);
    ctx.moveTo(eB0.x, eB0.y); ctx.lineTo(eB1.x, eB1.y); ctx.stroke();
    // ligne de cote
    ctx.beginPath(); ctx.moveTo(da.x, da.y); ctx.lineTo(db.x, db.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1.6;
    if (e.arrow === 'tick') {
      // ticks d'architecte (obliques à 45°) aux deux extrémités
      const ang = Math.atan2(db.y - da.y, db.x - da.x) + Math.PI / 4;
      const t = 6, cx = Math.cos(ang) * t, cy = Math.sin(ang) * t;
      ctx.beginPath();
      ctx.moveTo(da.x - cx, da.y - cy); ctx.lineTo(da.x + cx, da.y + cy);
      ctx.moveTo(db.x - cx, db.y - cy); ctx.lineTo(db.x + cx, db.y + cy);
      ctx.stroke();
    } else {
      // flèches pleines pointant vers l'extérieur (look AutoCAD)
      const L = Math.hypot(db.x - da.x, db.y - da.y) || 1, ux = (db.x - da.x) / L, uy = (db.y - da.y) / L, px = -uy, py = ux;
      const al = 9, aw = 3.2;   // longueur / demi-largeur de la flèche (px écran)
      ctx.beginPath(); ctx.moveTo(da.x, da.y); ctx.lineTo(da.x + ux * al + px * aw, da.y + uy * al + py * aw); ctx.lineTo(da.x + ux * al - px * aw, da.y + uy * al - py * aw); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(db.x, db.y); ctx.lineTo(db.x - ux * al + px * aw, db.y - uy * al + py * aw); ctx.lineTo(db.x - ux * al - px * aw, db.y - uy * al - py * aw); ctx.closePath(); ctx.fill();
    }
    // texte au milieu, lisible
    const mid = toS(g.mid);
    ctx.translate(mid.x, mid.y);
    ctx.rotate(-g.angleDeg * Math.PI / 180);
    const fs = Math.max(9, Math.round(12 * ((e.textMm || 2.5) / 2.5)));
    ctx.font = '600 ' + fs + 'px system-ui,Segoe UI,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(g.text, 0, -3);
    ctx.restore();
  };

  // Texte annotation (hauteur en mm RÉELS -> suit le zoom et l'échelle d'impression)
  R.drawText = function (ctx, view, e, colOverride, fallback) {
    if (!e.points || !e.points.length || !e.text) return;
    const s = R.worldToScreen(view, e.points[0].x, e.points[0].y);
    const px = Math.max(5, (e.hMm || 800) * view.pxPerMm);
    ctx.save();
    ctx.fillStyle = R._adapt(colOverride || e.color || fallback || '#e8ebf2');
    ctx.translate(s.x, s.y);
    if (e.angleDeg) ctx.rotate(-e.angleDeg * Math.PI / 180);
    ctx.font = '600 ' + px + 'px ' + (e.font || 'system-ui,Segoe UI,sans-serif');
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    String(e.text).split('\n').forEach((line, i) => ctx.fillText(line, 0, i * px * 1.2));
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

  // Hachure d'une zone fermée (clip au contour puis motif)
  R.drawHatch = function (ctx, view, e, fallback) {
    if (!e.points || e.points.length < 3) return;
    const col = R._adapt(e.color || fallback || '#8892b0');
    const pts = e.points.map(p => R.worldToScreen(view, p.x, p.y));
    ctx.save();
    ctx.beginPath(); pts.forEach((s, i) => i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y)); ctx.closePath(); ctx.clip();
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    pts.forEach(s => { if (s.x < minx) minx = s.x; if (s.y < miny) miny = s.y; if (s.x > maxx) maxx = s.x; if (s.y > maxy) maxy = s.y; });
    const sp = Math.max(4, (e.spacingMm || 300) * view.pxPerMm);
    if (e.pattern === 'solid') { ctx.globalAlpha = 0.85; ctx.fillStyle = col; ctx.fillRect(minx, miny, maxx - minx, maxy - miny); }
    else {
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      if (e.pattern === 'tiles') hatchTiles(ctx, minx, miny, maxx, maxy, sp);
      else { hatchLines(ctx, minx, miny, maxx, maxy, sp, e.angleDeg || 45); if (e.pattern === 'cross') hatchLines(ctx, minx, miny, maxx, maxy, sp, (e.angleDeg || 45) + 90); }
    }
    ctx.restore();
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.render = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
