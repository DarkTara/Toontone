# Toon Tone Tour V3.2 🚲🎨

Jeu multijoueur temps réel de reconnaissance de couleurs de logos, avec une identité Tour de France. Déploiement prévu sur **GitHub + Railway**.

## Nouveautés V3.2

### 🔐 La vraie réponse reste côté serveur
Pendant une manche, le navigateur joueur ne reçoit plus :

- la couleur cible HEX ;
- le logo original contenant la couleur cible.

Il reçoit uniquement :

- une image de jeu où la zone cible est déjà grisée ;
- un masque binaire indiquant quels pixels le joueur peut recolorer.

La vraie couleur et le logo original ne sont envoyés qu'après l'arrivée de l'étape.

Les logos créés avec une version précédente sont **sécurisés automatiquement par la page admin** au premier chargement de la V3.2. Laisse simplement `/admin.html` ouvert quelques secondes avant de lancer une course.

### 🧪 Score CIEDE2000
Le classement jaune utilise maintenant **CIEDE2000 (ΔE00)**, une mesure colorimétrique plus proche de la perception humaine que ΔE76.

Le score affiché est :

```text
Score = max(0, 100 - 2 × ΔE00)
```

Repères :

- ΔE00 = 0 → 100 %
- ΔE00 = 2 → 96 %
- ΔE00 = 5 → 90 %
- ΔE00 = 10 → 80 %
- ΔE00 = 20 → 60 %
- ΔE00 ≥ 50 → 0 %

Le facteur ×2 garde une amplitude de jeu lisible malgré l'échelle plus compacte de CIEDE2000.

### 🏁 Animations Grand Tour

- compte à rebours 3…2…1 puis **GO !** ;
- animation d'**arrivée d'étape** avec passage du vélo ;
- animation renforcée quand un maillot change de leader ;
- confettis au classement final.

### 💾 Historique des parties
Chaque Tour terminé est automatiquement archivé dans `/data/game-state.json` avec :

- date et nom du Tour ;
- classements jaune, vert et montagne ;
- statistiques ;
- récompenses ;
- résultats de chaque étape ;
- couleurs HEX choisies par chaque joueur.

La direction de course peut consulter jusqu'aux **50 dernières parties**, ouvrir un résumé ou exporter les résultats en JSON.

### 📊 Étalonnage de la difficulté
Chaque logo accumule ses performances réelles : nombre d'étapes, nombre de réponses et proximité moyenne.

À partir de **10 réponses**, Toon Tone propose une catégorie selon la moyenne observée :

- moyenne ≥ 90 % → 🟢 Facile · 2 pts
- moyenne ≥ 82 % → 🔵 Moyen · 5 pts
- moyenne ≥ 72 % → 🟡 Difficile · 10 pts
- moyenne ≥ 62 % → 🔴 Très difficile · 15 pts
- moyenne < 62 % → ⚫ Hors catégorie · 20 pts

La difficulté **n'est jamais modifiée silencieusement** : l'animateur choisit d'appliquer la suggestion pour un logo ou toutes les suggestions en une fois.

## Maillot à pois

Catégories :

- 🟢 Facile : 2 pts
- 🔵 Moyen : 5 pts
- 🟡 Difficile : 10 pts
- 🔴 Très difficile : 15 pts
- ⚫ Hors catégorie : 20 pts

Top 5 de chaque étape : **100 % / 75 % / 50 % / 30 % / 15 %** de la valeur de l'étape, arrondie au point le plus proche avec un minimum de 1 point.

## Déploiement Railway

Variables recommandées :

```text
ADMIN_PASSWORD=un_vrai_mot_de_passe
DATA_DIR=/data
ROUND_SECONDS=20
```

Ajoute un volume Railway monté sur `/data` afin de conserver logos, Tours, historiques et étalonnages entre les redéploiements.

Le projet doit être placé **directement à la racine du dépôt GitHub** :

```text
/
├── server.js
├── package.json
├── railway.json
├── README.md
├── VERSION.txt
└── public/
    ├── index.html
    ├── admin.html
    ├── app.js
    ├── admin.js
    ├── logo-renderer.js
    ├── color-picker.js
    └── styles.css
```

Après déploiement, `/version` doit retourner `3.2.0` avec `secureClientAnswer: true` et `scoringModel: "CIEDE2000"`.

## Migration depuis V3.1

1. Remplace les fichiers du dépôt par ceux de la V3.2.
2. Laisse Railway redéployer.
3. Ouvre `/admin.html` et connecte-toi.
4. Attends que le message **Sécurisation des anciens logos** disparaisse.
5. Vérifie `/version`.
6. Lance une partie normalement.

Les logos, Tours et données déjà stockés dans `/data` sont conservés.
