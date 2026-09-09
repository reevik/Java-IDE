import { useEffect, useRef } from "react";
import { EditorState, StateField, type Extension, type Range } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { QuickSearchPanel } from "./QuickSearchPanel";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

interface Props {
  initial: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onCursor?: (line: number, col: number) => void;
  readOnly?: boolean;
}

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.6em" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.35em" },
  { tag: t.heading3, fontWeight: "700", fontSize: "1.18em" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700", color: "var(--text-primary)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent-strong)", textDecoration: "underline" },
  { tag: t.url, color: "var(--text-tertiary)" },
  { tag: t.monospace, color: "var(--accent-strong)" },
  { tag: t.quote, color: "var(--text-secondary)", fontStyle: "italic" },
  { tag: t.list, color: "var(--accent-strong)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--text-tertiary)" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent", color: "var(--text-primary)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
      fontSize: "14.5px",
      lineHeight: "1.7",
    },
    ".cm-content": { padding: "20px 32px 200px", caretColor: "var(--accent)", maxWidth: "824px", margin: "0 auto", boxSizing: "border-box" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(228,85,31,0.2)" },
    ".cm-activeLine": { backgroundColor: "transparent" },
  },
  { dark: false },
);

// Syntax-marker node names hidden in Live Preview (revealed on the cursor's node).
const MARK_NODES = new Set(["EmphasisMark", "CodeMark", "HeaderMark", "QuoteMark", "LinkMark", "URL", "StrikethroughMark"]);

/** A rendered thematic break (`---`). */
class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement("div");
    el.className = "md-hr";
    return el;
  }
}

/** A rendered raw-HTML block (e.g. an HTML `<table>`). Click to edit the source. */
class HtmlWidget extends WidgetType {
  constructor(readonly html: string) { super(); }
  eq(o: HtmlWidget) { return o.html === this.html; }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "md-html md-preview";
    wrap.innerHTML = this.html;
    // Click (outside a link) reveals the raw source for editing.
    wrap.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      e.preventDefault();
      const pos = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() { return false; }
}

/** Obsidian-style inline rendering: hide markdown markers, style content, and
 *  reveal the raw source wherever the selection is. */
function buildDecorations(view: EditorView): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const { doc } = view.state;
  const sel = view.state.selection;
  const editing = (from: number, to: number) => sel.ranges.some((r) => r.from <= to && r.to >= from);
  const addLine = (pos: number, cls: string) => deco.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const addLines = (from: number, to: number, cls: string) => {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      addLine(line.from, cls);
      pos = line.to + 1;
    }
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        if (/^ATXHeading[1-6]$/.test(name)) {
          addLine(node.from, `cm-h${name.slice(-1)}`);
        } else if (name === "Blockquote") {
          addLines(node.from, node.to, "cm-quote");
        } else if (name === "FencedCode" || name === "CodeBlock") {
          const codeEditing = editing(node.from, node.to);
          addLines(node.from, node.to, codeEditing ? "cm-codeblock cm-codeblock-editing" : "cm-codeblock");
          if (name === "FencedCode" && !codeEditing) {
            const first = doc.lineAt(node.from);
            const last = doc.lineAt(Math.max(node.from, node.to - 1));
            if (last.number > first.number) {
              if (first.length) deco.push(Decoration.replace({}).range(first.from, first.to));
              if (last.length) deco.push(Decoration.replace({}).range(last.from, last.to));
            }
          }
        } else if (name === "InlineCode") {
          deco.push(Decoration.mark({ class: "cm-inline-code" }).range(node.from, node.to));
        } else if (name === "ListMark") {
          deco.push(Decoration.mark({ class: "cm-list-mark" }).range(node.from, node.to));
        } else if (name === "Link") {
          deco.push(Decoration.mark({ class: "cm-md-link" }).range(node.from, node.to));
        } else if (MARK_NODES.has(name)) {
          const parent = node.node.parent;
          if (!parent) return;
          if (name === "CodeMark" && parent.name !== "InlineCode") return;
          if ((name === "LinkMark" || name === "URL") && parent.name !== "Link") return;
          if (editing(parent.from, parent.to)) return;
          let end = node.to;
          if (name === "HeaderMark" || name === "QuoteMark") {
            while (doc.sliceString(end, end + 1) === " ") end++;
          }
          if (end > node.from) deco.push(Decoration.replace({}).range(node.from, end));
        }
      },
    });
  }
  return Decoration.set(deco, true);
}

function livePreview(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) {
          this.decorations = buildDecorations(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Block widgets (HR, raw-HTML blocks) — these MUST be provided by a StateField,
 *  not a ViewPlugin (CodeMirror forbids block decorations from plugins). */
function buildBlockDecos(state: EditorState): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const { doc } = state;
  const sel = state.selection;
  const editing = (from: number, to: number) => sel.ranges.some((r) => r.from <= to && r.to >= from);
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "HorizontalRule") {
        if (!editing(node.from, node.to)) {
          deco.push(Decoration.replace({ widget: new HrWidget(), block: true }).range(node.from, node.to));
        }
      } else if (node.name === "HTMLBlock") {
        if (!editing(node.from, node.to)) {
          deco.push(Decoration.replace({ widget: new HtmlWidget(doc.sliceString(node.from, node.to)), block: true }).range(node.from, node.to));
        }
      }
    },
  });
  return Decoration.set(deco, true);
}

const blockDecoField = StateField.define<DecorationSet>({
  create: (state) => buildBlockDecos(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection) return buildBlockDecos(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** A single-view Markdown editor with Obsidian-style Live Preview — you edit
 *  inline the moment you open the file. App remounts it per file via `key`. */
export default function MarkdownEditor({ initial, onChange, onSave, onCursor, readOnly }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(mdHighlight),
          EditorView.lineWrapping,
          livePreview(),
          blockDecoField,
          search({ top: true, createPanel: (v) => new QuickSearchPanel(v) }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current(); return true; } },
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              onCursorRef.current?.(line.number, head - line.from + 1);
            }
          }),
        ],
      }),
    });
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="md-cm h-full overflow-hidden" />;
}
