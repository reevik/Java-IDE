import { useState, type ReactNode } from "react";
import { highlightRust } from "../lib/rustHighlight";

export interface RefProps {
  /** Resolve a cited path/filename to a real absolute file path, or null. */
  resolveRef?: (cited: string) => string | null;
  /** Open a resolved source path at an optional 1-based line. */
  onOpen?: (path: string, line?: number) => void;
  /** Apply a code block to the focused editor; returns what it did. */
  onApplyCode?: (code: string, lang: string) => "applied" | "inserted" | "none";
}

/** A compact Markdown renderer for AI chat: syntax-highlighted code fences,
 *  inline code (with clickable source references), bold/italic, headings, and
 *  lists. Not a full CommonMark parser — just the subset an LLM emits. */
export default function Markdown({ text, resolveRef, onOpen, onApplyCode }: { text: string } & RefProps) {
  return (
    <div className="flex flex-col gap-2">
      {splitFences(text).map((b, i) =>
        b.kind === "code" ? (
          <CodeBlock key={i} code={b.code} lang={b.lang} onApplyCode={onApplyCode} />
        ) : (
          <Prose key={i} text={b.text} resolveRef={resolveRef} onOpen={onOpen} />
        ),
      )}
    </div>
  );
}

function CodeBlock({ code, lang, onApplyCode }: { code: string; lang: string; onApplyCode?: RefProps["onApplyCode"] }) {
  const [note, setNote] = useState<string | null>(null);
  const canApply = !!onApplyCode && isRust(lang) && code.trim().length > 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setNote("Copied");
      setTimeout(() => setNote(null), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  const apply = () => {
    const r = onApplyCode?.(code, lang);
    setNote(r === "applied" ? "Applied ✓" : r === "inserted" ? "Inserted at cursor" : "Couldn't apply");
    setTimeout(() => setNote(null), 1800);
  };

  return (
    <div className="group relative">
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {note && <span className="mr-1 text-[10px] text-[var(--accent-strong)]">{note}</span>}
        <button onClick={copy} className="rounded bg-[var(--menu-bg)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)] shadow-sm hover:text-[var(--text-primary)]">
          Copy
        </button>
        {canApply && (
          <button onClick={apply} className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent-strong)] shadow-sm hover:brightness-105">
            Apply
          </button>
        )}
      </div>
      <pre className="cm-code-snippet overflow-x-auto rounded-lg border border-[color:var(--line)] bg-[var(--surface-2)] p-2.5 font-mono text-[11.5px] leading-[1.5]">
        <code>{isRust(lang) ? highlightRust(code) : code}</code>
      </pre>
    </div>
  );
}

function isRust(lang: string) {
  return lang === "" || lang === "rust" || lang === "rs";
}

type Block = { kind: "code"; code: string; lang: string } | { kind: "prose"; text: string };

/** Split into prose and fenced-code blocks. A trailing unterminated fence (mid-
 *  stream) is treated as a code block to the end, so streaming looks right. */
function splitFences(md: string): Block[] {
  const blocks: Block[] = [];
  const re = /```([\w-]*)\r?\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m.index > last) blocks.push({ kind: "prose", text: md.slice(last, m.index) });
    blocks.push({ kind: "code", lang: m[1].toLowerCase(), code: m[2].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  const tail = md.slice(last);
  const openM = /```([\w-]*)\r?\n?/.exec(tail);
  if (openM) {
    if (tail.slice(0, openM.index).trim()) blocks.push({ kind: "prose", text: tail.slice(0, openM.index) });
    blocks.push({ kind: "code", lang: openM[1].toLowerCase(), code: tail.slice(openM.index + openM[0].length).replace(/\n$/, "") });
  } else if (tail.trim()) {
    blocks.push({ kind: "prose", text: tail });
  }
  return blocks;
}

