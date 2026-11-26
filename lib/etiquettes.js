// Connaissance des étiquettes de colis : formats de numéros, contrôle des noms, guide de lecture pour l'IA.
'use strict';

const norm = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const plainUp = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// ---------- formats de numéros de suivi, par transporteur ----------
// Chaque entrée : expression régulière sur le numéro nettoyé (majuscules, sans espaces ni tirets).
const FORMATS = {
  colissimo: [/^[6-9][A-Z]\d{11}$/, /^[A-Z]{2}\d{9}FR$/],                   // 6C21339014797, 8R…, CB123456789FR
  laposte: [/^\d[A-Z]\d{11}$/, /^[A-Z]{2}\d{9}FR$/],                        // lettre suivie 1K…, recommandé 1A… / RA…FR
  amazon: [/^FR\d{10}$/, /^TBA\d{12}$/],                                     // FR3269215560, TBA123456789012
  chronopost: [/^[A-Z]{2}\d{9}[A-Z]{2}$/],                                   // XN217543973JB, GL692682820JB
  dpd: [/^\d{14}[A-Z]?$/, /^\d{12,15}$/],                                    // 10314002082630 (+ lettre de contrôle)
  dhl: [/^[A-Z]{2}\d{9}DE$/, /^\d{10}$/, /^\d{12}$/, /^\d{20}$/, /^JJD\d{16,20}$/], // CI161997812DE, Express 10, Paket 12/20
  ups: [/^1Z[A-Z0-9]{16}$/],
  gls: [/^\d{11,12}$/, /^[A-Z0-9]{8}$/],
  fedex: [/^\d{12}$/, /^\d{15}$/],
  tnt: [/^GE\d{9}WW$/, /^\d{9}$/],
  mondialrelay: [/^\d{8,12}$/],
  relaiscolis: [/^\d{10,16}$/, /^[A-Z0-9]{10,16}$/],
  colisprive: [/^\d{16,17}$/, /^[A-Z0-9]{10,20}$/],
  cainiao: [/^LP\d{14}$/, /^[A-Z]{2}\d{9}CN$/, /^CNFR[A-Z0-9]{8,20}$/],      // AliExpress
  yunexpress: [/^YT\d{16}$/],                                                // Temu, Shein…
};
const ALIAS = [
  [/colissimo/i, 'colissimo'], [/poste|lettre|recommand/i, 'laposte'], [/amazon/i, 'amazon'], [/chrono/i, 'chronopost'],
  [/dpd/i, 'dpd'], [/dhl|deutsche/i, 'dhl'], [/ups/i, 'ups'], [/gls/i, 'gls'], [/fedex/i, 'fedex'], [/tnt/i, 'tnt'],
  [/mondial|vinted go/i, 'mondialrelay'], [/relais ?colis/i, 'relaiscolis'], [/colis ?priv/i, 'colisprive'],
  [/cainiao|aliexpress/i, 'cainiao'], [/yun|temu|shein/i, 'yunexpress'],
];
const transporteurCle = t => { for (const [re, k] of ALIAS) if (re.test(String(t || ''))) return k; return ''; };

// clé de contrôle Colissimo (pondération 3/1 sur les 10 premiers chiffres) — vérifiée sur de vrais numéros
function cleColissimoOk(k) {
  const d = k.slice(2, 12).split('').map(Number); let s = 0; d.forEach((x, i) => { s += i % 2 ? x : 3 * x; });
  return (10 - s % 10) % 10 === +k[12];
}

// formats « forts » d'autres transporteurs (ex. colis Vinted annoncé Mondial Relay mais expédié en Colissimo)
const FORT = /^(FR\d{10}|[A-Z]{2}\d{9}[A-Z]{2}|1Z[A-Z0-9]{16}|TBA\d{12}|YT\d{16}|LP\d{14}|JJD\d{16,20})$/;
function numeroValide(n, tr) {
  const k = norm(n); if (!k) return false;
  if (/^[6-9][A-Z]\d{11}$/.test(k) && !cleColissimoOk(k)) return false;    // chiffre mal lu sur un Colissimo
  const t = transporteurCle(tr);
  if (!t) return /^[6-9][A-Z]\d{11}$/.test(k) || /^\d[A-Z]\d{11}$/.test(k) || FORT.test(k) || /^\d{14}[A-Z]?$/.test(k) || /^\d{18,22}$/.test(k);
  if (FORMATS[t].some(re => re.test(k))) return true;
  return FORT.test(k);
}

