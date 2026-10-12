/* QlygoCAD — engine/units.js
 * Conversions d'unités. Fonctions PURES, aucune dépendance au shell desktop.
 * Règle d'or du projet : toute la géométrie est stockée en MILLIMÈTRES RÉELS.
 * L'échelle (ex. 1:100) n'intervient QU'À L'EXPORT papier.
 */
(function (root) {
  const U = {};

  U.MM_PER_INCH = 25.4;
  U.PT_PER_INCH = 72; // le "point" PostScript/PDF = 1/72 pouce

  // millimètres papier -> points PDF
  U.mmToPt = function (mm) { return (mm * U.PT_PER_INCH) / U.MM_PER_INCH; };
  U.ptToMm = function (pt) { return (pt * U.MM_PER_INCH) / U.PT_PER_INCH; };

  // Formats papier en mm (portrait)
  U.PAPER = {
    A4: { w: 210, h: 297 },
    A3: { w: 297, h: 420 }
  };

  // Longueur réelle (mm) -> longueur papier (mm) à l'échelle 1:denom
  // ex: 1000 mm réels à 1:100 -> 10 mm papier
  U.realMmToPaperMm = function (realMm, denom) { return realMm / denom; };

  root.QCAD = root.QCAD || {};
  root.QCAD.units = U;
  if (typeof module !== 'undefined' && module.exports) module.exports = U;
})(typeof window !== 'undefined' ? window : globalThis);
