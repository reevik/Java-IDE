/** Configurable keymap: standard templates (Default / IntelliJ / NetBeans) plus
 *  per-action custom overrides, with import/export. Shortcuts are stored and
 *  matched by physical key `code` (layout-independent) and modifier flags. */

export interface KeyAction {
  id: string;
  label: string;
  group: string;
}

/** The remappable actions and their groups (labels shown in the Keymap page). */
export const KEY_ACTIONS: KeyAction[] = [
  { id: "file.new-file", label: "New File", group: "File" },
  { id: "file.new-class", label: "New Java Class", group: "File" },
  { id: "file.new-dir", label: "New Folder", group: "File" },
  { id: "file.save", label: "Save", group: "File" },
  { id: "file.close-tab", label: "Close Tab", group: "File" },
  { id: "project.open", label: "Open Project", group: "File" },

  { id: "cargo.build", label: "Build", group: "Build" },
  { id: "cargo.run", label: "Run", group: "Build" },
  { id: "cargo.test", label: "Test", group: "Build" },
  { id: "cargo.clippy", label: "Check", group: "Build" },
  { id: "cargo.check", label: "Code Analysis", group: "Build" },
  { id: "cargo.fmt", label: "Format Project", group: "Build" },
  { id: "cargo.cancel", label: "Stop", group: "Build" },

  { id: "code.reformat", label: "Reformat Code", group: "Code" },
  { id: "code.goto-line", label: "Go to Line", group: "Code" },
  { id: "code.refactor", label: "Refactor This", group: "Code" },

  { id: "debug.start", label: "Start / Continue Debugging", group: "Debug" },
  { id: "debug.step-over", label: "Step Over", group: "Debug" },
  { id: "debug.step-into", label: "Step Into", group: "Debug" },
  { id: "debug.step-out", label: "Step Out", group: "Debug" },
  { id: "debug.stop", label: "Stop Debugging", group: "Debug" },
  { id: "debug.toggle-breakpoint", label: "Toggle Breakpoint", group: "Debug" },

  { id: "view.quickopen", label: "Go to File", group: "View" },
  { id: "view.search", label: "Find in Files", group: "View" },
  { id: "view.palette", label: "Command Palette", group: "View" },
  { id: "view.tree", label: "Toggle Explorer", group: "View" },
  { id: "view.output", label: "Toggle Output", group: "View" },
  { id: "view.ai", label: "Toggle Intelligent Review", group: "View" },
  { id: "view.chat", label: "Toggle AI Assistant", group: "View" },
  { id: "view.skills", label: "Toggle Skills", group: "View" },
  { id: "view.taskboard", label: "Task Board", group: "View" },
  { id: "ai.review", label: "Review File", group: "AI" },
  { id: "ai.explain", label: "Explain Selection / File", group: "AI" },
];

/** The built-in Default keymap (macOS), as display strings. */
const DEFAULT_MAP: Record<string, string> = {
  "file.new-file": "⌘N",
  "file.new-dir": "⌘⇧N",
  "file.save": "⌘S",
  "file.close-tab": "⌘W",
  "project.open": "⌘⇧O",
  "cargo.build": "⌘B",
  "cargo.run": "⌘R",
  "cargo.test": "⌘U",
  "cargo.clippy": "⌘L",
  "cargo.check": "⌘⇧B",
  "cargo.fmt": "⌥⇧F",
  "cargo.cancel": "⌘.",
  "code.reformat": "⌘⌥L",
  "code.goto-line": "⌃G",
  "code.refactor": "⌃T",
  "debug.start": "F5",
  "debug.step-over": "F10",
  "debug.step-into": "F11",
  "debug.step-out": "⇧F11",
  "debug.stop": "⇧F5",
  "debug.toggle-breakpoint": "⌘F8",
  "view.quickopen": "⌘P",
  "view.search": "⌘⇧F",
  "view.palette": "⌘K",
  "view.tree": "⌘⌥1",
  "view.output": "⌘⌥2",
  "view.ai": "⌘⌥3",
  "view.chat": "⌘⌥4",
  "view.skills": "⌘⌥5",
  "ai.review": "⌘⇧A",
  "ai.explain": "⌘⇧E",
};

