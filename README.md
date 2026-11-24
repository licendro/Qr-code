# Scan colis — registre du vaguemestre

Petite app web pour enregistrer les colis :

- tu prends l'étiquette en photo et l'app remplit le numéro FR, le nom, le prénom, le produit, le téléphone et les infos (société, unité…) ;
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

## HTTPS avec un nom de domaine (recommandé)

Sur iPhone, le bouton « Copier le message » marche mieux en HTTPS, et ton mot de passe ne passe plus en clair.

1. Chez ton registrar, crée un enregistrement DNS **A** `colis.ton-domaine.fr` qui pointe vers l'IP du VPS.
2. Sur le VPS :

```bash
sudo apt install -y caddy
echo 'colis.ton-domaine.fr {
    reverse_proxy localhost:3000
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw delete allow 3000/tcp     # l'app n'est plus accessible qu'en https
```

Ensuite, ouvre `https://colis.ton-domaine.fr`. Caddy s'occupe tout seul du certificat.

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

- **Avec `ANTHROPIC_API_KEY`** (dans `.env`) : Claude lit toute l'étiquette (numéro FR, nom, prénom, produit, téléphone, infos). La clé se crée sur console.anthropic.com. Chaque lecture coûte une petite fraction de centime avec le modèle Haiku.
- **Sans clé** : lecture locale sur le téléphone. Elle trouve seulement le numéro FR et le téléphone, et il faut taper le nom à la main.

## Remarque

Si le bouton silencieux de l'iPhone est activé, le bip d'alarme ne s'entend pas, mais l'écran clignote quand même en rouge.
