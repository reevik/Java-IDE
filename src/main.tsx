import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { applyAppearance, applyFont, loadAppearance } from "./lib/theme";

const queryClient = new QueryClient();

// Apply the saved light/dark theme + editor font before first paint.
applyAppearance(loadAppearance());
applyFont();
// Keep "System" in sync with the OS setting while the app is open.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (loadAppearance() === "system") applyAppearance("system");
});

// --- Turn off native spell-check / autocorrect / autocomplete everywhere -------
// This is a code IDE — OS autocorrect mangling identifiers and red spell squiggles
// are unwanted. Apply to every input/textarea/contenteditable (incl. CodeMirror),
// and to any added later, via a MutationObserver.
(() => {
  const tame = (el: Element) => {
    if (!(el instanceof HTMLElement)) return;
    el.setAttribute("spellcheck", "false");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.setAttribute("autocomplete", "off");
  };
  const SEL = "input, textarea, [contenteditable]";
  const applyIn = (root: ParentNode) => root.querySelectorAll?.(SEL).forEach(tame);

  const start = () => {
    applyIn(document);
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n instanceof HTMLElement) {
            if (n.matches(SEL)) tame(n);
            applyIn(n);
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

// --- Diagnose + self-heal the intermittent webview viewport collapse ----------
// The transparent macOS window's WKWebView sometimes reports a much shorter
// viewport after a reflow, packing the whole UI into a top strip. We log the
// dimensions (readable at /tmp/rustade-client.log) and, when a sudden collapse is
// detected, ask the window to re-lay-out its webview to the full bounds.
(() => {
  const log = (line: string) => {
    const stamped = `[${new Date().toISOString().slice(11, 23)}] ${line}`;
    // eslint-disable-next-line no-console
    console.log(stamped);
    invoke("log_client", { line: stamped }).catch(() => {});
  };
  const dims = () => {
    const de = document.documentElement;
    const root = document.getElementById("root");
    return `innerH=${window.innerHeight} clientH=${de.clientHeight} rootH=${root?.getBoundingClientRect().height ?? "?"} dpr=${window.devicePixelRatio}`;
  };

  let lastHeal = 0;
  log(`boot ${dims()}`);

  window.addEventListener("resize", () => log(`resize ${dims()}`));

  const appRoot = () => document.getElementById("root")?.firstElementChild as HTMLElement | undefined;
  const metrics = (r: HTMLElement) => {
    const kids = Array.from(r.children) as HTMLElement[];
    const appH = Math.round(r.getBoundingClientRect().height);
    // How far down the page the content actually reaches (statusbar bottom when
    // healthy; the top strip's bottom when collapsed — even if appH stays full).
    const lastBottom = kids.length ? Math.round(Math.max(...kids.map((k) => k.getBoundingClientRect().bottom))) : 0;
    const kidStr = kids.map((c, i) => `${i}:${Math.round(c.getBoundingClientRect().height)}`).join(",");
    return { appH, lastBottom, kidStr };
  };
  // The "collapse" is really a stray top-level scroll shifting the app up, so the
  // recovery is to reset every scroll offset back to the top.
  const heal = (r: HTMLElement) => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const root = document.getElementById("root");
    if (root) root.scrollTop = 0;
    r.scrollTop = 0;
  };

  // The collapse fires no resize event (the viewport stays full), so poll the
  // real layout each frame-ish and both log changes and self-heal collapses.
  let last = "";
  setInterval(() => {
    const r = appRoot();
    if (!r) return;
    const vh = window.innerHeight;
    const m = metrics(r);
    const s = `vh=${vh} appH=${m.appH} last=${m.lastBottom} kids=[${m.kidStr}]`;
    if (s !== last) {
      last = s;
      log(`tick ${s}`);
    }
    // Collapsed: root shrank, or content stops well short of the viewport bottom.
    const collapsed = vh > 200 && (m.appH < vh * 0.85 || m.lastBottom < vh * 0.85);
    if (collapsed && Date.now() - lastHeal > 1200) {
      lastHeal = Date.now();
      log(`COLLAPSE → heal (vh=${vh} appH=${m.appH} last=${m.lastBottom})`);
      heal(r);
    }
  }, 250);

  window.addEventListener("error", (e) => log(`window.error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => log(`unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`));
})();

// Safety net: never strand the user on the splash. If the React bootstrap hasn't
// dismissed it within a few seconds (e.g. a render crash before App's effect runs),
// reveal the main window anyway so the error boundary / UI becomes visible.
setTimeout(() => {
  invoke("close_splashscreen").catch(() => {});
}, 6000);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary fallbackTitle="The app hit an unexpected error">
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
