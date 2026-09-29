/**
 * Banc de test hors navigateur pour core/local_records.js
 * Dexie réel + IndexedDB simulée (fake-indexeddb) + le vrai module du projet.
 * Lancement : bash scripts/tests/run.sh (voir README.md de ce dossier).
 */
import "fake-indexeddb/auto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// Racine du dépôt : passée par scripts/tests/run.sh, déduite sinon.
const ROOT = process.env.ROOT_DIR || path.resolve(here, "../..");

const require = createRequire(import.meta.url);
globalThis.Dexie = require(path.join(ROOT, "static/lib/dexie.min.js"));
globalThis.Dexie.dependencies.indexedDB = globalThis.indexedDB;
globalThis.Dexie.dependencies.IDBKeyRange = globalThis.IDBKeyRange;

const mod = await import(path.join(here, ".app-test.mjs"));
const {
  db, initRulesEngine, allRules,
  applyLocalOverlay, applyPendingWritesToRecord, getLocalRecordValues,
  getPendingEntries, getPendingWritesForRecord, getPendingRecordLabel,
  normalizeForList, sanitizePendingValues,
  isLocalId, localIdFromUuid, uuidFromLocalId,
} = mod;

initRulesEngine(allRules);

let passed = 0;
let failed = 0;
function check(label, condition, extra = "") {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label} ${extra}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const MODEL = "sale.order";
const OTHER_MODEL = "purchase.order";

const FIELDS = {
  name: { label: "Référence", type: "char", required: true },
  partner_id: { label: "Client", type: "many2one", relation: "res.partner" },
  state: { label: "Statut", type: "selection", selection: [["draft", "Devis"], ["sent", "Devis envoyé"], ["sale", "Bon de commande"]] },
  amount_total: { label: "Total", type: "monetary" },
  date_order: { label: "Date", type: "datetime" },
  tag_ids: { label: "Étiquettes", type: "many2many", relation: "crm.tag" },
  active: { label: "Actif", type: "boolean" },
  order_line: { label: "Lignes", type: "one2many", relation: "sale.order.line" },
};

let uuidCounter = 0;
async function queueEntry({ operation, payload, status = "pending", model = MODEL }) {
  const localUuid = `uuid-test-${++uuidCounter}`;
  await db.sync_queue.add({
    local_uuid: localUuid,
    model_name: model,
    operation,
    action_type: "generic",
    payload: JSON.stringify(payload),
    reference_write_date: null,
    reference_values: null,
    status,
    created_at: "2026-09-29 10:00:00",
  });
  return localUuid;
}

console.log("\n=== 0. Préparation : caches de référence ===");
await db.reference_records.bulkPut([
  { model: "res.partner", id: 7, display_name: "Ma Société SARL" },
  { model: "crm.tag", id: 3, display_name: "Urgent" },
]);
check("reference_records alimenté", (await db.reference_records.count()) === 2);

console.log("\n=== 1. Identifiants locaux ===");
check("isLocalId", isLocalId("tmp:abc") === true && isLocalId(42) === false);
check("aller-retour uuid", uuidFromLocalId(localIdFromUuid("abc")) === "abc");

console.log("\n=== 2. Miroir de _prepare_values (sync_queue.py) ===");
const sanitized = sanitizePendingValues(
  {
    name: "S1", note: "", comment: false, active: false, amount_total: 0,
    tag_ids: [], partner_id: null, inconnu: "x", id: 5,
  },
  { name: { type: "char" }, note: { type: "text" }, comment: { type: "text" }, active: { type: "boolean" }, amount_total: { type: "monetary" }, tag_ids: { type: "many2many", relation: "crm.tag" }, partner_id: { type: "many2one", relation: "res.partner" } }
);
check("char '' ignoré", !("note" in sanitized));
check("text false ignoré", !("comment" in sanitized));
check("boolean false conservé", sanitized.active === false);
check("monetary 0 conservé", sanitized.amount_total === 0);
check("many2many [] conservé", eq(sanitized.tag_ids, []));
check("many2one null ignoré", !("partner_id" in sanitized));
check("champ inconnu du modèle ignoré", !("inconnu" in sanitized));
check("id conservé", sanitized.id === 5);

