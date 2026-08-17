# Toon Tone Tour V4.0 — Grand Tour Edition 🚲🎨

Application multijoueur temps réel de reconnaissance des couleurs de logos, pensée pour une animation de groupe et déployable sur **GitHub + Railway**.

## V4.0 : ce qui change

### 🎨 Refonte visuelle complète

- nouvelle identité Grand Tour côté joueur et organisateur ;
- écran de connexion plus immersif ;
- cockpit animateur réorganisé autour des actions importantes ;
- cartes de classement plus lisibles ;
- nouvelle mise en page de la manche, des résultats et du classement final ;
- responsive téléphone / tablette / desktop.

### ⚡ Assistant « Partie rapide »

En haut de la direction de course :

1. donne un nom à la partie ;
2. choisis le nombre d’étapes ;
3. choisis une sélection équilibrée ou aléatoire ;
4. choisis un preset ;
5. clique sur **Générer & lancer**.

Aucun Tour enregistré n’est obligatoire.

Presets inclus :

- **⚡ Rapide** — 12 s, résultats courts, enchaînement automatique ;
- **🎉 Soirée** — 20 s, rythme équilibré ;
- **🏆 Compétitif** — score un peu plus exigeant et seuil de qualification plus élevé ;
- **🧠 Expert** — 25 s et score plus sévère.

### 🗂️ Bibliothèque de logos avancée

- recherche par nom, catégorie ou tag ;
- filtres par difficulté et catégorie ;
- tri A→Z, difficulté, utilisation ou besoin d’étalonnage ;
- catégories de marque et tags personnalisés ;
- sélection multiple ;
- ajout de plusieurs logos au Tour en un clic ;
- suppression multiple ;
- indication du nombre de fois où un logo a été joué et utilisé dans des Tours.

### 📊 Étalonnage de difficulté V2

L’étalonnage repose désormais sur toutes les réponses historiques du logo avec :

- une moyenne observée ;
- une moyenne ajustée avec un a priori afin d’éviter de sur-réagir après quelques réponses ;
- un niveau de confiance selon la taille de l’échantillon ;
- une tendance basée sur les dernières manches ;
- une suggestion de catégorie après un minimum de réponses ;
- la possibilité de **verrouiller** la difficulté d’un logo pour ignorer les recommandations automatiques.

Les catégories restent : 2 / 5 / 10 / 15 / 20 points montagne.

### 🏆 Records persistants & carrières

Les records sont conservés entre les parties :

- meilleure précision ;
- réponse ≥ 90 % la plus rapide ;
- plus grand écart à la cible ;
- meilleure moyenne sur un Tour ;
- record de points montagne.

La page finale signale les nouveaux records battus. Le cockpit admin contient aussi un **Hall of Fame** et un classement de carrière par pseudo : parties, victoires, victoires d’étapes, podiums et meilleure moyenne.

### 🛡️ Reprise après incident / redémarrage Railway

Si Railway redémarre pendant un Tour, la V4 détecte la course interrompue et affiche une bannière **Reprise après incident** dans l’admin.

- les étapes déjà terminées et les scores restent enregistrés ;
- l’étape interrompue n’est pas comptabilisée ;
- l’organisateur peut reprendre le Tour au même endroit après reconnexion des joueurs ;
- l’enchaînement automatique est désactivé lors de la reprise pour éviter un départ avant le retour du peloton.

En plus, un **point de restauration** est créé avant chaque étape. L’organisateur peut revenir à l’état précédent si une étape a été validée alors qu’un incident important devait l’annuler.

### ⚙️ Paramètres de gameplay

Réglages configurables :

- durée de l’étape ;
- délai entre les résultats ;
- fin automatique quand tous ont répondu ;
- seuil de qualification au jaune / vert ;
- multiplicateur du score CIEDE2000 ;
- durée du compte à rebours ;
- affichage ou masquage du code HEX ;
- activation du maillot vert ;
- activation du classement montagne.

Le code HEX reste **activé par défaut**.

### 🩺 État du système

La direction de course indique :

- version serveur ;
- capacité d’écriture du stockage ;
- présence du volume Railway `/data` ;
- nombre de logos sécurisés ;
- nombre de parties archivées ;
- dernière sauvegarde ;
- dernières actions importantes de l’organisateur.

## Mécaniques conservées

- multijoueur Socket.IO ;
- masquage sécurisé de la vraie couleur côté serveur ;
- roue chromatique + HEX ;
- score CIEDE2000 ;
- maillot jaune : proximité moyenne ;
- maillot vert : temps cumulé ajusté ;
- montagne Top 5 : 100 / 75 / 50 / 30 / 15 % des points du logo ;
- fin d’étape dès que tous les partants ont répondu ;
- Tours fixes ou aléatoires ;
- pause, reprise, +10 s, annulation, rejeu, saut d’étape ;
- gestion des joueurs et doublons ;
- historique des parties ;
- statistiques finales et exploration de toutes les réponses.

## Score CIEDE2000

Le serveur transforme les couleurs sRGB en CIELAB puis calcule la distance perceptuelle **ΔE00** selon CIEDE2000.

La formule par défaut est :

```text
Score = max(0, 100 - 2 × ΔE00)
```

Le multiplicateur `2` est configurable dans la V4. Un preset compétitif ou expert peut donc rendre les écarts de couleur plus pénalisants sans modifier l’algorithme CIEDE2000 lui-même.

## Déploiement Railway

Variables recommandées :

```text
ADMIN_PASSWORD=un_mot_de_passe_solide
DATA_DIR=/data
ROUND_SECONDS=20
```

Ajoute un **Railway Volume** monté sur :

```text
/data
```

Le fichier persistant est :

```text
/data/game-state.json
```

Sans volume, l’application fonctionne mais les logos, historiques, records et Tours peuvent disparaître lors d’un redéploiement.

## Vérification après déploiement

Ouvre :

```text
/version
```

Tu dois obtenir une réponse contenant :

```json
{
  "version": "4.0.0",
  "scoringModel": "CIEDE2000",
  "visualOverhaul": true,
  "advancedLogoLibrary": true,
  "quickGameWizard": true,
  "persistentRecords": true,
  "calibrationV2": true,
  "crashRecovery": true,
  "gameplayPresets": true,
  "systemStatus": true
}
```

Et `/health` permet de vérifier l’état de stockage et la présence du volume persistant.

## Migration depuis V3.x

La V4 charge automatiquement le format de données des V3 précédentes : logos, masques sécurisés, Tours, joueurs, calibrations et historique sont conservés.

Les nouveaux champs V4 (tags, catégorie, verrouillage, records, carrières, échantillons de calibration) reçoivent des valeurs par défaut.

Avant une mise à jour importante, il reste recommandé d’utiliser **Exporter logos + Tours** depuis la direction de course.

## Tests

La V4 ajoute un test automatique du moteur CIEDE2000 :

```bash
npm test
```

Le test compare l’implémentation à plusieurs valeurs de référence ΔE00 et vérifie le comportement du score Toon Tone.
