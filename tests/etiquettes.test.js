// Banc d'essai : 60 étiquettes de modèles différents (lectures possibles de l'IA, bonnes ou mauvaises)
// Lancer : npm test
'use strict';
const E = require('../lib/etiquettes');

// [transporteur annoncé, numéro lu, nom lu, numéro accepté ?, nom accepté ?, description]
const CAS = [
  // --- Colissimo / La Poste ---
  ['Colissimo', '6C21339014797', 'LANE', true, true, 'Colissimo réel (LANE)'],
  ['Colissimo', '6C 21339014797', 'LANE', true, true, 'numéro avec espace'],
  ['Colissimo', '5C21339014797', 'LANE', false, true, '6 lu comme 5 (préfixe impossible)'],
  ['Colissimo', '6C21339014798', 'LANE', false, true, 'dernier chiffre mal lu (clé fausse)'],
  ['Colissimo', '6C21339O14797', 'LANE', false, true, 'O à la place de 0'],
  ['Colissimo', '6A05233302808', 'OBERN-FRONTIER', true, true, 'Colissimo 6A réel'],
  ['Colissimo', '116C21339014799', 'LANE', false, true, 'code de tri pris pour le numéro'],
  ['Colissimo', 'FR-COL-1176-52CHA', 'LANE', false, true, 'code de tri FR-COL'],
  ['Colissimo', '2558036238', 'LANE', false, true, 'réf client prise pour le numéro'],
  ['Colissimo', '6C21339014797', 'ECOLE DE GENDARMERIE', true, false, 'adresse prise pour le nom'],
  ['Colissimo', '6C21339014797', 'CHAUMONT', true, false, 'ville prise pour le nom'],
  ['Colissimo', '6C21339014797', '1 AVENUE DU 109IEME RI', true, false, 'rue prise pour le nom'],
  ['Colissimo', 'CB123456789FR', 'MARTIN', true, true, 'Colissimo international'],
  ['La Poste', '1K12345678901', 'DURAND', true, true, 'lettre suivie'],
  ['La Poste', '1A12345678901', 'PETIT', true, true, 'recommandé national'],
  ['La Poste', 'RA123456789FR', 'LEROY', true, true, 'recommandé international'],
  // --- Amazon ---
  ['Amazon', 'FR3269215560', 'GOSSE DARCHE', true, true, 'Amazon réel'],
  ['Amazon', 'FR3268170312', 'DENDENE', true, true, 'Amazon réel (DENDENE)'],
  ['Amazon', 'FR326794 1872', 'OBERN-FRONTIER', true, true, 'numéro Amazon coupé en deux'],
  ['Amazon', 'FR32692155', 'GOSSE DARCHE', false, true, 'numéro Amazon tronqué'],
  ['Amazon', 'TBA123456789012', 'ROUX', true, true, 'Amazon Logistics TBA'],
  ['Amazon', 'DBF1', 'DENDENE', false, true, 'code de tri DBF1'],
  ['Amazon', 'FR3269215560', 'CYCLE', true, false, '« CYCLE » pris pour le nom'],
  ['Amazon', 'FR3269215560', 'AMAZON', true, false, 'marque prise pour le nom'],
  // --- Chronopost ---
  ['Chronopost', 'XN217543973JB', 'KERJEAN', true, true, 'Chronopost réel'],
  ['Chronopost', 'GL692682820JB', 'SALAÜN', true, true, 'Chronopost réel (accent)'],
  ['Chronopost', 'XN21 7543 9733 36O', 'KERJEAN', false, true, 'ligne Track interne'],
  ['Chronopost', 'FR-CHR-0436-TOY0', 'KERJEAN', false, true, 'code de tri TOY0'],
  ['Chronopost', 'FRFFW046778740', 'KERJEAN', false, true, 'référence expéditeur'],
  ['Chronopost', 'XN217543973JB', 'DECATHLON', true, false, 'expéditeur pris pour le nom'],
  ['Chronopost', 'XN217543973JB', 'EG', true, false, 'grade seul'],
  // --- DPD ---
  ['DPD', '10314002082630', 'ROBLES', true, true, 'DPD réel'],
  ['DPD', '1031 4002 0826 30 Q', 'ROBLES', true, true, 'DPD avec lettre de contrôle'],
  ['DPD', 'FR-DPD-1010', 'ROBLES', false, true, 'code de tri DPD'],
  ['DPD', 'VD267831', 'ROBLES', false, true, 'référence commande'],
  ['DPD', '10314002082630', 'PREDICT', true, false, 'nom du service'],
  // --- DHL / Deutsche Post ---
  ['DHL', 'CI161997812DE', 'GOSSE DARCHE', true, true, 'DHL Paket international réel'],
  ['DHL', '1234567890', 'WEBER', true, true, 'DHL Express 10 chiffres'],
  ['DHL', '00340434161234567890', 'SCHMIDT', true, true, 'DHL Paket 20 chiffres'],
  ['DHL', '5026557/439 53 04', 'GOSSE DARCHE', false, true, 'numéro de facturation'],
  ['Deutsche Post', 'CI161997812DE', 'PAKET', true, false, 'mot de l\'étiquette pris pour le nom'],
  // --- UPS / GLS / FedEx / TNT ---
  ['UPS', '1Z999AA10123456784', 'BERNARD', true, true, 'UPS'],
  ['UPS', '1Z999AA1012345', 'BERNARD', false, true, 'UPS tronqué'],
  ['GLS', '12345678901', 'MOREAU', true, true, 'GLS 11 chiffres'],
  ['GLS', 'ZK4P7Q2M', 'MOREAU', true, true, 'GLS Track ID'],
  ['FedEx', '123456789012', 'GIRARD', true, true, 'FedEx 12 chiffres'],
  ['TNT', 'GE123456789WW', 'FAURE', true, true, 'TNT'],
  // --- relais / marketplaces ---
  ['Mondial Relay', '12345678', 'LAMBERT', true, true, 'Mondial Relay 8 chiffres'],
  ['Mondial Relay', '12345678', 'RELAY', true, false, 'nom du réseau pris pour le nom'],
  ['Vinted Go', '1234567890', 'FONTAINE', true, true, 'Vinted Go'],
  ['Relais Colis', '1234567890123', 'ROUSSEAU', true, true, 'Relais Colis'],
  ['Colis Privé', '12345678901234567', 'VINCENT', true, true, 'Colis Privé'],
  ['YunExpress', 'YT2412345678901234', 'MULLER', true, true, 'Temu / YunExpress'],
  ['Shein', 'YT2412345678901234', 'SHEIN', true, false, 'marque prise pour le nom'],
  ['Cainiao', 'LP00123456789012', 'LEFEBVRE', true, true, 'AliExpress Cainiao'],
  ['AliExpress', 'UH123456789CN', 'MERCIER', true, true, 'AliExpress S10'],
  // --- inconnu / pièges ---
  ['', '6C21339014797', 'Guillaume LANE', true, true, 'transporteur non reconnu'],
  ['Autre', '52000', 'BLANC', false, true, 'code postal'],
  ['Autre', '23/11/2026', 'BLANC', false, true, 'date'],
  ['Autre', 'XN217543973JB', 'CEDEX', true, false, 'mot d\'adresse'],
];

