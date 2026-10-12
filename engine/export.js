/* QlygoCAD — engine/export.js
 * Transforme une SCÈNE (mm réels) en PDF papier à l'ÉCHELLE demandée.
 * C'est ICI que l'échelle 1:denom est appliquée. Le reste du moteur l'ignore.
 */
(function (root) {
  const QCAD = root.QCAD = root.QCAD || {};
  const U = QCAD.units || require('./units');
  const PDF = QCAD.pdf || require('./pdf');
  const GEO = QCAD.geometry || require('./geometry');

  /* opts:
   *   scaleDenom : 100  (=> 1:100)
   *   paper      : 'A4' | 'A3'
   *   orientation: 'portrait' | 'landscape'
   *   marginMm   : marge papier autour du cadre (défaut 10)
   *   title      : texte du cartouche (ASCII)
   *   showRuler  : true -> dessine un segment-témoin d'1 m + étiquette
   */
  QCAD.exportPdf = function (scene, opts) {
    opts = opts || {};
    const denom = opts.scaleDenom || 100;
    const paper = U.PAPER[opts.paper || 'A4'];
    const landscape = opts.orientation === 'landscape';
    const pageMmW = landscape ? paper.h : paper.w;
    const pageMmH = landscape ? paper.w : paper.h;
    const margin = opts.marginMm != null ? opts.marginMm : 10;

    const wPt = U.mmToPt(pageMmW);
    const hPt = U.mmToPt(pageMmH);
    const doc = new PDF.PdfDoc(wPt, hPt);
    const page = doc.page;

    // Position réelle (mm) -> point PDF.
    // On place l'origine scène (0,0) à la marge bas-gauche. Y vers le haut (même repère).
    function X(realMm) { return U.mmToPt(margin + realMm / denom); }
    function Y(realMm) { return U.mmToPt(margin + realMm / denom); }

    // Cadre du dessin (bord de page - marge)
    page.polyline([
      { x: U.mmToPt(margin), y: U.mmToPt(margin) },
      { x: U.mmToPt(pageMmW - margin), y: U.mmToPt(margin) },
      { x: U.mmToPt(pageMmW - margin), y: U.mmToPt(pageMmH - margin) },
      { x: U.mmToPt(margin), y: U.mmToPt(pageMmH - margin) }
    ], '#9aa6bf', 0.5, true);

    // Entités de la scène
    for (const e of scene.entities) {
      if (e.type === 'dim') { drawDimPdf(page, e, X, Y); continue; }
      const pts = e.points.map(p => ({ x: X(p.x), y: Y(p.y) }));
      page.polyline(pts, plotColor(e.color || '#1b2b4b'), U.mmToPt(e.penMm != null ? e.penMm : 0.25), e.closed);
    }

    // Cartouche bas + échelle
    const base = U.mmToPt(margin + 1.5);
    page.text(base, U.mmToPt(margin + 3), 8, (opts.title || 'QlygoCAD') + '   -   Echelle 1:' + denom + '   -   ' + (opts.paper || 'A4'), '#44506b');

    // Segment-témoin : 1 m réel -> (1000/denom) mm papier. À 1:100 => 10 mm, mesurable à la règle.
    if (opts.showRuler !== false) {
      const paperMm = 1000 / denom; // longueur papier du témoin, en mm
      const x1 = U.mmToPt(pageMmW - margin - 4);
      const x0 = x1 - U.mmToPt(paperMm);
      const yR = U.mmToPt(margin + 4);
      page.polyline([{ x: x0, y: yR }, { x: x1, y: yR }], '#c0392b', 0.7, false);
      // petits traits verticaux aux extrémités
      page.polyline([{ x: x0, y: yR - U.mmToPt(1.2) }, { x: x0, y: yR + U.mmToPt(1.2) }], '#c0392b', 0.7, false);
      page.polyline([{ x: x1, y: yR - U.mmToPt(1.2) }, { x: x1, y: yR + U.mmToPt(1.2) }], '#c0392b', 0.7, false);
      // étiquette alignée à droite sur le témoin (largeur approx. du texte en pt)
      const label = '1 m = ' + (Math.round(paperMm * 10) / 10) + ' mm (regle)';
      const approxW = label.length * 3.6; // ~largeur moyenne Helvetica 7pt
      page.text(Math.max(U.mmToPt(margin), x1 - approxW), yR + U.mmToPt(2), 7, label, '#c0392b');
    }

    return doc;
  };

  // Convention de tracé : un trait très clair (dessiné en clair sur l'espace objet
  // sombre, comme AutoCAD) devient NOIR sur le papier blanc.
  function plotColor(hex) {
    const c = PDF.hexRgb(hex);
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return lum > 0.82 ? '#000000' : hex;
  }

  // Dessin d'une cotation sur le PDF (décorations en taille PAPIER constante)
  function drawDimPdf(page, e, X, Y) {
    const g = GEO.dimGeometry(e);
    const col = e.color || '#b9375e';
    const P = p => ({ x: X(p.x), y: Y(p.y) });
    const da = P(g.da), db = P(g.db);
    page.polyline([P(g.extA[0]), P(g.extA[1])], col, U.mmToPt(0.2));
    page.polyline([P(g.extB[0]), P(g.extB[1])], col, U.mmToPt(0.2));
    page.polyline([da, db], col, U.mmToPt(0.2));
    // ticks d'architecte (2 mm papier, obliques à 45°)
    const tang = Math.atan2(g.along.y, g.along.x) + Math.PI / 4;
    const tl = U.mmToPt(2), tx = Math.cos(tang) * tl, ty = Math.sin(tang) * tl;
    page.polyline([{ x: da.x - tx, y: da.y - ty }, { x: da.x + tx, y: da.y + ty }], col, U.mmToPt(0.3));
    page.polyline([{ x: db.x - tx, y: db.y - ty }, { x: db.x + tx, y: db.y + ty }], col, U.mmToPt(0.3));
    // texte centré, décalé vers l'extérieur
    const mid = P(g.mid), size = U.mmToPt(e.textMm || 2.5);
    const u = (e.offMm || 0) >= 0 ? 1 : -1, gap = U.mmToPt(1.2);
    const approx = g.text.length * size * 0.5;
    page.text(mid.x - approx / 2 + g.normal.x * u * gap, mid.y + g.normal.y * u * gap, size, g.text, col);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { exportPdf: QCAD.exportPdf };
})(typeof window !== 'undefined' ? window : globalThis);
