import { invoke } from "@tauri-apps/api/core";

export type Appearance = "light" | "dark" | "system";

const KEY = "appearance";

export function loadAppearance(): Appearance {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function saveAppearance(a: Appearance) {
  localStorage.setItem(KEY, a);
}

/** Whether the given setting resolves to a dark UI right now. */
export function isDark(a: Appearance = loadAppearance()): boolean {
  if (a === "dark") return true;
  if (a === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// --- Editor font ------------------------------------------------------------

const FONT_FAMILY_KEY = "editor.fontFamily";
const FONT_SIZE_KEY = "editor.fontSize";

export function loadFontFamily(): string {
  return localStorage.getItem(FONT_FAMILY_KEY) ?? "";
}
export function loadFontSize(): number {
  const n = Number(localStorage.getItem(FONT_SIZE_KEY));
  return Number.isFinite(n) && n >= 9 && n <= 28 ? n : 13;
}

/** Push the font choice into the CSS variables the editors read. */
export function applyFont() {
  const st = document.documentElement.style;
  const fam = loadFontFamily();
  if (fam) st.setProperty("--code-font-family", `"${fam}", ui-monospace, "SF Mono", Menlo, monospace`);
  else st.removeProperty("--code-font-family");
  st.setProperty("--code-font-size", `${loadFontSize()}px`);
}

export function saveFont(family: string, size: number) {
  localStorage.setItem(FONT_FAMILY_KEY, family);
  localStorage.setItem(FONT_SIZE_KEY, String(size));
  applyFont();
  // Re-measure open editors (font metrics changed).
  window.dispatchEvent(new Event("rustade:theme"));
}

/** Apply the theme to the document + native window, and notify live listeners
 *  (open CodeMirror editors reconfigure themselves — no reload needed). */
export function applyAppearance(a: Appearance) {
  const dark = isDark(a);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  invoke("set_window_theme", { dark }).catch(() => {});
  window.dispatchEvent(new Event("rustade:theme"));
}
