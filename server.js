// Scan colis — serveur sans dépendance (Node 20+)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- config (.env) ----------
const ROOT = __dirname;
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* pas de .env */ }

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
// Modèle principal (Sonnet par défaut, le plus fiable). Option économie : ANTHROPIC_MODEL=claude-haiku-5-5 et
// ANTHROPIC_MODEL_FIABLE=claude-sonnet-5-5 → Haiku lit d'abord, Sonnet seulement si la lecture est douteuse.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const MODEL_FIABLE = process.env.ANTHROPIC_MODEL_FIABLE || '';
const WORKSPACE = process.env.ANTHROPIC_WORKSPACE_ID || '';
const SIGNATURE = process.env.SIGNATURE || 'Julien MERCERON';
if (!PASSWORD || PASSWORD === 'change-moi') {
  console.error('⚠  Définis APP_PASSWORD dans le fichier .env avant de lancer l\'app.');
  process.exit(1);
}

// ---------- stockage (fichiers JSON, écriture atomique + sauvegarde quotidienne) ----------
const DATA = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA, 'colis.json');
const SESS_FILE = path.join(DATA, 'sessions.json');
fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
function writeJson(f, v) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, f);
}

let colis = readJson(DB_FILE, []);
// migration : ancien « validé » = reporté au registre
for (const c of colis) {
  if (!c.etat) { c.etat = c.validatedAt ? 'reporte' : 'recu'; c.reporteAt = c.validatedAt || null; c.remisAt = null; }
  if (!c.type) c.type = 'C';
}
let sessions = new Set(readJson(SESS_FILE, []));
let version = Date.now();

// ---------- apprentissage : annuaire des personnes + corrections faites à la main ----------
const LEARN_FILE = path.join(DATA, 'apprentissage.json');
let learn = readJson(LEARN_FILE, { personnes: {}, corrections: [], stats: { lectures: 0, sonnet: 0 } });
learn.stats = learn.stats || { lectures: 0, sonnet: 0 };
const saveLearn = () => { try { writeJson(LEARN_FILE, learn); } catch (e) {} };
const plain = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
function lev(a, b) { if (Math.abs(a.length - b.length) > 3) return 9; const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
function apprendre(final, lu) {
  // 1) annuaire : nom → prénom + compagnie
  const k = plain(final.nom);
  if (k.length >= 2) { const p = learn.personnes[k] || { n: 0 }; learn.personnes[k] = { nom: final.nom, prenom: final.prenom || p.prenom || '', cie: final.cie || p.cie || '', n: p.n + 1, last: Date.now() }; }
  // 2) corrections : ce que l'IA avait lu ≠ ce que tu as validé
  if (lu && typeof lu === 'object') for (const champ of ['numero', 'nom', 'prenom', 'cie', 'emballage']) {
    const a = String(lu[champ] || '').trim(), b = String(final[champ] || '').trim();
    if (b && a.toUpperCase() !== b.toUpperCase()) learn.corrections.push({ champ, lu: a.slice(0, 40), correct: b.slice(0, 40), tr: final.transporteur || '', ts: Date.now() });
  }
  learn.corrections = learn.corrections.slice(-40);
  saveLearn();
}
// après lecture : on corrige l'orthographe et on complète grâce à l'annuaire
function completerAvecAnnuaire(out) {
  const k = plain(out.nom); if (k.length < 3) return out;
  let best = null, bd = 9;
  for (const [key, p] of Object.entries(learn.personnes)) { const d = key === k ? 0 : lev(key, k); if (d < bd || (d === bd && best && p.n > best.n)) { bd = d; best = p; } }
  const tol = k.length >= 8 ? 2 : 1;
  if (best && bd <= tol) {
    if (bd > 0 && out.prenom && best.prenom && lev(plain(out.prenom), plain(best.prenom)) > 2) return out; // homonyme probable
    out.nom = best.nom; if (!out.prenom || lev(plain(out.prenom), plain(best.prenom)) <= 2) out.prenom = best.prenom || out.prenom;
    if (!out.cie && best.cie) out.cie = best.cie;
    out.connu = true;
  }
  return out;
}
function leconsPourPrompt() {
  const c = learn.corrections.filter(x => x.lu).slice(-12);
  if (!c.length) return '';
  return '\n\nErreurs déjà faites sur ces étiquettes (à ne pas refaire) :\n' + c.map(x => `- ${x.tr ? '[' + x.tr + '] ' : ''}${x.champ} lu « ${x.lu} » alors que c'était « ${x.correct} »`).join('\n');
}

// au premier démarrage, l'annuaire apprend des colis déjà enregistrés
if (!Object.keys(learn.personnes).length) { for (const c of colis) if (c.nom) apprendre(c, null); }

function save() {
  version = Date.now();
  writeJson(DB_FILE, colis);
  const day = new Date().toISOString().slice(0, 10);
  const bk = path.join(DATA, 'backups', `colis-${day}.json`);
  try { fs.copyFileSync(DB_FILE, bk); } catch (e) {}
  // garde 60 jours de sauvegardes
  try {
    const files = fs.readdirSync(path.join(DATA, 'backups')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 60))) fs.unlinkSync(path.join(DATA, 'backups', f));
  } catch (e) {}
}

