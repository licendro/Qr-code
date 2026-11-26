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
// sessions : { sid: { role: 'admin' | 'user', code?, device? } } — anciennes sessions (tableau) = ton iPhone → admin
let sessions = (() => { const r = readJson(SESS_FILE, {}); if (Array.isArray(r)) { const o = {}; for (const sid of r) o[sid] = { role: 'admin' }; return o; } return r; })();
const saveSessions = () => writeJson(SESS_FILE, sessions);
// ---------- accès payant : codes ----------
const ACCES_FILE = path.join(DATA, 'acces.json');
let acces = readJson(ACCES_FILE, { codes: {}, adminDevice: null, sessionsStripe: {} });
const saveAcces = () => writeJson(ACCES_FILE, acces);
const PRIX_SCAN = Number(process.env.PRIX_SCAN_CENTIMES) || 3;        // 3 centimes par lecture IA
const MIN_RECHARGE = Number(process.env.MIN_RECHARGE_CENTIMES) || 200;  // 2 € minimum, montant libre au-dessus
const MAX_RECHARGE = 10000;
const CREDIT_OFFERT = Number(process.env.CREDIT_OFFERT_CENTIMES) || 200; // crédit d'un code offert par l'admin
acces.credite = acces.credite || {};
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_RESTRICTED_KEY || '';
const STRIPE_WHSEC = process.env.STRIPE_WEBHOOK_SECRET || '';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
function nouveauCode() { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c; do { c = Array.from(crypto.randomBytes(8), b => A[b % A.length]).join(''); c = c.slice(0, 4) + '-' + c.slice(4); } while (acces.codes[c]); return c; }
// active le code réservé pour une session Checkout payée (appelé par le webhook ET par la page de retour : idempotent)
function activerCodeSession(cs) {
  if (!cs || cs.payment_status === 'unpaid') return null;
  let code = acces.sessionsStripe[cs.id] || cs.metadata?.code;
  if (!code) return null;
  const c = acces.codes[code] || (acces.codes[code] = { cree: Date.now(), source: 'stripe' });
  c.actif = true; c.enAttente = false; c.email = cs.customer_details?.email || c.email || '';
  if (!acces.credite[cs.id]) { acces.credite[cs.id] = true; c.solde = (c.solde || 0) + (cs.amount_total || 0); c.verse = (c.verse || 0) + (cs.amount_total || 0); c.dernierPaiement = Date.now(); }
  acces.sessionsStripe[cs.id] = code; saveAcces();
  return code;
}
// vérification de la signature Stripe-Signature (t=…,v1=…) — HMAC SHA-256 de « t.payload » avec le secret whsec_
function signatureStripeOk(raw, header) {
  if (!STRIPE_WHSEC || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map(x => x.split('=')).filter(x => x.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = String(header).split(',').filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  const t = Number(parts.t); if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const attendu = crypto.createHmac('sha256', STRIPE_WHSEC).update(t + '.' + raw).digest('hex');
  return sigs.some(v => v.length === attendu.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(attendu)));
}
async function stripe(method, chemin, form) {
  const r = await fetch((process.env.STRIPE_API_BASE || 'https://api.stripe.com') + '/v1' + chemin, { method, headers: { Authorization: 'Bearer ' + STRIPE_KEY, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message || 'Stripe ' + r.status); return j;
}
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
const sessionDe = req => { const s = sessions[cookies(req).sid]; if (!s) return null; if (s.role === 'user') { const c = acces.codes[s.code]; if (!c || !c.actif) return null; } return s; };
const authed = req => !!sessionDe(req);
const cookieSid = (req, sid) => `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${isHttps(req) ? '; Secure' : ''}`;
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
- codes : au plus 3 autres identifiants de suivi visibles (numéro sous le code-barres principal, « Track »), sans espaces. Pas de réf. client ni de code de tri.
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
        model, max_tokens: 350,
        // consignes fixes en « system » + cache : quand tu scannes plusieurs colis d'affilée, ce long texte coûte ~10× moins cher
        system: [{ type: 'text', text: PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: 'Lis cette étiquette et réponds avec le JSON demandé.' + leconsPourPrompt() }
        ] }]
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j?.error?.message || ('API ' + r.status)); e.status = r.status; throw e; }
    const u = j.usage || {}; learn.stats.cacheLu = (learn.stats.cacheLu || 0) + (u.cache_read_input_tokens || 0);
    learn.stats.cacheEcrit = (learn.stats.cacheEcrit || 0) + (u.cache_creation_input_tokens || 0); dernierAppel = Date.now();
    return (j.content || []).map(c => c.text || '').join('');
  } finally { clearTimeout(t); }
}
// Maintien du cache (1 h) pendant les heures de service : un mini-appel texte (~0,02 centime) toutes les 50 min
// évite de réécrire les consignes (≈ 0,8 centime) au premier colis de chaque heure.
let dernierAppel = 0;
setInterval(async () => {
  if (!API_KEY || process.env.CACHE_MAINTIEN === '0') return;
  const d = new Date(), h = d.getHours(), j = d.getDay();
  if (j === 0 || h < 7 || h >= 19 || !dernierAppel || Date.now() - dernierAppel < 45 * 60000) return;
  try {
    await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', { method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(WORKSPACE ? { 'anthropic-workspace-id': WORKSPACE } : {}) },
      body: JSON.stringify({ model: MODEL, max_tokens: 1, system: [{ type: 'text', text: PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [{ role: 'user', content: 'ok' }] }) });
    dernierAppel = Date.now();
  } catch (e) {}
}, 5 * 60000);

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
      const saisie = String(b.password || b.code || '').trim(), device = String(b.device || '').slice(0, 64);
      const a = Buffer.from(saisie), e = Buffer.from(PASSWORD);
      if (a.length === e.length && crypto.timingSafeEqual(a, e)) {
        // accès illimité : réservé au premier appareil connecté en admin (ton iPhone)
        if (acces.adminDevice && device !== acces.adminDevice) { await new Promise(r => setTimeout(r, 1200)); return send(res, 403, { error: 'Accès admin réservé à un autre appareil' }); }
        if (!acces.adminDevice && device) { acces.adminDevice = device; saveAcces(); }
        const sid = crypto.randomBytes(32).toString('hex'); sessions[sid] = { role: 'admin', device }; saveSessions();
        return send(res, 200, { ok: true, role: 'admin' }, { 'Set-Cookie': cookieSid(req, sid) });
      }
      const code = saisie.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
      const c = acces.codes[code];
      if (!c || !c.actif) { await new Promise(r => setTimeout(r, 1200)); return send(res, 401, { error: 'Code incorrect' }); }
      if (c.device && device && c.device !== device) return send(res, 403, { error: 'Ce code est déjà utilisé sur un autre téléphone' });
      if (!c.device && device) { c.device = device; c.premiereUtilisation = Date.now(); saveAcces(); }
      const sid = crypto.randomBytes(32).toString('hex'); sessions[sid] = { role: 'user', code, device }; saveSessions();
      return send(res, 200, { ok: true, role: 'user' }, { 'Set-Cookie': cookieSid(req, sid) });
    }
    // ----- paiement Stripe : 5 € → un code -----
    if (p === '/api/config') return send(res, 200, { stripe: !!STRIPE_KEY, prixScan: PRIX_SCAN, minRecharge: MIN_RECHARGE, contact: process.env.CONTACT_CREDIT || 'Julien MERCERON' });
    if (p === '/api/payer' && req.method === 'POST') {
      if (!STRIPE_KEY) return send(res, 501, { error: 'Paiement en ligne pas encore activé : demande un code au vaguemestre.' });
      const b = await readBody(req, 2000);
      const montant = Math.round(Number(b.montant) * 100);
      if (!(montant >= MIN_RECHARGE && montant <= MAX_RECHARGE)) return send(res, 400, { error: `Montant entre ${MIN_RECHARGE / 100} € et ${MAX_RECHARGE / 100} €` });
      const ss = sessionDe(req);
      let code = ss && ss.role === 'user' ? ss.code : null;                       // recharge de son propre code
      if (!code) { code = nouveauCode(); acces.codes[code] = { actif: false, cree: Date.now(), source: 'stripe', enAttente: true, solde: 0 }; saveAcces(); }
      const base = BASE_URL || ((isHttps(req) ? 'https://' : 'http://') + req.headers.host);
      const cs = await stripe('POST', '/checkout/sessions', {
        'metadata[code]': code, 'payment_intent_data[metadata][code]': code,
        'payment_intent_data[description]': `Crédit Scan colis (${Math.floor(montant / PRIX_SCAN)} scans) — ton code : ${code}`, // visible sur le reçu Stripe
        mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'eur',
        'line_items[0][price_data][unit_amount]': String(montant),
        'line_items[0][price_data][product_data][name]': 'Crédit Scan colis',
        'line_items[0][price_data][product_data][description]': `${Math.floor(montant / PRIX_SCAN)} lectures d'étiquettes à ${PRIX_SCAN} centimes — sert uniquement à payer l'IA`,
        success_url: base + '/?paye={CHECKOUT_SESSION_ID}', cancel_url: base + '/'
      });
      return send(res, 200, { url: cs.url });
    }
    if (p === '/api/stripe-webhook' && req.method === 'POST') {
      const raw = await new Promise((ok, ko) => { const ch = []; let n = 0; req.on('data', c => { n += c.length; if (n > 1e6) req.destroy(); else ch.push(c); }); req.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); req.on('error', ko); });
      if (!signatureStripeOk(raw, req.headers['stripe-signature'])) return send(res, 400, { error: 'signature invalide' });
      const ev = JSON.parse(raw), obj = ev.data && ev.data.object;
      if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') { const code = activerCodeSession(obj); if (code) console.log('paiement reçu → code', code); }
      if (ev.type === 'checkout.session.async_payment_failed') console.log('paiement échoué', obj && obj.id);
      return send(res, 200, { received: true });
    }
    if (p === '/api/code-paye' && req.method === 'POST') {
      const b = await readBody(req, 2000); const id = String(b.session || '');
      if (!STRIPE_KEY || !/^cs_[A-Za-z0-9_]+$/.test(id)) return send(res, 400, { error: 'paiement inconnu' });
      const dejaActif = acces.sessionsStripe[id] && acces.codes[acces.sessionsStripe[id]]?.actif;
      if (dejaActif && acces.credite[id]) return send(res, 200, { code: acces.sessionsStripe[id], solde: acces.codes[acces.sessionsStripe[id]].solde || 0 });
      const cs = await stripe('GET', '/checkout/sessions/' + encodeURIComponent(id));
      const code = activerCodeSession(cs);
      if (!code) return send(res, 402, { error: 'Paiement pas encore confirmé, réessaie dans un instant' });
      return send(res, 200, { code, solde: acces.codes[code].solde || 0 });
    }
    if (p.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'non connecté' });

      if (p === '/api/logout' && req.method === 'POST') {
        delete sessions[cookies(req).sid]; saveSessions();
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
      }
      if (p === '/api/me') { const ss = sessionDe(req), cc = ss.code ? acces.codes[ss.code] : null; return send(res, 200, { ok: true, role: ss.role, code: ss.code || null, solde: cc ? cc.solde || 0 : null, prixScan: PRIX_SCAN, minRecharge: MIN_RECHARGE, lecture: API_KEY ? 'claude' : 'locale', signature: SIGNATURE, appris: Object.keys(learn.personnes).length, corrections: learn.corrections.length, stats: learn.stats }); }

      if (p.startsWith('/api/admin/')) {
        if (sessionDe(req).role !== 'admin') return send(res, 403, { error: 'réservé à l\'admin' });
        if (p === '/api/admin/codes' && req.method === 'GET') return send(res, 200, { codes: acces.codes, stripe: !!STRIPE_KEY, prixScan: PRIX_SCAN });
        if (p === '/api/admin/codes' && req.method === 'POST') { const code = nouveauCode(); acces.codes[code] = { actif: true, cree: Date.now(), source: 'offert', solde: CREDIT_OFFERT }; saveAcces(); return send(res, 200, { code }); }
        const m2 = p.match(/^\/api\/admin\/codes\/([A-Z0-9-]{9})\/(liberer|desactiver|activer|crediter)$/);
        if (m2 && req.method === 'POST') { const c = acces.codes[m2[1]]; if (!c) return send(res, 404, { error: 'code inconnu' });
          if (m2[2] === 'liberer') c.device = null; else if (m2[2] === 'crediter') { const bb = await readBody(req, 500).catch(() => ({})); const cents = Math.round(Number(bb.euros || 2) * 100); if (!(cents > 0 && cents <= 100000)) return send(res, 400, { error: 'montant invalide' }); c.solde = (c.solde || 0) + cents; c.verse = (c.verse || 0) + cents; (c.historique = c.historique || []).push({ ts: Date.now(), cents, mode: 'manuel' }); } else c.actif = m2[2] === 'activer';
          if (!c.actif) for (const [sid, ss] of Object.entries(sessions)) if (ss.code === m2[1]) delete sessions[sid];
          saveAcces(); saveSessions(); return send(res, 200, { ok: true }); }
        return send(res, 404, { error: 'route inconnue' });
      }
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
        const ss = sessionDe(req), cc = ss.role === 'user' ? acces.codes[ss.code] : null;
        if (cc && (cc.solde || 0) < PRIX_SCAN) return send(res, 402, { error: 'credit', solde: cc.solde || 0 });
        const b = await readBody(req);
        const b64 = String(b.image || '').replace(/^data:image\/\w+;base64,/, '');
        if (!b64) return send(res, 400, { error: 'image manquante' });
        try {
          const out = await lireEtiquette(b64);
          if (cc) { cc.solde = (cc.solde || 0) - PRIX_SCAN; cc.scans = (cc.scans || 0) + 1; saveAcces(); out.solde = cc.solde; }
          return send(res, 200, out);
        }
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
