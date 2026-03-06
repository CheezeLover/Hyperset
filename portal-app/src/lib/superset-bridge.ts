// Types for the postMessage protocol between the Portal and the Superset iframe

export type PortalToSuperset =
  | { type: "navigate_dashboard"; dashboardId: number | string }
  | { type: "navigate_chart"; chartId: number | string }
  | { type: "navigate_sql_lab" }
  | { type: "ping" };

export type SupersetToPortal =
  | {
      type: "inspect_chart";
      chartId: number | string;
      chartTitle: string;
      datasource: string;
      query?: string;
      filters?: Record<string, unknown>;
    }
  | { type: "pong" }
  | { type: "ready" };

export function sendToSuperset(
  iframeRef: HTMLIFrameElement | null,
  message: PortalToSuperset,
  supersetOrigin: string
) {
  if (!iframeRef?.contentWindow) return;
  iframeRef.contentWindow.postMessage(message, supersetOrigin);
}
