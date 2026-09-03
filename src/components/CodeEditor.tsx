import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorState, StateEffect, StateField, RangeSet, Compartment, type Text } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  hoverTooltip,
  tooltips,
  gutter,
  GutterMarker,
  Decoration,
  WidgetType,
  ViewPlugin,
  type ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";
import { lintGutter, linter, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { QuickSearchPanel } from "./QuickSearchPanel";
import { EDITOR_THEMES, loadEditorTheme } from "../lib/editorThemes";
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
  ensureSyntaxTree,
  indentUnit,
  bracketMatching,
  StreamLanguage,
  foldGutter,
  codeFolding,
  foldKeymap,
  foldAll,
  unfoldAll,
  foldCode,
  unfoldCode,
} from "@codemirror/language";
import { java } from "@codemirror/lang-java";
import { xml } from "@codemirror/lang-xml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import {
  autocompletion,
  completionKeymap,
  snippet,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { codeAction, gitDiff, gitStageFile, lspCompletion, lspDefinition, lspHover, lspReferences, lspRename, type CodeAction, type FileEdit, type Reference } from "../lib/api";
import type { ChangeMarker } from "../lib/api";
import type { Breakpoint, LspDiagnostic } from "../lib/types";

// IntelliJ-style: hover info + go-to-definition link only while ⌘ (Meta) is held.
// Meta only — NOT Control, which on macOS is the right-click (Ctrl-click) gesture.
// Tracked globally since the CodeMirror hover source runs outside React.
let metaHeld = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key === "Meta") metaHeld = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Meta") metaHeld = false;
  });
  window.addEventListener("blur", () => (metaHeld = false));
}

/**
 * Minimal Markdown → HTML for rust-analyzer hovers, which are a ```rust code
 * fence (the signature) followed by doc prose. Full parsing isn't worth a
 * dependency here; we handle fences, inline code, bold, and paragraphs.
 */
function renderHoverHtml(md: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const parts = md.split(/```/);
  return parts
    .map((seg, i) => {
      if (i % 2 === 1) {
        // Inside a fence: drop an optional language tag on the first line.
        const body = seg.replace(/^[a-zA-Z]*\n/, "");
        return `<pre class="cm-hover-code">${esc(body.trim())}</pre>`;
      }
      const prose = esc(seg.trim());
      if (!prose) return "";
      return prose
        .split(/\n{2,}/)
        .map(
          (p) =>
            `<p>${p
              .replace(/`([^`]+)`/g, "<code>$1</code>")
              .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
              .replace(/\n/g, "<br>")}</p>`,
        )
        .join("");
    })
    .join("");
}

/**
 * While ⌘ is held, underline the identifier under the mouse (pointer cursor), and
 * ⌘-click jumps to its definition — the IntelliJ/VS Code navigation gesture.
 */
// --- Git change bars (IntelliJ-style gutter markers) -----------------------

const setChangeBars = StateEffect.define<ChangeMarker[]>();

class ChangeBarMarker extends GutterMarker {
  constructor(readonly kind: string) {
    super();
  }
  eq(other: ChangeBarMarker) {
    return other.kind === this.kind;
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = `cm-change-bar cm-change-${this.kind}`;
    return d;
  }
}

/** Build a gutter marker set from backend line ranges, anchored to line starts. */
function buildBarSet(bars: ChangeMarker[], doc: Text): RangeSet<GutterMarker> {
  const ranges = [];
  for (const b of bars) {
    for (let ln = b.start_line; ln <= b.end_line; ln++) {
      if (ln < 1 || ln > doc.lines) continue;
      ranges.push(new ChangeBarMarker(b.kind).range(doc.line(ln).from));
    }
  }
  return RangeSet.of(ranges, true);
}

/**
 * The markers are kept as a position-anchored RangeSet and mapped through every
 * edit, so they stay glued to their lines while you type — the debounced diff
 * only refreshes them, it doesn't drive their placement (which would lag by one
 * line the moment you insert a line).
 */
const changeBarsField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setChangeBars)) return buildBarSet(e.value, tr.state.doc);
    return value;
  },
});

/** The raw hunk data (kept alongside the gutter markers) so a click can look up
 *  the hunk's kind + committed text. Line numbers refresh with each diff. */
const changeMarkersData = StateField.define<ChangeMarker[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setChangeBars)) return e.value;
    return value;
  },
});

/** Clicking a change bar opens a peek of the hunk (via the onPeek bridge). */
function changeBarGutter(onPeek: (m: ChangeMarker, newText: string, top: number, left: number) => void) {
  return gutter({
    class: "cm-change-gutter",
    markers: (view) => view.state.field(changeBarsField),
    domEventHandlers: {
      mousedown(view, line, event) {
        const e = event as MouseEvent;
        if (e.button !== 0) return false;
        const lineNo = view.state.doc.lineAt(line.from).number;
        const hit = view.state.field(changeMarkersData).find((m) => lineNo >= m.start_line && lineNo <= m.end_line);
        if (!hit) return false;
        e.preventDefault();
        const doc = view.state.doc;
        const newText =
          hit.kind === "deleted"
            ? ""
            : doc.sliceString(doc.line(hit.start_line).from, doc.line(Math.min(hit.end_line, doc.lines)).to);
        const top = view.coordsAtPos(doc.line(hit.start_line).from)?.top ?? e.clientY;
        onPeek(hit, newText, top, e.clientX);
        return true;
      },
    },
  });
}

/** Revert a hunk to its committed (HEAD) text, in-buffer (no git write). */
function revertHunk(view: EditorView, m: ChangeMarker) {
  const doc = view.state.doc;
  const s = Math.min(Math.max(m.start_line, 1), doc.lines);
  const e = Math.min(Math.max(m.end_line, 1), doc.lines);
  if (m.kind === "added") {
    // Remove the added lines (and one adjoining newline so no blank line lingers).
    const from = e < doc.lines ? doc.line(s).from : s > 1 ? doc.line(s - 1).to : doc.line(s).from;
    const to = e < doc.lines ? doc.line(e + 1).from : doc.line(e).to;
    view.dispatch({ changes: { from, to, insert: "" }, scrollIntoView: true });
  } else if (m.kind === "modified") {
    view.dispatch({ changes: { from: doc.line(s).from, to: doc.line(e).to, insert: m.old_text }, scrollIntoView: true });
  } else {
    // Deleted: re-insert the removed lines at the anchor.
    const at = doc.line(s).from;
    view.dispatch({ changes: { from: at, to: at, insert: `${m.old_text}\n` }, scrollIntoView: true });
  }
}

/** Debounced diff of the live buffer vs HEAD, pushed into `changeBarsField`. */
function gitChangeBars(root: string, path: string) {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {
        this.schedule(0);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(120);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.compute(), delay);
      }
      compute() {
        // Capture the exact doc the diff runs against. `gitDiff` is async (IPC +
        // git), and the returned markers are line numbers valid only for this doc.
        // If the buffer changed meanwhile, applying them would shift every marker by
        // the line delta — so discard and let the edit's own re-schedule catch up.
        const doc = this.view.state.doc;
        gitDiff(root, path, doc.toString())
          .then((bars) => {
            if (this.view.state.doc === doc) {
              this.view.dispatch({ effects: setChangeBars.of(bars) });
            }
          })
          .catch(() => {});
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
}

// --- Debugger: breakpoint gutter + current-line highlight ------------------

const setBreakpoints = StateEffect.define<Breakpoint[]>();

