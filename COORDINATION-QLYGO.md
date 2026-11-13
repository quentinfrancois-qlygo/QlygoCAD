# Coordination QLYGO ↔ QlygoCAD

> Contrat partagé entre les DEUX agents de développement de Quentin.
> Posé le 06/11/2026. **À tenir à jour par les deux côtés.** Lu par les deux.

## Qui fait quoi (décidé par Quentin, 06/11/2026)

### Agent QLYGO — « intégration & mises en ligne »
Dépôt `D:\IA\QLYGO`, prod `qlygo.fr`.
- Pousse les mises à jour et **déploie** (tout ce qui est en ligne).
- Possède **tout ce qui RELIE QLYGO en ligne ↔ QlygoCAD** : bouton « Ouvrir dans
  QlygoCAD » dans la prépa, endpoints serveur `/api/qlygocad/pending` (set/get),
  `/pending/status`, `/pending/ack`, la **jauge**, le **handshake** du protocole
  `qlygocad://`.
- Possède tout le reste **non-CAO** (stabilité serveur, notifications, dossiers…).

### Agent QlygoCAD — « l'USAGE CAO / le dessin »
Dépôt `D:\QlygoCAD` (GitHub `quentinfrancois-qlygo/QlygoCAD`).
- Développe **le dessin** : `engine/` (moteur) + la partie dessin de `app-poc.js` /
  `poc.html` (outils, cotation, hachures, export…).
- Tout ce qui est **purement technique CAO / dessin**.
- ⚠️ **PAS le shell/launcher** (voir ci-dessous).

