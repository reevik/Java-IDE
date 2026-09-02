import { invoke } from "@tauri-apps/api/core";
import type {
  AiBackend,
  CargoCommand,
  ProjectInfo,
  ProjectRef,
  Review,
  SearchMatch,
  SourceBreakpoint,
  TreeNode,
} from "./types";

// --- Projects ---

export function listProjects(): Promise<ProjectRef[]> {
  return invoke("list_projects");
}

export function addProject(path: string): Promise<ProjectRef[]> {
  return invoke("add_project", { path });
}

/** Scaffold a new project via `cargo new` under parent/name; returns updated list. */
export function createProject(parent: string, name: string, bin: boolean): Promise<ProjectRef[]> {
  return invoke("create_project", { parent, name, bin });
}

export function removeProject(path: string): Promise<ProjectRef[]> {
  return invoke("remove_project", { path });
}

/** Open a project in a brand-new IDE window. */
export function openProjectWindow(path: string): Promise<void> {
  return invoke("open_project_window", { path });
}

export interface CrateDep {
  name: string;
  version: string;
  kind: "normal" | "dev" | "build";
}
export interface ModuleNode {
  name: string;
  path: string;
  file: string | null;
  inline: boolean;
  children: ModuleNode[];
}
export interface ProjectModules {
  crate_name: string;
  root_file: string | null;
  modules: ModuleNode[];
  deps: CrateDep[];
}

/** The project's Rust module tree plus its crate dependencies. */
export function projectModules(root: string): Promise<ProjectModules> {
  return invoke("project_modules", { root });
}

export interface CodeSymbol {
  name: string;
  /** fn | struct | enum | trait | impl | type | const | static | macro | union */
  kind: string;
  /** 1-based line of the declaration. */
  line: number;
  children: CodeSymbol[];
}

/** Top-level items (fns, structs, …) declared in a Rust file, for the outline. */
export function fileSymbols(path: string): Promise<CodeSymbol[]> {
  return invoke("file_symbols", { path });
}

export interface DepNode {
  name: string;
  version: string;
  dedup: boolean;
  children: DepNode[];
}

/** The transitive dependency tree via `cargo tree` (rejects if cargo is missing). */
export function dependencyTree(root: string): Promise<DepNode[]> {
  return invoke("dependency_tree", { root });
}

export interface CrateHit {
  name: string;
  version: string;
  description: string;
  downloads: number;
}

/** Search crates.io for crates matching the query. */
export function searchCrates(query: string): Promise<CrateHit[]> {
  return invoke("search_crates", { query });
}

/** Add a dependency to the project via `cargo add <name>`; returns cargo's summary. */
export function cargoAdd(root: string, name: string): Promise<string> {
  return invoke("cargo_add", { root, name });
}

export function projectInfo(path: string): Promise<ProjectInfo> {
  return invoke("project_info", { path });
}

// --- Files ---

export function readProjectTree(path: string): Promise<TreeNode[]> {
  return invoke("read_project_tree", { path });
}

export function readFile(path: string): Promise<string> {
  return invoke("read_file", { path });
}

export function writeFile(path: string, contents: string): Promise<void> {
  return invoke("write_file", { path, contents });
}

export function createFile(dir: string, name: string): Promise<string> {
  return invoke("create_file", { dir, name });
}

export function createDir(dir: string, name: string): Promise<string> {
  return invoke("create_dir", { dir, name });
}

/** Create a module. `parentFile` is the parent module's file (a submodule of it);
 *  null/undefined creates a top-level module at the crate root. */
export function createModule(root: string, name: string, parentFile?: string | null): Promise<string> {
  return invoke("create_module", { root, name, parentFile: parentFile ?? null });
}

export function renamePath(from: string, name: string): Promise<string> {
  return invoke("rename_path", { from, name });
}

export function deletePath(path: string): Promise<void> {
  return invoke("delete_path", { path });
}

// --- Cargo ---

/** Starts a cargo command; progress arrives as `cargo:event` events. */
export function cargoRun(
  dir: string,
  command: CargoCommand,
  extra: string[] = [],
  env: Record<string, string> = {},
): Promise<number> {
  return invoke("cargo_run", { dir, command, extra, env });
}