console.log("\n=== 3. Création hors-ligne visible dans la liste ===");
const createUuid = await queueEntry({
  operation: "create",
  payload: {
    name: "S00042", partner_id: 7, state: false, amount_total: 1200,
    date_order: "2026-09-29T14:30", tag_ids: [3], active: true,
    order_line: [{ product_id: 12, product_uom_qty: 2 }],
    note: "", inconnu: "x",
  },
});

const serverRecords = [
  { id: 101, name: "S00001", partner_id: [7, "Ma Société SARL"], state: "draft", amount_total: 500, date_order: "2026-09-01 09:00:00", tag_ids: [], active: true, order_line: [] },
  { id: 102, name: "S00002", partner_id: [7, "Ma Société SARL"], state: "sale", amount_total: 900, date_order: "2026-09-02 09:00:00", tag_ids: [[3, "Urgent"]], active: true, order_line: [] },
  { id: 103, name: "S00003", partner_id: [7, "Ma Société SARL"], state: "draft", amount_total: 300, date_order: "2026-09-03 09:00:00", tag_ids: [], active: true, order_line: [] },
];

let overlay = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {
  domain: [["state", "in", ["draft", "sent"]]],
});
check("la liste contient la ligne locale + les serveur", overlay.length === 4, `(reçu ${overlay.length})`);
const localRow = overlay[0];
check("la ligne locale est en tête", isLocalId(localRow.id), `(id=${localRow.id})`);
check("id local = tmp:<uuid> de l'action", localRow.id === localIdFromUuid(createUuid));
check("name repris du payload", localRow.name === "S00042");
check("state par défaut 'draft' (règle du moteur)", localRow.state === "draft");
check("many2one normalisé en [id, libellé]", eq(localRow.partner_id, [7, "Ma Société SARL"]));
check("many2many normalisé en couples", eq(localRow.tag_ids, [[3, "Urgent"]]));
check("datetime au format serveur", localRow.date_order === "2026-09-29 14:30:00");
check("montant conservé", localRow.amount_total === 1200);
check("marqueur __local__", localRow.__local__ === true && localRow.__local_status__ === "pending");
check("champ non supporté non exposé", !("inconnu" in localRow));

console.log("\n=== 4. Domaine d'action : pas de devis dans la liste des commandes ===");
const commandes = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {
  domain: [["state", "in", ["sale", "done"]]],
});
check("le brouillon local n'apparaît pas dans la liste des commandes",
  !commandes.some((r) => isLocalId(r.id)), `(reçu ${commandes.map((r) => r.id).join(",")})`);

const devis = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {
  domain: [["state", "in", ["draft", "sent"]]],
});
check("le brouillon local apparaît dans Devis", devis.some((r) => r.id === localIdFromUuid(createUuid)));

const sansDomaine = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {});
check("sans domaine, la ligne locale reste visible", sansDomaine.length === 4);

console.log("\n=== 5. Domaine additionnel (navigation filtrée) ===");
const filtre = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {
  domain: [["state", "in", ["draft", "sent"]]],
  extraDomain: [["partner_id", "=", 99]],
});
check("extraDomain exclut la ligne locale dont le partenaire ne correspond pas",
  !filtre.some((r) => isLocalId(r.id)), `(reçu ${filtre.map((r) => r.id).join(",")})`);
const filtreLocal = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {
  domain: [["state", "in", ["draft", "sent"]]],
  extraDomain: [["partner_id", "=", 7]],
});
check("la ligne locale portant le partenaire 7 passe l'extraDomain",
  filtreLocal.some((r) => r.id === localIdFromUuid(createUuid)));

