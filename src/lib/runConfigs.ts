import type { CargoCommand } from "./types";

/** An IntelliJ-style run configuration for a project. */
export interface RunConfig {
  id: string;
  name: string;
  /** "run" → run a main class; "test" → run tests. */
  kind: "run" | "test";
  /** For "run": the fully-qualified main class (empty = the project's default). */
  mainClass?: string;
  /** For "test": a filter — `Class` or `Class#method` (empty = all tests). */
  testFilter?: string;
  /** Program args (passed to the program). */
  args: string[];
  /** Environment variables for the process. */
  env: Record<string, string>;
}

const KEY = (root: string) => `runconfigs:${root}`;
const SEL_KEY = (root: string) => `runconfigs.selected:${root}`;

export function loadConfigs(root: string): RunConfig[] {
  try {
    const raw = localStorage.getItem(KEY(root));
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveConfigs(root: string, configs: RunConfig[]) {
  localStorage.setItem(KEY(root), JSON.stringify(configs));
}

export function loadSelectedId(root: string): string | null {
  return localStorage.getItem(SEL_KEY(root));
}

export function saveSelectedId(root: string, id: string) {
  localStorage.setItem(SEL_KEY(root), id);
}

export function newId(): string {
  return `rc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Auto-generate a sensible starter set: one "Run" per discovered main class (or a
 *  blank Run to fill in), plus "All Tests". */
export function defaultConfigs(mains: string[]): RunConfig[] {
  const out: RunConfig[] = mains.map((m) => ({
    id: newId(),
    name: m.split(".").pop() || m,
    kind: "run",
    mainClass: m,
    args: [],
    env: {},
  }));
  if (out.length === 0) out.push({ id: newId(), name: "Run", kind: "run", mainClass: "", args: [], env: {} });
  out.push({ id: newId(), name: "All Tests", kind: "test", testFilter: "", args: [], env: {} });
  return out;
}

/** Translate a run config into semantic flags the backend maps to Maven/Gradle:
 *  `--main <class>`, `--test <filter>`, and program args after `--`. */
export function toCargo(c: RunConfig): { command: CargoCommand; extra: string[]; env: Record<string, string> } {
  const extra: string[] = [];
  if (c.kind === "run") {
    if (c.mainClass && c.mainClass.trim()) extra.push("--main", c.mainClass.trim());
    if (c.args.length) extra.push("--", ...c.args);
    return { command: "run", extra, env: c.env };
  }
  if (c.testFilter && c.testFilter.trim()) extra.push("--test", c.testFilter.trim());
  return { command: "test", extra, env: c.env };
}

/** Split a command-line string into args, honoring single/double quotes. */
export function parseArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** Re-serialize args for display in a single input (quoting ones with spaces). */
export function serializeArgs(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

/** Parse "KEY=VALUE" lines into an env map. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

/** Serialize an env map back to "KEY=VALUE" lines. */
export function serializeEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}
