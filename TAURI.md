# QlygoCAD — application de bureau (.exe / .app) avec Tauri

Ce dossier `src-tauri/` transforme QlygoCAD en **vraie application installée**
(un `.exe` sous Windows, un `.app`/`.dmg` sous macOS) — **pas** un raccourci
navigateur ni une PWA. Tout le dessin reste le même code web (`engine/*`,
`app-poc.js`) : Tauri ne fait qu'ouvrir une fenêtre native autour.

**Tauri est 100 % gratuit et open-source.** Aucun compte, aucune licence,
aucun coût de signature obligatoire. Le `.exe` produit est léger (quelques Mo,
pas ~100 Mo comme Electron) car il réutilise le moteur web déjà présent dans
Windows (WebView2) et macOS (WebKit).

---

## 1. À installer UNE SEULE FOIS sur l'ordinateur qui compile

> ⚠️ Ces outils servent à **fabriquer** l'application. Une fois le `.exe`
> construit, la personne qui l'utilise n'a **rien** à installer.

### Windows
1. **Node.js** (LTS) — https://nodejs.org (déjà là si `npm` répond).
2. **Rust** — https://www.rust-lang.org/tools/install (exécuter `rustup-init.exe`).
3. **Microsoft C++ Build Tools** — https://visualstudio.microsoft.com/visual-cpp-build-tools/
   cocher « Développement Desktop en C++ ».
4. **WebView2** — déjà présent sur Windows 10/11 à jour (sinon « Evergreen
   Runtime » sur le site Microsoft Edge WebView2).

### macOS
1. **Node.js** (LTS).
2. **Rust** (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`).
3. **Xcode Command Line Tools** : `xcode-select --install`.

---

## 2. Construire l'application

Depuis la racine du projet (`D:\IA\QLYGO\qlygocad\` ou équivalent) :

```bash
npm install          # récupère l'outil Tauri (une seule fois)
npm run tauri:build  # compile l'application native
```

La première compilation est longue (Rust compile ses dépendances : 5–15 min).
Les suivantes sont rapides.

Le résultat se trouve dans :

```
src-tauri/target/release/bundle/
├── msi/QlygoCAD_0.98.0_x64_en-US.msi      (installateur Windows)
├── nsis/QlygoCAD_0.98.0_x64-setup.exe     (installateur Windows alternatif)
├── dmg/QlygoCAD_0.98.0_aarch64.dmg        (macOS)
└── macos/QlygoCAD.app                     (macOS)
```

> Important : on ne compile un `.exe` **que** sous Windows, et un `.app`/`.dmg`
> **que** sous macOS. Chaque système fabrique sa propre version.

## 3. Lancer en mode développement (fenêtre native + rechargement)

```bash
npm run tauri:dev
```

---

## Comment ça marche (pour mémoire)

- `npm run tauri:build` lance d'abord `node prepare-dist.mjs`, qui recopie
  uniquement les fichiers web utiles (`index.html`, `poc.html`, `app-poc.js`,
  `engine/`, `assets/`, `ver.txt`) dans un dossier `dist/` propre.
- Tauri embarque ce `dist/` dans le binaire et ouvre `poc.html` au démarrage.
- `dist/`, `src-tauri/target/` et `node_modules/` sont ignorés par git
  (ils se régénèrent à la compilation).

## Enregistrement sur le disque dur

QlygoCAD enregistre / ouvre les fichiers `.qcad` et exporte en PDF/DXF via les
API web standard (File System Access), supportées par WebView2 sous Windows.
Si un jour macOS pose problème sur ces API, on ajoutera les plugins Tauri
`dialog` + `fs` (déclarés dans `src-tauri/capabilities/default.json`).

---

## Alternative déjà en place : Electron

Le projet contient aussi un shell **Electron** (`src/main.js`), qui produit
également une vraie application native. Electron ne demande **que Node.js**
(pas de Rust ni de build tools C++), donc il est plus simple à compiler, mais
le `.exe` est beaucoup plus lourd (~100 Mo). Pour l'essayer :

```bash
npm install
npm start            # ouvre QlygoCAD dans une fenêtre Electron
```

Tauri (ci-dessus) reste recommandé pour la version distribuée : plus léger,
plus rapide, démarrage quasi instantané.