console.log("\n=== 6. Modification hors-ligne d'une fiche existante ===");
await queueEntry({ operation: "write", payload: { id: 101, name: "S00001-révisé", amount_total: 777, note: "", active: false } });
overlay = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {});
const patched = overlay.find((r) => r.id === 101);
check("valeur patchée visible", patched.name === "S00001-révisé" && patched.amount_total === 777);
check("chaîne vide (char) non appliquée à l'affichage", "note" in patched === false);
check("booléen false bien appliqué", patched.active === false);
check("ligne marquée locale", patched.__local__ === true);
check("les autres lignes sont intactes", overlay.find((r) => r.id === 102).name === "S00002");

console.log("\n=== 7. Suppression hors-ligne (unlink) ===");
await queueEntry({ operation: "unlink", payload: { id: 102 } });
overlay = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {});
check("la ligne supprimée disparaît", overlay.every((r) => r.id !== 102));
check("la liste ne comporte plus que les autres lignes + la création locale",
  overlay.length === 3, `(reçu ${overlay.length})`);

console.log("\n=== 8. Une action synchronisée sort de la surcouche ===");
const entries = await getPendingEntries(MODEL);
check("3 actions non confirmées listées", entries.length === 3, `(reçu ${entries.length})`);
const unlinkEntry = entries.find((e) => e.operation === "unlink");
await db.sync_queue.update(unlinkEntry.id, { status: "sent", odoo_record_id: 555 });
overlay = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {});
check("l'action confirmée ne masque plus la ligne serveur",
  overlay.some((r) => r.id === 102), `(reçu ${overlay.map((r) => r.id).join(",")})`);
check("les autres actions restent visibles localement",
  overlay.some((r) => r.id === 101 && r.__local__) && overlay.some((r) => isLocalId(r.id)));

for (const entry of entries) await db.sync_queue.update(entry.id, { status: "sent", odoo_record_id: 555 });
overlay = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {});
check("plus aucune ligne locale une fois tout synchronisé",
  overlay.length === 3 && !overlay.some((r) => r.__local__), `(reçu ${overlay.length})`);
const otherModel = await applyLocalOverlay(OTHER_MODEL, serverRecords, FIELDS, {});
check("la surcouche est bien filtrée par modèle", otherModel.length === 3);

console.log("\n=== 9. Rouvrir une fiche modifiée hors-ligne (formulaire) ===");
await queueEntry({ operation: "write", payload: { id: 101, name: "S00001-révisé", amount_total: 777 } });
const cached = { id: 101, name: "S00001", amount_total: 500, state: "draft", __reference_write_date__: "2026-09-01 09:00:00", order_line: [] };
const merged = await applyPendingWritesToRecord(MODEL, cached, FIELDS);
check("modification locale fusionnée", merged.name === "S00001-révisé" && merged.amount_total === 777);
check("état serveur conservé", merged.state === "draft");
check("référence de conflit conservée", merged.__reference_write_date__ === "2026-09-01 09:00:00");
check("l'enregistrement d'origine n'est pas modifié", cached.name === "S00001");
check("many2one NON normalisé pour le formulaire", (await applyPendingWritesToRecord(MODEL, { id: 101, partner_id: 7 }, FIELDS)).partner_id === 7);

console.log("\n=== 10. Réouvrir un brouillon créé hors-ligne ===");
const draftUuid = await queueEntry({ operation: "create", payload: { name: "S00099", partner_id: 7, amount_total: 10 } });
const values = await getLocalRecordValues(MODEL, localIdFromUuid(draftUuid));
check("les valeurs initiales viennent du payload", values.name === "S00099" && values.amount_total === 10);
check("pas d'id Odoo dans un brouillon", values.id === undefined);
check("brouillon d'un autre modèle refusé", (await getLocalRecordValues(OTHER_MODEL, localIdFromUuid(draftUuid))) === null);
await db.sync_queue.update((await db.sync_queue.where("local_uuid").equals(draftUuid).first()).id, { payload: JSON.stringify({ name: "S00099-modifié", amount_total: 42 }) });
const amended = await getLocalRecordValues(MODEL, draftUuid);
check("amendement du brouillon pris en compte", amended.name === "S00099-modifié" && amended.amount_total === 42);