export function cargoCancel(): Promise<void> {
  return invoke("cargo_cancel");
}

// --- Search ---

export function searchInFiles(root: string, query: string, caseSensitive: boolean): Promise<SearchMatch[]> {
  return invoke("search_in_files", { root, query, caseSensitive });
}

/** Current git branch of the project, or null when not a repo. */
export function gitBranch(root: string): Promise<string | null> {
  return invoke("git_branch", { root });
}
export function gitBranches(root: string): Promise<string[]> {
  return invoke("git_branches", { root });
}
export function gitCheckout(root: string, rev: string): Promise<string> {
  return invoke("git_checkout", { root, rev });
}
export function gitCreateBranch(root: string, name: string, start: string): Promise<string> {
  return invoke("git_create_branch", { root, name, start });
}
export function gitCherryPick(root: string, branch: string, hash: string): Promise<string> {
  return invoke("git_cherry_pick", { root, branch, hash });
}
export function gitCherryPickHead(root: string, hash: string): Promise<string> {
  return invoke("git_cherry_pick_head", { root, hash });
}
export function gitRevert(root: string, hash: string): Promise<string> {
  return invoke("git_revert", { root, hash });
}
export function gitReset(root: string, hash: string, mode: "soft" | "mixed" | "hard"): Promise<string> {
  return invoke("git_reset", { root, hash, mode });
}

export interface ChangeMarker {
  /** 1-based, inclusive. */
  start_line: number;
  end_line: number;
  kind: "added" | "modified" | "deleted";
}

/** Per-line git change markers for `text` vs the file's committed (HEAD) version. */
export function gitDiff(root: string, path: string, text: string): Promise<ChangeMarker[]> {
  return invoke("git_diff", { root, path, text });
}

export interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  /** Author time, unix seconds. */
  time: number;
  subject: string;
  /** Decoration refs, e.g. "HEAD -> main", "origin/main", "tag: v1". */
  refs: string[];
}

/** Commit log. `all` walks every branch (for the graph); else follows HEAD. */
export function gitLog(root: string, all: boolean, limit = 200): Promise<GitCommit[]> {
  return invoke("git_log", { root, all, limit });
}

export interface GitChange {
  /** Staged (index) code: M A D R C ? ! or " ". */
  staged: string;
  /** Unstaged (working-tree) code. */
  unstaged: string;
  /** Path relative to the repo root. */
  path: string;
  /** Original path for renames/copies. */
  orig: string | null;
}

/** Pending working-tree/index changes. */
export function gitStatus(root: string): Promise<GitChange[]> {
  return invoke("git_status", { root });
}

export interface GitFileChange {
  /** A M D R C T. */
  status: string;
  /** Path relative to the repo root. */
  path: string;
  orig: string | null;
}

/** The files a single commit changed. */
export function gitCommitFiles(root: string, hash: string): Promise<GitFileChange[]> {
  return invoke("git_commit_files", { root, hash });
}

/** The unified diff a commit applied to one file. */
export function gitFileDiff(root: string, hash: string, path: string): Promise<string> {
  return invoke("git_file_diff", { root, hash, path });
}

/** The working-tree diff (vs HEAD) for one file. */
export function gitWorkingDiff(root: string, path: string): Promise<string> {
  return invoke("git_working_diff", { root, path });
}

/** Discovered test function names, for run-config filter suggestions. */
export function listTests(root: string): Promise<string[]> {
  return invoke("list_tests", { root });
}

/** Stage the given repo-relative paths (`git add`). */
export function gitStage(root: string, paths: string[]): Promise<void> {
  return invoke("git_stage", { root, paths });
}

/** Unstage the given repo-relative paths (`git restore --staged`). */
export function gitUnstage(root: string, paths: string[]): Promise<void> {
  return invoke("git_unstage", { root, paths });
}

/** Commit the currently-staged changes; returns git's summary line. */
export function gitCommit(root: string, message: string): Promise<string> {
  return invoke("git_commit", { root, message });
}

