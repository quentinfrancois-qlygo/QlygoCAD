// Preuve que le correctif anti-CSRF fonctionne : on EXECUTE la fonction corrigee
// de QlygoCAD avec un faux pont, et on regarde les en-tetes qu'elle construit.
// Le test doit SAVOIR ECHOUER : on verifie aussi qu'une lecture n'envoie rien,
// et qu'une ecriture sans jeton en bocal va d'abord le chercher.
import { readFileSync } from 'node:fs';

const src = readFileSync('app-poc.js', 'utf8');

// On isole le bloc utile : les helpers cookies + qlygoNative.
// Bornes exactes : du premier helper cookie jusqu'a la fin de qlygoNative
// (la fonction suivante dans le fichier est buildMultipartForm).
const lignes = src.split('\n');
const iDebut = lignes.findIndex(l => l.includes('function _qcadReadCookie()'));
const iFin = lignes.findIndex((l, i) => i > iDebut && l.includes('function buildMultipartForm('));
if (iDebut < 0 || iFin < 0) { console.error('bornes introuvables'); process.exit(1); }
const bloc = lignes.slice(iDebut, iFin).join('\n');

const appels = [];
let bocal = null;                      // le cookie stocke, pilote par le test

const contexte = {
  localStorage: {
    getItem: () => bocal,
    setItem: (_, v) => { bocal = v; },
  },
  TextEncoder, TextDecoder,
  console,
  window: {
    __TAURI__: {
      core: {
        invoke: async (cmd, args) => {
          if (cmd === 'plugin:http|fetch') {
            const c = args.clientConfig;
            appels.push({
              methode: c.method,
              url: c.url,
              csrf: (c.headers || []).filter(h => String(h[0]).toLowerCase() === 'x-csrftoken').map(h => h[1])[0] || null,
            });
            // Le serveur pose le jeton quand la requete n'en a pas (comme le vrai).
            return 1;
          }
          if (cmd === 'plugin:http|fetch_send') {
            if (!bocal || !bocal.includes('csrf_token')) {
              return { rid: 1, status: 200, headers: { 'set-cookie': ['csrf_token=JETON-DU-SERVEUR; Path=/'] } };
            }
            return { rid: 1, status: 200, headers: {} };
          }
          if (cmd === 'plugin:http|fetch_read_body') return [123, 125, 1];   // "{}" + fin
          throw new Error('commande inconnue ' + cmd);
        },
      },
    },
  },
};

const fabrique = new Function(
  'localStorage', 'window', 'TextEncoder', 'TextDecoder', 'console',
  bloc + '\nreturn { qlygoNative, _qcadReadCookie };'
);
const { qlygoNative } = fabrique(
  contexte.localStorage, contexte.window, TextEncoder, TextDecoder, console
);

function bilan(titre, ok) {
  console.log(`  ${ok ? '[OK]  ' : '[RATE]'} ${titre}`);
  return ok ? 0 : 1;
}

let rates = 0;

// ── 1. Bocal VIDE + ecriture : doit aller chercher le jeton, puis l'envoyer ──
bocal = null; appels.length = 0;
await qlygoNative('POST', '/api/qlygocad/commun/base', { bodyText: '{"ents":[]}' });
const ecriture1 = appels.filter(a => a.methode === 'POST');
rates += bilan('bocal vide : un GET prealable va chercher le jeton',
  appels.some(a => a.methode === 'GET' && a.url.includes('/api/me')));
rates += bilan('bocal vide : l ecriture part AVEC le jeton',
  ecriture1.length === 1 && ecriture1[0].csrf === 'JETON-DU-SERVEUR');

// ── 2. Bocal DEJA garni : l'ecriture part directement avec le jeton ──
bocal = JSON.stringify({ v: 'session=abc; csrf_token=DEJA-LA', ts: Date.now() });
appels.length = 0;
await qlygoNative('DELETE', '/api/dossiers/1/fichiers/2', {});
const suppr = appels.filter(a => a.methode === 'DELETE');
rates += bilan('bocal garni : pas de GET inutile', !appels.some(a => a.methode === 'GET'));
rates += bilan('bocal garni : le jeton stocke est renvoye',
  suppr.length === 1 && suppr[0].csrf === 'DEJA-LA');

// ── 3. Une LECTURE ne doit rien envoyer (le test sait distinguer) ──
appels.length = 0;
await qlygoNative('GET', '/api/dossiers/1', {});
rates += bilan('une lecture n envoie PAS de jeton',
  appels.length === 1 && appels[0].csrf === null);

console.log(`\n  ${5} controle(s), ${rates} echec(s)`);
process.exit(rates ? 1 : 0);
