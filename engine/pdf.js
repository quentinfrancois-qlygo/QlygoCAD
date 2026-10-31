/* QlygoCAD — engine/pdf.js
 * Générateur PDF VECTORIEL minimal, écrit à la main, SANS aucune librairie.
 * But : un PDF dont les traits se mesurent exactement à la règle.
 * Unité du PDF = le point (1/72 pouce). Origine en bas à gauche, Y vers le haut.
 * Tout le contenu est en ASCII -> comptage d'octets fiable, pas de compression.
 */
(function (root) {
  function num(n) { return (Math.round(n * 1000) / 1000).toString(); }
  function esc(s) {
    // Normalise les caractères typographiques courants vers Latin-1, puis remplace tout
    // ce qui dépasse 0..255 par '?' (sinon toBytes() le corromprait via & 0xff). Avec la
    // police en WinAnsiEncoding, les accents français (é è à ç É…) sortent correctement.
    s = String(s)
      .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ')
      .replace(/[^\u0000-ÿ]/g, '?');
    return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
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
    this._color = null; this._width = null; this._dash = null;
    this.images = [];   // XObjects image (logos) placés dans cette page
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
  // Polyligne : liste de points {x,y} en POINTS PDF (dashPt = motif de tirets, optionnel)
  PdfPage.prototype.polyline = function (ptsPt, hex, wpt, closed, dashPt) {
    if (!ptsPt.length) return;
    this._setStroke(hex || '#000000', wpt != null ? wpt : 0.709);
    const d = (dashPt && dashPt.length) ? '[' + dashPt.map(num).join(' ') + '] 0 d' : '[] 0 d';
    if (d !== this._dash) { this.ops.push(d); this._dash = d; }
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
  PdfPage.prototype.save = function () { this.ops.push('q'); this._color = null; this._width = null; this._dash = null; };
  PdfPage.prototype.restore = function () { this.ops.push('Q'); this._color = null; this._width = null; this._dash = null; };
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
  // Texte avec MATRICE (rotation / orientation) — utilisé par l'adaptateur Canvas->PDF.
  // a,b,c,d = partie linéaire (orientation + échelle), e,f = position en POINTS PDF.
  // bold => Helvetica-Bold (F2) ; sinon Helvetica (F1).
  PdfPage.prototype.textMatrix = function (a, b, c, d, e, f, sizePt, str, hex, bold) {
    const col = hexRgb(hex || '#000000');
    this.ops.push(
      num(col[0]) + ' ' + num(col[1]) + ' ' + num(col[2]) + ' rg BT /' + (bold ? 'F2' : 'F1') + ' ' +
      num(sizePt) + ' Tf ' + num(a) + ' ' + num(b) + ' ' + num(c) + ' ' + num(d) + ' ' + num(e) + ' ' + num(f) +
      ' Tm (' + esc(str) + ') Tj ET'
    );
    this._color = null;
  };
  // Place une image (JPEG latin1) via une matrice cm. a,b,c,d = axes (unité -> points),
  // e,f = origine (coin bas-gauche de l'image) en POINTS PDF. Renvoie l'id XObject.
  PdfPage.prototype.addImage = function (jpegBin, iw, ih, a, b, c, d, e, f) {
    const id = 'ImX' + this.images.length;
    this.images.push({ id: id, jpeg: jpegBin, w: iw | 0, h: ih | 0 });
    this.ops.push('q ' + num(a) + ' ' + num(b) + ' ' + num(c) + ' ' + num(d) + ' ' + num(e) + ' ' + num(f) + ' cm /' + id + ' Do Q');
    this._color = null; this._width = null; this._dash = null;
    return id;
  };

  // Document VECTORIEL — une ou PLUSIEURS pages. .page = 1re page (compat. export.js).
  function PdfDoc(wPt, hPt) {
    this.pages = [];
    this.page = this.addPage(wPt, hPt);
  }
  PdfDoc.prototype.addPage = function (wPt, hPt) {
    const p = new PdfPage(wPt, hPt); this.pages.push(p); return p;
  };
  PdfDoc.prototype.build = function () {
    const objs = [];                 // objs[n] indexé à partir de 1
    let n = 0; const next = () => (++n);
    const catalog = next();          // 1
    const pagesObj = next();         // 2
    const fontR = next();            // 3  Helvetica (F1)
    const fontB = next();            // 4  Helvetica-Bold (F2)
    const pb = this.pages.map(pg => ({ pg: pg, content: pg.ops.join('\n') + '\n', imgs: (pg.images || []).map(im => ({ im: im, num: 0 })) }));
    const kids = [];
    pb.forEach(p => {
      p.pageNum = next(); p.contentNum = next();
      p.imgs.forEach(io => io.num = next());
      kids.push(p.pageNum + ' 0 R');
    });
    objs[catalog] = '<</Type/Catalog/Pages ' + pagesObj + ' 0 R>>';
    objs[pagesObj] = '<</Type/Pages/Kids[' + kids.join(' ') + ']/Count ' + pb.length + '>>';
    objs[fontR] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>';
    objs[fontB] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>';
    pb.forEach(p => {
      let xobj = ''; p.imgs.forEach(io => xobj += '/' + io.im.id + ' ' + io.num + ' 0 R');
      const res = '<</Font<</F1 ' + fontR + ' 0 R/F2 ' + fontB + ' 0 R>>' + (p.imgs.length ? '/XObject<<' + xobj + '>>' : '') + '>>';
      objs[p.pageNum] = '<</Type/Page/Parent ' + pagesObj + ' 0 R/MediaBox[0 0 ' + num(p.pg.w) + ' ' + num(p.pg.h) + ']/Resources' + res + '/Contents ' + p.contentNum + ' 0 R>>';
      objs[p.contentNum] = '<</Length ' + byteLen(p.content) + '>>\nstream\n' + p.content + 'endstream';
      p.imgs.forEach(io => {
        const im = io.im;
        objs[io.num] = '<</Type/XObject/Subtype/Image/Width ' + im.w + '/Height ' + im.h +
          '/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ' + byteLen(im.jpeg) + '>>\nstream\n' + im.jpeg + '\nendstream';
      });
    });
    const total = n;
    let pdf = '%PDF-1.4\n'; const offsets = [];
    for (let i = 1; i <= total; i++) { offsets[i] = byteLen(pdf); pdf += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
    const xrefStart = byteLen(pdf);
    pdf += 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= total; i++) pdf += ('0000000000' + offsets[i]).slice(-10) + ' 00000 n \n';
    pdf += 'trailer\n<</Size ' + (total + 1) + '/Root ' + catalog + ' 0 R>>\nstartxref\n' + xrefStart + '\n%%EOF';
    return pdf;
  };
  // Uint8Array (1 octet par caractère ASCII) -> prêt pour Blob / fichier
  PdfDoc.prototype.toBytes = function () {
    const s = this.build();
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
    return a;
  };

  // ---- PDF d'une IMAGE pleine page (JPEG) ---------------------------------
  // Sert aux pages à gabarit (cartouche DP) rasterisées : plus besoin de la
  // fenêtre d'impression (pop-up) bloquée par l'appli bureau. On fabrique un
  // vrai fichier PDF A4 contenant l'image, téléchargé directement.
  // jpegBin = chaîne binaire latin1 (1 octet/caractère, via atob), imgW/imgH =
  // pixels de l'image, wPt/hPt = taille de la page en points PDF.
  function ImageDoc(jpegBin, imgW, imgH, wPt, hPt) {
    this.jpeg = jpegBin; this.iw = imgW | 0; this.ih = imgH | 0; this.w = wPt; this.h = hPt;
  }
  ImageDoc.prototype.build = function () {
    const content = 'q ' + num(this.w) + ' 0 0 ' + num(this.h) + ' 0 0 cm /Im0 Do Q\n';
    const objs = [];
    objs[1] = '<</Type/Catalog/Pages 2 0 R>>';
    objs[2] = '<</Type/Pages/Kids[3 0 R]/Count 1>>';
    objs[3] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 ' + num(this.w) + ' ' + num(this.h) +
      ']/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>';
    objs[4] = '<</Length ' + content.length + '>>\nstream\n' + content + 'endstream';
    objs[5] = '<</Type/XObject/Subtype/Image/Width ' + this.iw + '/Height ' + this.ih +
      '/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ' + this.jpeg.length +
      '>>\nstream\n' + this.jpeg + '\nendstream';
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    for (let i = 1; i <= 5; i++) { offsets[i] = pdf.length; pdf += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
    const xrefStart = pdf.length;
    pdf += 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) pdf += ('0000000000' + offsets[i]).slice(-10) + ' 00000 n \n';
    pdf += 'trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n' + xrefStart + '\n%%EOF';
    return pdf;
  };
  ImageDoc.prototype.toBytes = PdfDoc.prototype.toBytes;
  // Fabrique depuis un dataURL "data:image/jpeg;base64,..." (navigateur).
  ImageDoc.fromDataURL = function (dataURL, imgW, imgH, wPt, hPt) {
    const b64 = String(dataURL).split(',')[1] || '';
    const bin = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('latin1');
    return new ImageDoc(bin, imgW, imgH, wPt, hPt);
  };

  // ---- PDF MULTI-PAGES d'images (une feuille rasterisée par page) --------------
  // Sert à sortir plusieurs façades/pages dans UN SEUL PDF, dans l'ordre voulu.
  // pages = [{ jpeg (latin1), iw, ih, w(pt), h(pt) }]
  function ImagesDoc(pages) { this.pages = pages || []; }
  ImagesDoc.prototype.build = function () {
    const N = this.pages.length, objs = [];
    objs[1] = '<</Type/Catalog/Pages 2 0 R>>';
    const kids = [];
    for (let i = 0; i < N; i++) kids.push((3 + i * 3) + ' 0 R');
    objs[2] = '<</Type/Pages/Kids[' + kids.join(' ') + ']/Count ' + N + '>>';
    for (let i = 0; i < N; i++) {
      const pg = this.pages[i], pObj = 3 + i * 3, cObj = 4 + i * 3, iObj = 5 + i * 3;
      const content = 'q ' + num(pg.w) + ' 0 0 ' + num(pg.h) + ' 0 0 cm /Im0 Do Q\n';
      objs[pObj] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 ' + num(pg.w) + ' ' + num(pg.h) + ']/Resources<</XObject<</Im0 ' + iObj + ' 0 R>>>>/Contents ' + cObj + ' 0 R>>';
      objs[cObj] = '<</Length ' + content.length + '>>\nstream\n' + content + 'endstream';
      objs[iObj] = '<</Type/XObject/Subtype/Image/Width ' + (pg.iw | 0) + '/Height ' + (pg.ih | 0) + '/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ' + pg.jpeg.length + '>>\nstream\n' + pg.jpeg + '\nendstream';
    }
    const total = 2 + N * 3;
    let pdf = '%PDF-1.4\n'; const offsets = [];
    for (let i = 1; i <= total; i++) { offsets[i] = pdf.length; pdf += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
    const xrefStart = pdf.length;
    pdf += 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= total; i++) pdf += ('0000000000' + offsets[i]).slice(-10) + ' 00000 n \n';
    pdf += 'trailer\n<</Size ' + (total + 1) + '/Root 1 0 R>>\nstartxref\n' + xrefStart + '\n%%EOF';
    return pdf;
  };
  ImagesDoc.prototype.toBytes = PdfDoc.prototype.toBytes;
  ImagesDoc.fromDataURLs = function (items) {
    const pages = (items || []).map(it => {
      const b64 = String(it.dataURL).split(',')[1] || '';
      const bin = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('latin1');
      return { jpeg: bin, iw: it.iw, ih: it.ih, w: it.w, h: it.h };
    });
    return new ImagesDoc(pages);
  };

  // ---- Adaptateur Canvas 2D -> PDF VECTORIEL -----------------------------------
  // Mime l'API CanvasRenderingContext2D juste ce qu'il faut pour rejouer le dessin
  // d'une page-gabarit (cartouche + fenêtres de plan) dans un PdfPage : traits, textes
  // et remplissages deviennent du VECTORIEL (nets à n'importe quel zoom) au lieu d'un
  // JPEG pixelisé. L'espace d'entrée = POINTS PDF, Y vers le BAS (comme un canvas) ;
  // l'adaptateur retourne l'axe Y à l'émission. measCtx = vrai ctx 2D (pour measureText).
  function _clamp255(v) { v = v | 0; return v < 0 ? 0 : v > 255 ? 255 : v; }
  function _h2(v) { return ('0' + _clamp255(v).toString(16)).slice(-2); }
  function _parseColor(s) {
    if (s == null) return { hex: '#000000', a: 1 };
    s = String(s).trim();
    if (s[0] === '#') {
      if (s.length === 4) return { hex: '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3], a: 1 };
      if (s.length >= 7) return { hex: s.slice(0, 7).toLowerCase(), a: 1 };
      return { hex: '#000000', a: 1 };
    }
    const m = /^rgba?\(([^)]+)\)/i.exec(s);
    if (m) { const p = m[1].split(',').map(x => parseFloat(x)); return { hex: '#' + _h2(p[0]) + _h2(p[1]) + _h2(p[2]), a: (p.length > 3 ? p[3] : 1) }; }
    const named = { white: '#ffffff', black: '#000000', red: '#ff0000', transparent: null };
    const k = s.toLowerCase();
    if (k in named) { const hx = named[k]; return { hex: hx || '#000000', a: hx ? 1 : 0 }; }
    return { hex: '#000000', a: 1 };
  }
  // Mélange vers le BLANC (papier) selon alpha -> couleur opaque équivalente
  function blendWhite(hex, alpha) {
    if (alpha >= 1) return hex; if (alpha <= 0) return '#ffffff';
    const c = hexRgb(hex);
    return '#' + _h2((c[0] * alpha + (1 - alpha)) * 255) + _h2((c[1] * alpha + (1 - alpha)) * 255) + _h2((c[2] * alpha + (1 - alpha)) * 255);
  }
  function VectorCanvas(page, measCtx, pageHpt) {
    this.page = page; this._meas = measCtx; this.H = pageHpt;
    this.m = [1, 0, 0, 1, 0, 0]; this._st = [];
    this.fillStyle = '#000000'; this.strokeStyle = '#000000';
    this.lineWidth = 1; this.globalAlpha = 1;
    this.font = '10px sans-serif'; this.textAlign = 'left'; this.textBaseline = 'alphabetic';
    this.lineJoin = 'miter'; this.lineCap = 'butt'; this._dash = [];
    this._subs = []; this._cur = null;
  }
  const VC = VectorCanvas.prototype;
  VC._mul = function (n) { const m = this.m; this.m = [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]; };
  VC._tx = function (x, y) { const m = this.m; return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; };
  VC._pt = function (x, y) { const p = this._tx(x, y); return { x: p.x, y: this.H - p.y }; };
  VC._scale = function () { const m = this.m; return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1; };
  VC._lw = function () { return Math.max(0.1, this.lineWidth * this._scale()); };
  VC._dashArr = function () { if (!this._dash || !this._dash.length) return null; const s = this._scale(); return this._dash.map(v => v * s); };
  VC._fill = function () { const c = _parseColor(this.fillStyle); return blendWhite(c.hex, c.a * this.globalAlpha); };
  VC._stroke = function () { const c = _parseColor(this.strokeStyle); return blendWhite(c.hex, c.a * this.globalAlpha); };
  VC.save = function () { this._st.push([this.m.slice(), this.fillStyle, this.strokeStyle, this.lineWidth, this.globalAlpha, this.font, this.textAlign, this.textBaseline, (this._dash || []).slice(), this.lineJoin, this.lineCap]); this.page.save(); };
  VC.restore = function () { const s = this._st.pop(); if (s) { this.m = s[0]; this.fillStyle = s[1]; this.strokeStyle = s[2]; this.lineWidth = s[3]; this.globalAlpha = s[4]; this.font = s[5]; this.textAlign = s[6]; this.textBaseline = s[7]; this._dash = s[8]; this.lineJoin = s[9]; this.lineCap = s[10]; } this.page.restore(); };
  VC.translate = function (x, y) { this._mul([1, 0, 0, 1, x, y]); };
  VC.rotate = function (a) { const c = Math.cos(a), s = Math.sin(a); this._mul([c, s, -s, c, 0, 0]); };
  VC.scale = function (x, y) { this._mul([x, 0, 0, y, 0, 0]); };
  VC.setLineDash = function (d) { this._dash = (d || []).slice(); };
  VC.getLineDash = function () { return (this._dash || []).slice(); };
  VC.beginPath = function () { this._subs = []; this._cur = null; };
  VC.moveTo = function (x, y) { this._cur = [this._pt(x, y)]; this._subs.push(this._cur); };
  VC.lineTo = function (x, y) { if (!this._cur) this.moveTo(x, y); else this._cur.push(this._pt(x, y)); };
  VC.closePath = function () { if (this._cur) this._cur.closed = true; };
  VC.rect = function (x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); };
  VC.arc = function (cx, cy, r, a0, a1, ccw) {
    const TWO = Math.PI * 2; let s = a0, e = a1;
    if (!ccw) { if (e < s) e += TWO * Math.ceil((s - e) / TWO); } else { if (e > s) e -= TWO * Math.ceil((e - s) / TWO); }
    const n = Math.max(8, Math.ceil(Math.abs(e - s) / (Math.PI / 24)));
    if (!this._cur) { this._cur = []; this._subs.push(this._cur); }
    for (let i = 0; i <= n; i++) { const a = s + (e - s) * i / n; this._cur.push(this._pt(cx + Math.cos(a) * r, cy + Math.sin(a) * r)); }
  };
  VC.stroke = function () { const col = this._stroke(), lw = this._lw(), dash = this._dashArr(); for (const sp of this._subs) if (sp.length >= 2) this.page.polyline(sp, col, lw, !!sp.closed, dash); };
  VC.fill = function () { const col = this._fill(); for (const sp of this._subs) if (sp.length >= 3) this.page.fill(sp, col); };
  VC.clip = function () { for (const sp of this._subs) if (sp.length >= 3) this.page.clip(sp); };
  VC.fillRect = function (x, y, w, h) { this.page.fill([this._pt(x, y), this._pt(x + w, y), this._pt(x + w, y + h), this._pt(x, y + h)], this._fill()); };
  VC.strokeRect = function (x, y, w, h) { this.page.polyline([this._pt(x, y), this._pt(x + w, y), this._pt(x + w, y + h), this._pt(x, y + h)], this._stroke(), this._lw(), true, this._dashArr()); };
  VC.clearRect = function (x, y, w, h) { this.page.fill([this._pt(x, y), this._pt(x + w, y), this._pt(x + w, y + h), this._pt(x, y + h)], '#ffffff'); };
  VC._fontPx = function () { const m = /([\d.]+)px/.exec(this.font || ''); return m ? parseFloat(m[1]) : 10; };
  VC._isBold = function () { return /\b(bold|[6-9]00)\b/.test(this.font || ''); };
  VC.measureText = function (s) { try { this._meas.font = this.font; return this._meas.measureText(String(s)); } catch (e) { return { width: String(s).length * this._fontPx() * 0.5 }; } };
  VC.fillText = function (str, x, y) {
    str = String(str); if (!str) return;
    const fpx = this._fontPx(), bold = this._isBold();
    let w = 0; const ta = this.textAlign;
    if (ta === 'center' || ta === 'right' || ta === 'end') { try { this._meas.font = this.font; w = this._meas.measureText(str).width; } catch (e) { w = str.length * fpx * 0.5; } }
    const lx = x - (ta === 'center' ? w / 2 : (ta === 'right' || ta === 'end') ? w : 0);
    const tb = this.textBaseline;
    const ly = y + (tb === 'top' || tb === 'hanging' ? fpx * 0.80 : tb === 'middle' ? fpx * 0.30 : (tb === 'bottom' || tb === 'ideographic' ? -fpx * 0.18 : 0));
    const pos = this._pt(lx, ly), m = this.m;
    this.page.textMatrix(m[0], -m[1], -m[2], m[3], pos.x, pos.y, fpx, str, this._fill(), bold);
  };
  VC.strokeText = function (str, x, y) { this.fillText(str, x, y); };
  VC.drawImage = function (img, dx, dy, dw, dh) {
    try {
      const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1;
      if (dw == null) { dw = iw; dh = ih; }
      if (typeof document === 'undefined') return;
      const cv = document.createElement('canvas'); cv.width = iw; cv.height = ih;
      const cx = cv.getContext('2d'); cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, iw, ih); cx.drawImage(img, 0, 0, iw, ih);
      const b64 = cv.toDataURL('image/jpeg', 0.92).split(',')[1] || '';
      const bin = (typeof atob === 'function') ? atob(b64) : '';
      if (!bin) return;
      const o = this._pt(dx, dy + dh), ex = this._pt(dx + dw, dy + dh), ey = this._pt(dx, dy);
      this.page.addImage(bin, iw, ih, ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y);
    } catch (e) { }
  };
  // No-ops tolérés (appelés parfois par du code de rendu générique)
  VC.setTransform = function () { }; VC.resetTransform = function () { }; VC.quadraticCurveTo = function (cx, cy, x, y) { this.lineTo(x, y); };
  VC.bezierCurveTo = function (c1x, c1y, c2x, c2y, x, y) { this.lineTo(x, y); }; VC.createLinearGradient = function () { return { addColorStop: function () { } }; };

  root.QCAD = root.QCAD || {};
  root.QCAD.pdf = { PdfDoc: PdfDoc, ImageDoc: ImageDoc, ImagesDoc: ImagesDoc, VectorCanvas: VectorCanvas, blendWhite: blendWhite, hexRgb: hexRgb };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QCAD.pdf;
})(typeof window !== 'undefined' ? window : globalThis);
