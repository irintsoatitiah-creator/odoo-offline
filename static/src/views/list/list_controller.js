/**
 * views/list/list_controller.js
 * ================================
 * Manages the loading of the record list, pagination,
 * text search, and switching between list and kanban views.
 */

import { buildStockPickingTypeDomain } from "./stock_picking_dashboard.js";
import { bus } from "../../core/bus/bus_service.js";
import { CONFIG, getApiKey, getUserId } from "../../core/browser/session.js";
import { getSecurityInfo } from "../../core/user_service.js";
import { getModuleManifest, resolveModelViews, findActionDomain } from "../view_service.js";
import { getListRecordsSmart, getPurchaseDashboardSmart } from "../../core/list_cache.js";
import { applyLocalOverlay } from "../../core/local_records.js";
import { formatCellValue } from "./list_renderer_utils.js";
import { renderListView } from "./list_renderer.js";
import { renderKanbanView } from "../kanban/kanban_renderer.js";
import { renderPurchaseDashboard, buildPurchaseDashboardDomain } from "../purchase_dashboard.js";
import { buildControlPanel, renderViewSwitcherButtons } from "../../search/control_panel/control_panel.js";
import { filterByRecordRule } from "../../model/rules_engine/rules_engine.js";

const PAGE_SIZE = 20;

/**
 * Mounts the list controller into the container. Called by views/view.js.
 * @returns {Function} destroy
 */
