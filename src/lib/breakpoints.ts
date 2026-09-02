import type { Breakpoint, SourceBreakpoint } from "./types";

/** Breakpoints keyed by absolute file path. */
export type BreakpointMap = Record<string, Breakpoint[]>;

const KEY = (root: string) => `breakpoints:${root}`;

export function loadBreakpoints(root: string): BreakpointMap {
  try {
    const raw = localStorage.getItem(KEY(root));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as BreakpointMap) : {};
  } catch {
    return {};
  }
}

export function saveBreakpoints(root: string, map: BreakpointMap) {
  // Drop files with no breakpoints so the store doesn't accumulate empties.
  const trimmed: BreakpointMap = {};
  for (const [path, list] of Object.entries(map)) if (list.length) trimmed[path] = list;
  localStorage.setItem(KEY(root), JSON.stringify(trimmed));
}

/** The enabled breakpoints for one file, in the shape the DAP adapter expects. */
export function toSourceBreakpoints(list: Breakpoint[]): SourceBreakpoint[] {
  return list
    .filter((b) => b.enabled)
    .map((b) => ({
      line: b.line,
      condition: b.condition?.trim() || undefined,
      hitCondition: b.hitCondition?.trim() || undefined,
      logMessage: b.logMessage?.trim() || undefined,
    }));
}

/** The whole map converted to enabled-only source breakpoints, for `debug_start`. */
export function toSourceMap(map: BreakpointMap): Record<string, SourceBreakpoint[]> {
  const out: Record<string, SourceBreakpoint[]> = {};
  for (const [path, list] of Object.entries(map)) {
    const bps = toSourceBreakpoints(list);
    if (bps.length) out[path] = bps;
  }
  return out;
}

/** Total breakpoint count across all files. */
export function countBreakpoints(map: BreakpointMap): number {
  let n = 0;
  for (const list of Object.values(map)) n += list.length;
  return n;
}
