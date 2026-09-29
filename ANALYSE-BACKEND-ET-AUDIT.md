# Module Odoo `offline_sync` — analyse du backend + audit croisé avec la PWA

> Source : `https://github.com/irintsoatitiah-creator/offline_sync.git` (commit `1449cbc`, « Versionning »)
> 22 fichiers Python / ~2 420 lignes, module Odoo **17.0.1.0.0**, dépendances `base` + `web`.
> À lire avec `ANALYSE-ARCHITECTURE.md` (côté PWA) : les deux documents se répondent.

---

## 1. Vue d'ensemble

```
__manifest__.py        depends: base, web — data: ir.model.access.csv, views/res_users_views.xml
__init__.py            → models, controllers
models/
  res_users.py         champ offline_sync_api_key + action de génération
  sync_queue.py        cœur : modèle sync.queue + orchestration + exécution ORM générique
controllers/
  common.py            OfflineSyncMixin : CORS, auth clé API, domaines d'action, menus visibles,
                       refs tmp:<uuid>, listes de champs supportés/ignorés, modèles "techniques"
  auth_controller.py   /ping, /login
  apps_controller.py   /installed_apps (icône base64 + menus visibles + modèle principal)
  dashboard_controller.py  /dashboard_info, /app_info, /companies
  metadata_controller.py   /module_manifest (vues + champs + menus d'une app)
  fields_controller.py     /model_fields, /security_info
  database_controller.py   /reference_records, /list_records, /read_record
  sync_controller.py       /push, /resolve_conflict
  catalog_controller.py    /catalog/products
  purchase_dashboard_controller.py  /purchase_dashboard
utils/
  conflict_detector.py  détection de conflits (scalaire / many2many / lignes one2many)
  value_normalize.py    normalize_datetime, normalize_raw, build_many2many_commands
  json_utils.py         json_safe, safe_json_dumps
  app_discovery.py      guess_main_model (cache d'indices + heuristique par menu racine)
security/ir.model.access.csv   sync.queue : lecture/écriture/création pour tout utilisateur interne
views/res_users_views.xml      onglet « API Key Offline » dans la fiche utilisateur
```

