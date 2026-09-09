import type { CodeStyleKind } from "./api";

/** An imported Eclipse formatter profile (an .xml on disk). */
export interface ImportedProfile {
  name: string;
  path: string;
}

/** The persisted code-style selection. Built-ins have no path; an Eclipse
 *  profile carries the .xml path (and its display name). */
export interface StoredCodeStyle {
  kind: CodeStyleKind;
  path?: string;
  name?: string;
}

const STYLE_KEY = "java.codeStyle";
const PROFILES_KEY = "java.codeStyleProfiles";

export function loadCodeStyle(): StoredCodeStyle {
  try {
    const raw = localStorage.getItem(STYLE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && (s.kind === "google" || s.kind === "aosp" || s.kind === "eclipse")) return s;
    }
  } catch {
    /* ignore */
  }
  return { kind: "google" };
}

export function saveCodeStyle(s: StoredCodeStyle) {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function loadImportedProfiles(): ImportedProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveImportedProfiles(list: ImportedProfile[]) {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