function Prose({ text, resolveRef, onOpen }: { text: string } & RefProps) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(
        <p key={out.length} className="whitespace-pre-wrap break-words">
          {inline(para.join("\n"), resolveRef, onOpen)}
        </p>,
      );
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(
        <blockquote key={out.length} className="whitespace-pre-wrap break-words border-l-2 border-[var(--accent)]/40 pl-2.5 text-[var(--text-secondary)]">
          {inline(quote.join("\n"), resolveRef, onOpen)}
        </blockquote>,
      );
      quote = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it, j) => <li key={j}>{inline(it, resolveRef, onOpen)}</li>);
      out.push(
        list.ordered ? (
          <ol key={out.length} className="ml-4 list-decimal space-y-0.5">{items}</ol>
        ) : (
          <ul key={out.length} className="ml-4 list-disc space-y-0.5">{items}</ul>
        ),
      );
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // GFM table: a row line followed by a `|---|---|` separator.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      flushList();
      flushQuote();
      const header = tableCells(line);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        const r = lines[j];
        if (r.trim() === "" || !r.includes("|")) break;
        rows.push(tableCells(r));
      }
      out.push(
        <div key={out.length} className="overflow-x-auto">
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci} className="border border-[color:var(--line)] bg-[var(--surface-2)] px-2 py-1 text-left font-semibold">
                    {inline(c, resolveRef, onOpen)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci} className="border border-[color:var(--line)] px-2 py-1 align-top">
                      {inline(r[ci] ?? "", resolveRef, onOpen)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j - 1;
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      flushQuote();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const q = /^\s*>\s?(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      flushQuote();
      out.push(
        <p key={out.length} className="font-semibold text-[var(--text-primary)]">
          {inline(h[2], resolveRef, onOpen)}
        </p>,
      );
    } else if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
    } else if (ul) {
      flushPara();
      flushQuote();
      if (list && !list.ordered) list.items.push(ul[1]);
      else {
        flushList();
        list = { ordered: false, items: [ul[1]] };
      }
    } else if (ol) {
      flushPara();
      flushQuote();
      if (list && list.ordered) list.items.push(ol[1]);
      else {
        flushList();
        list = { ordered: true, items: [ol[1]] };
      }
    } else {
      flushList();
      flushQuote();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  flushQuote();
  return <div className="flex flex-col gap-1.5">{out}</div>;
}

/** A GFM table separator row, e.g. `|---|:--:|--:|` (with or without edge pipes). */
function isTableSep(line: string): boolean {
  const s = line.trim();
  if (!s.includes("-") || !s.includes("|")) return false;
  const cells = s.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c));
}

/** Split a `| a | b |` row into trimmed cells (edge pipes optional). */
function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const SRC_EXT = /\.(rs|toml|md|json|lock|txt|ya?ml|sh|sql)$/i;

/** A source reference like `src/paging.rs` or `src/paging.rs:128`. */
function parseRef(s: string): { path: string; line?: number } | null {
  const m = /^([\w./-]+\.[a-zA-Z]+)(?::(\d+))?(?::\d+)?$/.exec(s.trim());
  if (!m || !SRC_EXT.test(m[1])) return null;
  return { path: m[1], line: m[2] ? parseInt(m[2], 10) : undefined };
}

/** Inline `code` (resolvable source refs become links), **bold**, *italic*. */
function inline(text: string, resolveRef?: (cited: string) => string | null, onOpen?: (path: string, line?: number) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      const content = tok.slice(1, -1);
      const ref = resolveRef && onOpen ? parseRef(content) : null;
      // Only a link when it resolves to a real file in the project.
      const resolved = ref ? resolveRef!(ref.path) : null;
      if (ref && resolved) {
        nodes.push(
          <button
            key={k++}
            onClick={() => onOpen!(resolved, ref.line)}
            title={`Open ${ref.path}${ref.line ? `:${ref.line}` : ""}`}
            className="md-ref rounded bg-[var(--accent-soft)] px-1 py-0.5 font-mono text-[11px]"
          >
            {content}
          </button>,
        );
      } else {
        nodes.push(
          <code key={k++} className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[11px]">
            {content}
          </code>,
        );
      }
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      nodes.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