// doublons : [numéro A, codes A, numéro B, codes B, doublon attendu ?, description]
const DOUBLONS = [
  ['6C21339014797', ['116C21339014799', 'FR-COL-1176-52CHA', '2558036238'], '6C 21339014797', [], true, 'même Colissimo avec espaces'],
  ['6C21339014797', ['116C21339014799'], '', ['116C21339014799'], true, 'même colis via le code de tri'],
  ['6C21339014797', ['2558036238', 'FR-COL-1176-52CHA'], '6C62089323502', ['2558036238', 'FR-COL-1176-52CHA'], false, 'même réf client + même tri = colis différents'],
  ['XN217543973JB', ['FR-CHR-0436-TOY0'], 'GL692682820JB', ['FR-CHR-0436-TOY0'], false, 'même code TOY0 = colis différents'],
  ['FR3268170312', [], '3268170312', [], true, 'Amazon tapé sans FR'],
  ['FR3268170312', [], 'FR3268170319', [], false, 'Amazon proches mais différents'],
  ['10314002082630', [], '10314002082630Q', [], true, 'DPD avec / sans lettre'],
  ['CI161997812DE', [], 'ci 161997812 de', [], true, 'DHL écrit autrement'],
];

let ok = 0, ko = 0;
for (const [tr, num, nom, numAtt, nomAtt, desc] of CAS) {
  const n = E.numeroValide(num, tr), m = E.nomValide(nom);
  if (n === numAtt && m === nomAtt) ok++; else { ko++; console.log(`✗ ${desc} — ${tr} « ${num} » / « ${nom} » : numéro ${n} (attendu ${numAtt}), nom ${m} (attendu ${nomAtt})`); }
}
for (const [na, ca, nb, cb, att, desc] of DOUBLONS) {
  const A = E.keysFor(na, ca), B = E.keysFor(nb, cb); const dup = [...B].some(k => A.has(k));
  if (dup === att) ok++; else { ko++; console.log(`✗ doublon : ${desc} — trouvé ${dup}, attendu ${att}`); }
}
console.log(`\n${ok}/${ok + ko} tests réussis (${CAS.length} étiquettes, ${DOUBLONS.length} cas de doublons)`);
process.exit(ko ? 1 : 0);