// --- AI ---

export function aiBackend(): Promise<AiBackend> {
  return invoke("ai_backend");
}

export function setLlmApiKey(key: string): Promise<void> {
  return invoke("set_llm_api_key", { key });
}

/** Override the AI model (null → use the default). */
export function setModel(model: string | null): Promise<void> {
  return invoke("set_model", { model });
}

export interface AiSettings {
  backend: AiBackend;
  has_api_key: boolean;
  default_model: string;
  model_override: string | null;
}

export function aiSettings(): Promise<AiSettings> {
  return invoke("ai_settings");
}

export function appVersion(): Promise<string> {
  return invoke("app_version");
}

export interface ToolInfo {
  name: string;
  path: string | null;
  hint: string;
}

export function toolPaths(): Promise<ToolInfo[]> {
  return invoke("tool_paths");
}

/** Set the JDK bin directory the IDE uses (null → auto via PATH). */
export function setToolchainDir(dir: string | null): Promise<void> {
  return invoke("set_toolchain_dir", { dir });
}

export interface ToolchainInfo {
  dir: string | null;
  java: string | null;
  javac: string | null;
  version: string | null;
  vendor: string | null;
  java_home: string | null;
}

export function toolchainInfo(): Promise<ToolchainInfo> {
  return invoke("toolchain_info");
}

/** Review a Rust file; partial output streams via `ai:review-progress`. */
export function reviewCode(path: string, code: string): Promise<Review> {
  return invoke("review_code", { path, code });
}

/** Explain a file/selection; streams via `ai:text-progress`. */
export function explainCode(label: string, code: string): Promise<string> {
  return invoke("explain_code", { label, code });
}

/** Suggest a fix for a compiler error; streams via `ai:text-progress`. */
export function fixError(error: string, code: string): Promise<string> {
  return invoke("fix_error", { error, code });
}