// FR1283838 et 1283838 = même colis
const numKey = n => String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^FR/, '');
const clean = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const { norm, plainUp, numeroValide, trackKey, keysFor, nomValide, GUIDE, EXEMPLES } = require('./lib/etiquettes');

// ---------- helpers HTTP ----------
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((ok, ko) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { ko(new Error('trop gros')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { ko(e); } });
    req.on('error', ko);
  });
}
function cookies(req) {
  const o = {};
  for (const p of String(req.headers.cookie || '').split(';')) {
    const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return o;
}
const authed = req => sessions.has(cookies(req).sid);
const isHttps = req => req.headers['x-forwarded-proto'] === 'https';

// ---------- lecture d'étiquette par Claude (si clé API) ----------
const PROMPT = `Tu lis la photo d'une étiquette de colis reçue à l'École de gendarmerie de Chaumont (adresse : 1 avenue du 109e RI, 52000 Chaumont).
IMPORTANT : lis UNIQUEMENT l'étiquette principale, celle qui occupe le centre / la plus grande partie de l'image. Ignore complètement les autres colis, étiquettes, étagères ou papiers visibles autour ou en arrière-plan. Toutes les infos (numéro, nom, compagnie) doivent venir de cette même étiquette.
${GUIDE}

${EXEMPLES}

Extrais :

- transporteur : Colissimo, La Poste, Amazon, Chronopost, DPD, DHL, UPS, GLS, Mondial Relay ou Autre.
- emballage : « carton » (boîte rigide), « souple » (sachet/pochette plastique ou papier kraft souple) ou « enveloppe ».

- numero : LE numéro de suivi principal, recopié exactement sans espaces ni tirets. Formats selon le transporteur :
  • Colissimo / La Poste : 2 caractères + 11 chiffres, ex. 6C21339014797, 6A12345678901, 8R…, 6C62089323500 (souvent après « Num colis : », parfois écrit « 6C 21339014797 »). C'est le cas le plus fréquent.
  • Amazon : FR + 10 chiffres, ex. FR3269215560 (parfois imprimé en deux morceaux « FR326794 1872 » → FR3267941872).
  • Chronopost : 2 lettres + 9 chiffres + 2 lettres, ex. XN217543973JB, GL692682820JB.
  • DPD : 14 chiffres après « Track », ex. « 1031 4002 0826 30 » → 10314002082630.
  • DHL / Deutsche Post : « Shipment No. », ex. CI161997812DE. UPS : 1Z…. Recommandé : 2 lettres + 9 chiffres + FR.
- codes : TOUS les autres identifiants du colis visibles (numéros sous les codes-barres, « Track », références d'envoi, SSCC), sans espaces. Le numero y figure aussi.
- type : « R » si c'est un recommandé (mention recommandé, R1/R2/R3, avis de réception), sinon « C ».
- nom : NOM de famille du destinataire en MAJUSCULES, sans grade ni civilité (ignore EG, GAV, M., Mme…). Les étiquettes écrivent « NOM Prénom » ou « Prénom NOM » : le nom de famille est souvent en majuscules ; s'il n'y a aucun indice, le prénom est le mot qui est un prénom courant (Antoine, Lila, Ewen, Maxime…).
- prenom : prénom du destinataire (Première lettre en majuscule).
- cie : numéro de compagnie (1 à 7) s'il apparaît : « 1cie », « 1ere CIE », « 6 CIE », « 1 compagnie », « 6eme Compagnie », « 1 cie » collé au nom, ou une mention manuscrite comme « C1 », « 1C », « CI 1 ». Sinon vide.
- produit : expéditeur ou marque si visible (Decathlon, Salomon, Amazon, Vinted…), sinon le transporteur.
- tel : téléphone du destinataire s'il est écrit, sinon vide.
- infos : seulement une mention imprimée utile (section, bâtiment, « contre signature », « fragile »), en 5 mots max, sinon vide. JAMAIS de commentaire de ta part (pas de « illisible », « incertain », « lu comme »…).

Ne confonds pas avec : codes postaux, dates, poids, codes de tri (DBF1, ORY1, LYS8, 52U60, FR-COL-1176-52CHA, 802-FR-52000), numéros de compte ou de client de l'expéditeur, adresse.
N'invente rien et ne devine pas : un champ dont tu n'es pas sûr reste vide (mieux vaut vide que faux). Chaque caractère du numéro doit être clairement lisible, sinon numero vide.
Si l'image est floue ou l'étiquette coupée, mets "illisible": true. Réponds TOUJOURS et UNIQUEMENT avec ce JSON, sans texte autour :
{"transporteur":"","emballage":"","numero":"","codes":[],"type":"C","nom":"","prenom":"","cie":"","produit":"","tel":"","infos":"","illisible":false}`;

async function appelClaude(b64, model) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(WORKSPACE ? { 'anthropic-workspace-id': WORKSPACE } : {}) },
      body: JSON.stringify({
        model, max_tokens: 600,
        // consignes fixes en « system » + cache : quand tu scannes plusieurs colis d'affilée, ce long texte coûte ~10× moins cher
        system: [{ type: 'text', text: PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: 'Lis cette étiquette et réponds avec le JSON demandé.' + leconsPourPrompt() }
        ] }]
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j?.error?.message || ('API ' + r.status)); e.status = r.status; throw e; }
    return (j.content || []).map(c => c.text || '').join('');
  } finally { clearTimeout(t); }
}

