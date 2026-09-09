/** Actions run automatically when a Java file is saved (IntelliJ-style). */
export interface SaveActions {
  /** Reformat with the active code style. */
  format: boolean;
  /** Organize imports (add missing, remove unused, sort). */
  organizeImports: boolean;
}

const KEY = "java.saveActions";

const DEFAULTS: SaveActions = { format: false, organizeImports: false };

export function loadSaveActions(): SaveActions {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function saveSaveActions(s: SaveActions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
