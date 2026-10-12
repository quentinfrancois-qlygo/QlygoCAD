/* QlygoCAD — engine/snap.js
 * "Automatismes de précision" façon AutoCAD. Fonctions PURES (aucune dépendance
 * au Canvas ni à Electron).
 *   - query()      : accrochage aux objets (extrémité, milieu, intersection,
 *                    perpendiculaire) + grille, avec priorités.
 *   - constrain()  : contrainte d'angle (Ortho 90° / Polaire 45°).
 *   - alongDir()   : point à une DISTANCE donnée dans la direction courante
 *                    (saisie de la cote au clavier).
 * Toutes les coordonnées sont en MILLIMÈTRES RÉELS.
 */
(function (root) {
  const S = {};

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // Pied de la perpendiculaire de P sur le segment [A,B] (borné au segment)
  function perpFoot(P, A, B) {
    const dx = B.x - A.x, dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return null;
    let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return { x: A.x + t * dx, y: A.y + t * dy };
  }

  // Intersection de deux segments [A,B] et [C,D] (null si pas de croisement)
  function segInter(A, B, C, D) {
    const r = { x: B.x - A.x, y: B.y - A.y };
    const s = { x: D.x - C.x, y: D.y - C.y };
    const denom = r.x * s.y - r.y * s.x;
    if (Math.abs(denom) < 1e-9) return null; // parallèles
    const t = ((C.x - A.x) * s.y - (C.y - A.y) * s.x) / denom;
    const u = ((C.x - A.x) * r.y - (C.y - A.y) * r.x) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: A.x + t * r.x, y: A.y + t * r.y };
  }

  // Liste des segments [A,B] de la scène
  function segments(scene) {
    const out = [];
    for (const e of scene.entities) {
      const p = e.points;
      for (let i = 1; i < p.length; i++) out.push([p[i - 1], p[i]]);
      if (e.closed && p.length > 2) out.push([p[p.length - 1], p[0]]);
    }
    return out;
  }

  /* query(scene, pt, tolMm, opts) -> {x,y,type} ou null
   * opts: { from, grid, gridStepMm, types:{end,mid,inter,perp,grid} (tous true par défaut) }
   * Priorité : extrémité > intersection > milieu > perpendiculaire > grille.
   */
  S.query = function (scene, pt, tolMm, opts) {
    opts = opts || {};
    const want = opts.types || {};
    const on = k => want[k] !== false;
    const segs = segments(scene);
    const cands = [];

    if (on('end')) {
      for (const [a, b] of segs) {
        cands.push({ p: a, type: 'end', pr: 1 });
        cands.push({ p: b, type: 'end', pr: 1 });
      }
    }
    if (on('inter')) {
      for (let i = 0; i < segs.length; i++)
        for (let j = i + 1; j < segs.length; j++) {
          const x = segInter(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
          if (x) cands.push({ p: x, type: 'inter', pr: 2 });
        }
    }
    if (on('mid')) {
      for (const [a, b] of segs)
        cands.push({ p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, type: 'mid', pr: 3 });
    }
    if (on('perp') && opts.from) {
      for (const [a, b] of segs) {
        const f = perpFoot(opts.from, a, b);
        if (f) cands.push({ p: f, type: 'perp', pr: 4 });
      }
    }
    if (on('grid') && opts.grid) {
      const step = opts.gridStepMm || 1000;
      cands.push({ p: { x: Math.round(pt.x / step) * step, y: Math.round(pt.y / step) * step },
        type: 'grid', pr: 5 });
    }

    let best = null;
    for (const c of cands) {
      const d = dist(pt, c.p);
      if (d > tolMm) continue;
      if (!best || c.pr < best.pr || (c.pr === best.pr && d < best.d)) {
        best = { x: c.p.x, y: c.p.y, type: c.type, d };
      }
    }
    return best;
  };

  /* Sélection par clic : entité la plus proche du point (ou null). */
  S.pickEntity = function (scene, pt, tolMm) {
    let best = null;
    for (const e of scene.entities) {
      const p = e.points, n = p.length, edges = [];
      for (let i = 1; i < n; i++) edges.push([p[i - 1], p[i]]);
      if (e.closed && n > 2) edges.push([p[n - 1], p[0]]);
      for (const [a, b] of edges) {
        const f = perpFoot(pt, a, b); if (!f) continue;
        const d = dist(pt, f);
        if (d <= tolMm && (!best || d < best.d)) best = { e, d };
      }
    }
    return best ? best.e : null;
  };

  /* Sélection par fenêtre.
   * crossing=false (gauche->droite, BLEU) : entités ENTIÈREMENT dans le cadre.
   * crossing=true  (droite->gauche, VERT) : entités TOUCHÉES par le cadre.
   */
  S.boxSelect = function (scene, A, B, crossing) {
    const minx = Math.min(A.x, B.x), maxx = Math.max(A.x, B.x);
    const miny = Math.min(A.y, B.y), maxy = Math.max(A.y, B.y);
    const inside = p => p.x >= minx && p.x <= maxx && p.y >= miny && p.y <= maxy;
    const re = [
      [{ x: minx, y: miny }, { x: maxx, y: miny }], [{ x: maxx, y: miny }, { x: maxx, y: maxy }],
      [{ x: maxx, y: maxy }, { x: minx, y: maxy }], [{ x: minx, y: maxy }, { x: minx, y: miny }]
    ];
    const out = [];
    for (const e of scene.entities) {
      const p = e.points, n = p.length;
      const allIn = p.every(inside), anyIn = p.some(inside);
      if (!crossing) { if (allIn) out.push(e); continue; }
      let hit = anyIn;
      if (!hit) {
        const edges = [];
        for (let i = 1; i < n; i++) edges.push([p[i - 1], p[i]]);
        if (e.closed && n > 2) edges.push([p[n - 1], p[0]]);
        for (const [a, b] of edges) { for (const [c, d] of re) if (segInter(a, b, c, d)) { hit = true; break; } if (hit) break; }
      }
      if (hit) out.push(e);
    }
    return out;
  };

  /* Contrainte d'angle : force "to" sur un multiple de stepDeg autour de "from".
   * Ortho = 90, Polaire = 45. La LONGUEUR est conservée (projection).
   */
  S.constrain = function (from, to, stepDeg) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: to.x, y: to.y };
    const step = (stepDeg || 90) * Math.PI / 180;
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
  };

  /* Point à distance "lenMm" depuis "from", dans la direction de "toward"
   * (saisie clavier de la cote : on vise avec la souris, on tape la longueur).
   */
  S.alongDir = function (from, toward, lenMm) {
    const dx = toward.x - from.x, dy = toward.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d === 0) return { x: from.x + lenMm, y: from.y };
    return { x: from.x + dx / d * lenMm, y: from.y + dy / d * lenMm };
  };

  /* Point à longueur + ANGLE absolu (degrés, 0 = +X, sens trigo) depuis "from".
   * Saisie dynamique façon AutoCAD : "5000<90".
   */
  S.polar = function (from, lenMm, angleDeg) {
    const a = angleDeg * Math.PI / 180;
    return { x: from.x + Math.cos(a) * lenMm, y: from.y + Math.sin(a) * lenMm };
  };

  /* Décalage (offset) d'un segment [a,b] d'une distance signée, perpendiculairement.
   * distSigned > 0 -> côté gauche de a->b ; < 0 -> côté droit.
   */
  S.offset = function (a, b, distSigned) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d, ny = dx / d;
    return {
      a: { x: a.x + nx * distSigned, y: a.y + ny * distSigned },
      b: { x: b.x + nx * distSigned, y: b.y + ny * distSigned }
    };
  };

  /* Trouve le segment le plus proche du point (pour l'outil Cote au survol).
   * Retourne { a, b, foot, dist } ou null.
   */
  S.pickSegment = function (scene, pt, tolMm) {
    let best = null;
    for (const e of scene.entities) {
      if (e.type === 'dim') continue; // on ne cote pas une cote
      const p = e.points, n = p.length;
      const edges = [];
      for (let i = 1; i < n; i++) edges.push([p[i - 1], p[i]]);
      if (e.closed && n > 2) edges.push([p[n - 1], p[0]]);
      for (const [a, b] of edges) {
        const f = perpFoot(pt, a, b);
        if (!f) continue;
        const d = dist(pt, f);
        if (d <= tolMm && (!best || d < best.dist)) best = { a, b, foot: f, dist: d };
      }
    }
    return best;
  };

  // Point dans un polygone (règle pair-impair)
  function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  S.pointInPolygon = pointInPolygon;
  function polyArea(p) { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j].x + p[i].x) * (p[j].y - p[i].y); return Math.abs(s / 2); }

  /* La plus petite zone FERMÉE contenant le point (pour l'outil Hachures). */
  S.pickClosedRegion = function (scene, pt) {
    let best = null, bestArea = Infinity;
    for (const e of scene.entities) {
      if (e.type === 'hatch' || e.type === 'dim') continue;
      if (!e.closed || e.points.length < 3) continue;
      if (pointInPolygon(pt, e.points)) { const a = polyArea(e.points); if (a < bestArea) { bestArea = a; best = e; } }
    }
    return best;
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.snap = S;
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof window !== 'undefined' ? window : globalThis);
