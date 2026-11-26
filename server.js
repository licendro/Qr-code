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

// ---------- chiffrement au repos (AES-256-GCM) : les fichiers de data/ sont illisibles sans DATA_KEY ----------
let DATA_KEY = process.env.DATA_KEY || '';
if (!/^[0-9a-f]{64}$/i.test(DATA_KEY)) {
  DATA_KEY = crypto.randomBytes(32).toString('hex');
  fs.appendFileSync(path.join(ROOT, '.env'), `\n# Clé de chiffrement des données (générée automatiquement) — à sauvegarder hors du VPS, sans elle les données sont perdues\nDATA_KEY=${DATA_KEY}\n`);
  console.log('🔐 Nouvelle clé DATA_KEY générée et ajoutée à .env — sauvegarde-la hors du VPS.');
}
const CLE = Buffer.from(DATA_KEY, 'hex');
function chiffrer(txt) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', CLE, iv); const d = Buffer.concat([c.update(txt, 'utf8'), c.final()]);
  return JSON.stringify({ chiffre: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: d.toString('base64') }); }
function dechiffrer(raw) { const o = JSON.parse(raw); if (!o || o.chiffre !== 1) return raw; // ancien fichier en clair : lu puis réécrit chiffré
  const dc = crypto.createDecipheriv('aes-256-gcm', CLE, Buffer.from(o.iv, 'base64')); dc.setAuthTag(Buffer.from(o.tag, 'base64'));
  return Buffer.concat([dc.update(Buffer.from(o.data, 'base64')), dc.final()]).toString('utf8'); }
const readJson = (f, d) => { let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { return d; }
  try { return JSON.parse(dechiffrer(raw)); } catch (e) { console.error('⚠ Impossible de lire', path.basename(f), '(mauvaise DATA_KEY ?)'); process.exit(1); } };
function writeJson(f, v) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, chiffrer(JSON.stringify(v)), { mode: 0o600 });
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
// ---------- cagnotte commune (sans bénéfice) ----------
// Chaque lecture IA retire son COÛT RÉEL (tokens × tarif Anthropic) ; les paiements s'arrêtent quand la cagnotte est assez remplie.
const MIN_RECHARGE = Number(process.env.MIN_RECHARGE_CENTIMES) || 200;          // 2 € minimum par participation
const PLAFOND_PERSONNE = Number(process.env.PLAFOND_PERSONNE_CENTIMES) || 1000; // 10 € maximum par personne (cumulé)
const PLAFOND_CAGNOTTE = Number(process.env.PLAFOND_CAGNOTTE_CENTIMES) || 2000; // au-delà, on bloque les paiements (pas de bénéfice)
const FRAIS_FIXE = 25, FRAIS_PCT = 1.5;                                          // frais Stripe estimés (carte européenne)
const TAUX_USD_EUR = Number(process.env.TAUX_USD_EUR) || 0.92;
const TARIFS = { // dollars par million de tokens : entrée, sortie, écriture cache 1 h (2×), lecture cache
  'claude-sonnet-5-5': [2, 10, 4, 0.10], 'claude-haiku-5-5': [0.10, 0.50, 0.20, 0.01], 'claude-opus-5-5': [4, 20, 8, 0.20] };
const coutCentimes = (model, u) => { const t = TARIFS[model] || TARIFS['claude-sonnet-5-5'];
  return ((u.input_tokens || 0) * t[0] + (u.output_tokens || 0) * t[1] + (u.cache_creation_input_tokens || 0) * t[2] + (u.cache_read_input_tokens || 0) * t[3]) / 1e6 * 100 * TAUX_USD_EUR; };
