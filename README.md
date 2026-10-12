# QlygoCAD

Éditeur de **dessin 2D à l'échelle** (façon AutoCAD, **sans 3D**) : on dessine des
plans de maison tout à l'échelle et on exporte un **PDF vectoriel qui se mesure
juste à la règle** (ex. 1:100 → 1 m réel = 1 cm sur la feuille).

> Projet **100 % local**, totalement séparé de QLYGO. Rien ne part en ligne.
> But final : arrêter de payer la licence AutoCAD, puis compléter les dossiers DP
> de QLYGO (plans **DP2** masse et **DP4** façades) en natif.

---

## 🧠 Le principe clé : un moteur autonome

Tout le « cerveau » du dessin vit dans **`engine/`** — ce sont des fonctions pures
en JavaScript, **indépendantes d'Electron**. Résultat : le même moteur tournera
dans l'app desktop **et**, demain, directement dans QLYGO (composant web), sans
rien réécrire.

```
engine/
  units.js     — conversions (mm réels ↔ points PDF, échelles, formats papier)
  geometry.js  — modèle de scène et entités, stockés en MILLIMÈTRES RÉELS
  render.js    — affichage Canvas (la vue à l'écran, zoom/déplacement libres)
  pdf.js       — générateur PDF vectoriel minimal, écrit à la main (0 librairie)
  export.js    — applique l'ÉCHELLE (1:100…) et produit le PDF papier A4/A3
```

Règle d'or : **la géométrie est toujours en millimètres réels**. L'échelle
n'intervient qu'au moment de l'export papier. On ne « dessine » jamais à 1:100,
on dessine en vrai et on imprime à l'échelle.

Le reste (fenêtre, souris, boutons) est du « shell » :
```
poc.html + app-poc.js   — l'app de dessin (barre d'outils, souris, clavier)
src/                     — enveloppe Electron (la transforme en vrai logiciel PC)
```

---

## ▶️ Lancer

**Juste tester le POC tout de suite (aucune installation) :**
ouvrir `dist/qlygocad-poc.html` dans un navigateur (double-clic).
Dessiner quelques traits → bouton **« Exporter PDF »** → imprimer → mesurer à la règle.

**Lancer comme vrai logiciel (Electron) :**
```bash
npm install
npm start
```

