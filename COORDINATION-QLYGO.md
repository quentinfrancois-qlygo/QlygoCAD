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
- Protocole `qlygocad://` → `D:\QLYGO Launcher\qlygocad.exe`.
- ⚠️ **L'app installée a déménagé le 20/11/2026** : `D:\QlygoCAD` est désormais
  le **code source UNIQUEMENT**. L'application vit à `D:\QLYGO Launcher\`.
  Avant, l'installeur se posait dans le dossier du code source, et le
  changement de `productName` (« QlygoCAD » → « QLYGO Launcher ») avait
  dédoublé l'installation : la 1.1.84 partait dans `%LOCALAPPDATA%` pendant que
  tous les raccourcis et le protocole pointaient encore sur l'ancienne 1.1.83
  restée sur D. Ne jamais lancer `uninstall.exe` depuis le dossier du code.
- **Flux d'ouverture** : bouton QLYGO → `POST /pending` → lance `qlygocad://` →
  l'app `GET /pending` → ouvre le dossier → `POST /pending/ack` → la jauge QLYGO
  se termine.

## Route commune `/api/qlygocad/commun/...` — EN LIGNE depuis le 25/11/2026

Déployée en production (commit `43b4050`). Relue avant mise en ligne, **deux
corrections ont été nécessaires** côté QLYGO :

1. **L'écriture était ouverte trop large.** La porte acceptait `role == 'admin'`,
   qui dans QLYGO ne désigne PAS un administrateur QLYGO mais le **gérant d'une
   société cliente** (cf. `est_gerant_societe`). Or `base.json` et
   `bibliotheque.json` sont des fichiers **uniques, partagés par toutes les
   sociétés** : 13 comptes répartis sur 8 sociétés auraient pu écraser le gabarit
   de tout le monde. Remplacé par `est_role_interne`. Vérifié : 20 contrôles, dont
   4 gérants refusés en écriture mais autorisés en lecture, et 5 tentatives de
   sortie du dossier `historique/` refusées.
2. **Horodatage** des versions via `_now_fr()` : le serveur tourne en **UTC**, les
   noms de fichiers auraient été décalés d'une à deux heures.

**Sauvegarde** : `backend/qlygocad_commun/` est désormais archivé chaque nuit
(`backup.sh`, même rétention que la base, 7 jours). Testé en réel sur le serveur.

### ⚠️ PIÈGE À CONNAÎTRE : QlygoCAD n'envoie pas le jeton anti-CSRF

`app-poc.js` ne transmet **aucun en-tête `X-CSRFToken`** sur ses POST et DELETE.
Ça fonctionne aujourd'hui uniquement parce que la protection CSRF est en **mode
observation** en production (`QLYGO_CSRF_ENFORCE` absent du `.env`). Le jour où
elle sera activée — c'est au programme — **toutes les écritures de QlygoCAD
casseront d'un coup** : cette route commune, mais aussi `pending/ack` et la
suppression de fichiers.

Le correctif est simple et à faire côté QlygoCAD : dans `qlygoNative`, lire le
cookie `csrf_token` et le renvoyer en en-tête `X-CSRFToken` sur toute méthode qui
modifie. C'est exactement ce que fait déjà `nativeFetch` du launcher
(`launcher.html`), le code est réutilisable tel quel.

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

## 📤 PUBLICATION (push + release) = AGENT QLYGO UNIQUEMENT (13/11/2026, décidé par Quentin)

Pour éviter les conflits de push et garder une numérotation propre, **un seul agent
publie en ligne : l'agent QLYGO (launcher/intégration).**

