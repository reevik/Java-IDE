export interface ProjectRef {
  path: string;
  name: string;
}

export interface ProjectInfo {
  path: string;
  name: string;
  version: string;
  /** Java language level, e.g. "17" (may be ""). */
  edition: string;
  /** True for a multi-module Maven/Gradle build. */
  is_workspace: boolean;
  /** Sub-module names of a multi-module build. */
  members: string[];
  /** Fully-qualified classes with a `public static void main` — run/debug targets. */
  bins: string[];
  /** True when the project has a `src/main/java` source root. */
  has_lib: boolean;
}

export type JavaKind = "class" | "interface" | "enum" | "record" | "annotation";

export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children: TreeNode[] | null;
  /** For `.java` files: the declared top-level type, for a type-specific icon. */
  javaKind?: JavaKind;
}

/** One compiler message, flattened for the Problems list. */
export interface Diagnostic {
  level: string;
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
  code: string | null;
  rendered: string | null;
}

/** Streamed from the cargo runner. */
export type CargoEvent =
  | { type: "line"; stream: "stdout" | "stderr"; text: string }
  | { type: "diagnostic"; diagnostic: Diagnostic }
  | { type: "finished"; code: number; secs: number };

export type CargoCommand = "build" | "run" | "test" | "clippy" | "check" | "fmt";

/** rust-analyzer diagnostic (0-based ranges), pushed via publishDiagnostics. */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** 1 = error, 2 = warning, 3 = info, 4 = hint. */
  severity?: number;
  message: string;
  code?: string | number | { value: string };
}

export interface LspDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

/** One text-search hit from Find in Files. */
export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  /** The matching line, left-trimmed for display. */
  text: string;
  /** Char offset + length of the match within `text` (for highlighting). */
  match_start: number;
  match_len: number;
}

export type AiBackend = "cli" | "api" | "none";

/** One applyable refactoring/fix from the AI review. */
export interface Suggestion {
  /** refactor | bug | idiom | perf | style | docs */
  kind: string;
  title: string;
  detail: string;
  original: string;
  replacement: string;
}

export interface Quality {
  score: number;
  verdict: string;
  correctness: number;
  idiomatic: number;
  clarity: number;
  error_handling: number;
}

export interface Review {
  quality: Quality | null;
  summary: string;
  suggestions: Suggestion[];
}

/** A source breakpoint. `line` is 1-based. Empty/undefined condition fields mean
 *  "unconditional". A disabled breakpoint is kept (and listed) but not sent to the
 *  debugger. */
export interface Breakpoint {
  line: number;
  enabled: boolean;
  /** Stop only when this expression is true (DAP `condition`). */
  condition?: string;
  /** Stop only from the Nth hit, e.g. ">=3" or "5" (DAP `hitCondition`). */
  hitCondition?: string;
  /** Logpoint: print this message (with {expr} interpolation) instead of stopping. */
  logMessage?: string;
}

/** The enabled-only shape sent to the DAP adapter. */
export interface SourceBreakpoint {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export type SaveState = "saved" | "dirty" | "saving" | "error";

/** One open file, kept as a buffer so unsaved edits survive tab switches. */
export interface OpenFile {
  path: string;
  name: string;
  content: string;
  saveState: SaveState;
  loading: boolean;
  /** Bumped to force the uncontrolled editor to remount with new text. */
  rev: number;
  /** True for dependency/std files opened via Go to Definition — not editable. */
  readOnly?: boolean;
  /** "diff" tabs render a read-only unified diff instead of the code editor. */
  kind?: "file" | "diff";
}