### Agent QLYGO — possède AUSSI le LAUNCHER (clarifié 06/11/2026)
L'**application elle-même** (le « QLYGO Launcher ») = agent QLYGO :
`launcher.html`, `src-tauri/` (fenêtres, tray, comportement de fermeture),
`tauri.conf.json`, le **renommage en « QLYGO Launcher »**, l'architecture
(Launcher = contenant ; QLYGO et QlygoCAD = 2 fenêtres distinctes qu'il ouvre).
Rework en cours — **Passe 1 FAITE** (multi-fenêtres + rename + capabilities, sans
Rust) ; **Passe 2 = tray** (Rust). ⚠️ QlygoCAD : **ne touche plus** `launcher.html`,
`src-tauri/`, `tauri.conf.json`, `capabilities/` — c'est la zone QLYGO maintenant.

### Zone de contact (on se parle ICI)
Le protocole `qlygocad://`, le launcher, l'ouverture d'un dossier depuis QLYGO.
Quand l'un touche à l'**interface entre les deux**, il l'écrit dans ce fichier.

## Canal commun
- **CE FICHIER** = le contrat partagé. L'agent QLYGO en garde une copie dans sa
  mémoire projet. Pas de messagerie live entre les deux (bloquée) → **Quentin
  relaie** si c'est urgent.

## État au 06/11/2026 — côté QLYGO (stabilité, FAIT)
QLYGO prod = **1.3.4**. Trois correctifs de fond déployés :
- `max-requests` gunicorn 150 → 1500 (fin du recyclage permanent des workers).
- Dédup des notifications **persistante** en base (fin des doublons Telegram).
- **L'ANCIEN agent AutoCAD est ARRÊTÉ et retiré de l'autostart**
  (`D:\IA\QLYGO\agent\qlygo_arriere_plan.ps1`). Il interrogeait
  `/api/qlygocad/agent/poll` **toutes les 5 s = 43 % de la charge serveur** alors
  qu'AutoCAD est remplacé par QlygoCAD natif.
  👉 **QlygoCAD : ne PAS relancer cet agent AutoCAD, c'est volontaire.**

## Ce que l'agent QLYGO a compris de QlygoCAD (pour info)
- App **Tauri** (+ Electron en alternative), **v1.1.8**, à `D:\QlygoCAD`.
- Moteur `engine/` **framework-agnostic** → embarquable dans QLYGO plus tard.
- Protocole `qlygocad://` → `D:\QlygoCAD\qlygocad.exe`.
- **Flux d'ouverture** : bouton QLYGO → `POST /pending` → lance `qlygocad://` →
  l'app `GET /pending` → ouvre le dossier → `POST /pending/ack` → la jauge QLYGO
  se termine.

## En cours / à faire ensemble
- [x] **RÉOUVERTURE « Échec de l'enregistrement HTTP 502 » : RÉGLÉ côté QLYGO
      (06/11/2026).** DIAGNOSTIC pour info QlygoCAD : ce message venait du bouton
      « Ouvrir dans QlygoCAD » de la prépa QLYGO (son ÉTAPE 2 = `PUT /api/dossiers/<id>`
      qui enregistre la fiche) qui prenait un **502 parce que le serveur était saturé**
      (par l'ancien agent AutoCAD + le recyclage). **Ce n'était PAS un bug de l'app
      QlygoCAD.** Corrigé : serveur stabilisé + réessai auto sur 502/503/504 dans la
      prépa. → **QlygoCAD : rien à faire de ton côté pour ce point précis.** Si un
      souci de 2ᵉ ouverture PERSISTE côté app (instance déjà lancée / protocole
      `qlygocad://` pas re-capté), ça c'est ta zone — dis-le ici.
- [x] **Jauge QLYGO** : elle va déjà 0→100 (5 étapes, timeout 45 s), conforme au
      besoin → gardée telle quelle.
- [ ] Vision : QLYGO + QlygoCAD **téléchargeables depuis QLYGO** (onglet
      « Applications »), accès gated par abonnement + **auto-updater Tauri**.

## MàJ 09/11/2026 — côté launcher (agent QLYGO)
Série de correctifs launcher **v1.1.50 → v1.1.53** (zone launcher = `launcher.html` +
`src-tauri/`, ne pas y toucher côté QlygoCAD) :
- v1.1.50 : masquage tray fiable (commande Rust) + `prevent_exit` (fermer une fenêtre
  ne quitte plus l'app).
- v1.1.51 : la veille « dossier en attente » n'est plus relancée sur le simple focus
  (sinon sortir le launcher du tray rouvrait QlygoCAD).
- v1.1.52 : veille **bornée** (~20 s, fin du poll perpétuel) + anti-réouverture du même
  dossier.
- v1.1.53 : **« le dossier s'ouvre en double » corrigé** côté launcher. Le handler de
  lien profond `go()` passe maintenant par `openCad()` (fenêtre QlygoCAD unique,
  dédupliquée) au lieu de transformer la fenêtre du launcher en éditeur.

⚠️ **Point à clarifier ENSEMBLE** : il y a **DEUX veilles** qui interrogent
`/api/qlygocad/pending` : celle du **launcher** (la mienne) et celle de **l'éditeur**
(`startEditorPendingWatch`, `app-poc.js`, sonde 3 s en continu). Pour l'instant ça
coexiste (l'éditeur déduplique les onglets, le launcher déduplique les fenêtres), mais
il faudrait décider **qui pilote l'ouverture d'un dossier** pour éviter les courses.
👉 QlygoCAD : si tu changes le comportement de `onCloseRequested` (croix de la fenêtre
poc.html) ou de `startEditorPendingWatch`, **écris-le ici** — ça touche directement le
launcher.

## 🔒 PROTOCOLE DE SÉCURITÉ — on partage le MÊME dossier et le MÊME dépôt (13/11/2026)

Les deux discussions travaillent dans `D:\QlygoCAD` et poussent sur le même GitHub.
Ce n'est donc PAS cloisonné : sans discipline, l'un peut écraser le travail de l'autre.
Règles simples, obligatoires des deux côtés :

1. **AVANT de changer de discussion : `git add` + `git commit` + `git push origin main`.**
   Ne jamais laisser du travail non poussé en partant. (Le 13/11, 2 commits launcher
   non poussés auraient été perdus par un `MAJ-QlygoCAD`/reset — plus jamais.)
2. **AVANT de travailler : `git pull origin main`** pour partir de la dernière version.
3. **JAMAIS de `git reset --hard` ni de push forcé** vers une version ancienne.
   ⚠️ `MAJ-QlygoCAD.bat` fait `git reset --hard origin/main` : ne le lancer QUE si
   origin/main contient bien le dernier travail des DEUX côtés (donc après push).
4. **Numéro de version** : celui qui publie prend le suivant (pull d'abord). Au
   13/11, origin/main = **v1.1.62**, à jour avec tout le travail launcher.

### Zones (qui édite quoi)
- **Launcher / intégration (agent QLYGO) — NE PAS toucher côté QlygoCAD** :
  `launcher.html`, tout `src-tauri/` (Rust, `icons/`, `capabilities/`, `tauri.conf.json`,
  `Cargo.toml`), le bloc de DÉMARRAGE + anti-cache de `poc.html`, et dans `app-poc.js`
  les fonctions d'INTÉGRATION : `openDossierPlan`, `applyDossierInfo`, `bootPlan`,
  `startEditorPendingWatch`, `onCloseRequested`, `qlygoNative`, le handshake `/pending`.
- **Dessin / CAO (agent QlygoCAD)** : tout `engine/`, et dans `app-poc.js`/`poc.html`
  les OUTILS DE DESSIN (lignes, cotes, hachures, calques, export…).
- **Fichier réellement PARTAGÉ = `app-poc.js`** (intégration + dessin dans le même
  fichier). C'est le point de friction n°1 → d'où la règle 1 (push avant de switcher)
  et « reste dans ta zone ».

### Récent côté launcher (origin/main à jour) — ne pas défaire
- v1.1.58 : correctif racine « ouvre la base au lieu du dossier » (anti-cache de
  `poc.html` désactivé dans l'app : il effaçait `?dossier=`).
- v1.1.59 : ouvrir QlygoCAD sans dossier → écran Accueil (bootPlan `showHome`).
- v1.1.60 : un logo par fenêtre. v1.1.61 : icône de base = logo LAUNCHER (icons/).
- v1.1.62 : `applyDossierInfo` pose `p.layoutData.bandColor` = couleur de la société
  (champ `data.societe_couleur`, exposé par QLYGO 1.3.10). → les bandeaux de mise en
  page prennent la couleur de marque de la société. **Ne pas retirer ce champ.**