**Principe directeur**, identique à celui de la PWA : *le serveur ne connaît aucun modèle métier en
dur*. `model_name`, `operation`, `method`, `args`, `kwargs` viennent intégralement du payload ;
`_is_technical_model()`, `guess_main_model()` et `_resolve_action_domain()` fournissent des
heuristiques génériques plutôt que des listes figées. Seules deux features sont volontairement
scopées à un modèle : le catalogue produits (`sale.order`/`purchase.order`) et le dashboard Achats
(`purchase.order` via l'action `purchase.purchase_rfq`).

---

## 2. Authentification, CORS et modèle de sécurité

| Mécanisme | Implémentation |
|---|---|
| Clé API | `res.users.offline_sync_api_key` (`secrets.token_urlsafe(32)`, `copy=False`, `groups="base.group_user"`), générée automatiquement au premier login |
| Transport | Header `Authorization: Bearer <clé>` sur toutes les routes sauf `/ping` et `/login` |
| Résolution | `res.users.sudo().search([("offline_sync_api_key","=",clé)], limit=1)` → l'utilisateur |
| Contexte d'exécution | `request.env(user=user.id)` — **pas de `sudo()`** sur les données, donc `ir.rule` et `ir.model.access` s'appliquent réellement |
| CORS | `ir.config_parameter` `offline_sync.allowed_origins` (liste séparée par virgules) ; en-tête `Access-Control-Allow-Origin` posé **uniquement** si l'`Origin` reçu est dans la liste |
| Routes | `auth="none"` + `csrf=False` + gestion explicite de `OPTIONS` (préflight) |
| Sudo restreint | `sudo()` n'est utilisé que pour l'introspection de structure (`ir.module.module`, `ir.model.data`, `ir.ui.menu`, `fields_get`, icônes) — jamais pour lire/écrire les données métier |

Point remarquable et bien pensé (`fields_controller.py`) : le calcul du domaine des record rules se
fait **sans** `sudo()`, avec un commentaire expliquant que `sudo()` court-circuite
`ir.rule._compute_domain()` (qui renvoie `[]` dès que `env.su` est vrai). Le domaine transmis à la
PWA est donc le domaine réel de l'utilisateur.

---

## 3. `sync.queue` — schéma et cycle de vie

| Champ | Rôle |
|---|---|
| `local_uuid` | UUID généré par la PWA — **contrainte unique** en base → idempotence du push |
| `model_name`, `operation` | `create` / `write` / `unlink` / `call_method` |
| `payload` | Texte JSON (le payload client, réécrit si des `tmp:` ont été résolus) |
| `status` | `pending` → `in_progress` → `sent` / `error` / `conflict` |
| `created_at`, `synced_at` | horodatage client / serveur |
| `error_message` | message d'exception, jamais une stack trace |
| `odoo_record_id` | ID réel de l'enregistrement concerné/créé |
| `reference_write_date`, `reference_values` | snapshot capturé au chargement du formulaire → base de la détection de conflit |
| `has_conflict`, `conflict_details` | conflit et son détail JSON |
| `requires_manual_action`, `pending_action` | action retournée par un `call_method` (ex. un wizard) que la sync ne peut pas rejouer |

`_order = "created_at asc"`. Le cycle de vie est écrit **exclusivement** par `apply_action()` et
`resolve_conflict()`, toujours via `write()` — jamais d'exception qui remonte au contrôleur.

---

## 4. Pipeline de synchronisation (`POST /offline_sync/push`)

```
1. OPTIONS            → réponse CORS nue
2. Auth               → 401 {"error":"Clé API invalide ou manquante"} si absente/inconnue
3. Pour chaque action du corps :
     ├─ local_uuid déjà en base ? → renvoie son statut actuel (rejeu idempotent, rien n'est réexécuté)
     └─ sinon create(status="pending")  ← payload/reference_values stockés tels quels
4. uuid_to_id = { local_uuid → odoo_record_id }  pour toutes les entrées status="sent"
     (permet aussi de résoudre les références d'un push ANTÉRIEUR, ex. après un retry)
5. Passes successives (max = nb d'actions + 1) :
     └─ une action ne s'exécute QUE si tous ses "tmp:<uuid>" sont résolus
        → substitute_tmp_refs() réécrit le payload, status="in_progress", apply_action()
        → si "sent" : uuid_to_id[uuid] = odoo_record_id (les passes suivantes en profitent)
6. Actions encore bloquées → status="error", message "Dépendance non résolue."
7. Réponse {"results": [ {local_uuid, status, odoo_record_id, conflicts, requires_manual_action,
                          pending_action} | {local_uuid, status:"error", error} ]}
```

L'étape 5 est l'équivalent d'un **tri topologique approximatif** : créer d'abord le partenaire
« tmp:… » permet ensuite d'écrire la commande qui le référence, sans que le serveur n'ait besoin de
connaître ces modèles. C'est le pendant serveur du `tmp:<uuid>` produit par
`many2one_field.js::createLocalRecord()`.

`apply_action()` : `env.cr.savepoint()` autour de l'exécution, puis écriture du statut final. Un
échec métier devient `error` + `error_message`, **jamais** une 500 : le client peut donc l'afficher
et proposer « Réessayer ». Très bon choix.

---

## 5. Détection de conflits (`utils/conflict_detector.py`)

Pré-requis : `reference_values` non vide, sinon **aucune détection** (c'est ce que souhaite la PWA
pour un `create`). Trois familles de comparaison, toujours selon la même règle :

> conflit ⇔ `local ≠ référence` **et** `serveur ≠ référence` (c'est-à-dire : j'ai modifié, ET le
> serveur a bougé depuis mon snapshot).

| Cas | Traitement |
|---|---|
| Scalaire (`char`, `text`, `int`, `float`, `boolean`, `selection`, `date`, `datetime`, `monetary`, `many2one`) | normalisation date/datetime (T → espace, troncature) puis triple comparaison |
| `many2many` | comparaison d'ensembles d'ids (les paires `[id, label]` sont dépliées) ; trois égalités testées avant de conclure au conflit |
| `one2many` | ligne à ligne, appariées par `id`, avec deux cas structurels : `edit_vs_delete` (j'ai modifié une ligne supprimée ailleurs) et `delete_vs_edit` (je supprime une ligne modifiée ailleurs — le détail des champs serveur modifiés est renvoyé) |

Le conflit renvoyé contient `field` (avec la notation `order_line[42].price_unit`),
`local_value`, `server_value` et `server_write_date` — exactement ce que `conflict_detail.js`
affiche en deux colonnes. Le formatage `champ[ligne].sous-champ` est **implémenté des deux côtés**
(`formatFieldLabel` côté PWA).

---

## 6. Résolution de conflits (`POST /offline_sync/resolve_conflict`)

- `resolution: "server"` → l'entrée passe simplement à `sent`, **rien n'est écrit** : l'action locale
  est abandonnée en bloc.
- `resolution: "local"` → le payload complet est réécrit (`_prepare_values` + `write`) en ignorant le
  conflit, sur `odoo_record_id`.
- Garde-fous : 404 si `local_uuid` inconnu, 409 si l'entrée n'est pas au statut `conflict`.
- Limite assumée et commentée dans le code : l'état serveur n'est **pas revérifié** entre la
  détection et la résolution (un « triple conflit » est jugé trop rare pour être géré).

L'arbitrage est **global à l'action**, pas champ par champ — ce qui est cohérent avec l'UI de la PWA
(`conflict_detail.js` applique bien une décision unique à toute l'entrée).

---

## 7. `_prepare_values()` — la frontière JSON ↔ ORM

C'est la fonction la plus critique du module : elle décide ce qui est réellement écrit.

```python
if not finfo:                       continue   # champ inconnu du modèle → ignoré (protection)
if value is None:                   continue
if (value is False or value == "") and finfo["type"] not in ("boolean","integer","float","monetary"):
                                    continue   # ← filtre "falsy non écrivable"
one2many   → [(2,id,0) suppression | (1,id,vals) maj | (0,0,vals) création]
many2many  → [(6,0,ids)]  = REMPLACEMENT TOTAL de la liste
datetime   → normalize_datetime(value, user.tz) → UTC (%Y-%m-%d %H:%M:%S)
```

Compléments intelligents de `_clean_line()` : une ligne créée avec seulement `product_id` reçoit son
`name` (display_name du produit) et son champ d'unité (`product_uom` ou `product_uom_id`, détecté
dynamiquement) ; un `product_template_id` est remappé vers la variante `product_id`.

**Invariant vérifié dans le code d'Odoo 17** (`odoo/fields.py`, `X2many.write_batch`) :
`value is False` → `[Command.clear()]` = **suppression de toutes les lignes**, tandis que `[]` →
aucune commande = **no-op**. La PWA n'envoie jamais `False` pour un x2many (`collectFormData`
produit `[]`), donc le cas destructeur n'est pas atteint pour les one2many. Il reste atteint pour
les *many2many* — voir finding 🔴 A de l'audit.

---

## 8. Cartographie des routes

| Route | Paramètres | Utilisée par la PWA |
|---|---|---|
| `GET /offline_sync/ping` | — (non authentifiée) | ✅ indicateur de connexion |
| `POST /offline_sync/login` | `login`, `password` | ✅ écran de login |
| `GET /offline_sync/installed_apps` | — | ✅ grille d'accueil + menu Applications |
| `GET /offline_sync/dashboard_info` | — | ✅ profil / société / badges |
| `GET /offline_sync/app_info` | — | ❌ (`{connected_as, uid}`) |
| `GET /offline_sync/companies` | — | ❌ (le bouton société de la navbar est inerte) |
| `GET /offline_sync/module_manifest` | `module` | ✅ toute la structure d'une app |
| `GET /offline_sync/model_fields` | `model` | ❌ (introspection ponctuelle de champs simples) |
| `GET /offline_sync/security_info` | `model` \| `models` (ou aucun → apps installées) | ✅ droits + record rules + champs |
| `GET /offline_sync/reference_records` | `model` | ✅ many2one/many2many |
| `GET /offline_sync/list_records` | `model`, `action`, `extra_domain`, `limit`, `offset` | ✅ (⚠️ sans `limit`/`offset` — voir 🟡 D) |
| `GET /offline_sync/read_record` | `model`, `id` | ✅ fiche complète |
| `GET /offline_sync/catalog/products` | `model`, `partner_id` | ✅ catalogue produits |
| `GET /offline_sync/purchase_dashboard` | `action` | ✅ bandeau RDQ |
| `POST /offline_sync/push` | `actions[]` | ✅ synchronisation |
| `POST /offline_sync/resolve_conflict` | `local_uuid`, `resolution` | ✅ arbitrage |

---

## 9. Contrat API : correspondance avec la PWA

Le contrat est **cohérent** : chaque champ consommé côté client existe côté serveur, et
inversement. Vérification détaillée des payloads :

| Endpoint | Réponse | Consommé côté PWA |
|---|---|---|
| `login` | `{uid, name, api_key}` | `saveSession()` ✅ |
| `installed_apps` | `{apps:[{technical_name,label,icon_base64,main_model,menus[]}]}` | grille d'accueil ✅ (`menus` non utilisé ici, le manifest fait foi) |
| `dashboard_info` | `{name,initial,company_name,unread_messages,pending_activities}` | `bus.trigger("user:info")` ✅ |
| `module_manifest` | `{module:{technical_name,label}, models[], fields{model:{champ→{label,type,required,selection,relation[,sub_fields]}}}, views{model:{default{},by_action{"<id>":{...}}}}, menus[]}` | `resolveModelViews()`, `form_compiler`, `x2many` ✅ |
| `security_info` | `{user_id, groups[], is_admin, models{model:{access{read,write,create,unlink}, domain[], fields[]}}}` | `user_service` + `filterByRecordRule` ✅ |
| `reference_records` | `{records:[{id,display_name[, symbol,position]}]}` | `name_service` ✅ |
| `list_records` | `{model,total,records[]}` | `list_cache` ✅ (`total` jamais affiché) |
| `read_record` | `{record:{…, __reference_write_date__}}` | `record_cache` + détection de conflit ✅ |
| `catalog/products` | `{model,partner_id,count,products[]}` | `catalog_cache` + cartes produit ✅ |
| `purchase_dashboard` | `{applicable}` **ou** `{applicable:true, toutes{}, mes{}, kpi{}}` | `purchase_dashboard.js` ✅ (le cas `applicable:false` est géré) |
| `push` | `{results:[{local_uuid,status,odoo_record_id,conflicts,requires_manual_action,pending_action,error}]}` | `rpc_service.syncPendingActions` ✅ |
| `resolve_conflict` | `{local_uuid,status,resolution,odoo_record_id}` / erreurs 404-409 | `conflict_detail.js` ✅ |

### Asymétries à connaître (elles ne cassent rien, mais elles fragilisent le contrat)

1. **many2one : deux formats selon la route.** `list_records` renvoie `read()` brut → `[id, label]` ;
   `read_record` « aplatit » en `id` seul (racine **et** lignes one2many). Le code client gère les
   deux (tests `Array.isArray(...)` dans `py_utils.resolveParentReferences`, `stock_rules.unwrapMany2one`,
   `domain_rules`, `formatCellValue`), mais toute nouvelle consommation doit en tenir compte.
2. **`fields` : deux structures pour un même nom.** Dans `module_manifest`, `fields[model]` est un
   **objet** indexé par nom de champ ; dans `security_info`, `fields` est une **liste** d'objets
   `{name,label,type,required,readonly,selection}`. La PWA ne consomme aujourd'hui que celui du
   manifest — à ne pas confondre le jour où les droits seront utilisés pour l'affichage.
3. **Fuseau horaire des `datetime`.** `_prepare_values` interprète une valeur `datetime-local` dans
   le fuseau `res.users.tz` **de l'utilisateur Odoo**, pas celui du navigateur ; sans `tz` renseigné,
   la valeur est supposée déjà en UTC. Un utilisateur dont le fuseau Odoo diffère de son appareil
   verra un décalage d'heures silencieux.
4. **`groups` de `security_info`** renvoie des **noms** de groupes (`g.name`), et non des xml_ids :
   c'est ce qui limite aujourd'hui le filtrage `groups="…"` côté client à un simple test `is_admin`
   (voir `access_rules.js`).
5. **4 routes non utilisées** par la PWA : `model_fields`, `app_info`, `companies`, et les `menus`
   de `installed_apps` (utilisé seulement indirectement via le manifest).

---

## 10. Audit croisé front ↔ back

Sévérité : 🔴 perte de données · 🟠 sécurité / fonctionnel majeur · 🟡 fonctionnel mineur ·
🔵 hygiène.

### 🔴 A. Une many2many non affichée dans la vue est **vidée** à chaque enregistrement
Chaîne complète, vérifiée des deux côtés :

1. `form_serializer.js::collectFormData()` itère sur **tous** les champs du modèle
   (`manifest.fields[model]`), pas seulement ceux de l'arch XML.
2. Branche `many2many` (l. 138) : si le widget n'a jamais été rendu, `hiddenInput` est `null` →
   `data[fieldName] = []`.
3. `_prepare_values()` ne filtre pas cette liste vide (`[] == ""` est faux en Python) →
   `build_many2many_commands([])` → `[(6, 0, [])]`.
4. `X2many.write_batch` (Odoo 17) : `Command.SET` avec une liste vide → **remplacement par rien**.
5. `detect_conflicts()` ne s'y oppose pas : `server_set == reference_set` → il conclut à l'absence de
   conflit (l'utilisateur n'a effectivement rien touché).

→ Toute many2many absente de la vue affichée (tags, catégories, abonnés, `tag_ids` d'un devis si la
vue simplifiée ne les montre pas…) est **silencieusement effacée** par la première sauvegarde PWA.
*Correctif côté PWA : n'inclure un champ que s'il a réellement été rendu (tester la présence du
`hiddenInput` / de `#field-<name>`), ou envoyer un payload différentiel.*

### 🔴 B. Les colonnes `char` d'une ligne one2many ne sont pas enregistrées
`char_field.js` est passé à OWL : `renderCharField()` renvoie le `<span>` de montage
(`field_bridge.js::renderOwlField`), pas l'`<input>`. Or `x2many_field.addRow()` stocke
`cellRefs[champ] = { el: inputEl }` et `getElementValue()` lit `el.value` → `undefined` → `false`.
Conséquence **exacte** (corrigée par rapport à ma première analyse, qui supposait un écrasement) :
`_prepare_values()` **ignore** un `False` de type `char` (filtre des « falsy non écrivables »,
`sync_queue.py` l. 316) → le champ n'est simplement **pas envoyé**. La modification de la
description d'une ligne (devis, commande, mouvement de stock) est donc **perdue sans aucun message**.
À l'inverse, les valeurs de départ `_rawRowData` ne sont pas écrasées : aucun risque de destruction,
seulement d'édition perdue. En formulaire racine, aucun problème (`#field-<name>` cible le vrai
`<input>` OWL).
*Correctif : exposer l'`<input>` réel par `renderOwlField()` (accesseur `_getInput()`), ou envelopper
le montage dans un conteneur qui répond à `value`.*