// ---------- clés pour repérer un doublon (formats forts uniquement) ----------
function trackKey(c) {
  const k = norm(c); let m;
  if (/^FR\d{10}$/.test(k)) return k;                            // Amazon
  if ((m = k.match(/^\d{0,2}(\d[A-Z]\d{11})$/))) return m[1];     // Colissimo / La Poste (116C… → 6C…)
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(k)) return k;                 // S10 : Chronopost, recommandé, DHL CI…DE, TNT GE…WW
  if (/^1Z[A-Z0-9]{16}$/.test(k)) return k;                         // UPS
  if (/^(TBA\d{12}|YT\d{16}|LP\d{14}|JJD\d{16,20})$/.test(k)) return k;
  if ((m = k.match(/^(\d{14})[A-Z]$/))) return m[1];               // DPD + lettre de contrôle
  if (/^\d{12,22}$/.test(k)) return k;                             // DPD, SSCC, Colis Privé…
  return null;
}
function keysFor(numero, codes) {
  const s = new Set(), m = norm(numero);
  if (m) { let t = trackKey(m); if (!t && /^\d{10}$/.test(m)) t = 'FR' + m; s.add(t || m); }
  for (const c of codes || []) { const t = trackKey(c); if (t) s.add(t); }
  return s;
}

// ---------- contrôle des noms : pas de mots d'adresse ni de codes ----------
const MOTS_INTERDITS = new Set(('CHAUMONT FRANCE ECOLE GENDARMERIE AVENUE AV RUE REGIMENT RGT INFANTERIE RI CIE COMPAGNIE CYCLE DBF ORY LYS ' +
  'COLISSIMO CHRONOPOST AMAZON DPD DHL UPS GLS LA POSTE PREDICT SIGN DOM CONTACT REF TRACK SERVICE SHIPMENT DELIVERY ADDRESS ' +
  'DESTINATAIRE EXPEDITEUR SENDER RECIPIENT COLIS POIDS KG PREMIUM PAKET INTERNATIONAL FR CEDEX BP SECTION BATIMENT ' +
  'MONDIAL RELAY RELAIS PRIVE SHEIN TEMU ALIEXPRESS VINTED ZALANDO DECATHLON CDISCOUNT FNAC LOGISTICS EXPRESS PARCEL ' +
  'EG GAV ESOG ELEVE SGT MDL MDC ADJ ADC MAJ LTN SLT CNE CDT M MR MME MLLE MLE').split(' '));