**Vérifier le moteur (génère un PDF d'exemple + contrôles automatiques) :**
```bash
npm test
```

**Régénérer le fichier unique après une modif :**
```bash
node tools/build-standalone.js
```

---

## ✅ Porte de validation du projet

> « Redessiner **un vrai plan DP** aussi vite qu'avec AutoCAD, et le PDF se mesure
> juste. »

Si oui → on élargit : symboles de menuiseries, cotations automatiques, hachures,
calques avancés, export **DXF**, puis pré-dessin DP2/DP4 à partir des données de
repérage de QLYGO.

### Nouveautés v0.7
- [x] **Ligne qui enchaîne** (commande LIGNE AutoCAD) : point 1 → 2 → 3… en continu jusqu'à **Échap** (la Polyligne reste un objet connecté)
- [x] **Édition par poignées (grips)** : sélectionne un objet → attrape une extrémité pour l'étirer, ou la **poignée centrale** d'une ligne pour la déplacer entière
- [x] **Cotes associatives** : une cote posée sur un trait **suit le trait** quand on l'édite (la mesure se recalcule) ; poignée centrale pour déplacer la ligne de cote
- [x] **Cotes enrichies** : calque **Cotation** dédié · **couleur par calque** · **taille réglable** (2 / 2,5 / 3,5 / 5 mm)
- [x] **Hachures** : remplir une **zone fermée** d'un clic — **couleur pleine**, **lignes**, **croisées**, **tuiles (toiture)** — couleur/espacement réglables, exportées en vectoriel dans le PDF
- [x] **Couleur de calque éditable** dans le gestionnaire de calques
- [x] Raccourcis : `HACHURES`/`HA`, `DEC` (Décaler), noun-verb (sélection + commande)
- [x] Anti-cache + version visible (F5 = dernière version)

### Nouveautés v0.5
- [x] **Ortho corrigé (F8)** : contrainte STRICTE horizontal / vertical (l'aimant grille ne peut plus la casser ; seul l'accrochage objet peut en sortir, comme AutoCAD)
- [x] **Raccourcis clavier intelligents** : tape des lettres → la ligne de commande s'ouvre toute seule. Alias AutoCAD : `L`, `PL`, `REC`, `O`/`DEC` (Décaler), `COTE`, `Z`/`ZE`, `CALQUES`… Entrée à vide = répète la dernière commande
- [x] **Noun-verb** : sélectionne un trait, tape `DEC` → le Décaler cible directement l'objet sélectionné
- [x] **Outils persistants** : Ligne, Cote, Décaler… restent actifs (on enchaîne) jusqu'à **Échap** (qui ramène à la Sélection)
- [x] **Gestionnaire de calques** : afficher/masquer 👁️, geler ❄️, verrouiller 🔒, calque courant, nouveau calque. Les calques masqués/gelés ne s'impriment pas ; les verrouillés ne sont pas sélectionnables
- [x] Les commandes AutoCAD non encore codées répondent « à venir » (honnête) au lieu d'« inconnue »

### Nouveautés v0.4 — Interface « poste de travail » façon AutoCAD
- [x] **Ruban** organisé comme AutoCAD : Sélection · Dessiner · Modifier · Annotation · Calques & propriétés · Mise en page (icônes **originales** QlygoCAD, pas celles d'Autodesk)
- [x] **Outil Sélection = outil par défaut** : clic = 1 objet ; cadre **gauche→droite (bleu)** = englobe entièrement ; **droite→gauche (vert)** = capture tout ce qui est touché ; **Suppr** efface
- [x] **Ligne de commande** : tape `L`, `PL`, `REC`, `COTE`, `DECALER`, `ZE`… + Entrée (Entrée à vide = répète la dernière commande)
- [x] **Barre d'état** avec bascules ACCROBJ / GRILLE / RÉSOL / ORTHO / POLAIRE (F3/F7/F8/F9/F10)
- [x] **Espace objet sombre** + **réticule plein écran** + **icône SCU** (repère X/Y)
- [x] **Décaler (Offset)** : tape la distance (en m), survole un trait, clique le côté
- [x] **Unités en mètres** : taper `7` = 7 m (le moteur reste au mm en interne pour la précision)
- [x] Conversion de tracé : trait clair à l'écran → **noir sur le PDF** (convention AutoCAD)

### Nouveautés v0.3
- [x] **Saisie dynamique** façon AutoCAD : une bulle suit le curseur (longueur + angle en direct) ; taper au clavier ouvre la saisie (`5000` ou `5000<90` longueur+angle)
- [x] **Ligne** (2 points, validée directement) distincte de la **Polyligne** (segments enchaînés, Entrée pour finir)
- [x] **Outil Cote** : survoler un trait propose sa cotation ; clic = cotation posée, exportée dans le PDF (ticks d'architecte)

### État actuel (v0.2 — POC + automatismes de précision)
- [x] Zone de dessin avec grille (1 m) et axes X/Y
- [x] Tracé de lignes / polylignes et rectangles, à l'échelle, en mm réels
- [x] Couleurs et épaisseurs de trait (épaisseur = en mm **papier**, constante)
- [x] Aimantation à la grille (10 cm), zoom molette, déplacement
- [x] Export **PDF vectoriel A4/A3** à l'échelle (1:50 / 1:100 / 1:200 / 1:500)
- [x] Témoin « 1 m » imprimé sur le plan pour vérifier la mesure à la règle
- [x] **Pack 1 — Précision (façon AutoCAD)** :
  - [x] Accrochage aux objets : extrémité, milieu, intersection, perpendiculaire (F3)
  - [x] **Ortho** H/V (F8) et **Polaire** 45° (F10)
  - [x] **Saisie de la cote au clavier** : viser la direction, taper la longueur en mm + Entrée
- [ ] Pack 2 — Édition : offset, ajuster/prolonger, copier/déplacer/pivoter, miroir, réseau
- [ ] Pack 3 — Habillage : cotations auto, textes, hachures, calques (interface)
- [ ] Pack 4 — Bibliothèque : symboles menuiseries (portes/fenêtres), mises en page
- [ ] Pack 5 — Échange : enregistrement `.qcad`, import/export **DXF**

### Raccourcis clavier
| Touche | Action |
|--------|--------|
| F3 | Accrochage aux objets on/off |
| F8 | Ortho (horizontal/vertical) on/off |
| F10 | Polaire (angles à 45°) on/off |
| chiffres | Saisie de la cote (longueur en mm) pendant un tracé |
| Entrée | Terminer le tracé (ou valider la cote) |
| Échap | Annuler le tracé en cours |

---

## 📏 Preuve que « ça mesure juste »

Un segment réel de **1 m** exporté à **1:100** mesure **10 mm** sur la feuille.
Vérifié automatiquement par `npm test`, et mesuré au pixel près sur le rendu A4
(rectangle 10×8 m → 100×80 mm papier). Le PDF est reconnu comme **A4 exact**
(841,89 × 595,276 pt en paysage).
