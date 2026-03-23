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

  // Derive the portal origin from this page's hostname.
  // Superset is at superset.<domain>; the portal is the root <domain>.
  // e.g. window.location = "https://superset.hyperset.internal"
  //      → PORTAL_ORIGIN   = "https://hyperset.internal"
  //
  // This is used BOTH to validate incoming messages (isPortalOrigin) AND
  // as the explicit targetOrigin when posting messages back to the portal,
  // preventing chart payloads from being intercepted by a malicious parent.
  const _hostParts = window.location.hostname.split(".");
  // Strip the leftmost subdomain label (e.g. "superset") to get the portal host.
  const _portalHost = _hostParts.length > 1
    ? _hostParts.slice(1).join(".")   // "superset.a.b" → "a.b", "superset.localhost" → "localhost"
    : _hostParts.join(".");            // already bare domain — use as-is
  const _port = window.location.port ? ":" + window.location.port : "";
  let PORTAL_ORIGIN = window.location.protocol + "//" + _portalHost + _port;

  // We will update PORTAL_ORIGIN with the exact parent origin once we receive a message from it.
  
  function isPortalOrigin(origin) {
    try {
      const u = new URL(origin);
      // Accept the exact portal host or any subdomain of it.
      // (Covers the case where future services share the same parent domain.)
      return u.hostname === _portalHost || u.hostname.endsWith("." + _portalHost);
    } catch {
      return false;
    }
  }

  // Attempt to initialize from document.referrer if available and valid
  try {
    if (document.referrer) {
      const ref = new URL(document.referrer);
      if (isPortalOrigin(ref.origin)) {
        PORTAL_ORIGIN = ref.origin;
      }
    }
  } catch (_) {}

  let lastReportedUrl = "";

  function getBestCurrentUrl() {
    return window.location.href;
  }

  function notifyLocation(reason) {
    if (window.parent && window.parent !== window) {
      // Use setTimeout to ensure any pending state updates are complete
      setTimeout(() => {
        const url = getBestCurrentUrl();
        lastReportedUrl = url;
        window.parent.postMessage(
          {
            type: "superset_location",
            url: url,
            reason: reason || "unknown",
          },
          PORTAL_ORIGIN
        );
      }, 50);
    }
  }

  // Set up a polling interval to catch ANY URL changes that might bypass history hooks
  setInterval(() => {
    const currentUrl = getBestCurrentUrl();
    if (currentUrl !== lastReportedUrl) {
      notifyLocation("polling_change");
    }
  }, 500);

  // Keep the portal informed of iframe location changes.
  // Covers initial load, browser nav, and SPA router updates.
  const _pushState = history.pushState;
  history.pushState = function () {
    const result = _pushState.apply(this, arguments);
    notifyLocation("pushState");
    return result;
  };

  const _replaceState = history.replaceState;
  history.replaceState = function () {
    const result = _replaceState.apply(this, arguments);
    notifyLocation("replaceState");
    return result;
  };

  window.addEventListener("popstate", function () {
    notifyLocation("popstate");
  });

  window.addEventListener("hashchange", function () {
    notifyLocation("hashchange");
  });

  // Catch manual in-app navigation even if router/history hooks do not fire.
  document.addEventListener(
    "click",
    function (event) {
      const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!anchor) return;
      const target = (anchor.getAttribute("target") || "").toLowerCase();
      if (target && target !== "_self") return;
      try {
        const href = anchor.getAttribute("href") || "";
        const nextUrl = new URL(href, window.location.href);
        if (nextUrl.origin !== window.location.origin) return;
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(
            {
              type: "superset_location",
              url: nextUrl.toString(),
              reason: "anchor_click",
            },
            PORTAL_ORIGIN
          );
        }
      } catch (_) {}
    },
    true
  );

  window.addEventListener("load", function () {
    notifyLocation("load");
  });

  // ── Listen for commands from the portal ────────────────────────
  window.addEventListener("message", function (event) {
    if (!isPortalOrigin(event.origin)) return;
    // Refine PORTAL_ORIGIN to the exact origin (e.g. including correct dev port),
    // safe to do now that we've validated the sender is the trusted portal host.
    PORTAL_ORIGIN = event.origin;

    const msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === "navigate_dashboard") {
      navigateToDashboard(msg.dashboardId);
    } else if (msg.type === "navigate_chart") {
      navigateToChart(msg.chartId);
    } else if (msg.type === "navigate_sql_lab") {
      navigateToSqlLab();
    } else if (msg.type === "get_location") {
      window.parent.postMessage(
        {
          type: "superset_location",
          url: getBestCurrentUrl(),
          reason: "requested",
        },
        event.origin
      );
    } else if (msg.type === "ping") {
      window.parent.postMessage({ type: "pong" }, event.origin);
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

  // Signal to portal that bridge is ready — scoped to PORTAL_ORIGIN only.
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "ready" }, PORTAL_ORIGIN);
    notifyLocation("ready");
  }

  console.log("[Hyperset Bridge] Loaded");
})();