const MOTS_JAMAIS = ['CHAUMONT', 'GENDARMERIE', 'AVENUE', 'INFANTERIE', 'REGIMENT', 'COLISSIMO', 'CHRONOPOST', 'AMAZON', 'CEDEX', 'FRANCE'];
function nomValide(n) {
  const t = plainUp(n).trim(); if (!t || /\d/.test(t) || t.length < 2 || t.length > 40) return false;
  const mots = t.split(/[\s'-]+/).filter(Boolean); if (!mots.length || mots.length > 4) return false;
  if (mots.some(m => MOTS_JAMAIS.includes(m))) return false;
  return !mots.every(m => MOTS_INTERDITS.has(m));
}

// ---------- guide de lecture donné à l'IA ----------
const GUIDE = `Où chercher selon le modèle d'étiquette :
• Colissimo (logo colissimo, souvent sachet souple) : nom en haut à gauche du bloc destinataire ; numéro après « Num colis : » (6A/6C/6G/6H/6M/6Q/6R/6V/6W/8L/8Q/8R/8V + 11 chiffres, parfois écrit « 6C 21339014797 »). Ignore « 116C… » (code de tri), « FR-COL-… », « Réf client », « Compte ».
• La Poste lettre suivie / recommandé : 1A…, 1K…, 2C… (+ 11 chiffres) ou RA…FR / RR…FR ; mention « Recommandé », « R1/R2 », « avis de réception » → type R.
• Amazon (ORY1, DBF1, CYCLE 1, XFRZ, LYS8, souvent carton ou sachet kraft) : nom sur la 1re ligne d'adresse (souvent « Prénom NOM ») ; numéro FR + 10 chiffres au centre (parfois coupé « FR326794 1872 ») ; Amazon Logistics : TBA + 12 chiffres. Ignore « TnMw5w5Xs », « 2/3061 ».
• Chronopost (Chrono 13, Chrono 18, Shop2Shop) : nom en haut du bloc « Delivery address » ou après « Ref : » ; numéro 2 lettres + 9 chiffres + 2 lettres (XN217543973JB, GL692682820JB) sous un code-barres. Ignore « FR-CHR-0436-TOY0 », « 52U60 », « 3C », « 18H ».
• DPD (Predict, Classic) : nom après « Contact » ou « Info » (ignore « M. », « Mme ») ; numéro après « Track » (14 chiffres, ex. 1031 4002 0826 30 → 10314002082630). Ignore « FR-DPD-… », « 010SA », « 328-FR-52000 ».
• DHL Paket / Deutsche Post : nom après « An/To » ; numéro « Shipment No. » (CI161997812DE) ou 12–20 chiffres. DHL Express : « Waybill » 10 chiffres.
• UPS : nom sous « SHIP TO » ; numéro « TRACKING # 1Z… ».
• GLS : nom dans « Destinataire » ; numéro « Track ID » (8 caractères) ou 11–12 chiffres.
• Mondial Relay / Vinted Go / Relais Colis : nom du destinataire en gros ; numéro d'expédition (8 à 12 chiffres) sous le code-barres ; le point relais n'est pas le destinataire.
• Colis Privé, YunExpress (YT…), Cainiao / AliExpress (LP…, …CN), Shein, Temu : nom sur la ligne « To » ou première ligne d'adresse ; numéro le plus long près du code-barres principal.
• FedEx (12 ou 15 chiffres), TNT (GE…WW).
• Étiquette inconnue : le numéro est l'identifiant mêlant lettres et chiffres (ou ≥ 12 chiffres) imprimé sous ou à côté du code-barres principal ; jamais un code de tri, un code postal ou une date.
Le nom du DESTINATAIRE n'est jamais : l'expéditeur, une marque, une ville, une rue, « École de gendarmerie », un service, un point relais ou un code de tri.
Mention manuscrite (« C1 », « 6 », « CI 1 », « 1cie ») près du nom = compagnie. Un gribouillis sans rapport (« E500 ») est à ignorer.`;

// ---------- exemples réels déjà lus à l'école (Chaumont) ----------
const EXEMPLES = `Exemples d'étiquettes reçues ici et la bonne lecture :
1. Colissimo, sachet souple : « LANE GUILLAUME / 1 AVENUE DU 109IEME RI / ECOLE DE GENDARMERIE 6 CIE / Num colis : 6C 21339014797 / Réf client 2558036238 / 116C21339014799 / FR-COL-1176-52CHA » → numero 6C21339014797, nom LANE, prenom Guillaume, cie 6.
2. Amazon, carton : « Antoine GOSSE DARCHE / 1, Avenue du 109ème R.I. / 1 compagnie / FR3269215560 / DBF1 CYCLE 1 » → numero FR3269215560, nom GOSSE DARCHE, prenom Antoine, cie 1.
3. Amazon, sachet kraft : « DENDENE Lila 1ere CIE / FR3268170312 / DBF1 CYCLE 1 » → numero FR3268170312, nom DENDENE, prenom Lila, cie 1.
4. Amazon sans nom de personne : « Obern – Frontier / 6eme Compagnie / FR326794 1872 » → numero FR3267941872, nom OBERN-FRONTIER (seulement si c'est le seul nom), cie 6.
5. Chronopost (Decathlon), carton : « Ewen Kerjean 1cie / XN217543973JB / XN21 7543 9733 36O / FR-CHR-0436-TOY0 / Reference FRFFW046778740 » → numero XN217543973JB, nom KERJEAN, prenom Ewen, cie 1, produit Decathlon.
6. Chronopost (Salomon) : « EG Arthur Salaün 1CIE / GL692682820JB / 0052 000G L692 6828… » → numero GL692682820JB, nom SALAÜN, prenom Arthur (EG = grade, ignoré), cie 1, produit Salomon.
7. DPD, sachet souple : « Contact M. maxime robles / CI9 (manuscrit) / 1031 4002 0826 30 Q / FR-DPD-1010 / Ref1 VD267831 » → numero 10314002082630, nom ROBLES, prenom Maxime, cie : seulement si lisible avec certitude.
8. DHL Paket International (Mammut), carton : « An/To : Antoine Gosse darche, 1 Av. du 109E R.I 1 compagnie / Shipment No. CI161997812DE » → numero CI161997812DE, nom GOSSE DARCHE, prenom Antoine, cie 1.`;

module.exports = { norm, plainUp, FORMATS, transporteurCle, cleColissimoOk, numeroValide, trackKey, keysFor, nomValide, MOTS_INTERDITS, GUIDE, EXEMPLES };
