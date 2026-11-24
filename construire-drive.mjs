// Fabrique « drive.html » (QLYGO Drive, application autonome du launcher) à partir
// de la page servie par QLYGO. Une seule source de vérité : le fichier d'origine
// n'est PAS recopié à la main, il est transformé ici, à chaque build.
//
// Ce que la transformation ajoute, c'est une passerelle :
//   - les appels de données partent par le pont natif de Tauri (sinon le navigateur
//     refuse de parler à qlygo.fr depuis une page locale) ;
//   - les vignettes sont récupérées en binaire puis réaffichées depuis la mémoire ;
//   - les téléchargements et l'extraction .zip passent par un jeton SSO à usage
//     unique et sont pris en charge nativement (le pont transporte octet par octet,
//     ce qui irait très mal pour une archive de plusieurs centaines de méga).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ici = dirname(fileURLToPath(import.meta.url));

// SOURCE UNIQUE. Depuis le 20/11/2026, la page du Drive appartient au launcher :
// elle a été retirée de QLYGO (la route /explorateur redirige maintenant vers /app)
// pour qu'il n'existe pas deux copies qui divergent doucement. Seules les API
// restent côté serveur : c'est la couche de données, et c'est elle qui porte le
// contrôle d'accès (super-admin).
const source = resolve(ici, 'drive-source.html');
if (!existsSync(source)) {
  console.error('[drive] source introuvable : ' + source);
  process.exit(1);
}

let html = readFileSync(source, 'utf8');

