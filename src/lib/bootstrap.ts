import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

/** The splash must stay up at least this long so it doesn't flicker on fast boots. */
const MIN_SPLASH_MS = 900;

let done = false;

async function step(msg: string, fn: () => Promise<unknown>) {
  await emit("splash:status", msg).catch(() => {});
  try {
    await fn();
  } catch {
    // Startup warm-ups are best-effort — a failure here shouldn't block the app.
  }
}

/**
 * Run the app's startup work while the splash window is shown, then dismiss the
 * splash and reveal the main window. Warms the app-level config commands so the
 * first Settings open / start screen is instant. Safe to call more than once
 * (StrictMode double-mount, HMR reloads) — later calls just re-reveal main.
 */
export async function runBootstrap(): Promise<void> {
  if (done) {
    await invoke("close_splashscreen").catch(() => {});
    return;
  }
  done = true;
  const started = Date.now();
  try {
    await step("Loading preferences…", async () => {
      await Promise.all([invoke("ai_settings"), invoke("toolchain_info"), invoke("tool_paths")]);
    });
    await step("Restoring projects…", async () => {
      await invoke("list_projects");
    });
    await step("Preparing workspace…", async () => {});
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed < MIN_SPLASH_MS) await new Promise((r) => setTimeout(r, MIN_SPLASH_MS - elapsed));
    await invoke("close_splashscreen").catch(() => {});
  }
}
