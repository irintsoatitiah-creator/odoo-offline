/**
 * core/local_records.js
 * =====================
 * "Surcouche locale" : rend visibles immédiatement — dans les listes comme
 * dans les formulaires — les enregistrements saisis dans la PWA mais pas
 * encore confirmés par Odoo (file d'attente sync_queue, voir
 * core/network/rpc_service.js).
 *
 * Sans cette surcouche, une création hors-ligne n'existe QUE dans la file :
 * l'utilisateur enregistre un devis, retourne à la liste, et son devis n'y
 * apparaît pas (la liste ne reflète que le dernier cache serveur).
 *
 * Principe : la source de vérité d'un enregistrement non synchronisé est
 * l'entrée sync_queue elle-même, pas un cache parallèle. Cette surcouche est
 * donc purement dérivée — aucune écriture, aucun état à maintenir :
 *
 *   create   → une ligne synthétique portant un identifiant local
 *              "tmp:<local_uuid>" (même convention que les many2one créés
 *              localement, voir views/fields/many2one/many2one_field.js, et
 *              résolue côté serveur par controllers/common.py::find_tmp_refs)
 *   write    → la ligne existante est patchée avec les valeurs saisies
 *   unlink   → la ligne existante est masquée
 *
 * Les statuts pris en compte sont exactement ceux pour lesquels Odoo n'a
 * PAS encore confirmé les données : "pending" (en attente), "error" (envoi
 * refusé — la saisie reste locale) et "conflict" (arbitrage en cours). Dès
 * qu'une action passe à "sent", la surcouche disparaît : c'est le serveur
 * qui fait foi, la liste est rechargée (voir views/list/list_controller.js).
 */

import { db } from "./orm_service.js";
import { getDefaultValue } from "../model/rules_engine/rules_engine.js";
import { matchesDomain } from "./py_js/py_utils.js";

/** Préfixe des identifiants purement locaux (déjà utilisé pour les many2one). */
export const LOCAL_ID_PREFIX = "tmp:";

/** Statuts d'une action dont les données ne sont PAS encore dans Odoo. */
export const PENDING_STATUSES = ["pending", "error", "conflict"];

/**
 * Types pour lesquels une valeur "falsy" (false / "") est réellement écrite
 * par le backend — miroir exact de sync_queue.py::_prepare_values()
 * (WRITABLE_FALSY_TYPES). Pour tous les autres types, le serveur IGNORE un
 * false : la surcouche ne doit donc pas l'afficher comme un vidage.
 */
const WRITABLE_FALSY_TYPES = new Set(["boolean", "integer", "float", "monetary"]);

/* ------------------------------------------------------------------------- */
/* Identifiants locaux                                                       */
/* ------------------------------------------------------------------------- */

export function isLocalId(id) {
  return typeof id === "string" && id.startsWith(LOCAL_ID_PREFIX);
}

export function localIdFromUuid(uuid) {
  return `${LOCAL_ID_PREFIX}${uuid}`;
}

export function uuidFromLocalId(id) {
  return isLocalId(id) ? id.slice(LOCAL_ID_PREFIX.length) : id;
}

/* ------------------------------------------------------------------------- */
/* Lecture de la file d'attente                                              */
/* ------------------------------------------------------------------------- */

/** Parse le payload JSON d'une entrée sync_queue (jamais d'exception remontée). */
export function parseEntryPayload(entry) {
  if (!entry) return null;
  if (typeof entry.payload === "object" && entry.payload !== null) return entry.payload;
  try {
    return JSON.parse(entry.payload || "{}");
  } catch (err) {
    console.warn("[local_records] Payload illisible pour", entry.local_uuid, err);
    return null;
  }
}

/**
 * Toutes les actions non confirmées d'un modèle, dans l'ordre chronologique
 * (l'`id` auto-incrémenté de Dexie est plus fiable que created_at, qui n'a
 * qu'une précision d'une seconde).
 */
export async function getPendingEntries(modelName) {
  const rows = await db.sync_queue.where("model_name").equals(modelName).toArray();
  return rows
    .filter((row) => PENDING_STATUSES.includes(row.status))
    .sort((a, b) => a.id - b.id);
}

/** Entrées non confirmées concernant un enregistrement précis. */
export async function getPendingWritesForRecord(modelName, recordId) {
  if (recordId === undefined || recordId === null) return [];
  const entries = await getPendingEntries(modelName);
  return entries.filter((entry) => {
    if (entry.operation !== "write") return false;
    const payload = parseEntryPayload(entry);
    return payload && String(payload.id) === String(recordId);
  });
}