class BreakpointMarker extends GutterMarker {
  constructor(readonly bp: Breakpoint) {
    super();
  }
  toDOM() {
    const d = document.createElement("div");
    const conditional = !!(this.bp.condition || this.bp.hitCondition || this.bp.logMessage);
    d.className =
      "cm-breakpoint" +
      (this.bp.enabled ? "" : " cm-breakpoint-disabled") +
      (conditional ? " cm-breakpoint-conditional" : "");
    if (conditional) {
      const parts = [
        this.bp.condition && `if ${this.bp.condition}`,
        this.bp.hitCondition && `hits ${this.bp.hitCondition}`,
        this.bp.logMessage && "log",
      ].filter(Boolean);
      d.title = parts.join(" · ");
    }
    return d;
  }
}
// A stable spacer marker so the gutter reserves its width even when empty.
const breakpointSpacer = new BreakpointMarker({ line: 0, enabled: true });

function buildBreakpointSet(bps: Breakpoint[], doc: Text): RangeSet<GutterMarker> {
  const ranges = [];
  for (const bp of [...bps].sort((a, b) => a.line - b.line)) {
    if (bp.line >= 1 && bp.line <= doc.lines) ranges.push(new BreakpointMarker(bp).range(doc.line(bp.line).from));
  }
  return RangeSet.of(ranges, true);
}

/** Red-dot breakpoints, owned by App and pushed via `setBreakpoints`. */
const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBreakpoints)) return buildBreakpointSet(e.value, tr.state.doc);
    return value.map(tr.changes);
  },
});

/** Gutter left of the line numbers; clicking a row toggles its breakpoint. */
function breakpointGutter(onToggle: (line: number) => void) {
  return gutter({
    class: "cm-breakpoint-gutter",
    markers: (v) => v.state.field(breakpointField),
    initialSpacer: () => breakpointSpacer,
    domEventHandlers: {
      mousedown(view, line) {
        onToggle(view.state.doc.lineAt(line.from).number);
        return true;
      },
    },
  });
}

// --- Run gutter: IntelliJ-style ▶ markers next to runnable functions --------

/** A runnable item discovered in the source: a `main` method or a `@Test` method. */
export interface Runnable {
  kind: "run" | "test";
  /** For "run": the fully-qualified main class. For "test": `Class` (whole class)
   *  or `Class#method` (single method). Used as the run-config name/target. */
  name: string;
}

const TEST_ANNOT = /@(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;
const CLASS_DECL = /^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+|strictfp\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/;
// A method declaration: optional annotations + modifiers + return type, then the
// method name right before `(`.
const METHOD_DECL = /^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public|protected|private|static|final|default|synchronized|abstract|native|strictfp|\s)*[\w.$<>\[\],\s]*?\b([A-Za-z_]\w*)\s*\(/;

/** Scan Java source for runnable members: a `public static void main` (→ run the
 *  enclosing class) and JUnit `@Test` methods (→ run `Class#method`), plus a
 *  class-level marker to run every test in the class. Returns 1-based lines. */
function scanRunnables(doc: Text): { line: number; run: Runnable }[] {
  const out: { line: number; run: Runnable }[] = [];

  // Package + primary (first) top-level type give us the FQ class name.
  let pkg = "";
  let primaryClass = "";
  let classDeclLine = 0;
  for (let i = 1; i <= doc.lines; i++) {
    const t = doc.line(i).text;
    if (!pkg) {
      const pm = /^\s*package\s+([\w.]+)\s*;/.exec(t);
      if (pm) pkg = pm[1];
    }
    if (!primaryClass) {
      const cm = CLASS_DECL.exec(t);
      if (cm) { primaryClass = cm[1]; classDeclLine = i; }
    }
    if (pkg && primaryClass) break;
  }
  const fqn = pkg && primaryClass ? `${pkg}.${primaryClass}` : primaryClass;

  let hasTest = false;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i).text;

    // `public static void main(String[] args)` — the entry point.
    if (/\bstatic\b/.test(line) && /\bvoid\b/.test(line) && /\bmain\s*\(/.test(line) && /String/.test(line)) {
      out.push({ line: i, run: { kind: "run", name: fqn || "main" } });
      continue;
    }

    // A `@Test` method: annotation on this line or the contiguous lines above.
    const mm = METHOD_DECL.exec(line);
    if (!mm) continue;
    const method = mm[1];
    if (method === "main" || /\b(if|for|while|switch|catch|return|new)\b/.test(method)) continue;
    let isTest = TEST_ANNOT.test(line);
    if (!isTest) {
      for (let j = i - 1; j >= 1; j--) {
        const s = doc.line(j).text.trim();
        if (s === "") continue;
        if (s.startsWith("@")) { if (TEST_ANNOT.test(s)) { isTest = true; break; } continue; }
        if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) continue;
        break; // real code above — stop scanning
      }
    }
    if (isTest) {
      hasTest = true;
      out.push({ line: i, run: { kind: "test", name: `${primaryClass}#${method}` } });
    }
  }

  // A single ▶ on the class declaration to run all of its tests.
  if (hasTest && classDeclLine > 0) {
    out.unshift({ line: classDeclLine, run: { kind: "test", name: primaryClass } });
  }
  return out;
}

class RunMarker extends GutterMarker {
  constructor(readonly run: Runnable) {
    super();
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = "cm-run-marker";
    d.title = this.run.kind === "test" ? `Run test \`${this.run.name}\`` : `Run \`${this.run.name}\``;
    return d;
  }
}

function buildRunnableSet(doc: Text): RangeSet<GutterMarker> {
  const ranges = scanRunnables(doc).map((r) => new RunMarker(r.run).range(doc.line(r.line).from));
  return RangeSet.of(ranges, true);
}

/** Recomputed on every doc change; renders the ▶ markers. */
const runnablesField = StateField.define<RangeSet<GutterMarker>>({
  create: (state) => buildRunnableSet(state.doc),
  update(value, tr) {
    return tr.docChanged ? buildRunnableSet(tr.state.doc) : value;
  },
});

/** Gutter (left-most) with a green ▶ on each runnable fn; click runs it. */
function runGutter(onRun: (run: Runnable) => void) {
  return gutter({
    class: "cm-run-gutter",
    markers: (v) => v.state.field(runnablesField),
    domEventHandlers: {
      mousedown(view, line, event) {
        let hit: Runnable | null = null;
        view.state.field(runnablesField).between(line.from, line.from, (_f, _t, m) => {
          hit = (m as RunMarker).run;
          return false;
        });
        if (!hit) return false;
        onRun(hit);
        (event as Event).preventDefault();
        return true;
      },
    },
  });
}

const setStopLine = StateEffect.define<number | null>(); // 1-based, or null to clear
const stopLineDeco = Decoration.line({ class: "cm-stop-line" });

/** Highlights the line the debugger is paused on. */
const stopLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setStopLine)) {
        if (e.value == null) return Decoration.none;
        const ln = Math.min(Math.max(e.value, 1), tr.state.doc.lines);
        return Decoration.set([stopLineDeco.range(tr.state.doc.line(ln).from)]);
      }
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- Inline diagnostics (Error Lens): message at the end of the line ---------