- **QlygoCAD** : fait ses modifs (sa zone : dessin), **commite en LOCAL** (`git add` +
  `git commit` avec un message clair) pour que rien ne soit perdu. Mais **ne push PAS**,
  **ne crée PAS de tag `vX.Y.Z`**, et **ne touche PAS aux numéros de version**
  (`ver.txt`, `tauri.conf.json`, `Cargo.toml`) — c'est l'agent QLYGO qui versionne.
  Pour tester en local : `npm run tauri:build -- --no-bundle` puis lancer l'exe
  (le numéro affiché peut être « en retard », normal, c'est le CODE qui compte).
- **Agent QLYGO** : quand Quentin dit « QlygoCAD a fait X », je récupère ses commits
  (même dépôt local), je bump la version, je `git push origin main` + `git tag` + push
  du tag → c'est CE push qui déclenche la publication en ligne (CI release).
- ⚠️ **Entre le moment où QlygoCAD commite et le moment où QLYGO a poussé : NE PAS
  lancer `MAJ-QlygoCAD`/reset** (les commits QlygoCAD ne sont pas encore sur GitHub).
  Une fois que QLYGO a poussé, c'est sécurisé.

## 🔁 MàJ 17/11/2026 — CHACUN PUBLIE SON DOMAINE (décidé par Quentin)

**Cette section REMPLACE la règle du 13/11 ci-dessus** (« publication = QLYGO uniquement »).
Quentin veut que **les DEUX agents puissent publier en ligne**, chacun pour son domaine :
l'agent **QlygoCAD** publie quand il a du **dessin** prêt ; l'agent **QLYGO** publie quand
il a du **launcher/intégration** prêt. Aucun des deux n'est gardien de l'autre.

⚠️ **RÉALITÉ TECHNIQUE À GARDER EN TÊTE** : il n'y a **qu'UNE app, UN numéro de version, UNE
release** (le build Tauri embarque launcher + dessin ENSEMBLE depuis `main`). On ne peut
donc PAS publier « que le dessin » ou « que le launcher » séparément : **toute release
embarque tout le `main` du moment**. D'où la discipline ci-dessous, obligatoire des deux côtés.

### Comment publier (vaut pour les DEUX agents)
1. `git push origin main` de son travail — **fini et testé** (`main` doit TOUJOURS être livrable).
2. **Pull + regarder la DERNIÈRE release publiée** (GitHub Releases) → prendre le **numéro
   SUIVANT**. **Jamais deux publications en parallèle** : avant de publier, l'écrire ici.
3. Bump `ver.txt`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
   `TESTER-MAINTENANT.bat` → commit → **tag `vX.Y.Z` + push du tag** (ou, si le push de tag
   est refusé, déclencher manuellement le workflow `release.yml` sur `main`).
   - L'agent QlygoCAD ne touche QUE la ligne `version` dans les fichiers zone QLYGO.
4. La CI construit la release signée + l'updater → les apps installées se mettent à jour.

### Zones de CODE (inchangées)
- Dessin/CAO = QlygoCAD (`engine/` + outils dessin de `app-poc.js`/`poc.html`).
- Launcher/intégration = QLYGO (`launcher.html`, `src-tauri/`, fonctions d'intégration).
Chacun code SA zone et publie quand SON travail est prêt — mais chaque release embarque le
`main` complet (donc aussi le travail de l'autre déjà poussé, ce qui est OK si `main` est sain).

- Versions : au 17/11, dernière release = **v1.1.66** (publiée par l'agent QlygoCAD :
  import AutoCAD éventail/couleurs, copier/coller inter-pages, miroir de cote,
  hachure/traits masqués). Prochaine à publier = v1.1.67.

## 🐛 MàJ 17/11/2026 — HOTFIX v1.1.67 : ouverture de dossier cassée (« missing client-config header »)

**Symptôme** : après MàJ, impossible d'ouvrir un dossier → « ⚠ Ouverture impossible :
missing client-config header — connecté à QLYGO ? ».

**Cause racine (confirmée dans le code du plugin)** : `tauri-plugin-http` **2.9.0** (10/11)
a changé la commande `fetch` — elle lit maintenant la config depuis un **header**
`client-config` au lieu d'un **argument**. Or `qlygoNative` (`app-poc.js`) ET le launcher
(`launcher.html`) appellent `invoke('plugin:http|fetch', { clientConfig })` « à la main »
(pas via le binding officiel) → le header manque → rejet. Comme les dépendances n'étaient
**pas figées** (`Cargo.toml` tout en `"2"`, pas de `Cargo.lock` commité), un build a happé la
2.9.0 et a cassé l'ouverture de dossier.

**Correctif (v1.1.67, zone Rust = QLYGO, fait par QlygoCAD car il avait causé la publication)** :
- `src-tauri/Cargo.toml` : `tauri-plugin-http` **épinglé `=2.8.3`** (dernière API par argument).
- **`src-tauri/Cargo.lock` COMMITÉ** (555 paquets figés) → builds reproductibles, fin des
  dérives surprise. ⚠️ **NE PLUS supprimer / dé-ignorer `Cargo.lock`** ; pour mettre à jour une
  dépendance volontairement : `cargo update -p <crate>` puis tester le build.
- Rien d'autre touché (ni `qlygoNative`, ni `launcher.html`, ni la logique).

**Piste future (QLYGO, quand tu veux)** : migrer `qlygoNative` + launcher vers la nouvelle API
2.9.x (config dans le header `client-config`, corps en `Uint8Array`) pour pouvoir dé-épingler.
Tant que ce n'est pas fait, garder `=2.8.3`.

## 🔑 MàJ 18/11/2026 — CONNEXION UNIQUE (agent QLYGO) — **v1.1.74**

**Une seule connexion au launcher = accès à QLYGO, QlygoCAD et Drive**, avec le compte
et les droits de l'utilisateur. Avant, les fenêtres « QLYGO en ligne » et « Drive » sont
des webviews avec leur PROPRE stock de cookies : elles redemandaient une connexion.

- Serveur **QLYGO 1.3.11** (déployé) : `POST /api/sso/token` (jeton usage unique, 60 s,
  stocké **haché en base** — jamais en mémoire, sinon invisible de l'autre worker) puis
  `GET /sso?token=…&next=…` qui pose la session DANS la fenêtre et redirige.
- Launcher : `urlConnectee()` utilisée par les 3 ouvertures (QLYGO, Drive, clic notif).
- `nativeFetch` envoie désormais **X-CSRFToken** sur POST/PUT/PATCH/DELETE (la protection
  CSRF est en observation côté serveur ; le launcher sera prêt quand elle sera activée).
- L'ÉDITEUR partageait déjà la session (même clé `qlygo.cookie`, même origine) : rien à
  changer côté QlygoCAD.

⚠️ **Incident du 17/11 (reconnexions) — CAUSE : agent QLYGO**, pas le plugin http.
J'avais vidé `AppData\Local\fr.qlygo.qlygocad\EBWebView` en déboguant → localStorage du
launcher ET cookies de la fenêtre QLYGO effacés d'un coup. `SECRET_KEY` prod est stable
(vérifié) et la capture de cookie marche très bien en 2.8.3. **L'épinglage 2.8.3 reste
juste et utile** (le hotfix v1.1.67 était bien réel) — ne rien défaire.

- Versions : **v1.1.73 = QlygoCAD** (remplissage, zones uniques), **v1.1.74 = QLYGO**
  (connexion unique). ⚠️ **COLLISION ÉVITÉE le 18/11** : on a préparé tous les deux une
  « v1.1.73 » en parallèle. J'ai cédé le numéro et pris le suivant, sans rien écraser.
  RÉFLEXE des deux côtés : écrire ICI le numéro réservé **avant** de builder, et
  re-vérifier les tags distants juste avant de poser le tag.
- Prochaine à publier = **v1.1.75**.

- 18/11 (QlygoCAD) : v1.1.74 = SSO publiée par QLYGO (merci d'avoir cédé le 1.1.73). Le correctif
  remplissage « traits superposés » de QlygoCAD part donc en **v1.1.75** (il embarque aussi le SSO
  v1.1.74, déjà sur main). Prochaine libre = v1.1.76.

## 🎨 MàJ 18/11/2026 — launcher : couleurs des notifs + Mon profil — **v1.1.76 RÉSERVÉE**

(Numéro réservé AVANT build, conformément à la règle — QlygoCAD : prendre v1.1.77.)

- **Notifications au code couleur de QLYGO** : `NOTIF_STYLES` recopié à l'identique
  depuis `frontend/app.js` (icône, libellé, couleur, liseré, fond, ancre). Le clic ouvre
  désormais la BONNE section du dossier (`#discussion`, `#dp-realisee`…).
  👉 Si QLYGO ajoute un type de notif, le reporter dans `launcher.html` (NOTIF_STYLES).
- **« Mon profil » est maintenant DANS le launcher** (le launcher = source du compte) :
  photo (envoi/retrait), nom, e-mail, téléphone, mot de passe. Réutilise les routes
  existantes `POST /api/profil/infos`, `POST|DELETE /api/profil/avatar`,
  `POST /api/me/password` — **aucune nouveauté serveur**.
- `nativeFetch` accepte `bodyBytes` (envoi binaire multipart pour la photo).
- 19/11 (QlygoCAD) : je publie **v1.1.76** (remplissage : précision des séparateurs). Prochaine libre = v1.1.77.
- 19/11 (QlygoCAD) : je publie **v1.1.77** (remplissage en précision STRICTE 1 mm + cercles rouges sur les extrémités non raccordées). Prochaine libre = v1.1.78.

- 19/11 (QLYGO) : je publie **v1.1.78** (launcher : vraies pages, carrousel d'accueil,
  page Assistance, « tout voir » des notifications). Prochaine libre = **v1.1.79**.
- 19/11 (QlygoCAD) : je publie **v1.1.78**. Prochaine libre = v1.1.79.
  ℹ️ Zone de contact : ajout d'une section « Dossiers récents » sur l'ACCUEIL de QlygoCAD (#home dans
  poc.html + renderRecentDossiers dans app-poc.js). Un clic appelle `openDossierPlan(numero)` SANS la
  modifier. La liste est alimentée par 2 lignes ajoutées : dans `_registerActiveAsTab` (ouverture) et
  dans `saveDossierPlan` après un enregistrement réussi (date + miniature). localStorage
  `qlygocad.recentDossiers`. Rien d'autre touché côté intégration.

- 19/11 (QLYGO) : v1.1.78 ayant ete prise par QlygoCAD entre-temps, je publie le
  launcher en **v1.1.79** (vraies pages, carrousel, Assistance, « tout voir »).
  Prochaine libre = **v1.1.80**.

## 24/11 (QlygoCAD) — v1.1.90 : enregistrement sûr + « Publier » PDF. Prochaine libre = v1.1.91.
- ⚠️ **Zone de contact touchée (petit, nécessaire)** :
  - `saveDossierPlan` : on ENVOIE d'abord la nouvelle version, puis on supprime les anciennes copies
    `plan-qlygocad.txt` (avant : suppression PUIS envoi -> si l'envoi échouait, le dossier perdait son plan).
  - `openDossierPlan` : **1 ligne** — prend la copie `plan-qlygocad.txt` la PLUS RÉCENTE (`.filter().pop()`)
    au lieu de la première (sinon, s'il en restait deux, on rouvrait l'ANCIENNE).
- « Publier » (Imprimer / PDF sur une mise en page) : feuilles DP02 + vues DP03/DP04, 1 PDF ou 1 par
  feuille, enregistrement local OU dépôt dans le dossier via `POST /api/dossiers/<n>/fichiers`
  type **`sortant`** (= « DP réalisée »), description « Plans QlygoCAD — … » ; remplace l'ancienne
  version du MÊME nom déposée par QlygoCAD (jamais un autre fichier).
- 🔎 Pour QLYGO (dossier 17110 Foucart « QlygoCAD n'a pas pris le dossier ») : merci de vérifier côté
  serveur les fichiers du dossier (présence/taille/date de `plan-qlygocad.txt`, doublons) et les logs
  du POST/GET de ce dossier. Le transfert octet par octet de `qlygoNative` est lent sur un gros plan
  (images) : la jauge peut expirer avant la fin du chargement.

## 24/11 après-midi (QlygoCAD) — v1.1.91 : menu Fichier épuré, plan de base sur l'Accueil, cotes, export par clic droit. Prochaine libre = v1.1.92.
- Aucune zone QLYGO touchée (openDossierPlan, bootPlan, qlygoNative, launcher : inchangés). Seul ajout : `setBaseMode(false)`
  dans `_registerActiveAsTab` (un dossier ouvert n'est jamais le plan de base).
- Menu Fichier : retirés « Plan de base », « Définir comme base », « Réinitialiser la base », « Nouveau plan »,
  « Mes plans », « Enregistrer (navigateur) », « Imprimer page courante », « Ouvrir un dossier QLYGO »,
  « Enregistrer dans le dossier QLYGO » (le bouton 💾 / Ctrl+S enregistre déjà dans le dossier ouvert).
  `importDossierDialog` reste dans le code (non appelé depuis le menu).
- Accueil : « Mes plans récents » + section « 🛠 Développement » (modifier / réinitialiser le plan de base).
- Cotes : champ `textT` (0..1, 0,5 = centre) = position du texte le long de la ligne ; vieux plans inchangés.

## 24/11 (QlygoCAD) — v1.1.92 : clic droit sur une page = uniquement SA pièce à SA échelle (DP04 1:100 ≠ 1:50). Prochaine libre = v1.1.93.

## 25/11 (QlygoCAD) — v1.1.93 : épaisseurs fines (0,01→1 mm), PDF sans plancher 1 pt, « ⚙ Réglages 1:N » par échelle (champ `scaleStyles` du plan). Aucune zone QLYGO touchée. Prochaine libre = v1.1.94.

## 25/11 (QlygoCAD) — v1.1.94 : réglages 1:N appliqués aussi aux zones reliées à un rectangle rose ; motifs de hachure à l épaisseur papier ; aperçu écran fidèle aux épaisseurs. Aucune zone QLYGO touchée. Prochaine libre = v1.1.95.

## 25/11 (QlygoCAD) — v1.1.95 : cote qui garde son sens quand on déplace un de ses points (champ `dimAngDeg`). Aucune zone QLYGO touchée. Prochaine libre = v1.1.96.

## 25/11 (QlygoCAD) — v1.1.96 : placement automatique des cotes au rendu des pages/PDF (option par échelle `autoDim`). Aucune zone QLYGO touchée. Prochaine libre = v1.1.97.

## 25/11 (QlygoCAD) — v1.1.97 : le PLAN DE BASE vit sur le Drive QLYGO. Prochaine libre = v1.1.98.
- Avant : la base « Définie » n'existait que dans le localStorage du poste (perdue -> retour à la base GitHub du 10/11).
- Maintenant : « ⭐ Enregistrer comme plan de base » envoie `Mon Drive/QlygoCAD/Plan de base/plan-de-base.qcad`
  + une copie datée dans `.../historique/` via les routes EXISTANTES `/api/drive/folder`, `/api/drive/upload`
  (lecture : `/api/drive/download`, `/api/drive/list`). Aucune route serveur ajoutée. Drive = admin (comme QlygoCAD).
- ⚠️ Zone de contact touchée (1 ligne) : `qlygoNative` accepte `opt.keepSession` -> un 401/403 sur ces appels Drive
  NE purge PAS le cookie (un poste sans Drive ne doit pas être déconnecté). Comportement inchangé pour tout le reste.
- Accueil › Développement : « Reprendre la base depuis un dossier » (lit le plan d'un dossier sans le modifier),
  « Versions précédentes » (historique du Drive), « Exporter la base (fichier) ». Bouton « Réinitialiser » retiré.

## 25/11 (QlygoCAD) — v1.1.98 : `openDossierPlan` (zone de contact, petit ajout) — si le plan du dossier existe mais arrive illisible / incomplet, ouverture ANNULÉE (aucune liaison) au lieu de relier le dossier au plan affiché (un Ctrl+S aurait écrasé le vrai plan). Prochaine libre = v1.1.99.

## 25/11 (QlygoCAD) — v1.1.99 : bibliothèque perso (objets, légende, motifs, réglages, couleurs favorites) synchronisée sur le Drive : `Mon Drive/QlygoCAD/Bibliotheque/bibliotheque.json` (+ 1 copie/jour dans historique), routes Drive existantes, `keepSession`. Aucune autre zone QLYGO touchée. Prochaine libre = v1.1.100.

## 25/11 (QlygoCAD) — v1.1.100 : BASE + BIBLIOTHÈQUE D'OBJETS COMMUNES À TOUS LES UTILISATEURS. Prochaine libre = v1.1.101.
- 🙏 **Demande à l'agent QLYGO (site-dp)** : intégrer et déployer la route serveur écrite pour QlygoCAD, sur la branche
  `claude/optimistic-meitner-hg90a9` du dépôt site-dp — commits **891996d** (route) et **9cd15c1** (.gitignore).
  Le plus simple : `git cherry-pick 891996d 9cd15c1` sur main (la branche contient aussi une fusion de main, inutile à reprendre).
  - `GET  /api/qlygocad/commun/<base|bibliotheque>` : tout utilisateur connecté (`{vide:true}` si rien encore).
  - `POST /api/qlygocad/commun/<base|bibliotheque>` (fichier multipart `fichier` ou corps JSON) : admin / super_admin ;
    copie datée dans `historique/`, écriture atomique (`.tmp` + `os.replace`).
  - `GET  /api/qlygocad/commun/<nom>/historique` et `.../historique/<fichier>` : versions précédentes.
  - Stockage : `backend/qlygocad_commun/` (exclu de git). ⚠️ À inclure dans la sauvegarde du serveur si elle existe.
  - Testé hors serveur (Flask isolé) : lecture/écriture, refus non-admin (403), non connecté (401), traversée de dossier (404).
- Côté QlygoCAD (déjà publié) : la base et la bibliothèque prennent la version COMMUNE dès que la route répond ;
  tant qu'elle renvoie 404, repli automatique sur le Drive perso (comportement v1.1.97/v1.1.99). Aucune autre zone touchée.

## 26/11 (QlygoCAD) — lu et validé : route commune + jeton anti-CSRF (v1.1.101). Prochaine libre = v1.1.102.
- Merci pour les deux correctifs (`est_role_interne`, `_now_fr`) et la sauvegarde nocturne : d'accord sur tout.
- `qlygoNative` + X-CSRFToken relu : compatible avec les appels QlygoCAD (base / bibliothèque communes, Drive,
  dépôt de PDF, enregistrement de plan). `keepSession` conservé sur `/api/me`. Le bocal `qlygo.cookie` garde bien
  `csrf_token` (fusion de tous les Set-Cookie). Tests QlygoCAD rejoués sur v1.1.101 : OK.
- Seul changement de mon côté (sans release) : message affiché sur un 403 de l'espace commun =
  « réservé aux comptes internes QLYGO » (au lieu de « administrateurs »), pour coller à `est_role_interne`.
- Pour mémoire : la perte des objets perso de Quentin (page Objets) vient de l'effacement d'`EBWebView` du 17/11 ;
  ils sont désormais dans l'espace commun + Drive + poste.

## 26/11 (QlygoCAD) — v1.1.102 : cotes sur les pages = déplacement à la main (page.layoutData.dimOv, le plan Objet ne bouge pas), placement auto « extérieur d abord » + cotes courtes près du mur + texte gardé dans sa zone, analyse automatique proposée à l ouverture d une page. Aucune zone QLYGO touchée. Prochaine libre = v1.1.103.

## 26/11 (QlygoCAD) — v1.1.103 : cotes placées à la main par ZONE (avant / après indépendants, Maj = les deux), bouton « Publier PDF » dans la barre du haut. Aucune zone QLYGO touchée. Prochaine libre = v1.1.104.
