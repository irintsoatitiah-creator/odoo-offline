# Tests hors navigateur

Ces tests vérifient la logique de `static/src/core/local_records.js` (surcouche
locale : affichage immédiat des enregistrements saisis hors-ligne) sans
navigateur, grâce à :

- **esbuild** : reconstitue un bundle ESM du module réellement livré (le même
  outil que `scripts/build-bundle.sh`) ;
- **fake-indexeddb** : fournit `indexedDB` à Node, ce qui permet d'utiliser le
  vrai Dexie livré dans `static/lib/dexie.min.js` et donc la vraie base
  `sync_queue` définie par `core/orm_service.js`. Aucune maquette de la base :
  les entrées sont créées puis relues exactement comme dans le navigateur.

## Lancer

```bash
bash scripts/tests/run.sh
```

Le script installe `fake-indexeddb` dans `scripts/tests/node_modules` si besoin
(les dépendances Node sont ignorées par git), construit le bundle de test puis
exécute les vérifications. Sortie attendue : `59 vérifications OK, 0 échec(s)`.

## Couverture

| Section | Ce qui est vérifié |
| --- | --- |
| 1 | Identifiants locaux `tmp:<uuid>` (aller-retour) |
| 2 | Miroir de `_prepare_values()` du module Odoo (`sync_queue.py`) |
| 3 | Une création hors-ligne apparaît en tête de liste avec ses valeurs |
| 4 | Le domaine de l'action filtre la ligne locale (Devis ≠ Commandes) |
| 5 | Le domaine additionnel s'applique aussi aux lignes locales |
| 6 | Une modification hors-ligne se superpose à la ligne serveur |
| 7 | Une suppression hors-ligne masque la ligne |
| 8 | Une action synchronisée sort de la surcouche |
| 9-10 | Réouverture d'une fiche (modifiée / créée) hors-ligne en formulaire |
| 11 | Libellé d'une référence créée localement (`tmp:<uuid>`) |
| 12 | La saisie la plus récente est en première ligne |
| 13 | Les statuts `error` / `conflict` remontent sur la ligne |
| 14-15 | Manifeste incomplet, payload JSON corrompu, modèle sans local |

Ces tests ne remplacent pas une vérification dans un navigateur (rendu OWL,
service worker) : ils valident la logique de données, pas l'affichage.