class InlineDiagWidget extends WidgetType {
  constructor(readonly message: string, readonly severity: number) {
    super();
  }
  eq(o: InlineDiagWidget) {
    return o.message === this.message && o.severity === this.severity;
  }
  toDOM() {
    const span = document.createElement("span");
    const tone = this.severity === 1 ? "cm-inline-error" : this.severity === 2 ? "cm-inline-warn" : "cm-inline-info";
    span.className = `cm-inline-diag ${tone}`;
    span.textContent = this.message.split("\n")[0]; // first line only
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

const severityRank = (s?: number) => s ?? 1; // 1=error … 4=hint (lower = more severe)

const setInlineDiags = StateEffect.define<DecorationSet>();
const inlineDiagField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setInlineDiags)) return e.value;
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** One end-of-line message per line (the most severe diagnostic on it). */
function buildInlineDiags(doc: Text, diags: LspDiagnostic[]): DecorationSet {
  const byLine = new Map<number, LspDiagnostic>();
  for (const d of diags) {
    const cur = byLine.get(d.range.start.line);
    if (!cur || severityRank(d.severity) < severityRank(cur.severity)) byLine.set(d.range.start.line, d);
  }
  const ranges = [];
  for (const [line0, d] of byLine) {
    const ln = line0 + 1;
    if (ln < 1 || ln > doc.lines) continue;
    ranges.push(
      Decoration.widget({ widget: new InlineDiagWidget(d.message, d.severity ?? 1), side: 1 }).range(doc.line(ln).to),
    );
  }
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges);
}

// --- XML well-formedness diagnostics ----------------------------------------
// XML has no language server, so we derive diagnostics from lang-xml's parse
// tree (error nodes = malformed markup / mismatched tags) and feed them through
// the same lint + inline-Error-Lens pipeline Java uses.

