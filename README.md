# Toon Tone Tour 🚲🎨

Jeu multijoueur temps réel inspiré d'un jeu de recherche de couleur, habillé façon Tour de France.

## Principe

- L'animateur ajoute des **logos**, une **couleur cible** et un nombre de **points de difficulté**.
- Le logo est montré aux joueurs **en niveaux de gris**.
- Chaque joueur choisit une couleur puis valide avant la fin du chrono.
- La proximité est calculée côté serveur avec une distance perceptuelle **CIE Lab / ΔE76**.

### Classements

- **🟨 Maillot jaune** : moyenne des pourcentages de proximité, du plus élevé au plus faible.
- **🟩 Maillot vert** : temps cumulé de réponse, du plus faible au plus élevé. Un joueur qui ne répond pas reçoit le temps maximum de la manche.
- **🔴 Maillot à pois** : points liés à la difficulté du logo. À chaque manche : 1er = 100 % des points, 2e = 60 %, 3e = 30 %.

## Lancer en local

Prérequis : Node.js 20+.

```bash
npm install
npm start
```

Puis ouvrir :

- Joueurs : `http://localhost:3000`
- Animateur : `http://localhost:3000/admin.html`
- Mot de passe admin local par défaut : `admin`

## Déploiement GitHub + Railway

1. Crée un dépôt GitHub et mets tous les fichiers de ce projet à la racine.
2. Sur Railway, crée un nouveau projet **Deploy from GitHub repo**.
3. Dans **Variables**, ajoute :
   - `ADMIN_PASSWORD` = un vrai mot de passe
   - `DATA_DIR` = `/data`
   - facultatif : `ROUND_SECONDS` = `20`
4. Ajoute un **Volume Railway** monté sur `/data` afin de conserver les logos, joueurs et scores après redéploiement/restart.
5. Dans **Networking**, génère un domaine public.
6. Ouvre `/admin.html`, ajoute tes logos et partage le code de salle ou le lien avec `?room=ABCDE`.

Railway fournit automatiquement `PORT`, le serveur l'utilise déjà.

## Structure

```text
.
├── server.js
├── package.json
├── railway.json
├── README.md
└── public/
    ├── index.html
    ├── admin.html
    ├── app.js
    ├── admin.js
    ├── logo-renderer.js
    └── styles.css
```

## Données et persistance

Le jeu écrit un fichier `game-state.json` dans :

1. `DATA_DIR` si défini,
2. sinon `/data` si le dossier existe,
3. sinon `./local-data` en local.

Les images sont stockées directement dans ce JSON sous forme de Data URL. C'est volontaire pour garder un déploiement simple. Pour plusieurs centaines de gros logos, mieux vaut passer ensuite à S3/Cloudinary/Supabase Storage.

## Sécurité

Le mot de passe par défaut `admin` n'est prévu que pour tester. Sur Railway, configure impérativement `ADMIN_PASSWORD`.

## Idées de V2

- écran podium final / fin d'étape,
- QR code de connexion,
- équipes,
- plusieurs couleurs cibles par logo,
- modes « couleur principale », « couleur secondaire » et « ordre des couleurs »,
- export CSV des résultats,
- programmation automatique d'une playlist de logos,
- sons / animations de sprint et attribution visuelle des maillots.

## Couleur partielle du logo

Depuis cette version, seule la couleur cible est neutralisée. Exemple : pour le logo Eurofins, tu peux sélectionner l'orange comme couleur à retrouver ; le bleu reste affiché normalement pendant la manche.

Dans l'espace animateur :

1. charge le logo ;
2. clique directement sur la couleur à masquer dans l'aperçu (ou choisis-la avec le sélecteur) ;
3. ajuste la **tolérance de détection** si nécessaire ;
4. vérifie que seule la zone voulue devient grise ;
5. ajoute le logo au parcours.

Pendant la manche, la zone grise se recolore en direct avec la couleur choisie par le joueur. Les anciennes entrées sauvegardées sans réglage de tolérance utilisent automatiquement la valeur `42`.
