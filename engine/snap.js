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
      if (e.type === 'image' || e.type === 'text') continue;
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
    if (on('center')) {   // centre des cercles / arcs
      for (const e of scene.entities) if (e.center) cands.push({ p: { x: e.center.x, y: e.center.y }, type: 'center', pr: 2 });
    }
    if (on('quadrant')) { // quadrants (0/90/180/270°) des cercles — pr 1 : à égalité avec les extrémités,
      // le plus proche gagne, donc on s'accroche au quadrant EXACT plutôt qu'au sommet polygonal voisin.
      for (const e of scene.entities) if (e.center && e.r) { const c = e.center, r = e.r;
        cands.push({ p: { x: c.x + r, y: c.y }, type: 'quadrant', pr: 1 }); cands.push({ p: { x: c.x - r, y: c.y }, type: 'quadrant', pr: 1 });
        cands.push({ p: { x: c.x, y: c.y + r }, type: 'quadrant', pr: 1 }); cands.push({ p: { x: c.x, y: c.y - r }, type: 'quadrant', pr: 1 }); }
    }
    if (on('perp') && opts.from) {
      for (const [a, b] of segs) {
        const f = perpFoot(opts.from, a, b);
        if (f) cands.push({ p: f, type: 'perp', pr: 4 });
      }
    }
    // "Proche de" (nearest) : point le plus proche SUR un trait. Permet de démarrer
    // un trait n'importe où le long d'une ligne d'aide (priorité faible : extrémité/
    // milieu/intersection gagnent si on est dessus).
    if (on('near')) {
      for (const [a, b] of segs) {
        const f = perpFoot(pt, a, b);
        if (f) cands.push({ p: f, type: 'near', pr: 5 });
      }
    }
    if (on('grid') && opts.grid) {
      const step = opts.gridStepMm || 1000;
      cands.push({ p: { x: Math.round(pt.x / step) * step, y: Math.round(pt.y / step) * step },
        type: 'grid', pr: 6 });
    }

    // Sélection par PRIORITÉ (pr faible = prioritaire), puis par distance à égalité.
    // NB : `best` DOIT mémoriser `pr`, sinon les comparaisons se font contre undefined
    // et c'est le premier candidat dans la tolérance qui gagne (ancien bug).
    let best = null;
    for (const c of cands) {
      const d = dist(pt, c.p);
      if (d > tolMm) continue;
      if (!best || c.pr < best.pr || (c.pr === best.pr && d < best.d)) {
        best = { x: c.p.x, y: c.p.y, type: c.type, d, pr: c.pr };
      }
    }
    return best;
  };

  /* Sélection par clic : entité la plus proche du point (ou null). */
  S.pickEntity = function (scene, pt, tolMm) {
    // À distance ~égale (traits superposés), on prend le PLUS RÉCENT (plus grand _ix),
    // pas le plus ancien : la ligne qu'on vient de poser est sélectionnable en premier.
    let best = null; const band = tolMm * 0.25;
    for (const e of scene.entities) {
      // les cotes se sélectionnent via leur géométrie VISIBLE (ligne de cote décalée) :
      // voir pickDimAt côté appli -> on les exclut ici pour ne pas « voler » le clic au trait.
      if (e.type === 'image' || e.type === 'text' || e.type === 'dim') continue;
      const p = e.points, n = p.length; let dmin = Infinity;
      for (let i = 1; i < n; i++) { const f = perpFoot(pt, p[i - 1], p[i]); if (f) { const d = dist(pt, f); if (d < dmin) dmin = d; } }
      if (e.closed && n > 2) { const f = perpFoot(pt, p[n - 1], p[0]); if (f) { const d = dist(pt, f); if (d < dmin) dmin = d; } }
      if (dmin > tolMm) continue;
      const ord = e._ix || 0, pen = (e.dash ? 1 : 0) + (e.noPrint ? 2 : 0);
      // à proximité ~égale : un trait réel (plein, imprimable) prime sur une ligne
      // d'aide ; à pénalité égale, le plus récemment tracé gagne.
      if (!best || dmin < best.d - band) best = { e, d: dmin, ord, pen };
      else if (dmin <= best.d + band && (pen < best.pen || (pen === best.pen && ord > best.ord))) best = { e, d: dmin, ord, pen };
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
    let best = null; const band = tolMm * 0.4;
    for (const e of scene.entities) {
      if (e.type === 'dim' || e.type === 'image' || e.type === 'text') continue; // on ne cote pas une cote / image / texte
      const p = e.points, n = p.length;
      const edges = [];
      for (let i = 1; i < n; i++) edges.push([p[i - 1], p[i]]);
      if (e.closed && n > 2) edges.push([p[n - 1], p[0]]);
      // un trait réel (plein, imprimable) est préféré à une ligne d'aide (pointillée /
      // non imprimée) ; à proximité ~égale, le segment le PLUS COURT gagne -> on cote
      // le mur de 10 m et non la grande ligne d'aide qui le croise.
      const penalty = (e.dash ? 1 : 0) + (e.noPrint ? 2 : 0);
      for (const [a, b] of edges) {
        const f = perpFoot(pt, a, b);
        if (!f) continue;
        const d = dist(pt, f);
        if (d > tolMm) continue;
        const len = dist(a, b);
        if (!best) { best = { a, b, foot: f, dist: d, len, penalty }; continue; }
        if (d < best.dist - band) best = { a, b, foot: f, dist: d, len, penalty };
        else if (d <= best.dist + band && (penalty < best.penalty || (penalty === best.penalty && len < best.len))) best = { a, b, foot: f, dist: d, len, penalty };
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

  // Segments [a,b] d'une entité (contour fermé inclus)
  S.entitySegments = function (e) {
    const p = e.points, n = p.length, out = [];
    for (let i = 1; i < n; i++) out.push([p[i - 1], p[i]]);
    if (e.closed && n > 2) out.push([p[n - 1], p[0]]);
    return out;
  };

  /* Paramètre t le long de AB (0..1) à l'intersection avec le SEGMENT CD,
   * si elle tombe dans les deux segments. null sinon. (Pour Ajuster.) */
  S.segParam = function (A, B, C, D) {
    const rx = B.x - A.x, ry = B.y - A.y, sx = D.x - C.x, sy = D.y - C.y;
    const den = rx * sy - ry * sx; if (Math.abs(den) < 1e-9) return null;
    const t = ((C.x - A.x) * sy - (C.y - A.y) * sx) / den;
    const u = ((C.x - A.x) * ry - (C.y - A.y) * rx) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return t;
  };

  /* Paramètre t le long de la DROITE AB (t quelconque) à l'intersection avec le
   * segment CD (u dans [0,1]). null sinon. (Pour Prolonger : t<0 ou t>1.) */
  S.rayParam = function (A, B, C, D) {
    const rx = B.x - A.x, ry = B.y - A.y, sx = D.x - C.x, sy = D.y - C.y;
    const den = rx * sy - ry * sx; if (Math.abs(den) < 1e-9) return null;
    const t = ((C.x - A.x) * sy - (C.y - A.y) * sx) / den;
    const u = ((C.x - A.x) * ry - (C.y - A.y) * rx) / den;
    if (u < -1e-9 || u > 1 + 1e-9) return null;
    return t;
  };

  /* Détection de la ZONE FERMÉE autour d'un point, même formée de plusieurs
   * traits séparés (ex. un triangle fait de 3 lignes). Renvoie le polygone
   * (liste de points) de la plus petite face bornée contenant le point, ou null.
   * Méthode : graphe planaire des extrémités + parcours de faces (demi-arêtes). */
  // Découpe chaque segment à ses intersections / jonctions en T avec les autres :
  // indispensable pour détecter une SOUS-zone (ex. une bande de façade délimitée par
  // un refend qui touche les murs au milieu, sans sommet partagé). O(n²), plafonné.
  function splitSegs(segs, tol) {
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const a = segs[i][0], b = segs[i][1];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      if (len2 < 1e-9) continue;
      const cuts = [0, 1];
      for (let j = 0; j < segs.length; j++) {
        if (j === i) continue;
        const x = segInter(a, b, segs[j][0], segs[j][1]);
        if (!x) continue;
        const t = ((x.x - a.x) * dx + (x.y - a.y) * dy) / len2;
        if (t > 1e-4 && t < 1 - 1e-4) cuts.push(t);
      }
      cuts.sort((p, q) => p - q);
      for (let k = 0; k < cuts.length - 1; k++) {
        const t0 = cuts[k], t1 = cuts[k + 1]; if (t1 - t0 < 1e-5) continue;
        const p0 = { x: a.x + t0 * dx, y: a.y + t0 * dy }, p1 = { x: a.x + t1 * dx, y: a.y + t1 * dy };
        if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > tol) out.push([p0, p1]);
      }
    }
    return out;
  }
  S.findRegion = function (scene, pt, tolMm) {
    const tol = tolMm || 1;
    // 1) segments de toutes les entités "piochables"
    const raw = [];
    for (const e of scene.entities) {
      if (e.type === 'hatch' || e.type === 'dim' || e.type === 'image' || e.type === 'text') continue;
      for (const [a, b] of S.entitySegments(e)) raw.push([a, b]);
    }
    if (!raw.length) return null;
    // découpe aux intersections (plafonnée pour rester fluide au survol)
    const segs = (raw.length <= 500) ? splitSegs(raw, tol) : raw;
    if (!segs.length) return null;
    // 2) nœuds (fusion des extrémités proches)
    const nodes = new Map();
    const keyOf = p => Math.round(p.x / tol) + '_' + Math.round(p.y / tol);
    function node(p) { const k = keyOf(p); let n = nodes.get(k); if (!n) { n = { x: p.x, y: p.y, edges: [] }; nodes.set(k, n); } return n; }
    const halfEdges = [];
    for (const [a, b] of segs) {
      const na = node(a), nb = node(b); if (na === nb) continue;
      const h1 = { from: na, to: nb }, h2 = { from: nb, to: na };
      h1.twin = h2; h2.twin = h1;
      h1.angle = Math.atan2(nb.y - na.y, nb.x - na.x);
      h2.angle = Math.atan2(na.y - nb.y, na.x - nb.x);
      na.edges.push(h1); nb.edges.push(h2); halfEdges.push(h1, h2);
    }
    for (const n of nodes.values()) n.edges.sort((p, q) => p.angle - q.angle);
    // demi-arête suivante dans une face : au nœud d'arrivée, celle juste avant le jumeau (sens horaire)
    function nextHE(h) { const es = h.to.edges; const i = es.indexOf(h.twin); return es[(i - 1 + es.length) % es.length]; }
    const visited = new Set();
    const faces = [];   // toutes les faces intérieures (aire > 0), avec leur centroïde
    for (const h0 of halfEdges) {
      if (visited.has(h0)) continue;
      const poly = []; let cur = h0, guard = 0;
      do { visited.add(cur); poly.push({ x: cur.from.x, y: cur.from.y }); cur = nextHE(cur); guard++; } while (cur !== h0 && guard < 100000);
      if (guard >= 100000 || poly.length < 3) continue;
      let A = 0, cxs = 0, cys = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; A += p.x * q.y - q.x * p.y; }
      A /= 2;
      if (A <= 0) continue;                     // faces intérieures = aire positive (sens trigo)
      for (const p of poly) { cxs += p.x; cys += p.y; }
      faces.push({ poly, A, c: { x: cxs / poly.length, y: cys / poly.length } });
    }
    // Face hôte = la PLUS PETITE face contenant le point (ex. le mur).
    let outer = null;
    for (const f of faces) if (pointInPolygon(pt, f.poly) && (!outer || f.A < outer.A)) outer = f;
    if (!outer) return null;
    // ÎLOTS (trous) : vraies zones fermées INTÉRIEURES (ex. fenêtres qui ne touchent
    // pas le bord). On exige qu'un îlot ne PARTAGE AUCUN SOMMET avec le contour hôte :
    // ça écarte les « slivers » parasites nés de lignes qui se croisent dans la zone
    // (ex. les pans de toit qui se croisent près du faîtage), lesquels ne sont PAS des
    // ouvertures et ne doivent donc pas être contournés. On ne garde que les îlots les
    // plus extérieurs (cadres imbriqués ignorés).
    const vtol = tol * 4;
    const touchesOuter = f => f.poly.some(v => outer.poly.some(o => Math.abs(o.x - v.x) < vtol && Math.abs(o.y - v.y) < vtol));
    const inside = faces.filter(f => f !== outer && f.A < outer.A - 1 && pointInPolygon(f.c, outer.poly) && !touchesOuter(f));
    const holes = inside.filter(f => !inside.some(g => g !== f && g.A > f.A && pointInPolygon(f.c, g.poly))).map(f => f.poly);
    return { outer: outer.poly, holes: holes };
  };

  root.QCAD = root.QCAD || {};
  root.QCAD.snap = S;
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof window !== 'undefined' ? window : globalThis);
