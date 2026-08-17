# Toon Tone Tour V2.3

Jeu multijoueur temps réel de reconnaissance de couleurs de logos, avec une identité visuelle inspirée du Tour de France.

## Nouveautés V2.3

### Difficulté montagne automatique
Chaque logo reçoit une catégorie :

- 🟢 Facile : 2 pts
- 🔵 Moyen : 5 pts
- 🟡 Difficile : 10 pts
- 🔴 Très difficile : 15 pts
- ⚫ Hors catégorie : 20 pts

L'estimation utilise :
- la notoriété de la marque ;
- la part visible du logo correspondant à la couleur cible ;
- le rôle de cette couleur dans le logo ;
- le caractère emblématique ou générique de la teinte.

La catégorie peut être forcée manuellement par l'animateur.

### Nouveau maillot à pois Top 5
Sur chaque logo, les cinq meilleurs joueurs ayant répondu marquent :

- 1er : 100 % des points du logo
- 2e : 75 %
- 3e : 50 %
- 4e : 30 %
- 5e : 15 %

Les points sont arrondis avec `Math.round`, avec un minimum de 1 point pour un joueur du Top 5.

### Équité pour les joueurs qui arrivent en retard
- Une manche mémorise la liste des joueurs présents au départ.
- Un joueur qui rejoint pendant une manche attend la suivante.
- Les classements jaune et vert sont considérés comme officiels à partir de 50 % des manches disputées.
- Pour le maillot vert, les manches ratées sont comptées comme le temps maximal de la manche : un joueur qui arrive tard ne gagne donc pas artificiellement grâce à un petit temps cumulé.

### Départ 3… 2… 1…
Chaque étape commence par un compte à rebours de 3 secondes. Le logo n'est visible qu'au départ.

### Résultats enrichis
La page joueur affiche désormais :
- la couleur choisie et son code HEX ;
- la vraie couleur et son code HEX ;
- le logo réalisé par le joueur ;
- le vrai logo original ;
- le rang sur la manche ;
- le nombre de points montagne gagnés ;
- l'écart avec le vainqueur ;
- l'évolution au classement jaune ;
- les changements de détenteurs de maillots.

### Édition des logos
Depuis l'espace animateur, un logo existant peut être modifié : nom, image, couleur cible, tolérance et paramètres de difficulté.

## Installation locale

```bash
npm install
npm start
```

Puis ouvrir :
- Joueurs : `http://localhost:3000`
- Animateur : `http://localhost:3000/admin.html`

Mot de passe admin par défaut : `admin`.

## Railway

Variables recommandées :

```text
ADMIN_PASSWORD=un_mot_de_passe_solide
DATA_DIR=/data
ROUND_SECONDS=20
```

Ajoute un volume Railway monté sur `/data` pour conserver logos, joueurs et classements après redéploiement.

## Vérification de version

Ouvre :

```text
https://TON-APP.up.railway.app/version
```

La réponse doit contenir :

```json
{
  "version": "2.3.0",
  "selectiveRecolor": true,
  "gameplay23": true
}
```