/** Format Java source with google-java-format; returns the formatted text. */
export function formatJava(text: string): Promise<string> {
  return invoke("format_java", { text, edition: null });
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

/** AI Assistant chat turn; grounded in the open file + project. Streams via `ai:chat-progress`. */
export function chatSend(messages: ChatMsg[], context: string | null, root: string | null): Promise<string> {
  return invoke("chat_send", { messages, context, root });
}

/** Agentic chat. `planOnly` → produce a plan (no edits), else edit files directly.
 *  Streams via `ai:chat-progress`. */
export function chatAgent(messages: ChatMsg[], root: string, filePath: string | null, planOnly = false): Promise<string> {
  return invoke("chat_agent", { messages, root, filePath, planOnly });
}

/** Stop the currently running agent (kills the CLI process). */
export function chatCancel(): Promise<void> {
  return invoke("chat_cancel");
}

export interface LspCompletion {
  label: string;
  filter_text: string;
  insert: string;
  /** When true, `insert` is an LSP snippet the editor must expand. */
  snippet: boolean;
  detail: string;
  kind: string;
}

/** Open/update a file in rust-analyzer so it re-checks and pushes diagnostics. */
export function lspSync(root: string, path: string, text: string): Promise<void> {
  return invoke("lsp_sync", { root, path, text });
}

/** Tell rust-analyzer the file was saved, triggering a cargo-check refresh. */
export function lspDidSave(root: string, path: string, text: string): Promise<void> {
  return invoke("lsp_did_save", { root, path, text });
}

export interface Definition {
  path: string;
  /** 0-based, as LSP reports it. */
  line: number;
  character: number;
}

/** The definition site of the symbol at a 0-based position, or null. */
export function lspDefinition(
  root: string,
  path: string,
  text: string,
  line: number,
  character: number,
): Promise<Definition | null> {
  return invoke("lsp_definition", { root, path, text, line, character });
}

/** One text edit within a code action (0-based LSP positions). */
export interface CodeActionEdit {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  newText: string;
}
/** A quick fix / assist for the ⌥⏎ menu; `edits` apply to the current file. */
export interface CodeAction {
  title: string;
  kind: string | null;
  isPreferred: boolean;
  edits: CodeActionEdit[];
}

/** All edits for one file in a rename/workspace edit. */
export interface FileEdit {
  path: string;
  edits: CodeActionEdit[];
}

/** Rename the symbol at a 0-based position project-wide; returns per-file edits. */
export function lspRename(
  root: string,
  path: string,
  text: string,
  line: number,
  character: number,
  newName: string,
): Promise<FileEdit[]> {
  return invoke("lsp_rename", { root, path, text, line, character, newName });
}

/** rust-analyzer code actions (quick fixes + assists) for a 0-based range. */
export function codeAction(
  root: string,
  path: string,
  text: string,
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
): Promise<CodeAction[]> {
  return invoke("code_action", { root, path, text, startLine, startCharacter, endLine, endCharacter });
}

/** One "Find Usages" hit: a location, its source line, and a usage category. */
export interface Reference {
  path: string;
  line: number;
  character: number;
  preview: string;
  /** "decl" | "write" | "read" — best-effort classification. */
  kind: "decl" | "write" | "read";
}

/** All references to the symbol at a 0-based position (includes the declaration). */
export function lspReferences(
  root: string,
  path: string,
  text: string,
  line: number,
  character: number,
): Promise<Reference[]> {
  return invoke("lsp_references", { root, path, text, line, character });
}

/** rust-analyzer hover info (type + docs, as Markdown) at a 0-based position. */
export function lspHover(
  root: string,
  path: string,
  text: string,
  line: number,
  character: number,
): Promise<string | null> {
  return invoke("lsp_hover", { root, path, text, line, character });
}

// --- Debugger (lldb-dap) ---

export interface StackFrame {
  id: number;
  name: string;
  path: string | null;
  line: number;
  column: number;
}
export interface Scope {
  name: string;
  variables_reference: number;
}
export interface Variable {
  name: string;
  value: string;
  type: string | null;
  variables_reference: number;
}
export interface EvalResult {
  result: string;
  variables_reference: number;
}

/** Path to the lldb-dap adapter, or null when the debugger isn't installed. */
export function debuggerAdapter(): Promise<string | null> {
  return invoke("debugger_adapter");
}

/** Build the chosen target and launch it under lldb-dap with the given breakpoints. */
export function debugStart(
  root: string,
  kind: "bin" | "test",
  name: string | null,
  args: string[],
  breakpoints: Record<string, SourceBreakpoint[]>,
): Promise<void> {
  return invoke("debug_start", { root, kind, name, args, breakpoints });
}
export function debugSetBreakpoints(path: string, breakpoints: SourceBreakpoint[]): Promise<void> {
  return invoke("debug_set_breakpoints", { path, breakpoints });
}
export function debugContinue(threadId: number): Promise<void> {
  return invoke("debug_continue", { threadId });
}
export function debugNext(threadId: number): Promise<void> {
  return invoke("debug_next", { threadId });
}
export function debugStepIn(threadId: number): Promise<void> {
  return invoke("debug_step_in", { threadId });
}
export function debugStepOut(threadId: number): Promise<void> {
  return invoke("debug_step_out", { threadId });
}
export function debugPause(threadId: number): Promise<void> {
  return invoke("debug_pause", { threadId });
}
export function debugStack(threadId: number): Promise<StackFrame[]> {
  return invoke("debug_stack", { threadId });
}
export function debugScopes(frameId: number): Promise<Scope[]> {
  return invoke("debug_scopes", { frameId });
}
export function debugVariables(variablesReference: number): Promise<Variable[]> {
  return invoke("debug_variables", { variablesReference });
}
export function debugEval(frameId: number, expr: string): Promise<EvalResult> {
  return invoke("debug_eval", { frameId, expr });
}
export function debugStop(): Promise<void> {
  return invoke("debug_stop");
}

/** rust-analyzer completions at a 0-based line/character in `path`. */
export function lspCompletion(
  root: string,
  path: string,
  text: string,
  line: number,
  character: number,
): Promise<LspCompletion[]> {
  return invoke("lsp_completion", { root, path, text, line, character });
}
