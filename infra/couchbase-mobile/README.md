# ePoc-mobile — Couchbase Lite JS + Sync Gateway (PRO: snapshot + events + analytics)

## Pourquoi cette pile ?

- **Couchbase Lite JavaScript** tourne dans le WebView / navigateur et stocke localement (IndexedDB).
- La **synchronisation ne se fait pas directement vers Couchbase Server** : elle passe par **Sync Gateway** (WebSockets).
- Ce modèle est très adapté au **BYOD + offline** : l’app continue de fonctionner sans Internet, puis se synchronise quand le réseau revient.

> Prérequis : pour Couchbase Lite JS, utilisez Sync Gateway **>= 3.3.1** (ou 4.0.1+) selon la documentation Couchbase.

---

## Modèle de données

### 1) SNAPSHOT (document de synthèse périodique)

Chaque export planifié est stocké comme un document :

- `type`: `"learningExport"`
- `schema`: `"epoc-mobile.learning-export@1"`
- `_id`: `learningExport::<learnerKey>::<generatedAt>`

Le snapshot contient la synthèse (modules, progression, sessions, badges, évaluations…).

### 2) EVENTS (granularité fine)

Chaque action significative génère aussi un document d’évènement :

- `type`: `"learningEvent"`
- `schema`: `"epoc-mobile.learning-event@1"`
- `eventType`: `"session_end" | "assessment_attempt" | "badge_unlocked" | ...`
- `_id`: `learningEvent::<learnerKey>::<epocId>::<eventType>::<ts>::<eventKey>`

> Les IDs sont déterministes => l’ingestion est **idempotente** (pas de doublons si un même évènement est ré-écrit).

---

## Démarrage serveur (dev)

```bash
cd infra/couchbase-mobile
docker compose up -d
```

### 1) Initialiser Couchbase Server

Ouvrir l’UI : http://localhost:8091

- Créer un bucket nommé **epoc**
- Garder les identifiants Admin alignés avec `sync-gateway.json` (ou modifier ce fichier)

### 2) Endpoints Sync Gateway

- Public : http://localhost:4984/epoc-learning
- Admin  : http://localhost:4985/epoc-learning (bind localhost en dev)

---

## Provisioning (création automatique des users Sync Gateway)

Le service **provisioner** écoute par défaut sur :

- http://localhost:8088/register

Il crée/maj un utilisateur Sync Gateway **par apprenant** (canal `u::<learnerKey>`) et renvoie `{username,password}`.

Exemple :

```bash
curl -X POST http://localhost:8088/register \
  -H 'Content-Type: application/json' \
  -d '{"learnerId":"+2250700000000"}'
```

---

## Configuration de l’app (Vite env vars)

Dans `.env` :

```bash
# Sync Gateway (WebSocket)
VITE_CBL_SYNC_URL=ws://localhost:4984/epoc-learning
VITE_CBL_SYNC_ENABLED=true
VITE_CBL_DB_NAME=epoc-learning
VITE_CBL_SYNC_CONTINUOUS=true

# Option A (recommandée) : provisioning
VITE_CBL_PROVISION_URL=http://localhost:8088/register

# Option B : credentials fixes (dev seulement)
# VITE_CBL_SYNC_USERNAME=<username>
# VITE_CBL_SYNC_PASSWORD=<password>

# Optionnel (privacy) : dériver learnerKey = sha256(salt::learnerId)
VITE_CBL_LEARNER_KEY_SALT=
```

En production, utilisez **wss://** (TLS) pour `VITE_CBL_SYNC_URL`, et mettez le provisioner derrière un reverse proxy (ou réseau interne).

---

## Stack analytics (PostgreSQL + Metabase) — optionnel

Pour des tableaux croisés / synthèses “pro”, vous pouvez activer le profil `analytics` :

```bash
docker compose --profile analytics up -d
```

- Postgres : `epoc_analytics` (port 5432)
- Metabase : http://localhost:3000
- ETL : lit le `_changes` feed de Sync Gateway (admin) et remplit `learning_snapshot` + `learning_event`.

Tables :
- `learning_snapshot` (JSONB snapshot complet)
- `learning_event` (JSONB event complet)
- `learning_event_flat` (vue aplatie pour analyses simples)

---

## Notes sécurité / gouvernance

- La **fonction `sync`** dans `sync-gateway.json` impose :
  - auth obligatoire (`login required`)
  - `doc.learnerKey` doit correspondre à `userCtx.name`
  - isolation par channel `u::<learnerKey>`

- Pour un contexte BYOD, cela évite qu’un apprenant écrive dans le canal d’un autre.