const PASSERELLE = `
<script>
/* ════════ Passerelle QLYGO Drive (ajoutée au build par construire-drive.mjs) ════════
   Cette page tourne dans le launcher, donc à une adresse locale. Sans cette
   passerelle, chacun de ses appels « /api/... » viserait le vide et le navigateur
   bloquerait la requête vers qlygo.fr. On réécrit donc fetch une fois pour toutes :
   le reste de la page continue de s'écrire exactement comme avant.           */
(function(){
  var QLYGO = 'https://qlygo.fr';
  var T = window.__TAURI__;
  if (!T || !T.core) { console.warn('[drive] pont Tauri absent : page laissée telle quelle'); return; }
  var invoke = T.core.invoke;

  // ── Dire CE QUI ne va pas, au lieu d'un « Impossible de charger » muet ──
  // Deux pannes nous ont coûté un aller-retour chacune faute de ce message :
  // la session lue au mauvais format, puis la fenêtre « qlygo-drive » absente de
  // la liste des permissions (src-tauri/capabilities/default.json).
  function alerter(titre, detail, aide){
    var id = 'drive-diagnostic';
    var vieux = document.getElementById(id); if (vieux) vieux.remove();
    var d = document.createElement('div');
    d.id = id;
    d.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;'
      + 'max-width:640px;background:#2B1416;border:1px solid #E53E3E;color:#FFE9E9;'
      + 'padding:14px 18px;font:14px/1.5 Inter,system-ui,sans-serif';
    d.innerHTML = '<b style="display:block;margin-bottom:4px">' + titre + '</b>'
      + '<span style="opacity:.85">' + detail + '</span>'
      + (aide ? '<div style="margin-top:8px;font-size:12.5px;opacity:.75">' + aide + '</div>' : '');
    (document.body || document.documentElement).appendChild(d);
    console.error('[drive] ' + titre + ' : ' + detail);
  }
  window.__driveAlerter = alerter;

  // ── Cookies de session, partagés avec le launcher ──
  // ATTENTION : le launcher ne range PAS la chaine de cookies telle quelle. Il la
  // range dans un objet { v: "<cookies>", ts: <date> }, avec une peremption de 30
  // jours. Lire la case brute renvoie donc le JSON entier, qui partait en en-tete
  // Cookie et que le serveur rejetait : c'etait la cause du « Impossible de charger
  // les dossiers ». On lit ET on ecrit dans le MEME format, sinon on casserait en
  // plus la session du launcher au premier appel.
  var CLE_COOKIE = 'qlygo.cookie';
  function lireCookie(){
    try {
      var o = JSON.parse(localStorage.getItem(CLE_COOKIE) || 'null');
      if (o && o.v && (Date.now() - (o.ts || 0) < 30 * 864e5)) return o.v;
    } catch(_){}
    return '';
  }
  function noterCookie(entetes){
    try {
      if (!entetes) return;
      var brut = entetes['set-cookie'] || entetes['Set-Cookie']; if (!brut) return;
      var liste = Array.isArray(brut) ? brut : [brut];
      var paires = {};
      lireCookie().split(';').forEach(function(p){ p = p.trim(); var i = p.indexOf('='); if (i > 0) paires[p.slice(0,i)] = p.slice(i+1); });
      liste.forEach(function(c){ var t = String(c||'').split(';')[0].trim(); var i = t.indexOf('='); if (i > 0) paires[t.slice(0,i)] = t.slice(i+1); });
      var refait = Object.keys(paires).map(function(k){ return k + '=' + paires[k]; }).join('; ');
      localStorage.setItem(CLE_COOKIE, JSON.stringify({ v: refait, ts: Date.now() }));
    } catch(_){}
  }

  // ── Serialisation multipart : indispensable pour deposer un fichier ──
  async function enMultipart(fd){
    // Le retour chariot est fabrique par code, volontairement.
    // Dans ce fichier, la passerelle vit dans un gabarit JS : toute sequence
    // d'echappement ecrite ici est interpretee une premiere fois a la generation.
    // Un retour chariot ecrit en dur devient donc un VRAI saut de ligne et casse
    // la page entiere (bug 1.1.86). Regle : aucun antislash dans ce bloc, meme
    // dans un commentaire. C'est ce commentaire-la qui avait reproduit le bug.
    var CRLF = String.fromCharCode(13, 10);
    var limite = '----qlygodrive' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var enc = new TextEncoder(), morceaux = [], entrees = [];
    fd.forEach(function(v, k){ entrees.push([k, v]); });
    for (var i = 0; i < entrees.length; i++) {
      var cle = entrees[i][0], val = entrees[i][1];
      if (typeof Blob !== 'undefined' && val instanceof Blob) {
        var nom = String(val.name || 'fichier').replace(/"/g, '');
        var type = val.type || 'application/octet-stream';
        morceaux.push(enc.encode('--' + limite + CRLF
          + 'Content-Disposition: form-data; name="' + cle + '"; filename="' + nom + '"' + CRLF
          + 'Content-Type: ' + type + CRLF + CRLF));
        morceaux.push(new Uint8Array(await val.arrayBuffer()));
        morceaux.push(enc.encode(CRLF));
      } else {
        morceaux.push(enc.encode('--' + limite + CRLF
          + 'Content-Disposition: form-data; name="' + cle + '"' + CRLF + CRLF
          + String(val) + CRLF));
      }
    }
    morceaux.push(enc.encode('--' + limite + '--' + CRLF));
    var total = morceaux.reduce(function(n, m){ return n + m.length; }, 0);
    var tout = new Uint8Array(total), pos = 0;
    morceaux.forEach(function(m){ tout.set(m, pos); pos += m.length; });
    return { octets: tout, type: 'multipart/form-data; boundary=' + limite };
  }

  // ── Un appel au serveur à travers le pont natif ──
  async function pont(chemin, opt, binaire){
    opt = opt || {};
    var url = /^https?:/i.test(chemin) ? chemin : QLYGO + chemin;
    var entetes = [], fournies = opt.headers || {};
    if (typeof fournies.forEach === 'function' && !Array.isArray(fournies)) {
      fournies.forEach(function(v,k){ entetes.push([k, String(v)]); });        // objet Headers
    } else {
      Object.keys(fournies).forEach(function(k){ entetes.push([k, String(fournies[k])]); });
    }
    var ck = lireCookie();
    if (ck) entetes.push(['Cookie', ck]);
    var methode = String(opt.method || 'GET').toUpperCase();
    if (['POST','PUT','PATCH','DELETE'].indexOf(methode) >= 0) {
      var m = /(?:^|;\\s*)csrf_token=([^;]+)/.exec(ck || '');
      if (m) entetes.push(['X-CSRFToken', decodeURIComponent(m[1])]);
    }
    var corps = null;
    if (opt.body instanceof Uint8Array) corps = Array.from(opt.body);
    else if (typeof FormData !== 'undefined' && opt.body instanceof FormData) {
      // Le pont natif ne transporte que des octets : un FormData doit etre
      // serialise A LA MAIN en multipart. Sans ca le corps partait VIDE et le
      // depot de fichier echouait en silence (constate le 20/11/2026).
      var mp = await enMultipart(opt.body);
      corps = Array.from(mp.octets);
      entetes = entetes.filter(function(h){ return String(h[0]).toLowerCase() !== 'content-type'; });
      entetes.push(['Content-Type', mp.type]);
    }
    else if (opt.body != null && typeof opt.body === 'string') corps = Array.from(new TextEncoder().encode(opt.body));
    else if (opt.body != null) corps = Array.from(new TextEncoder().encode(JSON.stringify(opt.body)));

    var rid;
    try {
      rid = await invoke('plugin:http|fetch', { clientConfig: { method: methode, url: url, headers: entetes, data: corps } });
    } catch (e) {
      var msg = String(e && e.message || e);
      if (/not allowed|forbidden|capabilit|permission/i.test(msg)) {
        alerter("Cette fenêtre n'a pas le droit d'appeler le serveur",
                "Le pont natif a refusé la requête.",
                "À corriger dans src-tauri/capabilities/default.json : la fenêtre « qlygo-drive » doit figurer dans « windows ».");
      } else {
        alerter("Le serveur est injoignable", msg, "Vérifie ta connexion, puis relance le Drive depuis le launcher.");
      }
      throw e;
    }
    var rep = await invoke('plugin:http|fetch_send', { rid: rid });
    noterCookie(rep && rep.headers);
    // On empile des TRANCHES et on assemble une seule fois. L'ancienne version
    // poussait octet par octet : des millions d'operations pour une seule photo.
    var tranches = [], recus = 0, garde = 0;
    for(;;){
      if (++garde > 200000) break;
      var bloc = await invoke('plugin:http|fetch_read_body', { rid: rep.rid });
      var arr = new Uint8Array(bloc);
      if (!arr.length) break;
      var utile = arr.subarray(0, arr.length - 1);
      tranches.push(utile); recus += utile.length;
      if (arr[arr.length - 1] === 1) break;
    }
    var brut = new Uint8Array(recus), ecrit = 0;
    tranches.forEach(function(t){ brut.set(t, ecrit); ecrit += t.length; });
    if (binaire) return { status: rep.status, bytes: brut, headers: rep.headers || {} };
    return { status: rep.status, text: new TextDecoder().decode(brut) };
  }

  // ── fetch réécrit : la page d'origine n'a pas une ligne à changer ──
  var fetchNavigateur = window.fetch.bind(window);
  window.fetch = function(ressource, options){
    var chemin = (typeof ressource === 'string') ? ressource : (ressource && ressource.url) || '';
    if (!/^\\/(api|sso)\\b/.test(chemin)) return fetchNavigateur(ressource, options);
    return pont(chemin, options || {}, false).then(function(r){
      return new Response(r.text, { status: r.status, headers: { 'Content-Type': 'application/json' } });
    });
  };

  // ── Vignettes : récupérées en binaire, puis affichées depuis la mémoire ──
  var cacheVignettes = Object.create(null);
  async function peupler(img){
    var src = img.getAttribute('src') || '';
    if (!src.startsWith('/api/')) return;
    img.removeAttribute('src');
    if (cacheVignettes[src]) { img.src = cacheVignettes[src]; return; }
    try {
      var r = await pont(src, { method: 'GET' }, true);
      if (r.status !== 200) return;
      var url = URL.createObjectURL(new Blob([r.bytes], { type: 'image/jpeg' }));
      cacheVignettes[src] = url;
      img.src = url;
    } catch(e){ console.warn('[drive] vignette impossible', src, e); }
  }
  function balayer(racine){
    (racine.querySelectorAll ? racine.querySelectorAll('img[src^="/api/"]') : []).forEach(peupler);
  }
  new MutationObserver(function(muts){
    muts.forEach(function(m){ m.addedNodes.forEach(function(n){ if (n.nodeType === 1) balayer(n); }); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', function(){ balayer(document); });

  // ── Téléchargements et extraction .zip : jeton SSO + prise en charge native ──
  // Le pont transporte octet par octet : parfait pour 35 Ko de vignette, inadapté
  // à une archive. On laisse donc le système faire le téléchargement, authentifié
  // par un jeton à usage unique.
  // ── Telechargement NATIF : « Enregistrer sous », puis ecriture par Rust ──
  // Aucune page web, aucun navigateur : l'application se suffit a elle-meme et
  // fonctionne donc a l'identique depuis n'importe quel ordinateur, du moment
  // qu'on est connecte. Le fichier est ecrit cote Rust, pas transporte en JS :
  // c'est ce qui le rend viable pour une archive de plusieurs centaines de Mo.
  // Retrouve un nom de fichier presentable a partir de l'adresse.
  // ATTENTION : nos adresses finissent par l'IDENTIFIANT interne du fichier
  // (un uuid sans extension). S'en servir comme nom produit un fichier que
  // Windows ne sait pas ouvrir. Ce repli n'est donc utilise qu'en dernier
  // recours, et il ajoute une extension generique pour rester ouvrable.
  function nomDepuisChemin(chemin){
    try {
      var sansParam = String(chemin).split('?')[0];
      var dernier = decodeURIComponent(sansParam.split('/').pop() || '');
      if (!dernier) return 'fichier';
      var ressembleAId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dernier);
      if (ressembleAId || dernier.indexOf('.') < 0) return 'document-qlygo.dat';
      return dernier;
    } catch(_) { return 'fichier'; }
  }
  function extensionsDe(nom){
    var pt = String(nom).lastIndexOf('.');
    return pt > 0 ? [{ name: 'Fichier ' + nom.slice(pt + 1).toUpperCase(), extensions: [nom.slice(pt + 1)] }] : [];
  }
  async function telechargerVers(chemin, nomPropose){
    var nom = nomPropose || nomDepuisChemin(chemin);
    try {
      if (!T.dialog || !T.dialog.save) {
        alerter("Impossible d'enregistrer le fichier",
                "La boite « Enregistrer sous » n'est pas disponible dans cette fenetre.",
                "Cote application : le plugin « dialog » doit etre installe et autorise.");
        return;
      }
      var cible = await T.dialog.save({ defaultPath: nom, filters: extensionsDe(nom) });
      if (!cible) return;                       // l'utilisateur a renonce
      if (!T.upload || !T.upload.download) {
        alerter("Impossible d'enregistrer le fichier",
                "Le telechargement natif n'est pas disponible dans cette fenetre.",
                "Cote application : le plugin « upload » doit etre installe et autorise.");
        return;
      }
      var url = /^https?:/i.test(chemin) ? chemin : QLYGO + chemin;
      var entetes = new Map();
      var ck = lireCookie();
      if (ck) entetes.set('Cookie', ck);
      await T.upload.download(url, cible, undefined, entetes);
      annoncer('Enregistre : ' + nom);
    } catch (e) {
      alerter("Le telechargement a echoue", String(e && e.message || e),
              "Verifie ta connexion, puis reessaie depuis le launcher connecte.");
    }
  }

  // Tout lien « telecharger » de la page passe par la boite native.
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[href^="/api/"]');
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    var nomVoulu = a.getAttribute('download');
    if (!nomVoulu) {
      // Le lien n'a pas transmis de nom : plutot que d'enregistrer sous un
      // identifiant illisible, on le dit franchement.
      alerter("Nom de fichier introuvable",
              "Ce lien ne transmet pas le nom du fichier.",
              "Le fichier serait enregistre sans extension et ne s'ouvrirait pas.");
      return;
    }
    telechargerVers(a.getAttribute('href'), nomVoulu);
  }, true);

  // ── Apercu DANS l'application, jamais dans un navigateur ──
  // Un clic sur un fichier ouvre un panneau interne. Les images et les PDF sont
  // affiches depuis la memoire (le lecteur PDF est integre au moteur de la
  // fenetre) ; pour les autres formats on propose directement l'enregistrement.
  function annoncer(texte){
    var id = 'drive-info', vieux = document.getElementById(id);
    if (vieux) vieux.remove();
    var d = document.createElement('div');
    d.id = id;
    d.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99998;background:#16281B;'
      + 'border:1px solid #3A9215;color:#E6FFE9;padding:11px 16px;font:13px/1.4 Inter,system-ui,sans-serif';
    d.textContent = texte;
    (document.body || document.documentElement).appendChild(d);
    setTimeout(function(){ if (d.parentNode) d.remove(); }, 4000);
  }

  async function apercuInterne(chemin){
    var nom = nomDepuisChemin(chemin);
    var ext = (nom.split('.').pop() || '').toLowerCase();
    var affichable = ['pdf','jpg','jpeg','png','webp','gif','bmp','txt','log','md','json','xml','csv'];
    if (affichable.indexOf(ext) < 0) return telechargerVers(chemin, nom);

    var fond = document.createElement('div');
    fond.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(8,10,16,.82);'
      + 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:26px';
    fond.innerHTML = '<div style="color:#E9EBF3;font:13px Inter,system-ui,sans-serif;opacity:.8">Ouverture de ' + nom + '...</div>';
    fond.addEventListener('click', function(e){ if (e.target === fond) fond.remove(); });
    document.body.appendChild(fond);
    var auClavier = function(e){ if (e.key === 'Escape') { fond.remove(); document.removeEventListener('keydown', auClavier); } };
    document.addEventListener('keydown', auClavier);

    try {
      var r = await pont(chemin, { method: 'GET' }, true);
      if (r.status !== 200) { fond.remove(); return alerter("Fichier illisible", 'Le serveur a repondu ' + r.status + '.', ''); }
      var types = { pdf:'application/pdf', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
                    webp:'image/webp', gif:'image/gif', bmp:'image/bmp' };
      var type = types[ext] || 'text/plain; charset=utf-8';
      var lien = URL.createObjectURL(new Blob([r.bytes], { type: type }));
      var corps = (ext === 'pdf')
        ? '<iframe src="' + lien + '" style="flex:1;width:100%;border:0;background:#fff"></iframe>'
        : (types[ext] ? '<img src="' + lien + '" style="flex:1;min-height:0;max-width:100%;object-fit:contain">'
                      : '<iframe src="' + lien + '" style="flex:1;width:100%;border:0;background:#fff"></iframe>');
      fond.innerHTML = '<div style="width:min(1100px,100%);height:100%;display:flex;flex-direction:column;gap:10px">'
        + '<div style="display:flex;align-items:center;gap:12px;color:#E9EBF3;font:600 13px Inter,system-ui,sans-serif">'
        + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + nom + '</span>'
        + '<button data-enregistrer="1" style="background:#EDA020;border:0;color:#191B22;font:700 12px Inter;padding:7px 14px;cursor:pointer">Enregistrer sous...</button>'
        + '<button data-fermer="1" style="background:none;border:1px solid #4A5163;color:#E9EBF3;font:700 12px Inter;padding:7px 12px;cursor:pointer">Fermer</button>'
        + '</div>' + corps + '</div>';
      fond.querySelector('[data-fermer]').onclick = function(){ URL.revokeObjectURL(lien); fond.remove(); };
      fond.querySelector('[data-enregistrer]').onclick = function(){ telechargerVers(chemin, nom); };
    } catch (e) {
      fond.remove();
      alerter("Impossible d'ouvrir le fichier", String(e && e.message || e), '');
    }
  }

  var ouvrirNatif = window.open;
  window.open = function(url, cible, options){
    if (typeof url === 'string' && url.startsWith('/api/')) { apercuInterne(url); return null; }
    return ouvrirNatif.call(window, url, cible, options);
  };

  if (!lireCookie()) {
    alerter("Session QLYGO introuvable",
            "Le Drive n'a pas retrouvé la connexion du launcher.",
            "Ferme cette fenêtre, vérifie que tu es connecté dans le launcher, puis rouvre le Drive.");
  }
  console.info('[drive] passerelle active vers ' + QLYGO + ' (session ' + (lireCookie() ? 'trouvée' : 'ABSENTE') + ')');
})();
</script>
`;

