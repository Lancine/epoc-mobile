# Analyse applicative — ePoc Mobile

## 1) Résumé exécutif

- **Type d'application**: lecteur de contenus pédagogiques mobile/web basé sur Ionic + Vue + Capacitor.
- **Cas d'usage principal**: consulter des ePocs (cours), suivre la progression, passer des évaluations, obtenir badges/score.
- **Positionnement technique**: architecture **offline-first** avec persistance locale, export des données d'apprentissage et synchronisation optionnelle via Couchbase Lite.

## 2) Architecture technique

### Stack

- **Frontend**: Vue 3 + Ionic Vue.
- **État global**: Pinia.
- **Mobile natif**: Capacitor (Android/iOS).
- **Build**: Vite.
- **Tests**: Vitest (unit), Cypress / WDIO (E2E).

### Démarrage applicatif

Le bootstrap (`src/main.ts`) initialise:

1. Vue/Ionic/i18n/Pinia/router.
2. Matomo (tracking manuel).
3. Service worker en mode web (hors preview).
4. Services de tracking session, export learning et sync Couchbase.

## 3) Flux fonctionnels majeurs

### Bibliothèque et contenus

- Récupération de collections **officielles** distantes.
- Support de bibliothèques **custom** via URL.
- Téléchargement ZIP des ePocs, décompression locale, suppression/réinitialisation.

### Lecture et progression

- Sauvegarde de la progression par ePoc/chapitre/contenu.
- Gestion des réponses d'évaluation, tentatives, choix, badges.
- Calcul de score global + score par évaluation.

### Routing

- Routes dédiées library/settings/about + parcours ePoc (overview, toc, player, assessment, score).
- Garde `fetchEpoc` pour charger le contenu avant navigation.
- Mode `preview` avec filtrage de routes.

## 4) Données, offline, synchronisation

### Offline-first

- Lecture locale de `content.json` via Capacitor Filesystem.
- Gestion des répertoires `epocs`, `local-epocs`, `epoc-editor`.

### Export learning

- Construction d'un payload d'apprentissage structuré (learner, device, cours, sessions, assessments, badges).
- Export fichier JSON local (fallback/legacy).
- Fréquences configurables (manual, daily, twiceDaily, weekly, monthly).

### Sync Couchbase Lite

- Persistance locale des snapshots/events d'apprentissage.
- Réplication optionnelle vers Sync Gateway (`VITE_CBL_SYNC_URL`).
- Gestion d'identité apprenant (`learnerId`, `learnerKey`) + credentials (env ou provisioning).

## 5) Forces

1. **Architecture pragmatique mobile** (Ionic/Capacitor mature).
2. **Bonne résilience offline** (fichiers locaux, stores persistés).
3. **Modèle de données learning riche** (events + snapshot).
4. **Extensibilité plugin** via iframes sandboxés et shortcodes.

## 6) Risques / dette technique observables

1. **Complexité fonctionnelle concentrée dans des stores volumineux** (maintenabilité).
2. **Typage partiellement permissif** (`any`), risque de régressions silencieuses.
3. **Hétérogénéité linguistique** FR/EN dans commentaires/messages.
4. **Logs console nombreux** en production potentielle.
5. **Couplage UI/logic** sur certains flux (menus/actions dans stores).

## 7) Recommandations prioritaires

### Court terme (1–2 sprints)

- Renforcer le typage TS (remplacer `any` critiques par types domain).
- Ajouter tests unitaires sur stores métier (reading/epoc/library).
- Uniformiser la gestion d'erreurs (wrappers + codes + UX cohérente).
- Encadrer les logs via un utilitaire de logging (niveau debug/prod).

### Moyen terme (3–6 sprints)

- Découper les gros stores en modules métier spécialisés.
- Ajouter métriques techniques (temps de sync, erreurs de download/unzip, taux d'échec exports).
- Stabiliser un contrat de schéma versionné pour la data learning.

### Gouvernance qualité

- Définir un **Definition of Done** avec:
  - test unitaire minimal,
  - validation lint,
  - couverture des cas offline,
  - checklist sécurité (URLs distantes, contenus plugins).

## 8) Conclusion

L'application est globalement **solide et bien orientée usage terrain** (mobile, offline, suivi pédagogique). Le principal levier d'amélioration est la **qualité interne** (modularité, typage, tests) pour sécuriser l'évolution à moyen terme, surtout avec l'ajout de couches sync/export/analytics.
