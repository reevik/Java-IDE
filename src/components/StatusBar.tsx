import { useMemo } from "react";

interface Props {
  /** Active file name + content (for language + indentation detection). */
  file: { name: string; content: string } | null;
  branch: string | null;
  cursor: { line: number; col: number };
}

/** VS Code-style status bar shown beneath the editor. */
export default function StatusBar({ file, branch, cursor }: Props) {
  const indent = useMemo(() => detectIndent(file?.content ?? ""), [file?.content]);
  const lang = file ? langOf(file.name) : "";

  return (
    <footer className="editor-status-bar flex h-[22px] shrink-0 items-center gap-4 px-3 text-[11px] text-[var(--text-tertiary)]">
      {branch && (
        <span className="flex items-center gap-1" title="Current git branch">
          <BranchIcon />
          {branch}
        </span>
      )}

      <div className="ml-auto flex items-center gap-4">
        {file && (
          <>
            <span className="tabular-nums" title="Cursor position">
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span title="Indentation">{indent}</span>
            <span title="File encoding">UTF-8</span>
            {lang && <span>{lang}</span>}
          </>
        )}
      </div>
    </footer>
  );
}

/** Guess indentation from the first indented line: tabs, or the space width. */
function detectIndent(content: string): string {
  const lines = content.split("\n");
  let minSpaces = Infinity;
  for (const l of lines) {
    if (l.startsWith("\t")) return "Tab";
    const m = /^( +)\S/.exec(l);
    if (m) minSpaces = Math.min(minSpaces, m[1].length);
  }
  return minSpaces === Infinity ? "Spaces: 4" : `Spaces: ${minSpaces}`;
}

function langOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      java: "Java",
      gradle: "Gradle",
      kts: "Kotlin Script",
      xml: "XML",
      properties: "Properties",
      md: "Markdown",
      json: "JSON",
      yaml: "YAML",
      yml: "YAML",
      sh: "Shell",
      sql: "SQL",
    }[ext] ?? (ext ? ext.toUpperCase() : "Plain Text")
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 4-6 2-6 5.5" />
    </svg>
  );
}
