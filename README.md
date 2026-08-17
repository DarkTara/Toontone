# Toon Tone Tour V3.1 🚲🎨

Jeu multijoueur temps réel inspiré de Toon Tone, avec une identité Tour de France. Déploiement prévu sur **GitHub + Railway**.

## Nouveautés V3

- **Roue chromatique personnalisée** avec carré saturation/luminosité.
- Le **code HEX reste visible et éditable** pendant la manche.
- **Tours / playlists** : crée un parcours nommé, ajoute les logos dans l’ordre souhaité et déplace-les avec ↑ / ↓.
- Enchaînement **manuel ou automatique** des étapes.
- Délai de résultats configurable entre deux étapes.
- **Écran final** avec podiums jaune, vert et pois.
- Récompenses de fin de Tour : Œil de lynx, Sprinteur, Régularité, Remontada et Grimpeur.
- Statistiques finales : nombre d’étapes, joueurs, proximité moyenne et étape la plus montagneuse.
- Import/export d’un **pack JSON** contenant logos et Tours.
- Toutes les fonctions V2.3 sont conservées : recoloration sélective, comparaison des logos, Top 5 montagne, difficulté automatique, joueurs tardifs, 3–2–1 et changements de maillot.

## Maillot à pois

Catégories :

- 🟢 Facile : 2 pts
- 🔵 Moyen : 5 pts
- 🟡 Difficile : 10 pts
- 🔴 Très difficile : 15 pts
- ⚫ Hors catégorie : 20 pts

Top 5 de chaque étape : **100 % / 75 % / 50 % / 30 % / 15 %** de la valeur de l’étape, arrondie au point le plus proche avec un minimum de 1 point.

## Déploiement Railway

Variables recommandées :

```text
ADMIN_PASSWORD=un_vrai_mot_de_passe
DATA_DIR=/data
ROUND_SECONDS=20
```

Ajoute un volume Railway monté sur `/data` afin de conserver les logos, Tours, joueurs et scores entre les redéploiements.

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

Après déploiement, `/version` doit retourner `3.1.0`.

## Utilisation rapide

1. Ouvre `/admin.html` et connecte-toi.
2. Ajoute tes logos et sélectionne la couleur cible dans l’aperçu.
3. Crée un Tour, ajoute les logos dans l’ordre souhaité et enregistre.
4. Choisis le temps par étape, le délai d’affichage des résultats et le mode manuel/auto.
5. Lance le Tour.
6. À la fin, tous les joueurs voient automatiquement le classement final.

Tu peux toujours utiliser le **mode libre** pour lancer un logo sans créer de Tour.


## Nouveautés V3.1

- Les trois classements généraux affichent désormais **tous les joueurs**, pas seulement les 7 premiers.
- Après chaque étape, un **classement complet de l'étape** affiche rang, couleur/HEX, proximité, temps et points montagne.
- L'écran de résultat reste affiché jusqu'au départ de l'étape suivante.
- Le classement montagne conserve son identité rouge/blanche mais **sans motif à pois** afin d'améliorer la lisibilité.
- L'écran final ajoute des statistiques de Tour et un tableau détaillé par joueur.
- Un bouton **Voir toutes les réponses** permet de rejouer chaque étape et de comparer toutes les couleurs HEX des joueurs à la couleur cible.

## Calcul exact du pourcentage de proximité

Le score actuel n'est pas une distance RGB brute. Le serveur convertit d'abord la réponse du joueur et la couleur cible depuis sRGB vers l'espace colorimétrique **CIELAB (Lab)** avec un blanc de référence D65.

1. Le code HEX est converti en composantes RGB 0–255.
2. Les composantes sRGB sont linéarisées (correction gamma).
3. Le RGB linéaire est converti en XYZ.
4. XYZ est converti en Lab : `L*` représente la luminosité, `a*` l'axe vert↔rouge et `b*` l'axe bleu↔jaune.
5. La distance utilisée est la distance euclidienne **Delta E 1976 (ΔE76)** :

```text
ΔE = sqrt((ΔL*)² + (Δa*)² + (Δb*)²)
```

6. Le score Toon Tone est ensuite :

```text
proximité = clamp(100 - ΔE, 0, 100)
```

Ainsi :
- couleur identique : ΔE = 0 → **100 %** ;
- ΔE = 5 → **95 %** ;
- ΔE = 20 → **80 %** ;
- ΔE = 50 → **50 %** ;
- ΔE ≥ 100 → **0 %**.

Le mot « pourcentage » désigne donc ici un **score de proximité ludique** et non un pourcentage scientifique absolu. CIELAB est utilisé parce qu'il est nettement plus pertinent visuellement qu'une simple différence entre les valeurs R, G et B.
