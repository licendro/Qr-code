# Scan colis — registre du vaguemestre

Petite app web pour savoir si un colis a déjà été scanné :

- tu prends l'étiquette en photo : l'app relève **tous les numéros** (codes-barres + numéros de suivi), sans les noms ;
- si l'un de ces numéros a déjà été scanné : **alarme** (bip fort, écran rouge, « DÉJÀ SCANNÉ » avec la date) ;
- sinon le colis est enregistré avec la date et l'heure ;
- saisie manuelle possible, recherche, suppression d'un scan ;
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