/** L'entrée sync_queue d'un UUID donné, si elle concerne bien ce modèle. */
export async function getPendingEntry(modelName, localUuidOrId) {
  const uuid = uuidFromLocalId(localUuidOrId);
  if (!uuid) return null;
  const entry = await db.sync_queue.where("local_uuid").equals(uuid).first();
  if (!entry) return null;
  if (modelName && entry.model_name !== modelName) return null;
  return entry;
}

/**
 * Libellé d'un enregistrement créé localement (ex: pour un many2one qui
 * pointe vers un partenaire créé hors-ligne) : le `name` du payload est ce
 * que l'utilisateur a de plus proche d'un display_name.
 */
export async function getPendingRecordLabel(modelName, localIdOrUuid) {
  const entry = await getPendingEntry(modelName, localIdOrUuid);
  if (!entry) return null;
  const payload = parseEntryPayload(entry);
  if (!payload) return null;
  return payload.name || payload.display_name || null;
}

/* ------------------------------------------------------------------------- */
/* Normalisation des valeurs                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Miroir de sync_queue.py::_prepare_values() : ne conserve que ce que le
 * serveur écrira réellement. Utilisé pour l'AFFICHAGE des modifications en
 * attente (la valeur montrée est donc exactement celle qui sera
 * synchronisée), jamais pour construire un payload.
 */
export function sanitizePendingValues(values, fieldsInfo) {
  const out = {};
  for (const [fieldName, value] of Object.entries(values || {})) {
    if (fieldName === "id" || fieldName === "_deleted") {
      out[fieldName] = value;
      continue;
    }
    const info = fieldsInfo ? fieldsInfo[fieldName] : null;
    if (fieldsInfo && !info) continue; // champ inconnu du modèle : le serveur l'ignore aussi
    if (value === null || value === undefined) continue;
    if (value === false || value === "") {
      // Falsy non écrit pour ce type (comme _prepare_values). Sans métadonnée
      // de champ (manifeste incomplet) on ne peut pas trancher : on
      // s'abstient, et la ligne s'affiche avec ses valeurs renseignées
      // plutôt que vide.
      if (!fieldsInfo || !WRITABLE_FALSY_TYPES.has(info.type)) continue;
    }
    out[fieldName] = value;
  }
  return out;
}

/**
 * "YYYY-MM-DDTHH:MM" (input datetime-local, ce que produit le formulaire) vers
 * le format serveur "YYYY-MM-DD HH:MM:SS" — pour que la ligne affichée dans la
 * liste soit au même format que celles venues d'Odoo.
 */
function toServerDatetime(value) {
  if (typeof value !== "string" || !value) return value;
  const normalized = value.replace("T", " ");
  return normalized.length === 16 ? `${normalized}:00` : normalized;
}

/**
 * Valeur de `state` d'un enregistrement pas encore créé côté serveur : le
 * formulaire ne collecte jamais ce champ (il est rendu par le widget
 * statusbar, pas par un <input>), or les domaines d'action
 * (ex: ["state", "in", ["draft", "sent"]]) en dépendent — sans cette valeur
 * par défaut, un devis créé hors-ligne serait filtré de sa propre liste.
 * La règle par défaut du moteur ("draft" pour un nouvel enregistrement, voir
 * rules/default_rules.js) est réutilisée plutôt que codée en dur ici.
 */
function defaultStateValue(fieldsInfo, payload) {
  const stateInfo = fieldsInfo ? fieldsInfo.state : null;
  if (!stateInfo) return undefined; // le modèle n'a pas de champ state
  const fromRules = getDefaultValue("*", "state", payload);
  if (fromRules !== undefined) return fromRules;
  const first = Array.isArray(stateInfo.selection) ? stateInfo.selection[0] : null;
  return first ? first[0] : undefined;
}

/** Déplie les couples [id, "Libellé"] en id, pour comparaison de domaine. */
function unwrapForDomain(record) {
  const out = {};
  for (const [key, value] of Object.entries(record || {})) {
    out[key] =
      Array.isArray(value) && value.length === 2 && typeof value[1] === "string"
        ? value[0]
        : value;
  }
  return out;
}

function recordMatchesDomain(record, domain) {
  if (!Array.isArray(domain) || domain.length === 0) return true;
  return matchesDomain(unwrapForDomain(record), domain);
}

/**
 * Résout les libellés d'un ensemble de références (ids numériques issus du
 * cache reference_records, "tmp:<uuid>" issus de créations locales) pour un
 * modèle de relation donné.
 * @returns {Promise<Map<string, string>>} clé = id ou "tmp:<uuid>"
 */