// La passerelle doit être en place AVANT le script de la page.
const marqueur = '<script>';
const i = html.indexOf(marqueur);
if (i < 0) { console.error('[drive] aucun <script> dans la source'); process.exit(1); }
html = html.slice(0, i) + PASSERELLE + html.slice(i);

// Les ressources compagnes (theme.js, context-menu.js, icone) sont ecrites en
// chemin relatif : depuis le launcher elles viseraient le disque local et
// tomberaient dans le vide, et le Drive perdrait le theme de QLYGO. On les pointe
// donc explicitement sur le serveur. Effet de bord voulu : changer le theme sur
// QLYGO se repercute aussi sur le Drive, sans republier l'application.
const SERVEUR = 'https://qlygo.fr';
html = html.replace(/(<script[^>]*\ssrc=")(?!https?:|\/\/)\/?([^"]+)(")/g, `$1${SERVEUR}/$2$3`);
html = html.replace(/(<link[^>]*\shref=")(?!https?:|\/\/|data:)\/?([^"]+)(")/g, `$1${SERVEUR}/$2$3`);

// Titre de fenêtre propre à l'application.
html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>QLYGO Drive</title>');

// ── Garde-fou : on REFUSE d'écrire un fichier dont le JavaScript est cassé ──
// Le 20/11/2026, un échappement mal traversé a produit une page syntaxiquement
// invalide : la passerelle ne démarrait pas, donc ni données ni message d'erreur.
// Une page muette coûte un aller-retour complet ; un build qui échoue coûte dix
// secondes. On vérifie donc chaque bloc <script> avant d'écrire.
{
  const blocs = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  let casse = 0;
  blocs.forEach((code, i) => {
    if (!code.trim()) return;
    try { new Function(code); }
    catch (e) { casse++; console.error(`[drive] bloc <script> n°${i} invalide : ${e.message}`); }
  });
  if (casse) {
    console.error(`[drive] ABANDON : ${casse} bloc(s) de script invalide(s), drive.html n'a PAS été écrit.`);
    process.exit(1);
  }
  console.log(`[drive] ${blocs.filter(b => b.trim()).length} bloc(s) de script vérifié(s) : syntaxe correcte`);
}

writeFileSync(resolve(ici, 'drive.html'), html, 'utf8');
console.log('[drive] drive.html fabriqué depuis ' + source + ' (' + Math.round(html.length / 1024) + ' Ko)');