async function lireAvec(b64, model) {
  let txt, last;
  for (let essai = 0; essai < 3; essai++) {
    try { txt = await appelClaude(b64, model); break; }
    catch (e) {
      last = e;
      if (e.status && ![429, 500, 502, 503, 529].includes(e.status)) throw e;
      await new Promise(r => setTimeout(r, 1500 * (essai + 1)));
    }
  }
  if (txt === undefined) throw last;
  return analyser(txt);
}
// ---------- contrôle de cohérence : pas de mots au hasard ----------
function noter(o) { o.verifier = []; if (!numeroValide(o.numero, o.transporteur)) o.verifier.push('numero'); if (o.nom && !nomValide(o.nom)) { o.verifier.push('nom'); o.nom = ''; o.prenom = ''; }
  return (o.numero ? 2 : 0) + (o.verifier.includes('numero') ? -1 : 1) + (o.nom ? 2 : 0) + (o.cie ? 1 : 0) - (o.illisible ? 2 : 0); }

async function lireEtiquette(b64) {
  learn.stats.lectures++;
  let out = await lireAvec(b64, MODEL), score = noter(out);
  const douteux = !out.numero || !out.nom || out.illisible || out.verifier.length;
  if (douteux && MODEL_FIABLE && MODEL_FIABLE !== MODEL) {
    learn.stats.sonnet++;
    try { const o2 = await lireAvec(b64, MODEL_FIABLE); const s2 = noter(o2); if (s2 >= score) { out = o2; score = s2; } } catch (e) { console.error('fiable:', e.message); }
  }
  if (out.transporteur) { learn.transporteurs = learn.transporteurs || {}; learn.transporteurs[out.transporteur] = (learn.transporteurs[out.transporteur] || 0) + 1; }
  saveLearn();
  return completerAvecAnnuaire(out);
}
function analyser(txt) {
  const m = txt.match(/\{[\s\S]*\}/);
  let o = {};
  try { o = m ? JSON.parse(m[0]) : { illisible: true }; } catch (e) { o = { illisible: true }; }
  const norm = c => String(c || '').replace(/[\s-]+/g, '').toUpperCase();
  const out = {};
  for (const k of ['type', 'cie', 'nom', 'prenom', 'produit', 'tel', 'infos', 'transporteur', 'emballage']) out[k] = String(o[k] ?? '').trim();
  out.emballage = /souple|sachet|pochette|plast/i.test(out.emballage) ? 'souple' : /envel/i.test(out.emballage) ? 'enveloppe' : /carton|boite|boîte/i.test(out.emballage) ? 'carton' : '';
  out.numero = norm(o.numero);
  out.codes = [...new Set([out.numero, ...(Array.isArray(o.codes) ? o.codes : []).map(norm)].filter(c => c.length >= 6 && c.length <= 40))];
  out.type = out.type.toUpperCase() === 'R' ? 'R' : 'C';
  out.nom = out.nom.toUpperCase();
  out.cie = (out.cie.match(/[1-7]/) || [''])[0];
  out.illisible = !!o.illisible;
  if (/illisible|incertain|flou|lu comme|valeur/i.test(out.infos)) out.infos = '';
  return out;
}