function xmlDiagnostics(view: EditorView): LspDiagnostic[] {
  const state = view.state;
  const doc = state.doc;
  // Force a full parse so errors near the end aren't missed on first paint.
  const tree = ensureSyntaxTree(state, doc.length, 2000) ?? syntaxTree(state);
  const out: LspDiagnostic[] = [];
  const seen = new Set<string>();
  tree.cursor().iterate((node) => {
    // Lezer marks unclosed tags / stray characters as error nodes, and a
    // wrong closing name as a dedicated `MismatchedCloseTag` (not an error node).
    // `MissingCloseTag` only ever co-occurs with a mismatch, so we skip it to
    // avoid flagging the same mistake twice.
    const isError = node.type.isError;
    const mismatched = node.name === "MismatchedCloseTag";
    if (!isError && !mismatched) return;

    let from = node.from;
    let to = node.to;
    if (to <= from) {
      // Zero-length error node → mark one character (or the char before EOF).
      if (from < doc.length) to = from + 1;
      else from = Math.max(0, from - 1);
    }
    const key = `${from}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    const s = doc.lineAt(from);
    const e = doc.lineAt(to);
    const message = mismatched
      ? `XML: mismatched closing tag ${doc.sliceString(from, to)}`
      : "XML: syntax error — check for an unclosed tag or invalid character.";
    out.push({
      range: {
        start: { line: s.number - 1, character: from - s.from },
        end: { line: e.number - 1, character: to - e.from },
      },
      severity: 1,
      message,
    });
  });
  return out;
}

/** A @codemirror/lint source: red squiggle + gutter marker + hover for XML. */
const xmlLinter = linter((view) => toCmDiagnostics(view, xmlDiagnostics(view)), { delay: 300 });

/** Error-Lens: the message at the end of the offending line (matches Java). */
const xmlInlineDiagPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInlineDiags(view.state.doc, xmlDiagnostics(view));
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = buildInlineDiags(u.view.state.doc, xmlDiagnostics(u.view));
    }
  },
  { decorations: (v) => v.decorations },
);

// --- Java .properties: highlighting + validation ----------------------------

// Per-language token map so keys/values/sections get styled without touching
// the global highlight style. The mode tags keys as "def", a built-in name the
// tokenTable can't override, so rename it to a custom token first.
const propertiesLang = StreamLanguage.define({
  ...properties,
  token(stream, state) {
    const tok = properties.token(stream, state);
    return tok === "def" ? "propertyDef" : tok;
  },
  tokenTable: { propertyDef: t.typeName, quote: t.string, header: t.keyword },
});

/** The key (before the first unescaped `=`, `:` or space); leading space skipped. */
function propertyKey(text: string): { key: string; start: number } {
  let i = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  const start = i;
  let key = "";
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { key += c + (text[i + 1] ?? ""); i++; continue; }
    if (c === "=" || c === ":" || c === " " || c === "\t") break;
    key += c;
  }
  return { key, start };
}

/** Validate a .properties file: bad `\u` escapes (error) + duplicate keys (warning). */
function propertiesDiagnostics(view: EditorView): LspDiagnostic[] {
  const doc = view.state.doc;
  const out: LspDiagnostic[] = [];
  const seen = new Set<string>();
  let continuation = false; // previous logical line continued via a trailing "\"
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const wasContinuation = continuation;
    const trailing = /(\\*)$/.exec(text)?.[1].length ?? 0;
    continuation = trailing % 2 === 1;

    // Malformed unicode escapes anywhere on the line.
    const badU = /\\u(?![0-9a-fA-F]{4})/g;
    let m: RegExpExecArray | null;
    while ((m = badU.exec(text)) !== null) {
      out.push({
        range: { start: { line: i - 1, character: m.index }, end: { line: i - 1, character: m.index + 2 } },
        severity: 1,
        message: "Properties: invalid \\u escape — expected 4 hex digits.",
      });
    }

    if (wasContinuation) continue; // a wrapped value, not a key line
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed === "" || /^[#!;]/.test(trimmed)) continue; // blank or comment

    const { key, start } = propertyKey(text);
    if (!key) continue;
    if (seen.has(key)) {
      out.push({
        range: { start: { line: i - 1, character: start }, end: { line: i - 1, character: start + key.length } },
        severity: 2,
        message: `Properties: duplicate key '${key}' — the last value wins.`,
      });
    } else {
      seen.add(key);
    }
  }
  return out;
}

const propertiesLinter = linter((view) => toCmDiagnostics(view, propertiesDiagnostics(view)), { delay: 300 });

const propertiesInlineDiagPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInlineDiags(view.state.doc, propertiesDiagnostics(view));
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = buildInlineDiags(u.view.state.doc, propertiesDiagnostics(u.view));
    }
  },
  { decorations: (v) => v.decorations },
);

// --- Collaborative agent editing: highlight the agent's edits + a "You" caret ---

const setAgentEdit = StateEffect.define<{ from: number; to: number }>();
const clearAgentEdit = StateEffect.define<null>();
const agentEditLine = Decoration.line({ class: "cm-agent-edit" });

/** Green line-highlight over the range the agent just wrote (cleared after a beat). */
const agentEditField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearAgentEdit)) return Decoration.none;
      if (e.is(setAgentEdit)) {
        const doc = tr.state.doc;
        const from = Math.min(Math.max(e.value.from, 0), doc.length);
        const to = Math.min(Math.max(e.value.to, from), doc.length);
        const first = doc.lineAt(from).number;
        const last = doc.lineAt(to).number;
        const ranges = [];
        for (let ln = first; ln <= last; ln++) ranges.push(agentEditLine.range(doc.line(ln).from));
        return Decoration.set(ranges);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const setYouActive = StateEffect.define<boolean>();
/** Whether the agent is active — drives the "You" caret label. */
const youActiveField = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setYouActive)) return e.value;
    return v;
  },
});

class YouLabelWidget extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-you-label";
    s.textContent = "You";
    return s;
  }
  ignoreEvent() {
    return true;
  }
}

/** While the agent is active, tag the user's caret with a "You" label. */
const youLabelPlugin = ViewPlugin.fromClass(
  class {
    deco: DecorationSet = Decoration.none;
    constructor(view: EditorView) {
      this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setYouActive)))) {
        this.build(u.view);
      }
    }
    build(view: EditorView) {
      if (!view.state.field(youActiveField)) {
        this.deco = Decoration.none;
        return;
      }
      const head = view.state.selection.main.head;
      this.deco = Decoration.set([Decoration.widget({ widget: new YouLabelWidget(), side: 1 }).range(head)]);
    }
  },
  { decorations: (p) => p.deco },
);

function cmdLinkExtension(root: string, path: string, onGoToDefinition: (p: string, line: number, col: number) => void) {
  return ViewPlugin.fromClass(
  class {
    deco: DecorationSet = Decoration.none;
    from = -1;
    to = -1;
    lastX = -1;
    lastY = -1;
    onKey = () => this.refresh();

    constructor(readonly view: EditorView) {
      window.addEventListener("keydown", this.onKey);
      window.addEventListener("keyup", this.onKey);
    }

    refresh() {
      if (!metaHeld || this.lastX < 0) return this.clear();
      const pos = this.view.posAtCoords({ x: this.lastX, y: this.lastY });
      if (pos == null) return this.clear();
      const w = this.view.state.wordAt(pos);
      if (!w) return this.clear();
      if (w.from === this.from && w.to === this.to) return;
      this.from = w.from;
      this.to = w.to;
      this.deco = Decoration.set([Decoration.mark({ class: "cm-cmd-link" }).range(w.from, w.to)]);
      this.view.dispatch({});
    }

    clear() {
      if (this.from === -1) return;
      this.from = this.to = -1;
      this.deco = Decoration.none;
      this.view.dispatch({});
    }

    destroy() {
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener("keyup", this.onKey);
    }
  },
  {
    decorations: (v) => v.deco,
    eventHandlers: {
      mousemove(e: MouseEvent) {
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.refresh();
      },
      mouseleave() {
        this.lastX = this.lastY = -1;
        this.clear();
      },
      mousedown(e: MouseEvent) {
        // ⌘-click only. Ignore Ctrl-click (that's the macOS right-click gesture).
        if (!metaHeld || e.button !== 0 || e.ctrlKey) return;
        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return;
        const w = this.view.state.wordAt(pos);
        if (!w) return;
        // Stop the click from just moving the caret; go to the definition instead.
        e.preventDefault();
        const line = this.view.state.doc.lineAt(pos);
        lspDefinition(root, path, this.view.state.doc.toString(), line.number - 1, pos - line.from)
          .then((d) => {
            console.debug("[goto-def]", w && this.view.state.sliceDoc(w.from, w.to), "→", d);
            if (d) onGoToDefinition(d.path, d.line + 1, d.character + 1); // → 1-based
          })
          .catch((err) => console.debug("[goto-def] error", err));
      },
    },
  },
  );
}

/** rust-analyzer hover, shown only while ⌘ is held (IntelliJ style). */
function rustAnalyzerHover(root: string, path: string) {
  return hoverTooltip(async (view, pos) => {
    if (!metaHeld) return null;
    const line = view.state.doc.lineAt(pos);
    try {
      const md = await lspHover(root, path, view.state.doc.toString(), line.number - 1, pos - line.from);
      if (!md) return null;
      return {
        pos,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "cm-hover-card";
          dom.innerHTML = renderHoverHtml(md);
          return { dom };
        },
      };
    } catch {
      return null;
    }
  }, { hoverTime: 120 });
}

interface Props {
  initial: string;
  path: string;
  /** Project root, for the rust-analyzer session. */
  root: string;
  onChange: (text: string) => void;
  onSave: () => void;
  /** The current selection, "" when the cursor is a caret. */
  onSelection?: (text: string) => void;
  /** Report the 1-based cursor line/column for the status bar. */
  onCursor?: (line: number, col: number) => void;
  /** rust-analyzer diagnostics for this file — shown as underlines + hover. */
  diagnostics: LspDiagnostic[];
  /** Read-only (a dependency/std file opened via Go to Definition). */
  readOnly?: boolean;
  /** ⌘-click on a symbol: jump to its definition (1-based line/col). */
  onGoToDefinition?: (path: string, line: number, column: number) => void;
  /** Breakpoint lines (1-based) for this file. */
  breakpoints?: Breakpoint[];
  /** Toggle a breakpoint on `line` (1-based) — a click in the breakpoint gutter. */
  onToggleBreakpoint?: (line: number) => void;
  /** The line (1-based) the debugger is paused on in this file, or null. */
  stopLine?: number | null;
  /** "Explain" a diagnostic (message + surrounding source) via the AI chat. */
  onExplainDiagnostic?: (message: string, snippet: string) => void;
  /** Run a function via its ▶ gutter marker (creates a run config + executes). */
  onRunSymbol?: (run: Runnable) => void;
  /** Show "Find Usages" results for `symbol` in the Usages panel. */
  onFindUsages?: (symbol: string, refs: Reference[]) => void;
  /** Apply a project-wide rename's per-file edits (across open buffers + disk). */
  onRename?: (edits: FileEdit[]) => void;
  /** The AI agent is running — show the "You" caret label (collaborative mode). */
  agentActive?: boolean;
  /** Called after the gutter peek stages the file, so the Git panel can refresh. */
  onStaged?: () => void;
}

/** Convert rust-analyzer's 0-based diagnostics into CodeMirror lint diagnostics. */
function toCmDiagnostics(
  view: EditorView,
  diags: LspDiagnostic[],
  onExplain?: (message: string, snippet: string) => void,
): CmDiagnostic[] {
  const doc = view.state.doc;
  const pos = (p: { line: number; character: number }) => {
    const line = doc.line(Math.min(Math.max(p.line + 1, 1), doc.lines));
    return Math.min(line.from + p.character, line.to);
  };
  const codeStr = (c: LspDiagnostic["code"]) =>
    c == null ? undefined : typeof c === "object" ? c.value : String(c);
  return diags.map((d) => {
    const from = pos(d.range.start);
    const to = Math.max(from, pos(d.range.end));
    const cm: CmDiagnostic = {
      from,
      to,
      severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
      message: d.message,
      source: codeStr(d.code),
      // rust-analyzer messages use markdown (backtick code, **bold**, fenced
      // blocks); render them instead of showing the raw formatting characters.
      renderMessage: () => {
        const el = document.createElement("div");
        el.className = "cm-diagnostic-md";
        el.innerHTML = renderHoverHtml(d.message);
        return el;
      },
    };
    if (onExplain) {
      cm.actions = [
        {
          name: "Explain",
          apply: (v, aFrom, aTo) => {
            // Send the surrounding line(s) as context for the explanation.
            const startLine = v.state.doc.lineAt(aFrom);
            const endLine = v.state.doc.lineAt(Math.max(aFrom, aTo));
            onExplain(d.message, v.state.sliceDoc(startLine.from, endLine.to));
          },
        },
      ];
    }
    return cm;
  });
}

/** Map an LSP kind slug to CodeMirror's completion type (drives the icon). */
const KIND_MAP: Record<string, string> = {
  method: "method",
  field: "property",
  property: "property",
  variable: "variable",
  class: "class",
  struct: "class",
  enum: "enum",
  interface: "interface",
  module: "namespace",
  keyword: "keyword",
  constant: "constant",
};

/**
 * Convert an LSP snippet (`is_invalid(${1:captcha}, ${2:attempts})$0`) into a
 * CodeMirror snippet template (`is_invalid(${captcha}, ${attempts})${}`). CM then
 * fills the argument names, selects the first, and Tab moves between them.
 */
function lspToCmTemplate(lsp: string): string {
  let out = "";
  let i = 0;
  while (i < lsp.length) {
    if (lsp[i] === "\\" && i + 1 < lsp.length) {
      out += lsp[i + 1];
      i += 2;
      continue;
    }
    const rest = lsp.slice(i);
    let m = /^\$\{(\d+):([^}]*)\}/.exec(rest);
    if (m) {
      out += "${" + m[2].replace(/[\\${}]/g, "\\$&") + "}";
      i += m[0].length;
      continue;
    }
    m = /^\$\{(\d+)\}/.exec(rest) || /^\$(\d+)/.exec(rest);
    if (m) {
      out += "${}";
      i += m[0].length;
      continue;
    }
    out += lsp[i];
    i += 1;
  }
  return out;
}

/** A CodeMirror completion source backed by rust-analyzer. */
function rustAnalyzerSource(root: string, path: string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    // Trigger on an identifier, or right after `.` / `::`.
    const word = ctx.matchBefore(/[A-Za-z0-9_]*/);
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 2), ctx.pos);
    const afterDot = before.endsWith(".") || before.endsWith("::");
    if (!ctx.explicit && !afterDot && (!word || word.from === word.to)) return null;

    const line = ctx.state.doc.lineAt(ctx.pos);
    try {
      const items = await lspCompletion(
        root,
        path,
        ctx.state.doc.toString(),
        line.number - 1, // LSP is 0-based
        ctx.pos - line.from,
      );
      if (items.length === 0) return null;
      const n = items.length;
      return {
        from: word ? word.from : ctx.pos,
        options: items.map((it, i) => ({
          // Match the typed prefix against the bare name; show the full label.
          label: it.filter_text || it.label,
          displayLabel: it.label,
          // Function/method calls arrive as snippets: use CodeMirror's snippet
          // engine so argument names are filled and Tab moves between them.
          // Everything else inserts plain text.
          apply: it.snippet ? snippet(lspToCmTemplate(it.insert)) : it.insert,
          detail: it.detail || undefined,
          type: KIND_MAP[it.kind] ?? "text",
          // Nudge rust-analyzer's ordering up so its top picks win ties.
          boost: Math.round((1 - i / n) * 30) - 15,
        })),
        // Keep filtering this list (rather than re-querying rust-analyzer) while
        // the user keeps typing identifier characters.
        validFor: /^[A-Za-z0-9_]*$/,
      };
    } catch (e) {
      console.error("completion failed", e);
      return null;
    }
  };
}

export interface CodeEditorHandle {
  /** Scroll to and place the cursor at a 1-based line/column. */
  goTo(line: number, column?: number): void;
  /** Replace the first verbatim occurrence of `original` with `replacement`. */
  applyEdit(original: string, replacement: string): boolean;
  /** Replace the current selection with `text` (or insert at the cursor). */
  replaceSelectionOrInsert(text: string): void;
  /** Live-update the doc to `text` in place (agent edit): minimal diff, keep the
   *  cursor, highlight the change, and scroll it into view. */
  updateContentLive(text: string): void;
  /** Replace the whole document (e.g. after reformatting), keeping undo history. */
  setDoc(text: string): void;
  focus(): void;
  /** Code folding actions for the command palette / menu. */
  foldAtCursor(): void;
  unfoldAtCursor(): void;
  foldAll(): void;
  unfoldAll(): void;
}

const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "#9333ea" },
  { tag: [t.string, t.special(t.string)], color: "#0a7d3c" },
  { tag: t.comment, color: "#8a8f98", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.atom], color: "#b45309" },
  { tag: [t.typeName, t.className, t.namespace], color: "#0369a1" },
  { tag: t.function(t.variableName), color: "#7c3aed" },
  { tag: t.propertyName, color: "#1d1d1f" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#475569" },
  { tag: t.meta, color: "#c2410c" }, // attributes: #[derive(...)]
  { tag: t.macroName, color: "#c2410c" },
  // XML (pom.xml, …)
  { tag: t.tagName, color: "#0369a1" },
  { tag: t.attributeName, color: "#7c3aed" },
  { tag: t.attributeValue, color: "#0a7d3c" },
  { tag: [t.angleBracket, t.processingInstruction], color: "#94a3b8" },
]);

// Brighter syntax palette for dark backgrounds.
const darkHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "#c792ea" },
  { tag: [t.string, t.special(t.string)], color: "#89e0a0" },
  { tag: t.comment, color: "#7c828d", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.atom], color: "#ffab70" },
  { tag: [t.typeName, t.className, t.namespace], color: "#79c0ff" },
  { tag: t.function(t.variableName), color: "#d2a8ff" },
  { tag: t.propertyName, color: "#e9e9ec" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#9aa5b1" },
  { tag: t.meta, color: "#ff9e64" },
  { tag: t.macroName, color: "#ff9e64" },
  // XML (pom.xml, …)
  { tag: t.tagName, color: "#79c0ff" },
  { tag: t.attributeName, color: "#d2a8ff" },
  { tag: t.attributeValue, color: "#89e0a0" },
  { tag: [t.angleBracket, t.processingInstruction], color: "#8b95a3" },
]);

const themeSpec = {
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text-primary)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: 'var(--code-font-family, "SF Mono", ui-monospace, Menlo, monospace)',
    fontSize: "var(--code-font-size, 13px)",
    lineHeight: "1.6",
  },
  ".cm-content": { padding: "12px 0 160px", caretColor: "var(--accent)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--text-tertiary)",
  },
  ".cm-activeLine": { backgroundColor: "rgba(228,85,31,0.06)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-secondary)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "rgba(228,85,31,0.2)",
  },
};
const theme = EditorView.theme(themeSpec, { dark: false });
const themeDark = EditorView.theme(themeSpec, { dark: true });

const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  {
    initial,
    path,
    root,
    onChange,
    onSave,
    onSelection,
    onCursor,
    diagnostics,
    readOnly,
    onGoToDefinition,
    breakpoints,
    onToggleBreakpoint,
    stopLine,
    onExplainDiagnostic,
    onRunSymbol,
    onFindUsages,
    onRename,
    agentActive,
    onStaged,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The active editor color scheme: an explicit choice, else the app light/dark.
  const editorThemeExtensions = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    const picked = EDITOR_THEMES.find((x) => x.id === loadEditorTheme(dark));
    const hl = picked ? picked.highlight : dark ? darkHighlightStyle : highlightStyle;
    const th = picked ? picked.theme : dark ? themeDark : theme;
    return [syntaxHighlighting(hl), th];
  };

  // Live re-theme open editors when the appearance / scheme changes (no reload).
  useEffect(() => {
    const onTheme = () => view.current?.dispatch({ effects: themeComp.current.reconfigure(editorThemeExtensions()) });
    window.addEventListener("rustade:theme", onTheme);
    return () => window.removeEventListener("rustade:theme", onTheme);
  }, []);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onToggleBreakpointRef = useRef(onToggleBreakpoint);
  onToggleBreakpointRef.current = onToggleBreakpoint;
  const onExplainRef = useRef(onExplainDiagnostic);
  onExplainRef.current = onExplainDiagnostic;
  const onRunSymbolRef = useRef(onRunSymbol);
  onRunSymbolRef.current = onRunSymbol;
  const onFindUsagesRef = useRef(onFindUsages);
  onFindUsagesRef.current = onFindUsages;
  const onRenameRef = useRef(onRename);
  onRenameRef.current = onRename;
  const onStagedRef = useRef(onStaged);
  onStagedRef.current = onStaged;

  // --- Git hunk peek: click a change bar → floating diff + Revert/Stage -------
  const [hunkPeek, setHunkPeek] = useState<{ marker: ChangeMarker; newText: string; top: number; left: number } | null>(null);
  const [staged, setStaged] = useState(false);
  const openPeekRef = useRef<(m: ChangeMarker, newText: string, top: number, left: number) => void>(() => {});
  openPeekRef.current = (marker, newText, top, left) => {
    setStaged(false);
    setHunkPeek({ marker, newText, top, left });
  };
  useEffect(() => {
    if (!hunkPeek) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { setHunkPeek(null); view.current?.focus(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [hunkPeek]);

  // --- Quick fixes (⌥⏎): rust-analyzer code actions in a caret popup ----------
  const [quickFix, setQuickFix] = useState<{ x: number; y: number; actions: CodeAction[]; index: number } | null>(null);
  const qfMenuRef = useRef<HTMLDivElement>(null);
  const runQuickFixRef = useRef<(v: EditorView) => void>(() => {});

  const applyAction = (a: CodeAction) => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const off = (line: number, ch: number) => {
      const l = doc.line(Math.min(Math.max(line + 1, 1), doc.lines));
      return Math.min(l.from + ch, l.to);
    };
    const changes = a.edits
      .map((e) => ({ from: off(e.startLine, e.startCharacter), to: off(e.endLine, e.endCharacter), insert: e.newText }))
      .sort((x, y) => x.from - y.from || x.to - y.to);
    v.dispatch({ changes });
    setQuickFix(null);
    setCtxMenu(null);
    v.focus();
  };

  // Fetch rust-analyzer code actions for the current selection/caret line.
  const getCodeActions = async (): Promise<CodeAction[]> => {
    const v = view.current;
    if (!v || !path.endsWith(".java") || !root) return [];
    const doc = v.state.doc;
    const sel = v.state.selection.main;
    const lc = (pos: number) => {
      const l = doc.lineAt(pos);
      return { line: l.number - 1, ch: pos - l.from };
    };
    // With no selection, ask over the whole caret line so a diagnostic's fix shows
    // wherever the caret sits on that line (IntelliJ-style), not just on its span.
    let s: { line: number; ch: number };
    let e: { line: number; ch: number };
    if (sel.empty) {
      const l = doc.lineAt(sel.head);
      s = { line: l.number - 1, ch: 0 };
      e = { line: l.number - 1, ch: l.length };
    } else {
      s = lc(sel.from);
      e = lc(sel.to);
    }
    try {
      return await codeAction(root, path, doc.toString(), s.line, s.ch, e.line, e.ch);
    } catch {
      return []; // rust-analyzer not ready / no client
    }
  };

  runQuickFixRef.current = async (v: EditorView) => {
    const coords = v.coordsAtPos(v.state.selection.main.head);
    if (!coords) return;
    const actions = await getCodeActions();
    setQuickFix({ x: coords.left, y: coords.bottom, actions, index: 0 });
  };

  // Keyboard + outside-click handling while the quick-fix menu is open.
  useEffect(() => {
    if (!quickFix) return;
    const onKey = (ev: KeyboardEvent) => {
      const n = quickFix.actions.length;
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        setQuickFix(null);
        view.current?.focus();
      } else if (n > 0 && (ev.key === "ArrowDown" || (ev.key === "Tab" && !ev.shiftKey))) {
        ev.preventDefault();
        ev.stopPropagation();
        setQuickFix((q) => (q ? { ...q, index: (q.index + 1) % n } : q));
      } else if (n > 0 && (ev.key === "ArrowUp" || (ev.key === "Tab" && ev.shiftKey))) {
        ev.preventDefault();
        ev.stopPropagation();
        setQuickFix((q) => (q ? { ...q, index: (q.index - 1 + n) % n } : q));
      } else if (n > 0 && ev.key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        applyAction(quickFix.actions[quickFix.index]);
      } else {
        // Any other key dismisses the menu and passes through to the editor.
        setQuickFix(null);
      }
    };
    const onDown = (ev: MouseEvent) => {
      if (!qfMenuRef.current?.contains(ev.target as Node)) setQuickFix(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [quickFix]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Right-click editor menu (Copy/Cut/Paste, quick actions, Find Usages) ---
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [ctxActions, setCtxActions] = useState<CodeAction[] | null>(null); // null = loading
  const ctxRef = useRef<HTMLDivElement>(null);

  const openContextMenu = (x: number, y: number) => {
    setCtxMenu({ x, y });
    setCtxActions(null);
    void getCodeActions().then(setCtxActions);
  };

  const clipboardCopy = async (cut: boolean) => {
    const v = view.current;
    if (!v) return;
    const sel = v.state.selection.main;
    let from = sel.from;
    let to = sel.to;
    if (sel.empty) {
      // No selection → operate on the whole caret line (VS Code behavior).
      const ln = v.state.doc.lineAt(sel.head);
      from = ln.from;
      to = Math.min(ln.to + 1, v.state.doc.length);
    }
    const text = v.state.sliceDoc(from, to);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
    if (cut && !readOnly) {
      v.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } });
    }
    v.focus();
  };

  const clipboardPaste = async () => {
    const v = view.current;
    if (!v || readOnly) return;
    try {
      const text = await navigator.clipboard.readText();
      const sel = v.state.selection.main;
      v.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length } });
      v.focus();
    } catch {
      /* clipboard unavailable */
    }
  };

  const findUsages = async () => {
    const v = view.current;
    if (!v || !path.endsWith(".java") || !root) return;
    const sel = v.state.selection.main;
    const ln = v.state.doc.lineAt(sel.head);
    const w = v.state.wordAt(sel.head);
    const symbol = w ? v.state.sliceDoc(w.from, w.to) : "symbol";
    try {
      const items = await lspReferences(root, path, v.state.doc.toString(), ln.number - 1, sel.head - ln.from);
      onFindUsagesRef.current?.(symbol, items);
    } catch {
      /* rust-analyzer not ready */
    }
  };

  // Inline rename box (⇧F6): pre-filled with the symbol, Enter renames project-wide.
  const [renameBox, setRenameBox] = useState<{ x: number; y: number; value: string } | null>(null);
  const startRename = () => {
    const v = view.current;
    if (!v || !path.endsWith(".java") || !root) return;
    const sel = v.state.selection.main;
    const w = v.state.wordAt(sel.head);
    if (!w) return;
    v.dispatch({ selection: { anchor: w.from, head: w.to } });
    const coords = v.coordsAtPos(w.from);
    if (coords) setRenameBox({ x: coords.left, y: coords.bottom, value: v.state.sliceDoc(w.from, w.to) });
  };
  const doRename = async (newName: string) => {
    const v = view.current;
    setRenameBox(null);
    if (!v || !root || !newName.trim()) return;
    const sel = v.state.selection.main;
    const ln = v.state.doc.lineAt(sel.head);
    try {
      const edits = await lspRename(root, path, v.state.doc.toString(), ln.number - 1, sel.head - ln.from, newName.trim());
      if (edits.length) onRenameRef.current?.(edits);
    } catch {
      /* rename failed (e.g. not renameable) */
    }
  };

  // Preserve the selection on right-click: CodeMirror's native mousedown would
  // otherwise collapse the selection to the click point before the menu opens.
  // We record the selection here (when the click is inside it) and re-apply it
  // when the context menu opens — robust even if CM still collapses it.
  const rightClickSelRef = useRef<{ from: number; to: number } | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onMouseDown = (e: MouseEvent) => {
      // Right-click, incl. the macOS Ctrl-click gesture (button 0 + ctrlKey).
      if (e.button !== 2 && !(e.ctrlKey && e.button === 0)) return;
      const v = view.current;
      if (!v) return;
      const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const sel = v.state.selection.main;
      const inside = !sel.empty && pos >= sel.from && pos <= sel.to;
      e.preventDefault();
      e.stopPropagation();
      if (inside) {
        rightClickSelRef.current = { from: sel.from, to: sel.to };
      } else {
        rightClickSelRef.current = null;
        v.dispatch({ selection: { anchor: pos } }); // right-click outside → move caret
      }
    };
    el.addEventListener("mousedown", onMouseDown, true);
    return () => el.removeEventListener("mousedown", onMouseDown, true);
  }, []);

  // Dismiss the context menu on outside-click or Escape.
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (ev: MouseEvent) => {
      if (ctxRef.current?.contains(ev.target as Node)) return;
      setCtxMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ctxMenu]);

  useImperativeHandle(ref, () => ({
    goTo(line: number, column = 1) {
      const v = view.current;
      if (!v) return;
      const clamped = Math.max(1, Math.min(line, v.state.doc.lines));
      const l = v.state.doc.line(clamped);
      const pos = Math.min(l.from + Math.max(0, column - 1), l.to);
      v.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
      v.focus();
    },
    applyEdit(original, replacement) {
      const v = view.current;
      if (!v) return false;
      const doc = v.state.doc.toString();
      const at = doc.indexOf(original);
      if (at === -1) return false;
      v.dispatch({
        changes: { from: at, to: at + original.length, insert: replacement },
        selection: { anchor: at + replacement.length },
        scrollIntoView: true,
      });
      onChangeRef.current(v.state.doc.toString());
      return true;
    },
    replaceSelectionOrInsert(text) {
      const v = view.current;
      if (!v) return;
      const sel = v.state.selection.main;
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
        scrollIntoView: true,
      });
      onChangeRef.current(v.state.doc.toString());
      v.focus();
    },
    updateContentLive(text) {
      const v = view.current;
      if (!v) return;
      const cur = v.state.doc.toString();
      if (cur === text) return;
      // Minimal diff: common prefix + suffix, replace the middle.
      let from = 0;
      const min = Math.min(cur.length, text.length);
      while (from < min && cur.charCodeAt(from) === text.charCodeAt(from)) from++;
      let end = 0;
      const maxSuf = Math.min(cur.length - from, text.length - from);
      while (end < maxSuf && cur.charCodeAt(cur.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
      const to = cur.length - end;
      const insert = text.slice(from, text.length - end);
      v.dispatch({
        changes: { from, to, insert },
        effects: [setAgentEdit.of({ from, to: from + insert.length }), EditorView.scrollIntoView(Math.min(from, text.length), { y: "center" })],
      });
      window.setTimeout(() => view.current?.dispatch({ effects: clearAgentEdit.of(null) }), 2600);
    },
    setDoc(text) {
      const v = view.current;
      if (!v || v.state.doc.toString() === text) return;
      // Keep the caret line where it was; formatting reflows around it.
      const line = v.state.doc.lineAt(v.state.selection.main.head).number;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
      const clamped = Math.max(1, Math.min(line, v.state.doc.lines));
      const pos = v.state.doc.line(clamped).from;
      v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      onChangeRef.current(v.state.doc.toString());
    },
    focus: () => view.current?.focus(),
    foldAtCursor: () => {
      const v = view.current;
      if (v) foldCode(v);
    },
    unfoldAtCursor: () => {
      const v = view.current;
      if (v) unfoldCode(v);
    },
    foldAll: () => {
      const v = view.current;
      if (v) foldAll(v);
    },
    unfoldAll: () => {
      const v = view.current;
      if (v) unfoldAll(v);
    },
  }), []);

  // Create once per file; the parent remounts (via `key`) to swap files.
  useEffect(() => {
    if (!host.current) return;
    const isJava = path.endsWith(".java");
    const state = EditorState.create({
      doc: initial,
      extensions: [
        ...(isJava ? [runnablesField, runGutter((r) => onRunSymbolRef.current?.(r))] : []),
        breakpointField,
        breakpointGutter((ln) => onToggleBreakpointRef.current?.(ln)),
        stopLineField,
        inlineDiagField,
        agentEditField,
        youActiveField,
        youLabelPlugin,
        lineNumbers(),
        // Code folding: a chevron gutter just right of the line numbers that
        // collapses/expands blocks (fns, impls, structs, …), IntelliJ-style.
        codeFolding(),
        foldGutter({ openText: "⌄", closedText: "›" }),
        changeBarsField,
        changeMarkersData,
        changeBarGutter((m, newText, top, left) => openPeekRef.current?.(m, newText, top, left)),
        ...(root ? [gitChangeBars(root, path)] : []),
        highlightActiveLine(),
        lintGutter(),
        // Render popups (diagnostics, hover, autocomplete) into <body> so they
        // escape the editor's `overflow: hidden` box and aren't clipped behind the
        // tab bar. (`.content-pane`'s backdrop-filter makes position:fixed unreliable.)
        tooltips({ parent: document.body }),
        history(),
        bracketMatching(),
        // NOTE: no drawSelection() — its synthetic selection layer doesn't paint
        // under macOS WKWebView (the selection state is correct, but the background
        // rectangles never render). We use the browser's native selection instead,
        // styled via `.cm-content ::selection` in App.css.
        indentUnit.of("    "),
        search({ top: true, createPanel: (v) => new QuickSearchPanel(v) }),
        highlightSelectionMatches(),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
          {
            // IntelliJ-style quick fixes / assists.
            key: "Alt-Enter",
            run: (v) => {
              void runQuickFixRef.current(v);
              return true;
            },
          },
          ...searchKeymap, // ⌘F find, ⌘G next, ⇧⌘G prev, ⌥⌘F replace
          ...foldKeymap, // ⌘⌥[ fold, ⌘⌥] unfold, ⌘⌥. toggle
          ...completionKeymap,
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
        ...(isJava
          ? [
              java(),
              cmdLinkExtension(root, path, (p, l, c) => onGoToDefinition?.(p, l, c)),
              rustAnalyzerHover(root, path),
              autocompletion({
                override: [rustAnalyzerSource(root, path)],
                activateOnTyping: true,
                activateOnTypingDelay: 150,
                icons: true,
              }),
            ]
          : []),
        // XML (pom.xml, settings.xml, …): highlighting + element folding come
        // from lang-xml; the shared foldGutter renders the chevrons; and the
        // linter + inline plugin mark well-formedness errors like Java compile
        // errors (squiggle, gutter, hover, end-of-line message).
        ...(path.endsWith(".xml") ? [xml(), xmlLinter, xmlInlineDiagPlugin] : []),
        // Java .properties: highlighting + validation (bad \u escapes, dup keys).
        ...(path.endsWith(".properties") ? [propertiesLang, propertiesLinter, propertiesInlineDiagPlugin] : []),
        ...(path.endsWith(".toml") ? [StreamLanguage.define(toml)] : []),
        themeComp.current.of(editorThemeExtensions()),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          if (u.selectionSet) {
            const main = u.state.selection.main;
            if (onSelectionRef.current) {
              onSelectionRef.current(main.from === main.to ? "" : u.state.sliceDoc(main.from, main.to));
            }
            if (onCursorRef.current) {
              const line = u.state.doc.lineAt(main.head);
              onCursorRef.current(line.number, main.head - line.from + 1);
            }
          }
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    // Report the starting cursor position (no selectionSet fires on mount).
    onCursorRef.current?.(1, 1);
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push rust-analyzer diagnostics whenever they change (setDiagnostics auto-
  // installs the lint state, so no linter source is needed — and none must exist,
  // or it would clear these on the next edit).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch(
      setDiagnostics(
        v.state,
        toCmDiagnostics(v, diagnostics, (msg, snippet) => onExplainRef.current?.(msg, snippet)),
      ),
    );
    // Inline (end-of-line) messages, Error Lens style.
    v.dispatch({ effects: setInlineDiags.of(buildInlineDiags(v.state.doc, diagnostics)) });
  }, [diagnostics]);

  // Push breakpoints + the paused line whenever they change.
  useEffect(() => {
    view.current?.dispatch({ effects: setBreakpoints.of(breakpoints ?? []) });
  }, [breakpoints]);
  useEffect(() => {
    view.current?.dispatch({ effects: setYouActive.of(!!agentActive) });
  }, [agentActive]);
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: setStopLine.of(stopLine ?? null) });
    if (stopLine != null) {
      const ln = Math.min(Math.max(stopLine, 1), v.state.doc.lines);
      v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(ln).from, { y: "center" }) });
    }
  }, [stopLine]);

  const isJavaFile = path.endsWith(".java");
  return (
    <>
      <div
        ref={host}
        className="cm-host h-full"
        onContextMenu={(e) => {
          e.preventDefault();
          // Re-apply the selection captured at right-mousedown (CM may have
          // collapsed it), so the menu acts on what was selected.
          const saved = rightClickSelRef.current;
          if (saved && view.current) {
            const s = view.current.state.selection.main;
            if (s.from !== saved.from || s.to !== saved.to) {
              view.current.dispatch({ selection: { anchor: saved.from, head: saved.to } });
            }
          }
          openContextMenu(e.clientX, e.clientY);
        }}
      />
      {ctxMenu &&
        createPortal(
          <div
            ref={ctxRef}
            className="context-menu fixed z-[80] min-w-[210px] max-w-[420px] max-h-[70vh] overflow-y-auto py-1 text-[12px]"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            <CtxItem label="Cut" hint="⌘X" disabled={readOnly} onClick={() => { setCtxMenu(null); void clipboardCopy(true); }} />
            <CtxItem label="Copy" hint="⌘C" onClick={() => { setCtxMenu(null); void clipboardCopy(false); }} />
            <CtxItem label="Paste" hint="⌘V" disabled={readOnly} onClick={() => { setCtxMenu(null); void clipboardPaste(); }} />
            {isJavaFile && (
              <>
                <div className="my-1 border-t border-[color:var(--line)]" />
                <CtxItem label="Rename…" hint="⇧F6" disabled={readOnly} onClick={() => { setCtxMenu(null); startRename(); }} />
                <CtxItem label="Find Usages" hint="⇧F7" onClick={() => { setCtxMenu(null); void findUsages(); }} />
                <div className="my-1 border-t border-[color:var(--line)]" />
                {/* Quick actions (same as ⌥⏎) inline in the menu. */}
                {ctxActions === null ? (
                  <div className="px-3 py-1 text-[11px] text-[var(--text-tertiary)]">Loading actions…</div>
                ) : ctxActions.length === 0 ? (
                  <div className="px-3 py-1 text-[11px] text-[var(--text-tertiary)]">No quick actions</div>
                ) : (
                  ctxActions.map((a, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => applyAction(a)}
                      title={a.title}
                      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[var(--text-primary)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]"
                    >
                      <span aria-hidden className="text-[11px]">💡</span>
                      <span className="min-w-0 flex-1 truncate">{a.title}</span>
                    </button>
                  ))
                )}
              </>
            )}
          </div>,
          document.body,
        )}
      {renameBox &&
        createPortal(
          <div className="qf-menu p-2" style={{ left: renameBox.x, top: renameBox.y, minWidth: 200 }}>
            <div className="mb-1 text-[11px] text-[var(--text-tertiary)]">Rename to (⏎ to apply, Esc to cancel)</div>
            <input
              autoFocus
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="field w-full px-2 py-1 text-[13px]"
              defaultValue={renameBox.value}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void doRename((e.target as HTMLInputElement).value);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setRenameBox(null);
                  view.current?.focus();
                }
                e.stopPropagation();
              }}
              onBlur={() => setRenameBox(null)}
            />
          </div>,
          document.body,
        )}
      {quickFix &&
        createPortal(
          <div ref={qfMenuRef} className="qf-menu" style={{ left: quickFix.x, top: quickFix.y }}>
            {quickFix.actions.length === 0 ? (
              <div className="qf-empty">No quick fixes available</div>
            ) : (
              quickFix.actions.map((a, i) => (
                <button
                  key={i}
                  type="button"
                  className={`qf-item ${i === quickFix.index ? "qf-active" : ""}`}
                  onMouseEnter={() => setQuickFix((q) => (q ? { ...q, index: i } : q))}
                  onClick={() => applyAction(a)}
                  title={a.title}
                >
                  <span className="qf-bulb" aria-hidden>
                    💡
                  </span>
                  <span className="qf-title">{a.title}</span>
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
      {hunkPeek &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[59]" onMouseDown={() => setHunkPeek(null)} />
            <div
              className="hunk-peek fixed z-[60]"
              style={{ top: Math.max(8, hunkPeek.top - 6), left: hunkPeek.left + 10 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="hunk-peek-head">
                <span className={`hunk-peek-kind hunk-${hunkPeek.marker.kind}`}>
                  {hunkPeek.marker.kind === "added" ? "Added" : hunkPeek.marker.kind === "deleted" ? "Deleted" : "Modified"}
                </span>
                <div className="hunk-peek-actions">
                  <button
                    type="button"
                    className="hunk-peek-btn"
                    title="Revert this hunk to the committed version"
                    onClick={() => { if (view.current) revertHunk(view.current, hunkPeek.marker); setHunkPeek(null); view.current?.focus(); }}
                  >
                    Revert
                  </button>
                  <button
                    type="button"
                    className="hunk-peek-btn"
                    disabled={!root || staged}
                    title="Stage this file (git add)"
                    onClick={() => { if (root) void gitStageFile(root, path).then(() => { setStaged(true); onStagedRef.current?.(); }).catch(() => {}); }}
                  >
                    {staged ? "Staged ✓" : "Stage file"}
                  </button>
                  {hunkPeek.marker.old_text && (
                    <button
                      type="button"
                      className="hunk-peek-btn"
                      title="Copy the committed text"
                      onClick={() => void navigator.clipboard?.writeText(hunkPeek.marker.old_text)}
                    >
                      Copy
                    </button>
                  )}
                  <button type="button" className="hunk-peek-btn" title="Close (Esc)" onClick={() => setHunkPeek(null)}>✕</button>
                </div>
              </div>
              <div className="hunk-peek-body">
                {hunkPeek.marker.old_text
                  ? hunkPeek.marker.old_text.split("\n").map((l, i) => (
                      <div key={`o${i}`} className="hunk-line hunk-del"><span className="hunk-sign">−</span>{l || " "}</div>
                    ))
                  : null}
                {hunkPeek.newText
                  ? hunkPeek.newText.split("\n").map((l, i) => (
                      <div key={`n${i}`} className="hunk-line hunk-add"><span className="hunk-sign">+</span>{l || " "}</div>
                    ))
                  : null}
                {!hunkPeek.marker.old_text && !hunkPeek.newText && (
                  <div className="hunk-line"><span className="hunk-sign"> </span>(empty)</div>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
});

function CtxItem({ label, hint, disabled, onClick }: { label: string; hint?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-6 px-3 py-1 text-left text-[var(--text-primary)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-primary)]"
    >
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[11px] text-[var(--text-tertiary)]">{hint}</span>}
    </button>
  );
}

export default CodeEditor;
