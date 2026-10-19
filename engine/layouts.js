/* QlygoCAD — engine/layouts.js
 * Mises en page (cartouches) dessinées en ESPACE PAPIER (mm, origine en haut-gauche).
 * Reproduit fidèlement la maquette DP (en-tête, bandes AVANT/APRÈS, boussoles,
 * échelles graphiques, légende, cartouche « emprise au sol », pied de page, logos).
 * Les ZONES DE PLAN sont laissées BLANCHES : l'utilisateur y insère ses propres plans.
 */
(function (root) {
  const NAVY = '#07367e', GRAY = '#555555';
  const imgCache = {};
  function img(src, onload) {
    let im = imgCache[src];
    if (!im) { im = new Image(); im.onload = () => { if (typeof onload === 'function') onload(); }; im.src = src; imgCache[src] = im; }
    return im;
  }

  function text(ctx, s, x, y, px, color, weight, align, family) {
    ctx.fillStyle = color; ctx.font = (weight || '600') + ' ' + px + 'px ' + (family || 'system-ui,Segoe UI,Arial,sans-serif');
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, y);
  }

  function compass(ctx, cx, cy, r, u) {
    ctx.save();
    ctx.strokeStyle = '#333'; ctx.lineWidth = Math.max(1, 0.25 * u); ctx.fillStyle = 'none';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    // aiguille Nord : flèche verticale, moitié foncée / moitié claire
    ctx.fillStyle = '#20242e'; ctx.beginPath(); ctx.moveTo(cx, cy - r * 0.92); ctx.lineTo(cx + r * 0.16, cy + r * 0.05); ctx.lineTo(cx, cy - r * 0.08); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#8a8f99'; ctx.beginPath(); ctx.moveTo(cx, cy - r * 0.92); ctx.lineTo(cx - r * 0.16, cy + r * 0.05); ctx.lineTo(cx, cy - r * 0.08); ctx.closePath(); ctx.fill();
    // petite pointe Sud grise
    ctx.fillStyle = '#b9bdc6'; ctx.beginPath(); ctx.moveTo(cx, cy + r * 0.08); ctx.lineTo(cx + r * 0.11, cy + r * 0.5); ctx.lineTo(cx, cy + r * 0.6); ctx.lineTo(cx - r * 0.11, cy + r * 0.5); ctx.closePath(); ctx.fill();
    // lettres
    ctx.fillStyle = '#20242e'; ctx.font = '600 ' + (2.6 * u) + 'px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - r - 2.4 * u); ctx.fillText('S', cx, cy + r + 2.4 * u);
    ctx.fillText('E', cx + r + 2.4 * u, cy); ctx.fillText('O', cx - r - 2.4 * u, cy);
    ctx.restore();
  }

  // échelle graphique 0..totalM mètres à 1:denom, origine (x0mm,ymm) en papier
  function scaleBar(ctx, T, u, x0mm, ymm, totalM, denom, label) {
    const mmPerM = 1000 / denom, seg = 10, h = 2.2;
    ctx.save();
    for (let i = 0; i < totalM / seg; i++) {
      const a = T(x0mm + i * seg * mmPerM, ymm), b = T(x0mm + (i + 1) * seg * mmPerM, ymm + h);
      ctx.fillStyle = (i % 2 === 0) ? NAVY : '#ffffff'; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = NAVY; ctx.lineWidth = 1; ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
    ctx.fillStyle = '#20242e'; ctx.font = '600 ' + (2.4 * u) + 'px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let m = 0; m <= totalM; m += 20) { const p = T(x0mm + m * mmPerM, ymm + h + 0.6); ctx.fillText(m === totalM ? (m + ' m') : ('' + m), p.x, p.y); }
    if (label) { const p = T(x0mm + totalM * mmPerM, ymm - 1.4); text(ctx, label, p.x, p.y, 3 * u, NAVY, '700', 'right'); }
    ctx.restore();
  }

  // Descripteur DP02 (Plan de masse) — A4 portrait.
  const dp02 = {
    name: 'DP02 — Plan de masse',
    paper: 'A4', orientation: 'portrait',
    // fenêtres de plan laissées blanches (mm papier, origine haut-gauche)
    planWindows: [{ x: 3, y: 42, w: 204, h: 104 }, { x: 3, y: 179, w: 204, h: 98 }],
    defaults: { client: 'Mme CAZEAUX Nicole', dpNum: 'DP 2', dpTitle: 'Plan masse', scaleDenom: 500, empAvant: '67.80', empApres: '70.36', empCreee: '2.56', footer: 'Les travaux projetés (I.T.E.) ne modifient pas les hauteurs de la maison.' },
    // T(xmm,ymm) -> {x,y} écran ; u = px par mm papier ; d = données du cartouche ; repaint = callback
    draw: function (ctx, T, u, d, repaint) {
      d = Object.assign({}, dp02.defaults, d || {});
      const W = 210;
      // ---- En-tête ----
      text(ctx, 'INFORMATIONS  CLIENT', T(45, 8.5).x, T(45, 8.5).y, 4.6 * u, NAVY, '700', 'center');
      text(ctx, d.client, T(45, 14.5).x, T(45, 14.5).y, 4.0 * u, NAVY, '500', 'center');
      text(ctx, d.dpNum, T(105, 10).x, T(105, 10).y, 8.5 * u, NAVY, '800', 'center');
      text(ctx, d.dpTitle, T(105, 16.5).x, T(105, 16.5).y, 4.2 * u, NAVY, '500', 'center');
      // logos (chargés de façon asynchrone -> repeindre quand prêts)
      const izi = img('assets/dp02-izi.png?v=34', repaint), qly = img('assets/dp02-qlygo.png?v=34', repaint);
      if (izi.complete && izi.naturalWidth) { const a = T(162, 3), s = 17 * u; ctx.drawImage(izi, a.x, a.y, s, s); }
      if (qly.complete && qly.naturalWidth) { const a = T(185, 4), w = 17 * u, h = w * 235 / 269; ctx.drawImage(qly, a.x, a.y, w, h); }
      // ---- Bandes AVANT / APRÈS ----
      function band(label, y0, y1) {
        const a = T(2, y0), b = T(208, y1); ctx.fillStyle = NAVY; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        text(ctx, label, T(105, (y0 + y1) / 2 + 3).x, T(105, (y0 + y1) / 2 + 3).y, 9 * u, '#ffffff', '800', 'center');
      }
      band('AVANT', 22.5, 41.3);
      band('APRES', 159.4, 178.4);
      // ---- Boussoles ----
      compass(ctx, T(196, 58).x, T(196, 58).y, 9 * u, u);
      compass(ctx, T(196, 196).x, T(196, 196).y, 9 * u, u);
      // ---- Échelles graphiques ----
      scaleBar(ctx, T, u, 3, 147.5, 100, d.scaleDenom, 'ECH 1:' + d.scaleDenom);
      scaleBar(ctx, T, u, 3, 279, 100, d.scaleDenom, 'ECH 1:' + d.scaleDenom);
      // ---- Légende (zone APRÈS) ----
      (function legend() {
        const y = 184, x = 6, rr = 1.4 * u;
        let p = T(x, y); ctx.fillStyle = '#1b5cff'; ctx.beginPath(); ctx.arc(p.x, p.y - rr, rr, 0, 7); ctx.fill();
        text(ctx, 'ISOLANT', T(x + 3, y).x, T(x + 3, y).y, 3.4 * u, '#20242e', '500', 'left');
        p = T(x + 26, y); ctx.fillStyle = '#20c030'; ctx.beginPath(); ctx.arc(p.x, p.y - rr, rr, 0, 7); ctx.fill();
        text(ctx, 'ENDUIT SIMPLE', T(x + 29, y).x, T(x + 29, y).y, 3.4 * u, '#20242e', '500', 'left');
      })();
      // ---- Cartouche « emprise au sol » ----
      (function emprise() {
        const a = T(5, 224), b = T(42, 243);
        ctx.strokeStyle = NAVY; ctx.lineWidth = Math.max(1, 0.3 * u); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        text(ctx, 'EMPRISE AU SOL', T(6.5, 228.5).x, T(6.5, 228.5).y, 3.2 * u, NAVY, '700', 'left');
        text(ctx, 'Avant travaux : ' + d.empAvant + ' m2', T(6.5, 232.8).x, T(6.5, 232.8).y, 2.9 * u, NAVY, '500', 'left');
        text(ctx, 'Apres travaux : ' + d.empApres + ' m2', T(6.5, 236.6).x, T(6.5, 236.6).y, 2.9 * u, NAVY, '500', 'left');
        text(ctx, 'Creee : ' + d.empCreee + ' m2', T(6.5, 240.4).x, T(6.5, 240.4).y, 2.9 * u, NAVY, '500', 'left');
      })();
      // ---- Pied de page ----
      text(ctx, d.footer, T(105, 291).x, T(105, 291).y, 3.4 * u, GRAY, '500', 'center');
      // ---- Marque des ZONES DE PLAN (blanches, repère léger pour l'édition) ----
      ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = '#c3ccda'; ctx.lineWidth = 1; ctx.fillStyle = 'rgba(150,165,190,.5)'; ctx.font = (3.2 * u) + 'px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      dp02.planWindows.forEach(w => { const a = T(w.x, w.y), b = T(w.x + w.w, w.y + w.h); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.fillText('zone plan — insérez votre plan ici', (a.x + b.x) / 2, (a.y + b.y) / 2); });
      ctx.restore();
    }
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.layouts = { dp02 };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QCAD.layouts;
})(typeof window !== 'undefined' ? window : globalThis);
