/**
 * Hyperset Superset Bridge
 * Injected into the Superset page by Caddy via sub_filter.
 * Enables bidirectional communication between the Portal and Superset.
 *
 * Portal → Superset: navigate to dashboard/chart
 * Superset → Portal: right-click chart → "Inspect in chatbot"
 */
(function () {
  "use strict";

  // The portal origin is the parent frame — we validate it loosely
  // by checking that it matches the same base domain suffix.
  const EXPECTED_DOMAIN_SUFFIX = window.location.hostname
    .split(".")
    .slice(-2)
    .join(".");

  function isPortalOrigin(origin) {
    try {
      const u = new URL(origin);
      return u.hostname.endsWith(EXPECTED_DOMAIN_SUFFIX);
    } catch {
      return false;
    }
  }

  // ── Listen for commands from the portal ────────────────────────
  window.addEventListener("message", function (event) {
    if (!isPortalOrigin(event.origin)) return;
    const msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === "navigate_dashboard") {
      navigateToDashboard(msg.dashboardId);
    } else if (msg.type === "navigate_chart") {
      navigateToChart(msg.chartId);
    } else if (msg.type === "navigate_sql_lab") {
      navigateToSqlLab();
    } else if (msg.type === "ping") {
      event.source?.postMessage({ type: "pong" }, event.origin);
    }
  });

  // ── Navigation helpers ─────────────────────────────────────────
  function navigateToDashboard(dashboardId) {
    // Try Superset React router first, fall back to location
    const store = getReactStore();
    if (store) {
      try {
        const { routing } = store.getState();
        if (routing) {
          store.dispatch({
            type: "@@router/CALL_HISTORY_METHOD",
            payload: { method: "push", args: [`/dashboard/${dashboardId}/`] },
          });
          return;
        }
      } catch (_) {}
    }
    window.location.href = `/superset/dashboard/${dashboardId}/`;
  }

  function navigateToChart(chartId) {
    const store = getReactStore();
    if (store) {
      try {
        store.dispatch({
          type: "@@router/CALL_HISTORY_METHOD",
          payload: { method: "push", args: [`/explore/?slice_id=${chartId}`] },
        });
        return;
      } catch (_) {}
    }
    window.location.href = `/explore/?slice_id=${chartId}`;
  }

  function navigateToSqlLab() {
    window.location.href = "/superset/sqllab/";
  }

  // Try to get the Redux store attached to a Superset React root
  function getReactStore() {
    const roots = document.querySelectorAll("[data-reactroot], #app, #root");
    for (const el of roots) {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
      if (!key) continue;
      let fiber = el[key];
      while (fiber) {
        if (fiber.stateNode?.store?.getState) return fiber.stateNode.store;
        if (fiber.memoizedProps?.store?.getState) return fiber.memoizedProps.store;
        fiber = fiber.return;
      }
    }
    return null;
  }

  // ── Right-click context menu on charts ────────────────────────
  let contextMenu = null;

  function removeContextMenu() {
    if (contextMenu) {
      contextMenu.remove();
      contextMenu = null;
    }
    document.removeEventListener("click", removeContextMenu, { once: true });
  }

  function showContextMenu(x, y, chartEl) {
    removeContextMenu();

    const menu = document.createElement("div");
    menu.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      z-index: 99999;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.18);
      font-family: system-ui, sans-serif;
      min-width: 200px;
      overflow: hidden;
    `;

    const item = document.createElement("div");
    item.style.cssText = `
      padding: 10px 16px;
      cursor: pointer;
      font-size: 13px;
      color: #1c1b1f;
      display: flex;
      align-items: center;
      gap: 8px;
    `;
    item.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="#20a7c9">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
      </svg>
      Inspect in chatbot
    `;

    item.addEventListener("mouseover", () => {
      item.style.background = "#e0f4f8";
    });
    item.addEventListener("mouseout", () => {
      item.style.background = "";
    });

    item.addEventListener("click", function () {
      removeContextMenu();
      sendChartToPortal(chartEl);
    });

    menu.appendChild(item);
    document.body.appendChild(menu);
    contextMenu = menu;

    // Close on next click anywhere
    setTimeout(() => {
      document.addEventListener("click", removeContextMenu, { once: true });
    }, 0);
  }

  function sendChartToPortal(chartEl) {
    // Extract chart metadata from the DOM
    const titleEl =
      chartEl.querySelector(".chart-header .header-title, .slice-header .header, [class*='ChartHeader'] h2, .chart-container h2") ||
      chartEl.closest("[data-slice-id]")?.querySelector(".header-title, .chart-name");

    const chartTitle = titleEl?.textContent?.trim() || "Unknown chart";

    // Try to get datasource name
    const datasourceEl = chartEl.querySelector(
      "[data-test='datasource-name'], .datasource-name, .chart-description"
    );
    const datasource = datasourceEl?.textContent?.trim() || "";

    // Try to extract slice id
    const sliceId =
      chartEl.closest("[data-slice-id]")?.dataset?.sliceId ||
      chartEl.closest("[data-chart-id]")?.dataset?.chartId ||
      "";

    const payload = {
      type: "inspect_chart",
      chartId: sliceId,
      chartTitle,
      datasource,
      query: "",
    };

    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, "*");
    }
  }

  // Attach context menu listener — use delegation on document
  // so it works even after Superset's React re-renders
  document.addEventListener("contextmenu", function (event) {
    // Only intercept right-clicks on chart containers
    const chartEl = event.target.closest(
      ".chart-container, .slice-cell, [data-slice-id], .dashboard-chart, " +
      ".dragdroppable--chart, .chart-slice, .slice-plugin-tooltip"
    );

    if (!chartEl) return;

    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, chartEl);
  });

  // Signal to portal that bridge is ready
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "ready" }, "*");
  }

  console.log("[Hyperset Bridge] Loaded");
})();