### 🔴 C. Impossible de vider un champ `char`/`text` (racine comme ligne)
`getElementValue()` retourne `el.value || false` → un champ effacé vaut `false` → filtré par
`_prepare_values()` (même règle qu'en B). L'utilisateur ne peut donc pas supprimer une note, un
commentaire, une référence : la valeur précédente reste sur le serveur. *Correctif : envoyer `""`
explicitement pour les types texte, ou assouplir le filtre côté serveur pour `char`/`text`.*

### 🟠 D. `sync.queue` n'a pas de propriétaire
- Aucune colonne `user_id` : `push_actions` construit `uuid_to_id` avec
  `SyncQueue.search([("status","=","sent"), ("odoo_record_id","!=",0)])` — **tous utilisateurs
  confondus**, donc la substitution d'un `tmp:<uuid>` peut pointer vers l'enregistrement d'un autre
  utilisateur si l'UUID est connu.
- `resolve_conflict` cherche par `local_uuid` seul, sans vérifier le propriétaire.
- `security/ir.model.access.csv` accorde `read/write/create` à `base.group_user` sans ir.rule : tout
  utilisateur interne peut donc lire les payloads des autres (données métier incluses) par ORM/XML-RPC.

Impact réel limité par le caractère aléatoire des UUID (`crypto.randomUUID`), mais c'est un trou
d'isolation entre utilisateurs — d'autant plus notable que la PWA, elle, purge son cache au
changement d'utilisateur (`cache_owner.js`). *Correctif : `user_id` sur `sync.queue` + filtrage dans
les deux routes + une `ir.rule`.*

### 🟡 E. `list_records` plafonne à 80 enregistrements, et la PWA ne le sait pas
`limit=80, offset=0` par défaut, `order="id desc"` ; la PWA n'envoie **jamais** `limit`/`offset`.
Elle pagine côté client (20/page) sur ces 80 lignes, et `listData.total` (le vrai compte, issu de
`search_count`) n'est **jamais affiché**. Une recherche « Commandes » sur 500 documents affichera
donc « 1-20 / 80 ». Effet de bord plus gênant : le compteur du bandeau Achats (calculé, lui, sur
tout le modèle) ne correspondra pas au nombre de lignes réellement listées.

### 🟡 F. Clés de cache désynchronisées entre préchargement et lecture
`buildListCacheKey()` (lecture) ajoute le domaine additionnel : `model::action::[domain]` ;
`offline_prefetch_service.js` (l. 71) écrit `model::action`. Les listes atteintes via un domaine
additionnel — navigation « Opérations » → `stock.picking` filtré par type de bon — ne sont donc pas
disponibles hors-ligne après un « Télécharger » complet.

### 🟡 G. CORS : sans paramètre système, tout échoue — avec un message trompeur
`_get_allowed_origins()` lit `offline_sync.allowed_origins` ; si le paramètre est absent, **aucune
origine n'est autorisée** (log `error` côté serveur, mais réponse HTTP normale). La PWA servie sur un
autre port (`localhost:8080`, `5500`…) verra tous ses appels bloqués par le navigateur et affichera
« Impossible de contacter le serveur. Vérifiez votre connexion. » → piste de diagnostic à documenter
en premier dans le README.

### 🟡 H. Record rules : filtrage client en « fail-open »
`py_utils.evaluateDomainLeaf()` ne gère que `=`, `==`, `!=`, `in`, `not in` ; **tout autre opérateur
retourne `true`**. Un `record_rule_domain` utilisant `child_of`, `parent_of`, `like`, `>`, `<`…
laisse donc passer les enregistrements localement. Les données restent protégées (le serveur filtre
au téléchargement), mais l'UI peut afficher des lignes après une fusion de caches inter-utilisateurs.
À noter aussi : le code prévient déjà (`warnOnce`) quand un champ référencé est absent des colonnes.

### 🟡 I. L'arbitrage de conflit est global, jamais par champ
`saveRecord()` envoie **tous** les champs collectés (pas de diff) et `detect_conflicts` compare champ
par champ, mais `resolve_conflict("server")` abandonne **l'action entière**. Un document dont un seul
champ a bougé ailleurs fait donc perdre toutes les autres modifications locales si l'utilisateur
choisit « Garder celle du serveur ». C'est un choix assumé côté UI (une action = une décision), mais
le libellé de l'UI ne le dit pas explicitement.

### 🔵 J. Hygiène / code mort
- `utils/json_utils.py::safe_json_dumps` et `utils/value_normalize.py::normalize_raw` : **jamais
  appelés**.
- `utils/conflict_detector.py::_extract_id` est **défini deux fois** (l. 213 et l. 219, corps
  identiques — la seconde écrase la première).
- Aucune purge de `sync.queue` (pas de `ir.cron`, pas de `unlink` exposé) : la table croît
  indéfiniment ; côté PWA, les entrées `sent` de la table Dexie `sync_queue` ne sont jamais
  supprimées non plus.
- `push_actions` ne valide pas le payload : un `local_uuid` manquant fait lever `SyncQueue.create()`
  hors du `try`, ce qui renvoie une 500 HTML au lieu d'une erreur par action.
- La table Dexie `sync_conflicts` (PWA, v8) reste déclarée mais inutilisée — vestige.

### 🔵 K. Fonctionnalités backend non exploitées
`/offline_sync/companies` existe, la navbar affiche un nom de société (`#shell-company-name`) mais
aucun sélecteur de société n'est câblé ; `app_info` et `model_fields` ne sont appelés nulle part.

---

## 11. Ce qui est solide (à préserver)

- **`_execute_call_method`** réutilise `get_public_method` + `odoo.api.call_kw`, exactement le
  mécanisme de `/web/dataset/call_button` : aucune liste blanche maison, mêmes garanties de sécurité
  (méthodes privées/techniques rejetées), et le cas « la méthode renvoie une action »
  (`requires_manual_action` / `pending_action`) est modélisé plutôt que nié. Le message affiché par
  `form_controller.js` (« étape supplémentaire dans Odoo ») est le bon.
- **Idempotence** par contrainte unique sur `local_uuid` : un retry après coupure réseau ne rejoue
  jamais une action déjà reçue.
- **`savepoint` + statut `error`** : aucune exception ne remonte au client, donc pas de file bloquée
  par une action « empoisonnée ».
- **Généricité** : aucun nom de modèle métier en dur hors des deux features volontairement scopées ;
  `guess_main_model` combine un cache d'indices et une heuristique par menu racine.
- **`_get_visible_menu_objs`** délègue à `ir.ui.menu._visible_menu_ids()`, c'est-à-dire au même
  mécanisme que le client web natif (groupes + droits sur l'action + élagage des parents vides).
- **_resolve_action_domain** combine le domaine de l'action **et** les filtres de recherche par
  défaut (`search_default_*`) : c'est ce qui rend « Devis » et « Commandes » correctement distincts
  côté PWA, alors que l'action de base ne porte aucun domaine.
- **_clean_line** complète les lignes créées hors-ligne (nom + unité depuis le produit, remappage
  template → variante) : la PWA peut se contenter d'envoyer `product_id` + quantité.

---

## 12. Vérifications effectuées

| Vérification | Résultat |
|---|---|
| Lecture intégrale des 22 fichiers Python | ✅ |
| Routes backend (16) ↔ routes consommées par la PWA (13) | ✅ toutes servies par le backend |
| Champs de chaque payload ↔ côté client | ✅ cohérents (asymétries documentées §9) |
| Sémantique d'une liste vide sur un x2many (`[]` vs `False`) | ✅ dans `odoo/fields.py` 17.0 : `[]` = no-op, `False` = `Command.clear()` |
| Filtre des « falsy non écrivables » de `_prepare_values` | ✅ source des findings B et C |
| Absence de `user_id`/`ir.rule`/`ir.cron` sur `sync.queue` | ✅ confirmée par recherche |
| Fonctions utilitaires jamais appelées | ✅ confirmé par recherche |
