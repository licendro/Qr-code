# Scan colis — registre du vaguemestre

Petite app web pour enregistrer les colis :

- caméra en direct (en https) : l'app lit l'étiquette toute seule et enregistre le colis dès qu'elle a le numéro et le nom ; sinon tu prends une photo et l'app remplit le numéro FR, le nom, le prénom, le produit, le téléphone et les infos (société, unité…) ;
- la date et l'heure s'enregistrent automatiquement ;
- tu peux chercher dans la liste ;
- **Validé ✓** retire le colis de la liste (il reste en base pour détecter les doublons) ;
- un colis déjà scanné déclenche une **alarme** (bip fort, écran rouge qui clignote, « PRODUIT DÉJÀ SCANNÉ ») ;
- un message WhatsApp tout prêt (« disponible au vaguemestre ») se copie, ou s'ouvre directement si le téléphone est connu ;
- la liste est partagée entre tous tes appareils et protégée par un mot de passe.

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

## HTTPS (obligatoire pour le scan en direct avec la caméra)

Sur iPhone, Safari n'ouvre la caméra en direct qu'en **https**. Il faut donc un sous-domaine, par exemple `colis.jdev-hub.fr`.

1. Chez ton hébergeur DNS (IONOS) : ajoute un enregistrement **A**, nom `colis`, valeur `217.160.243.228`.
2. Sur le VPS (nginx déjà installé) :

```bash
cat > /etc/nginx/sites-available/qr-code <<'NGINX'
server {
    listen 80;
    server_name colis.jdev-hub.fr 217.160.243.228;
    client_max_body_size 15m;
    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
}
NGINX
nginx -t && systemctl reload nginx
apt install -y certbot python3-certbot-nginx
certbot --nginx -d colis.jdev-hub.fr --redirect --agree-tos --register-unsafely-without-email
```

3. Ouvre `https://colis.jdev-hub.fr` : le bouton devient « Démarrer le scan ».

## Mettre à jour sans perdre les données

```bash
cd ~/qr-code && git pull && pm2 restart qr-code
```

Le dossier `data/` n'est pas suivi par git, donc une mise à jour ne l'efface jamais.

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