console.log("\n=== 11. Libellé d'une référence créée localement ===");
const partnerUuid = await queueEntry({ operation: "create", payload: { name: "Nouveau Client" }, model: "res.partner" });
check("libellé résolu depuis la file", (await getPendingRecordLabel("res.partner", localIdFromUuid(partnerUuid))) === "Nouveau Client");
const withLocalRef = await normalizeForList(MODEL, { name: "S1", partner_id: localIdFromUuid(partnerUuid) }, FIELDS);
check("many2one local normalisé avec son libellé", eq(withLocalRef.partner_id, [localIdFromUuid(partnerUuid), "Nouveau Client"]));
const unknownRef = await normalizeForList(MODEL, { partner_id: 4242 }, FIELDS);
check("référence inconnue affichée en #id", eq(unknownRef.partner_id, [4242, "#4242"]));

console.log("\n=== 12. Deux créations hors-ligne : la plus récente en tête ===");
const u1 = await queueEntry({ operation: "create", payload: { name: "S1" } });
const u2 = await queueEntry({ operation: "create", payload: { name: "S2" } });
const ordered = await applyLocalOverlay(MODEL, [], FIELDS, {});
check("la saisie la plus récente est en première ligne",
  ordered[0].id === localIdFromUuid(u2) && ordered[1].id === localIdFromUuid(u1),
  `(reçu ${ordered.map((r) => r.name).join(",")})`);

console.log("\n=== 13. Statut d'échec visible sur la ligne ===");
await db.sync_queue.update((await db.sync_queue.where("local_uuid").equals(u2).first()).id, { status: "error" });
const withError = await applyLocalOverlay(MODEL, [], FIELDS, {});
check("statut error remonté au rendu", withError[0].__local_status__ === "error");
const writeEntry = (await getPendingWritesForRecord(MODEL, 101))[0];
await db.sync_queue.update(writeEntry.id, { status: "conflict" });
const withConflict = await applyLocalOverlay(MODEL, serverRecords, FIELDS, {});
check("statut conflict remonté au rendu",
  withConflict.find((r) => r.id === 101).__local_status__ === "conflict");

console.log("\n=== 14. Manifeste incomplet : la ligne reste lisible ===");
const noFields = await applyLocalOverlay(MODEL, [], null, {});
check("sans métadonnées, la saisie reste affichée",
  noFields.length > 0 && noFields[0].name === "S2", `(reçu ${JSON.stringify(noFields[0] || null)})`);
check("sans métadonnées, les falsy ambiguës sont écartés",
  (await applyLocalOverlay(MODEL, [], null, {}))[0].note === undefined);

console.log("\n=== 15. Robustesse ===");
const empty = await applyLocalOverlay("crm.team", [], FIELDS, {});
check("liste vide et aucun local → résultat vide", eq(empty, []));
const brokenUuid = await queueEntry({ operation: "create", payload: {}, model: "crm.team" });
await db.sync_queue.update((await db.sync_queue.where("local_uuid").equals(brokenUuid).first()).id, { payload: "{ceci n'est pas du json" });
const withBroken = await applyLocalOverlay("crm.team", [{ id: 1, name: "X" }], FIELDS, {});
check("payload illisible ignoré sans planter", withBroken.length === 1 && withBroken[0].id === 1);
check("écriture directe par d'autres modules toujours possible", (await getPendingWritesForRecord(MODEL, 101)).length === 1);

console.log(`\n──────────────────────────────\n${passed} vérifications OK, ${failed} échec(s)\n`);
process.exit(failed === 0 ? 0 : 1);