// ---------- routes ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req, 10000);
      const a = Buffer.from(String(b.password || '')), e = Buffer.from(PASSWORD);
      if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) {
        await new Promise(r => setTimeout(r, 1200));
        return send(res, 401, { error: 'Mot de passe incorrect' });
      }
      const sid = crypto.randomBytes(32).toString('hex');
      sessions.add(sid); writeJson(SESS_FILE, [...sessions]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${isHttps(req) ? '; Secure' : ''}` });
    }
    if (p.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'non connecté' });

      if (p === '/api/logout' && req.method === 'POST') {
        sessions.delete(cookies(req).sid); writeJson(SESS_FILE, [...sessions]);
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
      }
      if (p === '/api/me') return send(res, 200, { ok: true, lecture: API_KEY ? 'claude' : 'locale', signature: SIGNATURE, appris: Object.keys(learn.personnes).length, corrections: learn.corrections.length, stats: learn.stats });

      if (p === '/api/colis' && req.method === 'GET') {
        if (url.searchParams.get('v') === String(version)) return send(res, 200, { same: true, version });
        return send(res, 200, { version, items: colis });
      }
      if (p === '/api/colis' && req.method === 'POST') {
        const b = await readBody(req, 50000);
        const numero = clean(b.numero, 60).replace(/[\s-]+/g, '').toUpperCase();
        let codes = [numero, ...(Array.isArray(b.codes) ? b.codes : [])].map(c => clean(c, 60).replace(/[\s-]+/g, '').toUpperCase()).filter(c => numKey(c).length >= 4);
        codes = [...new Set(codes)].slice(0, 20);
        if (!codes.length) return send(res, 400, { error: 'numéro manquant' });
        if (!b.force) {
          const mine = keysFor(numero, codes);
          for (const c of colis) for (const k of keysFor(c.numero, c.codes)) if (mine.has(k)) return send(res, 409, { error: 'doublon', existing: c, code: k });
        }
        const it = {
          id: crypto.randomBytes(8).toString('hex'), numero: numero || codes[0], codes, numKey: numKey(numero || codes[0]),
          produit: clean(b.produit), nom: clean(b.nom, 100).toUpperCase(), prenom: clean(b.prenom, 100),
          tel: clean(b.tel, 30), infos: clean(b.infos, 500), obs: clean(b.obs, 500),
          transporteur: clean(b.transporteur, 30), emballage: ['carton', 'souple', 'enveloppe'].includes(b.emballage) ? b.emballage : '',
          type: b.type === 'R' ? 'R' : 'C', cie: clean(b.cie, 30), vaguemestre: clean(b.vaguemestre, 60) || SIGNATURE,
          ts: Date.now(), etat: 'recu', reporteAt: null, remisAt: null
        };
        colis.push(it); save(); apprendre(it, b.lu);
        return send(res, 201, { item: it, version });
      }
      if (/^\/api\/colis\/[a-f0-9]+$/.test(p) && req.method === 'DELETE') {
        const id = p.split('/').pop(); const n = colis.length;
        colis = colis.filter(c => c.id !== id);
        if (colis.length === n) return send(res, 404, { error: 'introuvable' });
        save(); return send(res, 200, { ok: true, version });
      }
      let m = p.match(/^\/api\/colis\/([a-f0-9]+)\/etat$/);
      if (m && req.method === 'POST') {
        const it = colis.find(c => c.id === m[1]);
        if (!it) return send(res, 404, { error: 'introuvable' });
        const b = await readBody(req, 2000);
        if (!['recu', 'reporte', 'remis'].includes(b.etat)) return send(res, 400, { error: 'état inconnu' });
        it.etat = b.etat;
        if (b.etat === 'recu') { it.reporteAt = null; it.remisAt = null; }
        if (b.etat === 'reporte') { it.reporteAt = it.reporteAt || Date.now(); it.remisAt = null; }
        if (b.etat === 'remis') { it.reporteAt = it.reporteAt || Date.now(); it.remisAt = Date.now(); }
        save();
        return send(res, 200, { item: it, version });
      }
      m = p.match(/^\/api\/colis\/([a-f0-9]+)$/);
      if (m && req.method === 'PATCH') {
        const it = colis.find(c => c.id === m[1]);
        if (!it) return send(res, 404, { error: 'introuvable' });
        const b = await readBody(req, 5000);
        if (typeof b.obs === 'string') it.obs = clean(b.obs, 500);
        save();
        return send(res, 200, { item: it, version });
      }
      if (p === '/api/lire' && req.method === 'POST') {
        if (!API_KEY) return send(res, 501, { error: 'pas de clé API' });
        const b = await readBody(req);
        const b64 = String(b.image || '').replace(/^data:image\/\w+;base64,/, '');
        if (!b64) return send(res, 400, { error: 'image manquante' });
        try { return send(res, 200, await lireEtiquette(b64)); }
        catch (e) { console.error('lecture:', e.message); return send(res, 502, { error: e.message }); }
      }
      return send(res, 404, { error: 'route inconnue' });
    }

    // fichiers statiques
    const file = path.join(ROOT, 'public', p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
    if (!file.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'erreur serveur' });
  }
});

server.listen(PORT, () => console.log(`Scan colis en ligne sur le port ${PORT} — ${colis.length} colis en base, lecture ${API_KEY ? 'Claude (' + MODEL + ')' : 'locale'}`));