/** Overrides on top of Default for each template (only what differs). */
const TEMPLATE_OVERRIDES: Record<string, Record<string, string>> = {
  Default: {},
  "IntelliJ IDEA": {
    "cargo.build": "⌘F9",
    "cargo.run": "⌃R",
    "debug.start": "⌃D",
    "cargo.cancel": "⌘F2",
    "code.reformat": "⌘⌥L", // same
  },
  NetBeans: {
    "cargo.build": "F11",
    "cargo.run": "F6",
    "debug.start": "⌘F5",
    "debug.step-over": "F8",
    "debug.step-into": "F7",
    "debug.step-out": "⌘F7",
    "code.reformat": "⌥⇧F",
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATE_OVERRIDES);

// --- shortcut <-> display -----------------------------------------------------

const PUNCT: Record<string, string> = {
  BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/",
  Semicolon: ";", Quote: "'", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
  Enter: "⏎", Space: "␣", Escape: "Esc", Tab: "⇥", Backspace: "⌫",
};
const PUNCT_REV: Record<string, string> = Object.fromEntries(Object.entries(PUNCT).map(([k, v]) => [v, k]));

function codeToDisplay(code: string): string {
  const m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  const d = /^Digit(\d)$/.exec(code);
  if (d) return d[1];
  if (/^F\d+$/.test(code)) return code;
  return PUNCT[code] ?? code;
}
function displayTokenToCode(tok: string): string {
  if (/^[A-Za-z]$/.test(tok)) return `Key${tok.toUpperCase()}`;
  if (/^\d$/.test(tok)) return `Digit${tok}`;
  if (/^F\d+$/.test(tok)) return tok;
  return PUNCT_REV[tok] ?? tok;
}

export interface Shortcut { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; code: string }

/** Canonical id, e.g. "meta+shift+KeyB", for map keys + comparison. */
export function shortcutId(s: Shortcut): string {
  return [s.meta && "meta", s.ctrl && "ctrl", s.alt && "alt", s.shift && "shift", s.code].filter(Boolean).join("+");
}

/** Parse a display string ("⌘⇧B", "⌥⇧F", "F5", "⌘⌥[") into a Shortcut. */
export function parseShortcut(display: string): Shortcut | null {
  if (!display) return null;
  const s: Shortcut = { meta: false, ctrl: false, alt: false, shift: false, code: "" };
  let rest = display;
  for (;;) {
    if (rest.startsWith("⌘")) { s.meta = true; rest = rest.slice(1); }
    else if (rest.startsWith("⌃")) { s.ctrl = true; rest = rest.slice(1); }
    else if (rest.startsWith("⌥")) { s.alt = true; rest = rest.slice(1); }
    else if (rest.startsWith("⇧")) { s.shift = true; rest = rest.slice(1); }
    else break;
  }
  if (!rest) return null;
  s.code = displayTokenToCode(rest);
  return s;
}

export function shortcutToDisplay(s: Shortcut): string {
  return `${s.ctrl ? "⌃" : ""}${s.alt ? "⌥" : ""}${s.shift ? "⇧" : ""}${s.meta ? "⌘" : ""}${codeToDisplay(s.code)}`;
}

/** While the Keymap page is capturing a new shortcut, the global handler stands
 *  down so recording a binding doesn't also run the command. */
let recordingFlag = false;
export function setRecordingKeymap(v: boolean) { recordingFlag = v; }
export function isRecordingKeymap() { return recordingFlag; }

const MOD_CODES = new Set(["MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight"]);

/** A Shortcut from a keydown event (null for a modifier-only press). */
export function shortcutFromEvent(e: KeyboardEvent): Shortcut | null {
  if (MOD_CODES.has(e.code) || !e.code) return null;
  return { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, code: e.code };
}

// --- persistence + resolution -------------------------------------------------

const TEMPLATE_KEY = "keymap.template";
const CUSTOM_KEY = "keymap.custom";

export function loadTemplate(): string {
  const t = localStorage.getItem(TEMPLATE_KEY);
  return t && TEMPLATE_NAMES.includes(t) ? t : "Default";
}
export function saveTemplate(name: string) { localStorage.setItem(TEMPLATE_KEY, name); }

/** Per-action custom overrides: display string, or "" for an explicitly-unbound action. */
export function loadCustom(): Record<string, string> {
  try { const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
export function saveCustom(map: Record<string, string>) { localStorage.setItem(CUSTOM_KEY, JSON.stringify(map)); }

/** The resolved display string for one action under the current config. */
export function resolvedDisplay(id: string, template = loadTemplate(), custom = loadCustom()): string {
  if (id in custom) return custom[id];
  const t = TEMPLATE_OVERRIDES[template] ?? {};
  return t[id] ?? DEFAULT_MAP[id] ?? "";
}

/** All resolved bindings as { actionId: display }. */
export function resolvedBindings(template = loadTemplate(), custom = loadCustom()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of KEY_ACTIONS) out[a.id] = resolvedDisplay(a.id, template, custom);
  return out;
}

/** Map of shortcutId → actionId, for the runtime handler (skips unbound). */
export function bindingIndex(template = loadTemplate(), custom = loadCustom()): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const a of KEY_ACTIONS) {
    const s = parseShortcut(resolvedDisplay(a.id, template, custom));
    if (s) idx[shortcutId(s)] = a.id;
  }
  return idx;
}

// --- import / export ----------------------------------------------------------

export function exportKeymap(): string {
  return JSON.stringify({ version: 1, template: loadTemplate(), bindings: resolvedBindings() }, null, 2);
}

/** Import a keymap file: sets the template (if named) and stores its bindings as
 *  custom overrides. Returns an error message, or null on success. */
export function importKeymap(text: string): string | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return "Not valid JSON."; }
  const obj = data as { template?: string; bindings?: Record<string, string> };
  if (!obj || typeof obj !== "object" || !obj.bindings || typeof obj.bindings !== "object") {
    return "Missing a \"bindings\" object.";
  }
  const known = new Set(KEY_ACTIONS.map((a) => a.id));
  const custom: Record<string, string> = {};
  for (const [id, disp] of Object.entries(obj.bindings)) {
    if (known.has(id) && typeof disp === "string") custom[id] = disp;
  }
  if (obj.template && TEMPLATE_NAMES.includes(obj.template)) saveTemplate(obj.template);
  saveCustom(custom);
  return null;
}
