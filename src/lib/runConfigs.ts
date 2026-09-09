import type { CargoCommand } from "./types";

/** The kind of thing a run configuration launches. */
export type RunType = "application" | "maven" | "gradle" | "junit";

/** An IntelliJ-style, typed run configuration for a project. */
export interface RunConfig {
  id: string;
  name: string;
  type: RunType;
  /** application: the fully-qualified main class (empty = the project's default). */
  mainClass?: string;
  /** maven/gradle: goals/tasks, space-separated (e.g. "clean install", "build test"). */
  goals?: string;
  /** maven: comma-separated profiles activated with `-P`. */
  profiles?: string;
  /** junit: a filter — `Class` or `Class#method` (empty = all tests). */
  testTarget?: string;
  /** application: program arguments passed to the program. */
  args: string[];
  /** Environment variables for the process. */
  env: Record<string, string>;
}

/** Migrate a stored config (older ones used `kind: "run"|"test"`). */
function migrate(c: RunConfig & { kind?: "run" | "test"; testFilter?: string }): RunConfig {
  if (c.type) return c;
  if (c.kind === "test") return { ...c, type: "junit", testTarget: c.testFilter ?? "" };
  return { ...c, type: "application" };
}

const KEY = (root: string) => `runconfigs:${root}`;
const SEL_KEY = (root: string) => `runconfigs.selected:${root}`;

export function loadConfigs(root: string): RunConfig[] {
  try {
    const raw = localStorage.getItem(KEY(root));
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map(migrate) : [];
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

/** A new, empty configuration of the given type. */
export function newConfig(type: RunType): RunConfig {
  const base = { id: newId(), type, args: [], env: {} as Record<string, string> };
  switch (type) {
    case "maven":
      return { ...base, name: "Maven", goals: "clean install", profiles: "" };
    case "gradle":
      return { ...base, name: "Gradle", goals: "build" };
    case "junit":
      return { ...base, name: "All Tests", testTarget: "" };
    default:
      return { ...base, name: "Application", mainClass: "" };
  }
}

/** Auto-generate a starter set: one Application per discovered main class (or a
 *  blank one), plus an "All Tests" JUnit config. */
export function defaultConfigs(mains: string[]): RunConfig[] {
  const out: RunConfig[] = mains.map((m) => ({
    id: newId(),
    name: m.split(".").pop() || m,
    type: "application",
    mainClass: m,
    args: [],
    env: {},
  }));
  if (out.length === 0) out.push(newConfig("application"));
  out.push(newConfig("junit"));
  return out;
}

/** Whether this config runs through the build tool's goals rather than run/test. */
export function isGoalConfig(c: RunConfig): boolean {
  return c.type === "maven" || c.type === "gradle";
}

/** The build-tool goals/tasks for a maven/gradle config (incl. `-P` profiles). */
export function goalsFor(c: RunConfig): string[] {
  const g = parseArgs(c.goals ?? "");
  if (c.type === "maven" && c.profiles && c.profiles.trim()) g.push(`-P${c.profiles.trim()}`);
  return g;
}

/** Translate an application/junit config into the backend's semantic flags:
 *  `--main <class>`, `--test <filter>`, and program args after `--`. */
export function toCargo(c: RunConfig): { command: CargoCommand; extra: string[]; env: Record<string, string> } {
  const extra: string[] = [];
  if (c.type === "junit") {
    if (c.testTarget && c.testTarget.trim()) extra.push("--test", c.testTarget.trim());
    return { command: "test", extra, env: c.env };
  }
  if (c.mainClass && c.mainClass.trim()) extra.push("--main", c.mainClass.trim());
  if (c.args.length) extra.push("--", ...c.args);
  return { command: "run", extra, env: c.env };
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