acces.cagnotte = acces.cagnotte || { solde: 0, verse: 0, frais: 0, depense: 0, lectures: 0 };
function etatCagnotte(code) {
  const k = acces.cagnotte, verseMoi = code && acces.codes[code] ? acces.codes[code].verse || 0 : 0;
  const max = Math.floor(Math.min(PLAFOND_CAGNOTTE - k.solde, PLAFOND_PERSONNE - verseMoi) / 50) * 50; // par pas de 0,50 €
  return { solde: Math.round(k.solde), verse: k.verse, frais: Math.round(k.frais), depense: Math.round(k.depense), lectures: k.lectures,
    coutMoyen: k.lectures ? k.depense / k.lectures : 1, plafond: PLAFOND_CAGNOTTE, plafondPersonne: PLAFOND_PERSONNE, verseMoi,
    ouvert: !!STRIPE_KEY && max >= MIN_RECHARGE, maxPaiement: Math.max(0, max), min: MIN_RECHARGE,
    raison: !STRIPE_KEY ? 'stripe' : PLAFOND_PERSONNE - verseMoi < MIN_RECHARGE ? 'personne' : PLAFOND_CAGNOTTE - k.solde < MIN_RECHARGE ? 'pleine' : '' };
}
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
  if (!acces.credite[cs.id]) { acces.credite[cs.id] = true; const m = cs.amount_total || 0, frais = FRAIS_FIXE + m * FRAIS_PCT / 100;
    c.verse = (c.verse || 0) + m; c.dernierPaiement = Date.now();
    acces.cagnotte.verse += m; acces.cagnotte.frais += frais; acces.cagnotte.solde += m - frais; }
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
  try { fs.copyFileSync(DB_FILE, bk); fs.chmodSync(bk, 0o600); } catch (e) {}   // copie déjà chiffrée
  // conservation : 14 jours de sauvegardes seulement
  try {
    const files = fs.readdirSync(path.join(DATA, 'backups')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.unlinkSync(path.join(DATA, 'backups', f));
  } catch (e) {}
}

// ---------- durée de conservation (RGPD) : effacement automatique ----------
const JOURS_REMIS = Number(process.env.CONSERVATION_REMIS_JOURS) || 30;   // colis remis : 30 jours (le registre papier fait foi)
const JOURS_MAX = Number(process.env.CONSERVATION_MAX_JOURS) || 90;       // tout colis : 90 jours maximum
const JOURS_ANNUAIRE = Number(process.env.CONSERVATION_ANNUAIRE_JOURS) || 120; // personne non revue depuis 120 jours
function purger() {
  const now = Date.now(), J = 864e5, avant = colis.length;
  colis = colis.filter(c => !(c.etat === 'remis' && c.remisAt && now - c.remisAt > JOURS_REMIS * J) && now - c.ts <= JOURS_MAX * J);
  if (colis.length !== avant) { save(); console.log(`🧹 ${avant - colis.length} colis effacés (durée de conservation)`); }
  if (typeof learn !== 'undefined') {
    let n = 0; for (const [k, p] of Object.entries(learn.personnes)) if (now - (p.last || 0) > JOURS_ANNUAIRE * J) { delete learn.personnes[k]; n++; }
    const c0 = learn.corrections.length; learn.corrections = learn.corrections.filter(x => now - (x.ts || 0) <= JOURS_ANNUAIRE * J);
    if (n || c0 !== learn.corrections.length) saveLearn();
  }
  // anciennes sauvegardes en clair (avant le chiffrement) : effacées
  try { for (const f of fs.readdirSync(path.join(DATA, 'backups'))) { const fp = path.join(DATA, 'backups', f); if (!fs.readFileSync(fp, 'utf8').startsWith('{"chiffre":1')) fs.unlinkSync(fp); } } catch (e) {}
  for (const [sid, ss] of Object.entries(sessions)) if (ss.role === 'user' && (!ss.debut || now - ss.debut > 24 * 3600e3 * 2)) delete sessions[sid];
  saveSessions();
}
setTimeout(purger, 5000); setInterval(purger, 6 * 3600e3);

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
const tentatives = {};
const DUREE_SESSION_H = Number(process.env.DUREE_SESSION_HEURES) || 24;
const sessionDe = req => { const sid = cookies(req).sid, s = sessions[sid]; if (!s) return null;
  if (s.role === 'user') {
    const c = acces.codes[s.code];
    if (!c || !c.actif || !s.debut || Date.now() - s.debut > DUREE_SESSION_H * 3600e3) { delete sessions[sid]; saveSessions(); return null; }
  }
  return s; };
const authed = req => !!sessionDe(req);
const cookieSid = (req, sid, age = 31536000) => `sid=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${isHttps(req) ? '; Secure' : ''}`;
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

