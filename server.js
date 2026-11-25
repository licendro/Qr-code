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
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
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
const PROMPT = `Photo d'une étiquette de colis (pas forcément droite). Lis-la attentivement et extrais :
- numero : le numéro de suivi du colis ou du recommandé (souvent « FR… », mais aussi « 6A… », « 8R… », « XC… », « RL… », « CB… », « 1K… »…). Recopie-le exactement, sans espaces. S'il n'y en a aucun, prends le petit numéro imprimé à côté du nom du destinataire.
- type : « R » si c'est un recommandé (mention « recommandé », « lettre recommandée », « R1/R2/R3 », avis de réception), sinon « C ».
- cie : le numéro de compagnie du destinataire s'il est écrit (ex. « 7e Cie », « 7 CIE », « 7ème compagnie » → « 7 »), sinon vide.
- nom : NOM de famille du destinataire (sans grade : ignore EG, GAV, M., Mme, SGT…)
- prenom : prénom du destinataire
- produit : ce que contient le colis ou à défaut l'expéditeur / la marque (ex. « Colis Amazon », « Vinted »), court.
- tel : numéro de téléphone du destinataire s'il est écrit (chiffres seulement, sinon vide).
- infos : les autres indications utiles près du destinataire : société / compagnie / unité, service, bâtiment, étage, chambre, mentions comme « fragile » ou « contre signature ». Sépare-les par « · ». Pas l'adresse postale complète, pas l'expéditeur, pas la compagnie (déjà dans cie).
Réponds UNIQUEMENT avec ce JSON : {"numero":"","type":"C","cie":"","nom":"","prenom":"","produit":"","tel":"","infos":""} — chaîne vide si illisible, n'invente rien.`;

async function appelClaude(b64) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 600, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: PROMPT }
        ] }]
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j?.error?.message || ('API ' + r.status)); e.status = r.status; throw e; }
    return (j.content || []).map(c => c.text || '').join('');
  } finally { clearTimeout(t); }
}

async function lireEtiquette(b64) {
  let txt, last;
  for (let essai = 0; essai < 3; essai++) {
    try { txt = await appelClaude(b64); break; }
    catch (e) {
      last = e;
      // surcharge / limite / réseau : on réessaie ; clé invalide ou crédit épuisé : inutile
      if (e.status && ![429, 500, 502, 503, 529].includes(e.status)) throw e;
      await new Promise(r => setTimeout(r, 1500 * (essai + 1)));
    }
  }
  if (txt === undefined) throw last;
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('réponse illisible');
  const o = JSON.parse(m[0]);
  const out = {};
  for (const k of ['numero', 'type', 'cie', 'nom', 'prenom', 'produit', 'tel', 'infos']) out[k] = String(o[k] ?? '').trim();
  out.numero = out.numero.replace(/\s+/g, '').toUpperCase();
  out.type = out.type.toUpperCase() === 'R' ? 'R' : 'C';
  out.nom = out.nom.toUpperCase();
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
      if (p === '/api/me') return send(res, 200, { ok: true, lecture: API_KEY ? 'claude' : 'locale', signature: SIGNATURE });

      if (p === '/api/colis' && req.method === 'GET') {
        if (url.searchParams.get('v') === String(version)) return send(res, 200, { same: true, version });
        return send(res, 200, { version, items: colis });
      }
      if (p === '/api/colis' && req.method === 'POST') {
        const b = await readBody(req, 50000);
        const numero = clean(b.numero, 80).replace(/\s+/g, '');
        if (!numero) return send(res, 400, { error: 'numéro manquant' });
        const existing = colis.find(c => numKey(c.numero) === numKey(numero));
        if (existing) return send(res, 409, { error: 'doublon', existing });
        const it = {
          id: crypto.randomBytes(8).toString('hex'), numero, numKey: numKey(numero),
          produit: clean(b.produit), nom: clean(b.nom, 100), prenom: clean(b.prenom, 100),
          tel: clean(b.tel, 30), infos: clean(b.infos, 500), obs: clean(b.obs, 500),
          type: b.type === 'R' ? 'R' : 'C', cie: clean(b.cie, 30), vaguemestre: clean(b.vaguemestre, 60) || SIGNATURE,
          ts: Date.now(), etat: 'recu', reporteAt: null, remisAt: null
        };
        colis.push(it); save();
        return send(res, 201, { item: it, version });
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
