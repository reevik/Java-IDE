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

// --- Right margin: a column for the guide line + optional soft wrap ----------
const MARGIN_COLUMN_KEY = "editor.marginColumn";
const WRAP_AT_MARGIN_KEY = "editor.wrapAtMargin";
const SHOW_MARGIN_KEY = "editor.showMargin";

/** The right-margin column (characters). Migrates the old `editor.wrapColumn`. */
export function loadMarginColumn(): number {
  const n = Number(localStorage.getItem(MARGIN_COLUMN_KEY) ?? localStorage.getItem("editor.wrapColumn"));
  return Number.isFinite(n) && n >= 20 && n <= 400 ? n : 100;
}
/** Soft-wrap long lines at the margin. Migrates the old wrapColumn>0 meaning. */
export function loadWrapAtMargin(): boolean {
  const v = localStorage.getItem(WRAP_AT_MARGIN_KEY);
  if (v != null) return v === "1";
  const old = Number(localStorage.getItem("editor.wrapColumn"));
  return Number.isFinite(old) && old > 0;
}
/** Show the gray vertical guide at the margin column. */
export function loadShowMargin(): boolean {
  return localStorage.getItem(SHOW_MARGIN_KEY) === "1";
}
export function saveMargin(column: number, wrap: boolean, show: boolean) {
  localStorage.setItem(MARGIN_COLUMN_KEY, String(column));
  localStorage.setItem(WRAP_AT_MARGIN_KEY, wrap ? "1" : "0");
  localStorage.setItem(SHOW_MARGIN_KEY, show ? "1" : "0");
  // Open editors reconfigure via the same live-settings event.
  window.dispatchEvent(new Event("rustade:theme"));
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