async function appelClaude(b64, model, acc) {
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
    if (acc) acc.cents += coutCentimes(model, u);
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

async function lireAvec(b64, model, acc) {
  let txt, last;
  for (let essai = 0; essai < 3; essai++) {
    try { txt = await appelClaude(b64, model, acc); break; }
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
  const acc = { cents: 0 };
  let out = await lireAvec(b64, MODEL, acc), score = noter(out);
  const douteux = !out.numero || !out.nom || out.illisible || out.verifier.length;
  if (douteux && MODEL_FIABLE && MODEL_FIABLE !== MODEL) {
    learn.stats.sonnet++;
    try { const o2 = await lireAvec(b64, MODEL_FIABLE, acc); const s2 = noter(o2); if (s2 >= score) { out = o2; score = s2; } } catch (e) { console.error('fiable:', e.message); }
  }
  if (out.transporteur) { learn.transporteurs = learn.transporteurs || {}; learn.transporteurs[out.transporteur] = (learn.transporteurs[out.transporteur] || 0) + 1; }
  saveLearn();
  out = completerAvecAnnuaire(out); out._cout = acc.cents; return out;
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

// ---------- mode privé : seul l'iPhone du propriétaire passe ----------
const estPrive = () => acces.prive ?? (process.env.MODE_PRIVE === '1');
const estProprio = req => { const s = sessionDe(req); return !!s && s.role === 'admin' && (!acces.adminDevice || s.device === acces.adminDevice); };
const MSG_PRIVE = 'Accès réservé : voir avec le propriétaire du site.';
const PAGE_PRIVE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Accès réservé</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:16px system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}h1{font-size:26px;margin:12px 0}p{color:#94a3b8;margin:0 0 6px}#k{margin-top:40px;font-size:12px;color:#475569;background:none;border:0}#f{display:none;margin-top:14px;gap:8px}#f input,#f button{font:inherit;padding:10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0}#e{color:#f87171;font-size:14px;min-height:20px;margin-top:8px}</style></head>
<body><main><div style="font-size:46px">🔒</div><h1>Accès réservé</h1><p>Ce site est privé.</p><p>Voir avec le propriétaire du site.</p>
<button id="k" type="button">Propriétaire</button><form id="f"><input id="pw" type="password" placeholder="Mot de passe" autocomplete="current-password"><button>Entrer</button></form><div id="e"></div></main>
<script>document.getElementById('k').onclick=()=>{document.getElementById('f').style.display='flex';document.getElementById('pw').focus()};
document.getElementById('f').onsubmit=async ev=>{ev.preventDefault();let d='';try{d=localStorage.getItem('device')||''}catch(x){}
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value,device:d})});
if(r.ok)location.href='/';else{const j=await r.json().catch(()=>({}));document.getElementById('e').textContent=j.error||'Refusé'}}</script></body></html>`;

// ---------- routes ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net https://unpkg.com; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()'); res.setHeader('Content-Security-Policy', CSP);
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (estPrive() && !estProprio(req) && !(p === '/api/login' && req.method === 'POST') && p !== '/api/stripe-webhook' && p !== '/confidentialite.html') {
      if (p.startsWith('/api/')) return send(res, 403, { error: MSG_PRIVE, prive: true });
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAGE_PRIVE);
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const t = (tentatives[ip] = (tentatives[ip] || []).filter(x => Date.now() - x < 15 * 60e3));
      if (t.length >= 8) return send(res, 429, { error: 'Trop d\'essais, réessaie dans 15 minutes' });
      t.push(Date.now());
      const b = await readBody(req, 10000);
      const saisie = String(b.password || b.code || '').trim(), device = String(b.device || '').slice(0, 64);
      const a = Buffer.from(saisie), e = Buffer.from(PASSWORD);
      if (a.length === e.length && crypto.timingSafeEqual(a, e)) {
        // accès illimité : réservé au premier appareil connecté en admin (ton iPhone)
        if (acces.adminDevice && device !== acces.adminDevice) { await new Promise(r => setTimeout(r, 1200)); return send(res, 403, { error: 'Accès admin réservé à un autre appareil' }); }
        if (!acces.adminDevice && device) { acces.adminDevice = device; saveAcces(); }
        delete tentatives[ip]; const sid = crypto.randomBytes(32).toString('hex'); sessions[sid] = { role: 'admin', device }; saveSessions();
        return send(res, 200, { ok: true, role: 'admin' }, { 'Set-Cookie': cookieSid(req, sid) });
      }
      if (estPrive()) { await new Promise(r => setTimeout(r, 1200)); return send(res, 403, { error: MSG_PRIVE, prive: true }); }
      const code = saisie.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
      const c = acces.codes[code];
      if (!c || !c.actif) { await new Promise(r => setTimeout(r, 1200)); return send(res, 401, { error: 'Code incorrect' }); }
      if (c.device && device && c.device !== device) return send(res, 403, { error: 'Ce code est déjà utilisé sur un autre téléphone' });
      if (!c.device && device) { c.device = device; c.premiereUtilisation = Date.now(); saveAcces(); }
      delete tentatives[ip]; const sid = crypto.randomBytes(32).toString('hex'); sessions[sid] = { role: 'user', code, device, debut: Date.now() }; saveSessions();
      return send(res, 200, { ok: true, role: 'user', expire: Date.now() + DUREE_SESSION_H * 3600e3 }, { 'Set-Cookie': cookieSid(req, sid, DUREE_SESSION_H * 3600) });
    }
    // ----- paiement Stripe : 5 € → un code -----
    if (p === '/api/config') return send(res, 200, { stripe: !!STRIPE_KEY, cagnotte: etatCagnotte(null), contact: process.env.CONTACT_CREDIT || 'Julien MERCERON' });
    if (p === '/api/payer' && req.method === 'POST') {
      if (!STRIPE_KEY) return send(res, 501, { error: 'Paiement en ligne pas encore activé : demande un code au vaguemestre.' });
      const b = await readBody(req, 2000);
      const montant = Math.round(Number(b.montant) * 100);
      const ss = sessionDe(req);
      let code = ss && ss.role === 'user' ? ss.code : null;                       // participation avec son propre code
      const etat = etatCagnotte(code);
      if (!etat.ouvert) return send(res, 409, { error: etat.raison === 'personne' ? 'Tu as déjà participé à hauteur de 10 €, merci !' : 'La cagnotte est assez remplie pour le moment : pas besoin de payer.', cagnotte: etat });
      if (!(montant >= MIN_RECHARGE && montant <= etat.maxPaiement)) return send(res, 400, { error: `Montant entre ${MIN_RECHARGE / 100} € et ${(etat.maxPaiement / 100).toFixed(2).replace('.', ',')} €`, cagnotte: etat });
      if (!code) { code = nouveauCode(); acces.codes[code] = { actif: false, cree: Date.now(), source: 'stripe', enAttente: true }; saveAcces(); }
      const base = BASE_URL || ((isHttps(req) ? 'https://' : 'http://') + req.headers.host);
      const cs = await stripe('POST', '/checkout/sessions', {
        'metadata[code]': code, 'payment_intent_data[metadata][code]': code,
        'payment_intent_data[description]': `Participation à la cagnotte Scan colis — ton code d'accès : ${code}`, // visible sur le reçu Stripe
        mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'eur',
        'line_items[0][price_data][unit_amount]': String(montant),
        'line_items[0][price_data][product_data][name]': 'Participation cagnotte Scan colis',
        'line_items[0][price_data][product_data][description]': 'Cagnotte commune sans bénéfice : sert uniquement à payer la lecture des étiquettes par l\'IA (10 € max par personne)',
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
      if (dejaActif && acces.credite[id]) return send(res, 200, { code: acces.sessionsStripe[id], cagnotte: etatCagnotte(acces.sessionsStripe[id]) });
      const cs = await stripe('GET', '/checkout/sessions/' + encodeURIComponent(id));
      const code = activerCodeSession(cs);
      if (!code) return send(res, 402, { error: 'Paiement pas encore confirmé, réessaie dans un instant' });
      return send(res, 200, { code, cagnotte: etatCagnotte(code) });
    }
    if (p.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'non connecté' });

      if (p === '/api/logout' && req.method === 'POST') {
        delete sessions[cookies(req).sid]; saveSessions();
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0', 'Clear-Site-Data': '"cache"' });
      }
      if (p === '/api/me') { const ss = sessionDe(req), cc = ss.code ? acces.codes[ss.code] : null; return send(res, 200, { ok: true, role: ss.role, code: ss.code || null, cagnotte: etatCagnotte(ss.code), lecture: API_KEY ? 'claude' : 'locale', signature: SIGNATURE, appris: Object.keys(learn.personnes).length, corrections: learn.corrections.length, stats: learn.stats }); }

      if (p.startsWith('/api/admin/')) {
        if (sessionDe(req).role !== 'admin') return send(res, 403, { error: 'réservé à l\'admin' });
        if (p === '/api/admin/codes' && req.method === 'GET') return send(res, 200, { codes: acces.codes, stripe: !!STRIPE_KEY, cagnotte: etatCagnotte(null) });
        if (p === '/api/admin/codes' && req.method === 'POST') { const code = nouveauCode(); acces.codes[code] = { actif: true, cree: Date.now(), source: 'offert' }; saveAcces(); return send(res, 200, { code }); }
        if (p === '/api/admin/prive' && req.method === 'GET') return send(res, 200, { prive: estPrive() });
        if (p === '/api/admin/prive' && req.method === 'POST') { const b = await readBody(req, 1000); acces.prive = !!b.actif; if (acces.prive) { for (const [sid, ss] of Object.entries(sessions)) if (!(ss.role === 'admin' && (!acces.adminDevice || ss.device === acces.adminDevice))) delete sessions[sid]; saveSessions(); } saveAcces(); return send(res, 200, { prive: acces.prive }); }
        if (p === '/api/admin/deconnecter-tous' && req.method === 'POST') { for (const [sid, ss] of Object.entries(sessions)) if (ss.role !== 'admin') delete sessions[sid]; saveSessions(); return send(res, 200, { ok: true }); }
        if (p === '/api/admin/effacer-personne' && req.method === 'POST') {   // droit à l'effacement (RGPD)
          const bb = await readBody(req, 2000); const k = plain(bb.nom); if (k.length < 2) return send(res, 400, { error: 'nom manquant' });
          const avant = colis.length; colis = colis.filter(c => plain(c.nom) !== k); delete learn.personnes[k];
          learn.corrections = learn.corrections.filter(x => plain(x.lu) !== k && plain(x.correct) !== k);
          save(); saveLearn(); return send(res, 200, { ok: true, colisSupprimes: avant - colis.length });
        }
        const m3 = p.match(/^\/api\/admin\/codes\/([A-Z0-9-]{9})$/);
        if (m3 && req.method === 'DELETE') { delete acces.codes[m3[1]]; for (const [sid, ss] of Object.entries(sessions)) if (ss.code === m3[1]) delete sessions[sid]; saveAcces(); saveSessions(); return send(res, 200, { ok: true }); }
        const m2 = p.match(/^\/api\/admin\/codes\/([A-Z0-9-]{9})\/(liberer|desactiver|activer|crediter)$/);
        if (m2 && req.method === 'POST') { const c = acces.codes[m2[1]]; if (!c) return send(res, 404, { error: 'code inconnu' });
          if (m2[2] === 'liberer') c.device = null; else if (m2[2] === 'crediter') { const bb = await readBody(req, 500).catch(() => ({})); const cents = Math.round(Number(bb.euros || 2) * 100); if (!(cents > 0 && cents <= 100000)) return send(res, 400, { error: 'montant invalide' }); c.verse = (c.verse || 0) + cents; acces.cagnotte.verse += cents; acces.cagnotte.solde += cents; (c.historique = c.historique || []).push({ ts: Date.now(), cents, mode: 'manuel' }); } else c.actif = m2[2] === 'activer';
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
        if (cc && acces.cagnotte.solde <= 0) return send(res, 402, { error: 'cagnotte', cagnotte: etatCagnotte(ss.code) });   // cagnotte vide = plus de lecture IA
        const b = await readBody(req);
        const b64 = String(b.image || '').replace(/^data:image\/\w+;base64,/, '');
        if (!b64) return send(res, 400, { error: 'image manquante' });
        try {
          const out = await lireEtiquette(b64);
          const k = acces.cagnotte; k.solde -= out._cout; k.depense += out._cout; k.lectures++;   // coût réel, toutes lectures confondues
          if (cc) cc.scans = (cc.scans || 0) + 1; saveAcces(); delete out._cout; out.cagnotte = etatCagnotte(ss.code);
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