async function resolveLabels(relationModel, keys) {
  const labels = new Map();
  if (!relationModel || keys.length === 0) return labels;

  const numericKeys = keys.filter((key) => !isLocalId(key));
  const localKeys = keys.filter((key) => isLocalId(key));

  if (numericKeys.length > 0) {
    const rows = await db.reference_records.where("model").equals(relationModel).toArray();
    const byId = new Map(rows.map((row) => [String(row.id), row.display_name]));
    for (const key of numericKeys) {
      const label = byId.get(String(key));
      if (label) labels.set(key, label);
    }
  }

  for (const key of localKeys) {
    const entry = await db.sync_queue.where("local_uuid").equals(uuidFromLocalId(key)).first();
    if (!entry || entry.model_name !== relationModel) continue;
    const payload = parseEntryPayload(entry);
    const label = payload && (payload.name || payload.display_name);
    if (label) labels.set(key, label);
  }

  return labels;
}

/**
 * Convertit des valeurs "brutes" (celles d'un payload de formulaire) vers le
 * format attendu par les rendus de liste/kanban : many2one et many2many sous
 * forme de couples [id, "Libellé"] (convention de /offline_sync/read_record),
 * datetime au format serveur. Le reste est inchangé.
 *
 * @param {string} modelName
 * @param {Object} values
 * @param {Object} fieldsInfo - manifest.fields[modelName]
 */
