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
