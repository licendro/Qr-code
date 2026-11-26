# Scan colis — registre du vaguemestre

Petite app web pour enregistrer les colis du vaguemestre :

- photo de l'étiquette (mise au point de l'iPhone) : enregistrement automatique dès qu'elle a le numéro et le nom, bouton « Corriger » ;
- l'app apprend : annuaire des personnes déjà vues (orthographe + compagnie) et corrections renvoyées à l'IA ;
- lecture économique : Haiku d'abord, Sonnet seulement si besoin ;
- lecture par Claude (clé API) : numéro de suivi (Colissimo 6C…, Amazon FR…, Chronopost XN…JB, DPD, DHL…), nom, prénom, compagnie, expéditeur ;
- tous les numéros de l'étiquette sont gardés : si l'un d'eux a déjà été scanné → **alarme** ;
- suivi À reporter → À remettre → Remis, message WhatsApp, recherche ;
- liste partagée entre tous tes appareils, protégée par un mot de passe.

Pas de dépendance : il suffit de Node.js 20 ou plus. Les données sont dans `data/` (jamais envoyées sur GitHub). Une sauvegarde est faite chaque jour dans `data/backups/`, et les 60 derniers jours sont gardés.

---

## Installation sur le VPS (Ubuntu / Debian)

```bash
# 1. Node.js 22 + git
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # doit afficher v22.x

# 2. Récupérer l'app
cd ~
git clone https://github.com/licendro/Qr-code.git qr-code
cd qr-code

# 3. Configurer
cp .env.example .env
nano .env          # mets un APP_PASSWORD long, et ta clé ANTHROPIC_API_KEY si tu en as une
                   # (Ctrl+O, Entrée, Ctrl+X pour enregistrer et quitter)

# 4. Tester une fois
node server.js     # doit afficher « Scan colis en ligne sur le port 3000 »
                   # Ctrl+C pour arrêter

# 5. Le faire tourner en permanence (redémarre tout seul, même après un reboot)
sudo npm install -g pm2
pm2 start server.js --name qr-code
pm2 save
pm2 startup        # copie-colle puis lance la commande « sudo env PATH=... » qu'il affiche

# 6. Ouvrir le port (si le pare-feu ufw est actif)
sudo ufw allow 3000/tcp
```

Ensuite, ouvre `http://IP-DU-VPS:3000` sur ton iPhone. Dans Safari, touche **Partager → Sur l'écran d'accueil** pour l'avoir comme une app.

## HTTPS (obligatoire pour le scan en direct)

1. IONOS → DNS de jdev-hub.fr : enregistrement **A** `colis` → `217.160.243.228`, **sans AAAA**.
2. Vérifier : `dig +short A colis.jdev-hub.fr @ns1075.ui-dns.com` doit afficher l'IP, et `dig +short AAAA colis.jdev-hub.fr @1.1.1.1` rien.
3. `sed -i 's/server_name 217.160.243.228;/server_name colis.jdev-hub.fr 217.160.243.228;/' /etc/nginx/sites-available/qr-code && nginx -t && systemctl reload nginx`
4. `certbot --nginx -d colis.jdev-hub.fr --redirect --agree-tos --register-unsafely-without-email`

## Mettre à jour sans perdre les données

```bash
cd ~/qr-code && git pull && pm2 restart qr-code
```

Le dossier `data/` n'est pas suivi par git, donc une mise à jour ne l'efface jamais.

## Crédit prépayé (pas de bénéfice : ça paie seulement l'API)

- Chacun paie le montant qu'il veut (2 € minimum) par carte via Stripe Checkout → reçoit un **code** (affiché + écrit sur le reçu Stripe). Un code = un téléphone.
- Chaque lecture d'étiquette par l'IA retire **5 centimes** du crédit du code ; les doublons repérés par code-barres et la saisie à la main sont gratuits. Bouton « Recharger ».
- `APP_PASSWORD` = **admin illimité et gratuit**, verrouillé sur le premier téléphone qui s'en sert. Panneau « Codes d'accès » : code offert (2 € de crédit), +2 €, changer de téléphone, désactiver.
- Le crédit est versé par le **webhook** `checkout.session.completed` / `async_payment_succeeded` (signature vérifiée) et, en secours, par la page de retour (jamais crédité deux fois).
- Webhook Stripe : `https://colis.jdev-hub.fr/api/stripe-webhook`.
- Changer le téléphone admin : `cd ~/qr-code && node -e "const f='data/acces.json',a=require('./'+f);a.adminDevice=null;require('fs').writeFileSync(f,JSON.stringify(a,null,1))" && pm2 restart qr-code`

## Vider toute la base (avec sauvegarde)

```bash
cd ~/qr-code && cp data/colis.json data/backups/avant-vidage-$(date +%F-%Hh%M).json && echo '[]' > data/colis.json && pm2 restart qr-code
```

## Commandes utiles

```bash
pm2 logs qr-code          # voir les journaux
pm2 restart qr-code       # redémarrer
pm2 status                # état
cp data/colis.json ~/colis-sauvegarde.json   # sauvegarde manuelle
```

## Lecture des étiquettes

- **Avec `ANTHROPIC_API_KEY`** (dans `.env`) : Claude lit toute l'étiquette (numéro FR, nom, prénom, produit, téléphone, infos). La clé se crée sur console.anthropic.com. Par défaut, l'app utilise Claude Sonnet 5.5 (fiable, environ 0,6 centime par colis). Mets `ANTHROPIC_MODEL=claude-haiku-5-5` pour payer environ 20 fois moins. Si l'API ne répond pas, l'app bascule sur la lecture locale.
- **Sans clé** : lecture locale sur le téléphone. Elle trouve seulement le numéro FR et le téléphone, et il faut taper le nom à la main.

## Remarque

Si le bouton silencieux de l'iPhone est activé, le bip d'alarme ne s'entend pas, mais l'écran clignote quand même en rouge.