export async function normalizeForList(modelName, values, fieldsInfo) {
  const out = { ...(values || {}) };
  if (!fieldsInfo) return out;

  // 1. Inventaire des références à résoudre (une requête par modèle lié).
  const keysByRelation = new Map();
  const collect = (relation, key) => {
    if (!relation || key === undefined || key === null || key === "") return;
    if (!keysByRelation.has(relation)) keysByRelation.set(relation, new Set());
    keysByRelation.get(relation).add(String(key));
  };

  for (const [fieldName, info] of Object.entries(fieldsInfo)) {
    if (!(fieldName in out)) continue;
    const value = out[fieldName];

    if (info.type === "many2one") {
      if (Array.isArray(value)) {
        collect(info.relation, value[0]);
      } else if (value !== false && value !== null && value !== undefined && value !== "") {
        collect(info.relation, value);
      }
    } else if (info.type === "many2many" && Array.isArray(value)) {
      for (const item of value) collect(info.relation, Array.isArray(item) ? item[0] : item);
    } else if (info.type === "datetime") {
      out[fieldName] = toServerDatetime(value);
    }
  }

  const labelCache = new Map();
  for (const [relation, keys] of keysByRelation) {
    const labels = await resolveLabels(relation, [...keys]);
    for (const [key, label] of labels) labelCache.set(`${relation}::${key}`, label);
  }
  const labelOf = (relation, key) => labelCache.get(`${relation}::${key}`);

  // 2. Mise en forme des valeurs relationnelles.
  for (const [fieldName, info] of Object.entries(fieldsInfo)) {
    if (!(fieldName in out)) continue;
    const value = out[fieldName];

    if (info.type === "many2one") {
      if (value === false || value === null || value === undefined || value === "") {
        out[fieldName] = false;
        continue;
      }
      if (Array.isArray(value)) {
        out[fieldName] = [value[0], value[1] || `#${value[0]}`];
        continue;
      }
      const key = String(value);
      const id = isLocalId(key) ? key : Number(key);
      out[fieldName] = [id, labelOf(info.relation, key) || `#${id}`];
    } else if (info.type === "many2many") {
      if (!Array.isArray(value)) {
        out[fieldName] = [];
        continue;
      }
      out[fieldName] = value.map((item) => {
        if (Array.isArray(item)) return [item[0], item[1] || `#${item[0]}`];
        const key = String(item);
        const id = isLocalId(key) ? key : Number(key);
        return [id, labelOf(info.relation, key) || `#${id}`];
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------------- */
/* Construction de la surcouche                                              */
/* ------------------------------------------------------------------------- */

/**
 * Ligne "brute" correspondant à une création non synchronisée (valeurs au
 * format payload, donc directement comparables à un domaine Odoo).
 */
function buildRawLocalRow(modelName, entry, fieldsInfo) {
  const payload = parseEntryPayload(entry);
  if (!payload) return null;

  const raw = sanitizePendingValues(payload, fieldsInfo);
  raw.id = localIdFromUuid(entry.local_uuid);
  raw.__local__ = true;
  raw.__local_uuid__ = entry.local_uuid;
  raw.__local_status__ = entry.status;

  if (raw.state === undefined || raw.state === false) {
    const state = defaultStateValue(fieldsInfo, payload);
    if (state !== undefined) raw.state = state;
  }

  return raw;
}

/**
 * Copie d'affichage (couples [id, libellé]) d'une ligne locale — à insérer
 * en tête de liste, comme le fait Odoo pour un enregistrement fraîchement
 * créé (`order="id desc"`).
 */
export async function buildLocalRow(modelName, entry, fieldsInfo) {
  const raw = buildRawLocalRow(modelName, entry, fieldsInfo);
  if (!raw) return null;
  return await normalizeForList(modelName, raw, fieldsInfo);
}

/**
 * Applique la surcouche locale à une liste de lignes.
 *
 * @param {string} modelName
 * @param {Array} records - lignes issues du cache ou du serveur
 * @param {Object} fieldsInfo - manifest.fields[modelName]
 * @param {Object} [options]
 * @param {Array} [options.domain] - domaine de l'action courante : une ligne
 *   créée localement n'a de sens que dans la liste correspondante (un devis
 *   en brouillon ne doit pas apparaître dans "Commandes")
 * @param {Array} [options.extraDomain] - domaine additionnel de navigation
 *   (ex: stock.picking filtré par type de bon)
 * @returns {Promise<Array>} nouvelle liste : créations locales en tête,
 *   lignes patchées/supprimées prises en compte
 */
export async function applyLocalOverlay(modelName, records, fieldsInfo, { domain = null, extraDomain = null } = {}) {
  const base = Array.isArray(records) ? records : [];
  const entries = await getPendingEntries(modelName);
  if (entries.length === 0) return base.slice();

  const deletedIds = new Set();
  const patches = new Map();

  for (const entry of entries) {
    const payload = parseEntryPayload(entry);
    if (!payload) continue;

    if (entry.operation === "unlink") {
      if (payload.id !== undefined && payload.id !== null && payload.id !== false) {
        deletedIds.add(String(payload.id));
      }
    } else if (entry.operation === "write") {
      if (payload.id !== undefined && payload.id !== null && payload.id !== false) {
        // Le statut est conservé pour que la ligne signale un échec ou un
        // conflit, pas seulement une attente.
        patches.set(String(payload.id), { payload, status: entry.status });
      }
    }
  }

  const merged = [];
  for (const record of base) {
    if (record && deletedIds.has(String(record.id))) continue;

    const patch = record ? patches.get(String(record.id)) : null;
    if (!patch) {
      merged.push(record);
      continue;
    }

    merged.push(
      await normalizeForList(
        modelName,
        {
          ...record,
          ...sanitizePendingValues(patch.payload, fieldsInfo),
          __local__: true,
          __local_status__: patch.status || "pending",
        },
        fieldsInfo
      )
    );
  }

  const createdRows = [];
  for (const entry of entries) {
    if (entry.operation !== "create") continue;

    const raw = buildRawLocalRow(modelName, entry, fieldsInfo);
    if (!raw) continue;
    if (!recordMatchesDomain(raw, domain)) continue;
    if (!recordMatchesDomain(raw, extraDomain)) continue;

    createdRows.push(await normalizeForList(modelName, raw, fieldsInfo));
  }

  // Les entrées sont parcourues dans l'ordre chronologique ; la liste doit
  // présenter la saisie la plus récente en premier, comme le serveur
  // (list_records utilise order="id desc").
  createdRows.reverse();

  return [...createdRows, ...merged];
}

/* ------------------------------------------------------------------------- */
/* Côté formulaire                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Fusionne sur un enregistrement (format formulaire : many2one = id brut) les
 * modifications locales encore en attente, dans l'ordre chronologique.
 *
 * Sans ça, rouvrir hors-ligne un document déjà modifié hors-ligne réafficherait
 * la version du cache et la saisie suivante écraserait la précédente.
 *
 * @returns {Promise<Object>} copie fusionnée (l'original n'est pas modifié)
 */
export async function applyPendingWritesToRecord(modelName, record, fieldsInfo) {
  if (!record || record.id === undefined || record.id === null || isLocalId(record.id)) {
    return record;
  }

  const entries = await getPendingWritesForRecord(modelName, record.id);
  if (entries.length === 0) return record;

  let merged = record;
  for (const entry of entries) {
    const payload = parseEntryPayload(entry);
    if (!payload) continue;
    merged = { ...merged, ...sanitizePendingValues(payload, fieldsInfo) };
  }
  return merged;
}

/**
 * Valeurs initiales d'un formulaire ouvert sur une création non synchronisée
 * (identifiant "tmp:<uuid>") : le payload de la file EST l'état courant de la
 * fiche, mis à jour à chaque enregistrement via amendPendingCreate().
 */
export async function getLocalRecordValues(modelName, localIdOrUuid) {
  const entry = await getPendingEntry(modelName, localIdOrUuid);
  if (!entry) return null;
  if (entry.operation !== "create") return null;
  return parseEntryPayload(entry);
}