export async function mountListController(container, params, env) {
  const { module, model, view = "list", actionId, label, extraDomain = null } = params;

  if (!module || !model) {
    console.warn("[list_controller] descripteur incomplet, retour à l'accueil :", params);
    env.doAction("home_menu", { replace: true, clearStack: true });
    return () => {};
  }

  const apiKey = getApiKey();

  let currentPage = 0;
  let allRecordsRaw = [];
  let allRecords = [];
  let searchQuery = "";
  let currentView = view;
  let currentModelViews = null;
  let currentViewFieldsInfo = null;
  let activeDashboardFilter = null;
  let searchDebounceTimer = null;
  let actionDomain = null;
  let listRefreshTimer = null;

  // --- Construction of the control panel specific to this view ---
  const cp = buildControlPanel({
    withNewButton: true,
    withSearch: true,
    withPager: true,
    withViewSwitcher: true,
    withOptionsGear: true,
  });
  container.appendChild(cp.el);

  cp.breadcrumbCurrent.textContent = label || model;

  cp.newBtn.addEventListener("click", () => {
    env.doAction({ tag: "form_view", module, model, actionId, isNew: true });
  });

  cp.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    const query = cp.searchInput.value;
    searchDebounceTimer = setTimeout(() => {
      searchQuery = query;
      applySearchFilter();
      currentPage = 0;
      renderCurrentPage();
    }, 300);
  });

  cp.pagerPrevBtn.addEventListener("click", () => {
    if (currentPage > 0) { currentPage--; renderCurrentPage(); }
  });
  cp.pagerNextBtn.addEventListener("click", () => {
    if ((currentPage + 1) * PAGE_SIZE < allRecords.length) { currentPage++; renderCurrentPage(); }
  });

  // Status bar
  const statusEl = document.createElement("div");
  statusEl.className = "text-muted small px-3 py-1";
  statusEl.textContent = "Chargement de la liste...";
  container.appendChild(statusEl);

  const listContainer = document.createElement("div");
  listContainer.id = "list-container";

  const dashboardContainer = document.createElement("div");
  dashboardContainer.id = "dashboard-container";

  container.appendChild(dashboardContainer);
  container.appendChild(listContainer);

  function matchesSimpleDomain(record, domain) {
    return domain.every(([field, op, value]) => {
      const raw = record[field];
      switch (op) {
        case "=": return raw === value;
        case "in": return Array.isArray(value) && value.includes(raw);
        case "<": return raw !== undefined && raw !== false && raw < value;
        default: return true;
      }
    });
  }

  function applySearchFilter() {
    let filtered = allRecordsRaw;

    if (activeDashboardFilter) {
      const domain = buildPurchaseDashboardDomain(
        activeDashboardFilter.rowKey, activeDashboardFilter.stateKey, getUserId()
      );
      filtered = filtered.filter((r) => matchesSimpleDomain(r, domain));
    }

    allRecords = searchQuery
      ? filtered.filter((r) => recordMatchesQuery(r, currentViewFieldsInfo || {}, searchQuery))
      : filtered;
  }

  function recordMatchesQuery(record, fieldsInfo, query) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    for (const [fname, info] of Object.entries(fieldsInfo)) {
      const raw = record[fname];
      if (raw === undefined || raw === false || raw === null) continue;
      const text = formatCellValue(raw, info);
      if (text && text.toLowerCase().includes(q)) return true;
    }
    return false;
  }

  function updatePagerDisplay() {
    const total = allRecords.length;
    const start = currentPage * PAGE_SIZE;
    if (total === 0) {
      cp.pagerEl.style.setProperty("display", "none", "important");
      return;
    }
    cp.pagerEl.style.setProperty("display", "flex", "important");
    cp.pagerInfoEl.textContent = `${start + 1}-${Math.min(start + PAGE_SIZE, total)} / ${total}`;
    cp.pagerPrevBtn.disabled = currentPage === 0;
    cp.pagerNextBtn.disabled = start + PAGE_SIZE >= total;
  }

  function renderCurrentPage() {
    if (listContainer._currentView?._cleanup) {
      listContainer._currentView._cleanup();
    }
    listContainer.innerHTML = "";

    const start = currentPage * PAGE_SIZE;
    const pageRecords = allRecords.slice(start, start + PAGE_SIZE);

    const onRecordOpen = (recordId) => {
      env.doAction({
        tag: "form_view", module, model, id: recordId, actionId,
        listLabel: label || model,
      });
    };

    const onNavigate = (methodName, pickingTypeId) => {
      const buildExtra = buildStockPickingTypeDomain(methodName);
      if (!buildExtra) return; // méthode inconnue -> pas de navigation
      const pickingType = allRecords.find((r) => r.id === pickingTypeId);
      env.doAction({
        tag: "list_view",
        module,
        model: "stock.picking",
        extraDomain: [["picking_type_id", "=", pickingTypeId], ...buildExtra],
        label: pickingType?.name || "Transferts",
      });
    };

    const viewEl =
      currentView === "kanban"
        ? renderKanbanView(currentModelViews.kanban.arch, currentViewFieldsInfo, pageRecords, onRecordOpen, onNavigate)
        : renderListView(currentModelViews.list.arch, currentViewFieldsInfo, pageRecords, onRecordOpen, model);

    listContainer._currentView = viewEl;
    listContainer.appendChild(viewEl);
    updatePagerDisplay();
  }

  /**
   * Charge (ou recharge) les données de la liste : cache/serveur, puis
   * surcouche des modifications locales non synchronisées (voir
   * core/local_records.js). Isolée dans une fonction car rappelée à chaque
   * événement "sync:updated" : une création hors-ligne doit apparaître dans
   * la liste, et disparaître de la surcouche une fois réellement
   * synchronisée avec Odoo.
   */
  async function loadListData() {
    let loadError = null;
    let records = [];

    try {
      const listData = await getListRecordsSmart(model, apiKey, CONFIG.ODOO_BASE_URL, actionId, extraDomain);
      records = listData.records || [];
    } catch (err) {
      // Hors-ligne sans cache : on affiche malgré tout les saisies locales
      // plutôt qu'un écran d'erreur (voir surcouche ci-dessous).
      loadError = err;
      console.warn("[list_controller] Liste indisponible, surcouche locale seule :", err);
    }

    // Applique les record rules (ir.rule) mises en cache par user_service.js
    // -- jusqu'ici récupérées mais jamais utilisées (voir audit rules_engine).
    const securityInfo = await getSecurityInfo(model);
    allRecordsRaw = filterByRecordRule(model, records, securityInfo);

    // Créations/modifications/suppressions encore locales, en tête de liste.
    allRecordsRaw = await applyLocalOverlay(model, allRecordsRaw, currentViewFieldsInfo, {
      domain: actionDomain,
      extraDomain,
    });

    applySearchFilter();

    const lastPage = Math.max(0, Math.ceil(allRecords.length / PAGE_SIZE) - 1);
    if (currentPage > lastPage) currentPage = lastPage;

    renderCurrentPage();

    if (loadError && allRecords.length === 0) {
      statusEl.textContent = "Erreur : " + loadError.message;
    } else if (loadError) {
      statusEl.textContent = "Hors-ligne — seules les saisies locales sont affichées.";
    } else {
      statusEl.textContent = navigator.onLine ? "" : "Mode hors-ligne — liste mise en cache.";
    }
  }

  // Toute synchronisation (réussie ou en échec) change ce que la surcouche
  // doit montrer : une action "sent" sort de la file, un conflit y entre.
  const onSyncUpdated = () => {
    clearTimeout(listRefreshTimer);
    listRefreshTimer = setTimeout(() => {
      loadListData().catch((err) => console.warn("[list_controller] Rafraîchissement après synchro échoué:", err));
    }, 300);
  };

  try {
    const manifest = await getModuleManifest(module, apiKey, CONFIG.ODOO_BASE_URL);
    currentModelViews = resolveModelViews(manifest, model, actionId);
    currentViewFieldsInfo = manifest.fields[model];
    // Domaine de l'action/menu en cours : sert à ne pas afficher une saisie
    // locale dans une liste qui ne la concerne pas (Devis vs Commandes).
    actionDomain = findActionDomain(manifest, model, actionId);

    if (!currentModelViews) {
      statusEl.textContent = `Aucune vue disponible pour "${model}".`;
      return cleanup;
    }

    const availableViews = ["list", "kanban", "pivot", "graph"].filter((v) => currentModelViews[v]);
    function onViewSwitch(viewType) {
      currentView = viewType;
      renderViewSwitcherButtons(cp.viewSwitcherEl, availableViews, currentView, onViewSwitch);
      renderCurrentPage();
    }
    renderViewSwitcherButtons(cp.viewSwitcherEl, availableViews, currentView, onViewSwitch);

    if (currentView === "pivot" || currentView === "graph") {
      cp.pagerEl.style.setProperty("display", "none", "important");
      const placeholder = document.createElement("div");
      placeholder.className = "text-center text-muted p-5";
      placeholder.textContent = `Vue ${currentView === "pivot" ? "Pivot" : "Graphique"} : à venir.`;
      listContainer.appendChild(placeholder);
      statusEl.textContent = "";
      return cleanup;
    }

    if (model === "purchase.order") {
      const dashboardData = await getPurchaseDashboardSmart(apiKey, CONFIG.ODOO_BASE_URL, actionId);
      
      // The banner is only relevant for certain actions (e.g., "Requests for
      // Quotation"), not for all `purchase.order` views (e.g., "Purchase
      // Orders"). In such cases, the server does not return the expected
      // format—we degrade gracefully (no banner) rather than crashing.
      if (dashboardData && dashboardData.toutes && dashboardData.mes) {
        const dashboardEl = renderPurchaseDashboard(dashboardData, activeDashboardFilter, (rowKey, stateKey) => {
          activeDashboardFilter =
            activeDashboardFilter && activeDashboardFilter.rowKey === rowKey && activeDashboardFilter.stateKey === stateKey
              ? null : { rowKey, stateKey };
          applySearchFilter();
          currentPage = 0;
          renderCurrentPage();
        });
        dashboardContainer.appendChild(dashboardEl);
      } else if (dashboardData) {
        console.warn("Bandeau purchase_dashboard ignoré : données inattendues pour cette action.", dashboardData);
      }
    }

    await loadListData();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Erreur : " + err.message;
  }

  // Le rafraîchissement n'a de sens que si la vue a été montée avec succès.
  bus.subscribe("sync:updated", onSyncUpdated);

  function cleanup() {
    clearTimeout(searchDebounceTimer);
    clearTimeout(listRefreshTimer);
    bus.unsubscribe("sync:updated", onSyncUpdated);
    if (listContainer._currentView?._cleanup) {
      listContainer._currentView._cleanup();
    }
  }

  return cleanup;
}