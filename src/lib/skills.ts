/** Skills panel persistence. Skills are active by default, so we store only the
 *  set of DEACTIVATED skill ids (paths) plus any external skill folders added. */

const DEACT_KEY = "skills.deactivated";
const EXTDIR_KEY = "skills.externalDirs";

export function loadDeactivated(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(DEACT_KEY) ?? "[]");
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export function saveDeactivated(s: Set<string>) {
  try {
    localStorage.setItem(DEACT_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

export function loadExternalDirs(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(EXTDIR_KEY) ?? "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveExternalDirs(dirs: string[]) {
  try {
    localStorage.setItem(EXTDIR_KEY, JSON.stringify(dirs));
  } catch {
    /* ignore */
  }
}
