/* QlygoCAD — engine/pdf.js
 * Générateur PDF VECTORIEL minimal, écrit à la main, SANS aucune librairie.
 * But : un PDF dont les traits se mesurent exactement à la règle.
 * Unité du PDF = le point (1/72 pouce). Origine en bas à gauche, Y vers le haut.
 * Tout le contenu est en ASCII -> comptage d'octets fiable, pas de compression.
 */
(function (root) {
  function num(n) { return (Math.round(n * 1000) / 1000).toString(); }
  function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
  // Longueur en OCTETS d'une chaîne ASCII (on garde le contenu ASCII volontairement)
  function byteLen(s) { return s.length; }

  // #RRGGBB -> [r,g,b] normalisés 0..1
  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000');
    if (!m) return [0, 0, 0];
    const v = parseInt(m[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  function PdfPage(wPt, hPt) {
    this.w = wPt; this.h = hPt; this.ops = [];
    this._color = null; this._width = null;
  }
  PdfPage.prototype._setStroke = function (hex, wpt) {
    if (hex !== this._color) {
      const c = hexRgb(hex);
      this.ops.push(num(c[0]) + ' ' + num(c[1]) + ' ' + num(c[2]) + ' RG');
      this._color = hex;
    }
    if (wpt !== this._width) {
      this.ops.push(num(wpt) + ' w');
      this._width = wpt;
    }
  };
  // Polyligne : liste de points {x,y} en POINTS PDF
  PdfPage.prototype.polyline = function (ptsPt, hex, wpt, closed) {
    if (!ptsPt.length) return;
    this._setStroke(hex || '#000000', wpt != null ? wpt : 0.709);
    let s = num(ptsPt[0].x) + ' ' + num(ptsPt[0].y) + ' m';
    for (let i = 1; i < ptsPt.length; i++) s += ' ' + num(ptsPt[i].x) + ' ' + num(ptsPt[i].y) + ' l';
    if (closed) s += ' h';
    s += ' S';
    this.ops.push(s);
  };
  // Texte (Helvetica). x,y en points PDF. str DOIT rester ASCII.
  PdfPage.prototype.text = function (x, y, sizePt, str, hex) {
    const c = hexRgb(hex || '#000000');
    this.ops.push(
      num(c[0]) + ' ' + num(c[1]) + ' ' + num(c[2]) + ' rg ' +
      'BT /F1 ' + num(sizePt) + ' Tf ' + num(x) + ' ' + num(y) + ' Td (' + esc(str) + ') Tj ET'
    );
    this._color = null; // on a changé la couleur de remplissage, invalider le cache trait
  };
  // Sauvegarde / restauration de l'état graphique (pour le découpage)
  PdfPage.prototype.save = function () { this.ops.push('q'); this._color = null; this._width = null; };
  PdfPage.prototype.restore = function () { this.ops.push('Q'); this._color = null; this._width = null; };
  PdfPage.prototype._poly = function (ptsPt) {
    let s = num(ptsPt[0].x) + ' ' + num(ptsPt[0].y) + ' m';
    for (let i = 1; i < ptsPt.length; i++) s += ' ' + num(ptsPt[i].x) + ' ' + num(ptsPt[i].y) + ' l';
    return s + ' h';
  };
  // Découpe tout le dessin suivant à l'intérieur du polygone
  PdfPage.prototype.clip = function (ptsPt) { if (ptsPt.length < 3) return; this.ops.push(this._poly(ptsPt) + ' W n'); };
  // Remplit un polygone plein
  PdfPage.prototype.fill = function (ptsPt, hex) {
    if (ptsPt.length < 3) return;
    const c = hexRgb(hex || '#000000');
    this.ops.push(num(c[0]) + ' ' + num(c[1]) + ' ' + num(c[2]) + ' rg ' + this._poly(ptsPt) + ' f');
    this._color = null;
  };

  function PdfDoc(wPt, hPt) {
    this.page = new PdfPage(wPt, hPt);
  }
  PdfDoc.prototype.build = function () {
    const content = this.page.ops.join('\n') + '\n';
    const objs = [];
    objs[1] = '<</Type/Catalog/Pages 2 0 R>>';
    objs[2] = '<</Type/Pages/Kids[3 0 R]/Count 1>>';
    objs[3] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 ' + num(this.page.w) + ' ' + num(this.page.h) +
      ']/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>';
    objs[4] = '<</Length ' + byteLen(content) + '>>\nstream\n' + content + 'endstream';
    objs[5] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    for (let i = 1; i <= 5; i++) {
      offsets[i] = byteLen(pdf);
      pdf += i + ' 0 obj\n' + objs[i] + '\nendobj\n';
    }
    const xrefStart = byteLen(pdf);
    pdf += 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) {
      pdf += ('0000000000' + offsets[i]).slice(-10) + ' 00000 n \n';
    }
    pdf += 'trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n' + xrefStart + '\n%%EOF';
    return pdf;
  };
  // Uint8Array (1 octet par caractère ASCII) -> prêt pour Blob / fichier
  PdfDoc.prototype.toBytes = function () {
    const s = this.build();
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
    return a;
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.pdf = { PdfDoc: PdfDoc, hexRgb: hexRgb };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QCAD.pdf;
})(typeof window !== 'undefined' ? window : globalThis);
