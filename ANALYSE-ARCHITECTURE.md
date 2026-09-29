# odoo-offline — Analyse complète de l'architecture

> Document de synthèse produit après lecture intégrale des **83 fichiers** du dépôt
> (81 modules JS + `service-worker.js` + `index.html`/`manifest.json` + outillage `scripts/`),
> avec vérification par exécution : syntaxe ESM validée sur les 81 fichiers, bundle esbuild régénéré.

---

## 1. Nature du projet

**PWA autonome "odoo-offline"** (aucune dépendance à l'asset pipeline d'Odoo, aucun framework UI :
vanilla JS + DOM, avec OWL vendorisé en cours d'adoption). Elle dialogue avec un **module Odoo
backend `offline_sync`** exposant une **API JSON REST authentifiée par clé API Bearer**.

Objectif : permettre à un utilisateur d'Odoo 17 de **consulter et modifier des documents
(devis, commandes d'achat/vente, transferts de stock…) sans connexion**, les modifications étant
mises en file d'attente locale (IndexedDB) puis rejouées vers Odoo dès le retour du réseau, avec
**détection et arbitrage des conflits**.

Principe de conception structurant : **« offline-first »** — on écrit toujours d'abord en local
puis on tente la synchronisation, jamais de branche « RPC direct en ligne » séparée
(`form_controller.js::saveRecord()` et `onObjectButtonClick()` appliquent tous deux ce modèle).

---

## 2. Stack technique

| Élément | Choix | Remarque |
|---|---|---|
| Bundler | `esbuild` (IIFE, `target=es2020`, `--loader:.xml=text`) | `scripts/build-bundle.sh` → `static/src/bundles/app.bundle.js` (**gitignoré**) |
| Base locale | **Dexie.js** (IndexedDB), vendorié en global | schéma allant de la **version 1 à 11** |
| Réactivité UI | **OWL** vendorisé en global (`owl.iife.js`), 37 exports | plomberie en place, **1 seul champ migré** (`char`) |
| Positionnement | **Popper.js** v2 (global `window.Popper`) | via `core/dropdown/dropdown.js` |
| Styles | CSS Odoo « volés » (`css/web.assets_*.min.css`) injectés dynamiquement | + `home_menu.css` scopé |
| Hors-ligne | `service-worker.js` (cache `offline-sync-standalone-v24`) | network-first pour JS/CSS, cache-first pour le reste |

Aucun `package.json` à la racine : les seules dépendances Node sont les devDependencies
d'esbuild dans `scripts/`. Le runtime ne dépend d'aucun `node_modules`.

---

## 3. Arborescence et rôle des fichiers

```
index.html          → charge dexie, popper, owl.iife, puis app.bundle.js (ordre impératif)
manifest.json       → PWA (standalone, thème #1F3864)
service-worker.js   → précache du shell ; n'intercepte JAMAIS /offline_sync/* (laissé au réseau natif)
assets/, css/       → ressources statiques (icônes, police FontAwesome/Odoo, CSS Odoo minifiés)
scripts/            → outillage esbuild (package.json + build-bundle.sh)
static/lib/         → dexie.min.js, popper.js, owl.iife.js (vendorisés)
static/src/         → le moteur applicatif (voir ci-dessous)
```

### `static/src/core/` — socle

| Fichier | Rôle |
|---|---|
| `registry.js` | Registre clé/valeur par catégories (`services`, `actions`), tri par `sequence`, erreur si clé dupliquée sans `force: true`, caches `_entries/_elements` invalidés |
| `bus/bus_service.js` | `EventBus` (EventTarget) : `trigger/subscribe/unsubscribe` + enregistrement comme service `"bus"` |
| `browser/router_service.js` | État de navigation sérialisé dans le **hash** (`#tag=…&model=…`), `pushState/replaceState/popstate`, `onStateChange` |
| `browser/session.js` | `CONFIG.ODOO_BASE_URL` (**en dur : `http://localhost:8069`**) + session `{uid,name,api_key}` en `localStorage` |
| `assets.js` | Injection/retrait des CSS Odoo (`loadOdooAssets`, `loadScopedCss`) avec substitution `__ODOO_BASE__` |
| `orm_service.js` | **Schéma Dexie v1→v11** : `sync_queue`, `security_info`, `installed_apps`, `reference_records`, `module_manifests`, `list_cache`, `record_cache`, `dashboard_cache`, `sync_conflicts`, `catalog_cache`, `cache_meta`, `local_ledger` |
| `network/rpc_service.js` | **Cœur de la synchronisation** : `queueAction`, `queueMethodCall`, `syncPendingActions` (`POST /offline_sync/push`), retry/suppression, lecture des conflits, `resolveConflict` |
| `local_records.js` | **Surcouche locale** : projette la file `sync_queue` sur les listes/formulaires (`applyLocalOverlay`, `applyPendingWritesToRecord`, `getLocalRecordValues`, `sanitizePendingValues`, ids `tmp:<uuid>`) — §11 |
| `local_ledger.js` | Registre de **deltas** pour les agrégats multi-enregistrements (ex. `stock.quant.quantity`), avec purge par `sync_uuid` |
| `record_cache.js` / `list_cache.js` / `name_service.js` / `catalog_cache.js` | Caches « smart » : réseau si en ligne, repli silencieux sur IndexedDB sinon |
| `user_service.js` | Droits CRUD + domaines de record rules (`security_info`) et profil affiché (`cache_meta.profile`) |
| `cache_owner.js` | Détecte le **changement d'utilisateur Odoo** sur un poste partagé et purge tout le cache |
| `model_display.js` | Déduit « app + type de document » (ex. Ventes → Devis) depuis les menus/manifests, pour le titre de la page de conflit |
| `py_js/py_utils.js` | Traduction d'expressions « Python Odoo » → JS (`not/and/or/in/not in/True/False`) et évaluation de **domaines** en notation préfixe `&`/`\|`/`!` |
| `dropdown/dropdown.js` | Factory unique des dropdowns navbar (Popper, fermeture au clic extérieur) |
| `notebook/notebook.js` | Rendu des `<notebook>`/`<page>` de formulaire |

### `static/src/model/` — moteur métier offline

- **`rules_engine/rules_engine.js`** : moteur de règles réimplémentant côté client une partie du
  comportement Odoo. `initRulesEngine(allRules)` construit un index `model → buckets`
  (`compute, onchange, constraint, ondelete, access, domain, default, stock_effect`), avec un
  **modèle « joker » `*`** (règles valables pour tous les modèles). Fonctions clés :
  `runDocumentRules` (cascade `compute/onchange` sur racine + lignes, garde-fou 8 itérations),
  `validateDocument`, `checkOndeleteGuard`, `runLineRules`, `computeStockEffects`,
  `computeOptimisticStateUpdate`, `canPerformAction`, `isAllowedByGroups`,
  `evaluateNamedDomain`, `filterByRecordRule`, `getDefaultValue`. Snapshot `db.get(model,id)`
  construit une fois par cycle depuis `reference_records` (synchrone, pour des règles pures).
- **`rules/`** : jeu de règles « en dur » :
  - `purchase_order.js` / `sale_order.js` — `_onchange_product_id` (nom + prix depuis
    `product.product`), `_compute_amount` (`price_subtotal`/`price_total`), `_compute_amount_total`
    (`amount_total` = Σ lignes) ;
  - `stock_rules.js` — `stock.picking::button_validate` : calcule les **deltas** de stock
    (double entrée source/destination → `stock.quant.quantity`) et les répercussions
    `qty_received` (achat) / `qty_delivered` (vente) via `purchase_line_id` / `sale_line_id`,
    **+ un effet optimiste** (`state: done`, lignes `picked: true`) ;
  - `access_rules.js` (CRUD + `groups` — seul `is_admin` est réellement distingué),
    `domain_rules.js` (`purchase_dashboard_state`, `generic_record_rule` = application des
    `ir.rule` côté client), `default_rules.js` (`state` implicite `draft`),
    `generic_rules.js` (repli `qty × prix`) ;
  - `index.js` agrège le tout en `allRules`.
- **`relational_model/`** : `attachLiveBusinessRules` (réévaluation live de `readonly`/`required`
  à chaque `input`/`change`), `dynamic_field_attrs.js` (application/remise à zéro des attributs
  dynamiques), `compute_engine.js` (total d'un one2many recalculé en lisant les cellules DOM et en
  réutilisant la règle `price_total`, symbole de devise résolu depuis `res.currency`).

### `static/src/views/` — vues

- `view.js` : dispatcheur (`id`/`isNew` → form, sinon list) + enregistrement des actions
  `list_view`, `form_view`, `ir.actions.act_window`.
- `view_service.js` : cache des **manifests de module** (views XML, `fields_get`, menus) et
  `resolveModelViews` (vue par action, sinon vue par défaut).
- `list/` : `list_controller.js` (chargement, recherche texte debouncée, pagination 20/page,
  bascule list/kanban, **filtrage par record rules**, bandeau dashboard Achats),
  `list_renderer.js` (colonnes optionnelles persistées en localStorage, tri par colonne,
  sélection multiple), `list_renderer_utils.js` (formatage + badges `decoration-*`),
  `stock_picking_dashboard.js` (domaines des compteurs du kanban Opérations), `list_column_prefs.js`.
- `form/` : `form_controller.js` (chargement, préchargement des relations, sauvegarde, règles
  document, ledger, refresh post-sync, boutons objet), `form_renderer.js` (squelette Odoo +
  chatter factice), `form_compiler.js` (compilation récursive XML → DOM), `form_serializer.js`
  (`collectFormData`, `buildDocumentGraph`, `applyDocumentGraphToDom`…), `form_group/`,
  `button_box/` (smart buttons décoratifs), `status_bar_buttons/` (boutons `type="object"`
  fonctionnels, `type="action"` en attente, widget `statusbar` reconstruit).
- `fields/` : `field.js` (dispatcher par type) + 12 widgets (`char` en **OWL**, texte, integer,
  float, boolean, selection, date, datetime, monetary, **many2one** avec recherche locale + création
  locale `tmp:<uuid>`, **many2many** en tags, `x2many` complet avec `control` `create`/section/note,
  colonnes optionnelles, indicateur, et **catalogue produits** en overlay).
- `kanban/` : `kanban_compiler.js` (mini-QWeb : `t-if`, `t-esc/t-out`, `t-set`, `t-attf-class`) et
  `kanban_renderer.js` (cartes + délégation des boutons `type=object` vers la navigation).
- `purchase_dashboard.js` : bandeau KPI Achats (3×2 tuiles + 4 KPI), domaine délégué au rules_engine.

### `static/src/webclient/` — shell applicatif

`webclient.js` (navbar Odoo complète en template, masquée hors `home_menu/list_view/form_view`/
`conflict_detail`, chargement des CSS Odoo à la première vue concernée, menus horizontaux,
badges utilisateur/messages/activités, délégation à `mountWebclient()`),
`actions/action_service.js` (**le routeur** : garde d'authentification, pile de breadcrumb,
`restoreState` depuis le hash, `goBack`), `login.js` (écran de login Odoo-like, `POST
/offline_sync/login`, puis **`ensureCacheOwnership`** puis chargement des droits),
`home_menu/home_menu.js` (grille d'apps + `dashboard_info` + accès `downloadFullApp`),
`offline_prefetch_service.js` (**téléchargement complet d'une app** : manifest → droits → listes →
fiches une à une → relations), `navbar/` (`navbar.js` construction d'arbre de menus,
`apps_menu.js` installation/mise à jour des apps, `sync_status_panel.js` file + erreurs + auto-sync,
`conflict_panel.js` liste des conflits, `connectivity_indicator.js` ping réel toutes les 5 s),
`user_menu/user_menu.js` (menu utilisateur + vue « Mon compte »), `conflict_detail.js`
(**page d'arbitrage** champ par champ « votre modification / modification serveur »).

### `static/src/owl/` — chantier OWL

`README.md` (stratégie : OWL global, templates `.xml` colocalisés inlinés dans le bundle, mount
paresseux via `MutationObserver`), `app.js` (`mountOwlApp` → `owl.App` + `destroy`),
`templates.js` (`buildTemplateMap`), `debug.js` + `components/debug_ping/` (smoke test manuel via
`window.__owl_debug__`), `field_bridge.js` (**adaptateur** : `renderOwlField` renvoie un
`<span>` qui monte le composant de façon asynchrone, + `computeReadonly`/`computeRequired`).

---

## 4. Cycle de vie au démarrage

1. `index.html` charge dexie → popper → **owl** → `app.bundle.js`.
2. `main.js` : `startServices()` (parcours `registry.category("services")`), puis
   **`initRulesEngine(allRules)`** (avant tout rendu : les règles `access/default` sont consultées
   dès la première évaluation d'`invisible`/`readonly`), puis `registerServiceWorker()`
   (chemin **absolu** `/service-worker.js`), puis `bus.trigger("app:ready")` et `mountWebclient()`.
3. `webclient.js` : création du squelette (navbar + `#action-container` + conteneur de toasts),
   montage des panneaux navbar, puis `actionService.restoreState(router.current)` → deep link ou
   `home_menu`.
4. `action_service.js` : garde d'authentification (`getApiKey()` sinon `login`) → `mount()` du
   contrôleur enregistré dans `registry.category("actions")` → `bus.trigger("action:changed")`
   (c'est cet événement qui pilote l'affichage de la navbar et le chargement des CSS Odoo).

---

## 5. Flux offline-first (le cœur du projet)

**Écriture** : `queueAction()` → ligne `sync_queue` (`local_uuid`, `payload` JSON,
`reference_write_date`, `reference_values`, `status: pending`). Si `navigator.onLine`,
`syncPendingActions()` est tentée **immédiatement**, sinon le `sync_status_panel` envoie la file
au retour du réseau (`online`, `visibilitychange`, ou ouverture d'un formulaire).

**Réponse serveur** (`POST /offline_sync/push`) : chaque résultat est mappé en
`sent` (→ `createdIds`, `pending_action` éventuelle = étape manuelle restante dans Odoo),
`conflict` (état distinct d'une erreur, arbitrage humain) ou `error`. Les `sent` déclenchent
`clearLedgerForSyncUuid()` (la valeur serveur intègre désormais le delta local).

**Conflits** : stockés dans les lignes `sync_queue` (`status: conflict`, `conflict_details` JSON) —
⚠️ la table Dexie `sync_conflicts` (v8) est **déclarée mais jamais écrite ni lue** (vestige).
Résolution dans `conflict_detail.js` → `POST /offline_sync/resolve_conflict` (`local`/`server`),
**par action entière**, pas champ par champ.

**Effets locaux optimistes** : `computeStockEffects()` écrit des deltas dans `local_ledger`
(clé `sync_uuid` → purge après sync) ; `computeOptimisticStateUpdate()` patche
`record_cache` et re-rend le formulaire (`state → done`, `picked → true`) avant toute confirmation.

**Visibilité immédiate (surcouche locale)** : une écriture hors-ligne n'existe d'abord que dans
`sync_queue` ; pour qu'elle soit visible sans attendre le serveur, `core/local_records.js` la
projette au moment du rendu sur les listes (`applyLocalOverlay`) et sur les formulaires
(`applyPendingWritesToRecord`, `getLocalRecordValues`) — détail en §11.

**Isolation** : `cache_owner.js` purge **toutes** les tables Dexie (y compris file et conflits) si
l'UID Odoo change au login.

---

## 6. Endpoints backend consommés

| Endpoint | Usage |
|---|---|
| `POST /offline_sync/login` | authentification → `{uid, name, api_key}` |
| `GET /offline_sync/installed_apps` | grille d'accueil |
| `GET /offline_sync/dashboard_info` | profil, société, compteurs messages/activités |
| `GET /offline_sync/security_info` | droits CRUD, groupes, `record_rule_domain`, `fields` |
| `GET /offline_sync/module_manifest?module=` | vues XML + `fields_get` + menus d'une app |
| `GET /offline_sync/list_records?model=&action=&extra_domain=` | listes (clé de cache `model::action::domain`) |
| `GET /offline_sync/read_record?model=&id=` | fiche complète (+ `__reference_write_date__`) |
| `GET /offline_sync/reference_records?model=` | tables de référence many2one/many2many |
| `GET /offline_sync/catalog/products?model=&partner_id=` | catalogue produits (prix selon partenaire) |
| `GET /offline_sync/purchase_dashboard?action=` | KPI du bandeau Achats |
| `GET /offline_sync/ping` | indicateur de connexion réel |
| `POST /offline_sync/push` | rejeu de la file d'actions |
| `POST /offline_sync/resolve_conflict` | arbitrage d'un conflit |

---

## 7. Vérifications exécutées dans cet environnement

```
node --input-type=module --check  →  OK sur les 81 fichiers de static/src (0 erreur)
cd scripts && npm install         →  OK (esbuild 0.24.2)
bash scripts/build-bundle.sh      →  OK : app.bundle.js 261,5 ko / 6 455 lignes (+ sourcemap)
```

Le bundle n'est **pas** versionné (`.gitignore` : `static/src/bundles/`), donc `index.html`
ne peut pas fonctionner sur un clone frais avant `npm install` + build.

---

## 8. Points de vigilance relevés

> ⚠️ **Audit corrigé et complété depuis la lecture du backend** (module Odoo `offline_sync`) :
> voir **`ANALYSE-BACKEND-ET-AUDIT.md` §10**, qui contient l'audit croisé définitif (deux findings
> 🔴 supplémentaires côté contrat, sévérités révisées, preuves fichier par fichier).
> Les points ci-dessous restent valables côté PWA, avec la correction du n° 1 ci-dessous.
> Depuis, la **surcouche locale** (§11) répond au manque le plus visible — un enregistrement
> hors-ligne n'apparaissait ni dans sa liste ni en réouverture.

### 🔴 1. Les colonnes `char` des lignes one2many ne sont plus collectées (édition perdue)
`char_field.js` a été migré vers **OWL** : `renderCharField()` renvoie désormais le `<span>` de
montage (`renderOwlField`), pas l'`<input>`. Or `x2many_field.addRow()` mémorise
`cellRefs[col.field] = { el: inputEl }` et `form_serializer.getElementValue()` lit `el.value`
(cas `char`) / `el.checked` (cas `boolean`).
→ Sur une ligne one2many, un champ `char` (ex. `name` / description d'une ligne de devis ou de
commande) est lu comme `false`.
**Correction par rapport à ma première analyse** : le backend ne l'écrit pas pour autant —
`sync_queue.py::_prepare_values()` **ignore un `False` de type `char`** (filtre des « falsy non
écrivables », seuls boolean/integer/float/monetary sont écrits à `False`/`0`). Conséquence réelle :
la modification est **silencieusement perdue**, mais l'ancienne valeur n'est pas détruite.
En formulaire racine, pas de problème : `container.querySelector('#field-x')` retombe sur le vrai
`<input>` OWL.
Correctifs possibles : faire exposer par `renderOwlField()` un accesseur (`_getInput()`), ou
envelopper les widgets OWL dans une enveloppe qui répond à `value`/`checked`, ou faire remonter
l'état OWL via un attribut `data-value` synchronisé sur `t-on-input`.

### 🟠 2. URL et ressources en dur
`CONFIG.ODOO_BASE_URL = "http://localhost:8069"` est figé dans `core/browser/session.js` (utilisé
partout) ; `login.js` code aussi en dur les liens signup/reset/database manager, et charge le logo
depuis `upload.wikimedia.org` — donc **l'écran de login n'est pas pleinement utilisable hors-ligne**
et aucun déploiement n'est possible sans recompiler. Prévoir une variable de config (meta/ls/`env`).

### 🟠 3. Service Worker : portée et chemins
`navigator.serviceWorker.register("/service-worker.js")` utilise un chemin **absolu** : sur un
sous-dossier (GitHub Pages de type `/<repo>/`), l'enregistrement échoue → plus d'offline.
`manifest.json` (`start_url: ./index.html`, `scope: ./`) est, lui, relatif — incohérence.
À noter aussi : `CACHE_NAME` doit être incrémenté manuellement à chaque déploiement, et la
stratégie network-first JS/CSS écrira toujours la nouvelle version au retour du réseau.

### 🟡 4. Clés de cache désynchronisées entre préchargement et lecture
`getListRecordsSmart()` construit sa clé avec `extraDomain` (`model::action::[domain]`) alors que
`downloadFullApp()` (préchargement) enregistre sans `extra_domain`. Les listes atteintes via un
domaine additionnel (navigation « Opérations » → `stock.picking` filtré par type) ne sont donc
**pas** disponibles hors-ligne après un « Télécharger » complet.

### 🟡 4 bis. Une many2many non affichée est vidée côté serveur (voir audit croisé 🔴 A)
`collectFormData()` itère sur **tous** les champs du modèle (et non ceux de l'arch XML) : si le
widget many2many n'a pas été rendu, il produit `[]`, que le backend convertit en `(6, 0, [])` —
c'est-à-dire « vider la liste ». Détail complet et preuves dans `ANALYSE-BACKEND-ET-AUDIT.md`.

### 🟡 5. Droits d'accès collectés mais pas appliqués à l'UI
`user_service.canPerform()` n'est appelé par aucun contrôleur : aucun bouton/action n'est masqué
ou grisé selon `security_info` (seul le filtrage `filterByRecordRule` est réellement branché sur
les listes, et `groups="…"` se réduit à un test `is_admin`). La sécurité reste donc portée par le
serveur ; côté client c'est un affichage optimiste.

### 🟡 6. Écritures non différentielles
`saveRecord()` envoie **tous** les champs collectés (racine + lignes, `id` compris), pas un diff.
Conséquences : payloads volumineux, et surtout un conflit détecté sur la référence globale
(`reference_write_date`) plutôt que sur les seuls champs réellement modifiés — un utilisateur peut
donc se voir signaler un conflit sur un document dont il n'a touché qu'un champ, et l'arbitrage
`server` annule alors **toutes** ses modifications.

### 🟡 7. Table `sync_conflicts` fantôme
Déclarée en v8, jamais utilisée (les conflits vivent dans `sync_queue`). À supprimer ou à
brancher ; en l'état elle donne une fausse image du modèle de données.
Autres exports non consommés : `getConflictCount()`, `clearAllLedger()`.

### 🔵 8. Incohérences de documentation
`README.md` : la commande d'installation cible `odoooc17`, les commandes de désinstallation citent
`odoo_offline` et `offline_orm`, alors que le module backend référencé par le code est
`offline_sync`. Le README annonce aussi que `main.js` appelle `loadOdooAssets()` — c'est en réalité
`webclient.js` sur `action:changed`. Enfin `static/src/owl/README.md` affirme qu'« aucune vue
n'est touchée » : `char_field.js` est depuis migré et branché via `field_bridge.js`.

### 🔵 9. Limites assumées (déjà signalées dans les commentaires)
- `py_utils.translateOdooExprToJs()` est à base de regex (pas un parseur Python) : les expressions
  complexes peuvent être mal traduites — un `console.warn` et un `null` plutôt qu'un crash.
- `parseOdooOptions()` (many2one) est un JSON.parse « à la sauce Python » : suffisant pour
  `no_create`, pas pour des options imbriquées.
- Boutons `type="action"`, contextes de boutons (`context="{'validate_analytic': True}"`),
  chatter, vues pivot/graph, `unlink`/suppression d'enregistrement : non implémentés
  (placeholders explicites).
- `x2many_field` n'applique pas de logique par ligne dans `optimisticState` (mêmes valeurs pour
  toutes les lignes).

---

## 9. Commandes utiles

```bash
# Build (obligatoire avant de servir index.html)
cd scripts && npm install && cd ..
bash scripts/build-bundle.sh

# Tests hors navigateur de la surcouche locale (voir §11)
bash scripts/tests/run.sh

# Serveur statique local (l'app attend Odoo sur http://localhost:8069)
python3 -m http.server 8000

# Odoo backend : installer / mettre à jour le module offline_sync (voir README)
```

---

## 10. En résumé — la carte mentale du projet

```
                    ┌──────────────── index.html (dexie, popper, owl, bundle) ───────────────┐
                    │                                                                        │
   main.js ──► services (registry) ──► initRulesEngine(allRules) ──► mountWebclient()        │
                                                                     │                        │
        ┌────────────────────────────────────────────────────────────┼─────────────────────┐  │
        │ NAVBAR (webclient.js)                                      │  #action-container  │  │
        │  • apps / sync / conflits / user / connexion               ▼                     │  │
        │  • menus horizontaux (manifests)                 ActionService (routeur + pile)   │  │
        └──────────────────────────────────────────────────────────┬──────────────────────┘  │
                                                                   │                          │
              ┌────────────────────────────┬───────────────────────┴───────────────┐          │
              ▼                            ▼                                       ▼          │
      home_menu (grille apps)     list_controller               form_controller             │
      + dashboard_info            (recherche, pager,            (règles document,           │
      + downloadFullApp           kanban, record rules,         ledger, boutons objet,      │
                                  bandeau achats)               refresh post-sync)          │
              │                            │                               │                 │
              └──────────────┬─────────────┴───────────────┬───────────────┘                 │
                             ▼                             ▼                                 │
                 caches « smart » (Dexie)          rules_engine (+rules/*)                     │
                 list/record/name/catalog/         compute · onchange · constraint             │
                 reference/dashboard/security      access · domain · default · stock_effect    │
                             │                             │                                 │
                             └──────────► rpc_service (sync_queue) ◄── local_ledger ◄─────────┘
                                                  │  POST /offline_sync/push
                                                  ▼
                                    MODULE ODOO offline_sync (API JSON + clé API)
```

---

## 11. Surcouche locale — voir immédiatement ce qui a été enregistré hors-ligne

### Le problème

Le bouton nuage d'Odoo **enregistre** ; dans la PWA, il empile l'action dans `sync_queue` et
s'arrête là. Conséquence : on crée un devis hors-ligne, on revient à la liste… et le devis n'y est
pas. La ligne n'existait que dans la file d'attente et dans le cache du formulaire. Idem pour une
modification ou une suppression : la liste continuait d'afficher la version serveur.

### Le choix : une surcouche dérivée, pas un second cache

`static/src/core/local_records.js` (nouveau) lit la file `sync_queue` **au moment du rendu** et la
projette sur les données déjà chargées :

| Opération en attente | Effet sur la liste |
| --- | --- |
| `create` | ligne synthétique ajoutée **en tête**, id `tmp:<local_uuid>` |
| `write` | valeurs fusionnées par-dessus la ligne serveur, ligne marquée locale |
| `unlink` | ligne serveur masquée |

Rien n'est dupliqué en base : la file reste la seule source de vérité, donc aucune divergence
possible avec ce qui sera réellement envoyé à Odoo. Une fois l'action passée en `sent`, elle sort
naturellement de la surcouche (le statut n'est plus `pending|error|conflict`).

Deux garanties de fidélité :

- **Ce qui est affiché est ce qui sera écrit.** `sanitizePendingValues()` reproduit
  `sync_queue.py::_prepare_values()` : un `char`/`text` vide ou falsy est ignoré, un booléen
  `false`, un `0` monétaire ou une many2many vide sont au contraire écrits. L'utilisateur ne voit
  donc jamais une valeur collectée puis jetée par le serveur.
- **La liste affichée est la bonne liste.** `findActionDomain()` (view_service.js) résout le
  domaine de l'action en cours depuis le manifeste : un devis brouillon apparaît dans « Devis »
  (domaine `state in ['draft','sent']`) mais pas dans « Commandes ». C'est `search_default_*`
  inclus, puisque le domaine vient déjà résolu par le serveur.

### Intégration (aucun code spécifique à un modèle)

- `views/list/list_controller.js` : les données sont chargées par `loadListData()`, qui applique la
  surcouche après les `ir.rule` ; le contrôleur s'abonne à `sync:updated` et recharge la liste
  (anti-rebond 300 ms) dès qu'une synchronisation aboutit ou échoue. Comme le rendu kanban partage
  la même source, la vue kanban bénéficie de la surcouche sans code supplémentaire.
- `views/list/list_renderer.js` : ligne marquée locale — icône nuage / triangle de conflit /
  point d'exclamation d'erreur + infobulle explicite. `list_renderer_utils.js` sait désormais
  afficher une many2many (`[[id, "Libellé"], …]`).
- `views/form/form_controller.js` : un id `tmp:<uuid>` est accepté et routé dans l'URL ; la fiche
  se recharge depuis le payload de la file, une nouvelle sauvegarde **amende** la création en
  attente (`amendPendingCreate`) au lieu d'en créer une seconde, et l'état affiché reprend le
  statut réel (attente / échec / conflit). Si la synchro automatique a abouti entre-temps
  (l'`odoo_record_id` est désormais persisté par `syncPendingActions`), le formulaire bascule sur
  l'id réel et la sauvegarde devient un `write` : pas de doublon.
- `views/fields/many2one/many2one_field.js` : une référence vers une fiche créée localement
  (`tmp:<uuid>`, absente de `reference_records`) affiche son libellé lu dans la file.
- `service-worker.js` : cache `v25` (toute modification des fichiers pré-cachés doit incrémenter
  ce numéro, sinon le navigateur ressert l'ancien bundle).

### Vérifications

- `bash scripts/tests/run.sh` → **59 vérifications OK, 0 échec** : surcouche (création / écriture /
  suppression / domaines / statuts), miroir de `_prepare_values`, réouverture d'une fiche locale,
  libellé d'une référence locale, payload corrompu, manifeste incomplet. Le banc utilise le
  **vrai** Dexie (`static/lib/dexie.min.js`) sur une IndexedDB simulée (`fake-indexeddb`), donc la
  vraie base `sync_queue` de `orm_service.js` — aucune maquette.
- `bash scripts/build-bundle.sh` → bundle IIFE régénéré (~278 Ko) ; les 81 fichiers de
  `static/src` passent la vérification de syntaxe Node.

### Ce qui n'est pas fait

- Pas de grisage des lignes locales au-delà de l'icône/du titre (une icône a été préférée à un
  style qui pourrait passer pour un état serveur).
- Les boutons objet d'une fiche non synchronisée restent refusés avec un message explicite : ils
  s'exécutent côté serveur sur un id qui n'existe pas encore.
- Le fond du problème 🔴 A (many2many jamais rendue qui se retrouve vidée côté serveur) reste
  ouvert côté formulaire — voir `ANALYSE-BACKEND-ET-AUDIT.md`.
