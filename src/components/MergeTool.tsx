import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { gitStage, readFile, writeFile } from "../lib/api";

interface Props {
  /** Repo root. */
  root: string;
  /** Repo-relative path of the conflicted file. */
  path: string;
  onResolved: () => void;
  onClose: () => void;
}

type Segment =
  | { kind: "stable"; lines: string[] }
  | { kind: "conflict"; ours: string[]; base: string[] | null; theirs: string[] };

/** Split a file that contains git conflict markers into stable regions and
 *  conflict regions (ours / optional base / theirs). Handles both the default
 *  and diff3 (`|||||||` base) marker styles. */
function parseConflicts(text: string): { segments: Segment[]; conflicts: number } {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let stable: string[] = [];
  let conflicts = 0;
  const flushStable = () => { if (stable.length) { segments.push({ kind: "stable", lines: stable }); stable = []; } };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("<<<<<<<")) {
      flushStable();
      const ours: string[] = [];
      const base: string[] = [];
      const theirs: string[] = [];
      let mode: "ours" | "base" | "theirs" = "ours";
      let hasBase = false;
      i++;
      while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
        const cur = lines[i];
        if (cur.startsWith("|||||||")) { mode = "base"; hasBase = true; }
        else if (cur.startsWith("=======")) { mode = "theirs"; }
        else if (mode === "ours") ours.push(cur);
        else if (mode === "base") base.push(cur);
        else theirs.push(cur);
        i++;
      }
      i++; // skip the >>>>>>> line
      conflicts++;
      segments.push({ kind: "conflict", ours, base: hasBase ? base : null, theirs });
    } else {
      stable.push(l);
      i++;
    }
  }
  flushStable();
  return { segments, conflicts };
}

type Pick = "ours" | "theirs" | "both" | "base" | "edited";

/** A 3-way merge editor: Current (ours) on the left, the assembled Result in the
 *  middle, Incoming (theirs) on the right, resolved conflict-by-conflict. */
export default function MergeTool({ root, path, onResolved, onClose }: Props) {
  const abs = `${root}/${path}`;
  const [raw, setRaw] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    readFile(abs).then((t) => live && setRaw(t)).catch((e) => live && setErr(String(e)));
    return () => { live = false; };
  }, [abs]);

  const parsed = useMemo(() => (raw == null ? null : parseConflicts(raw)), [raw]);

  // Per-conflict resolution: the chosen text (null = unresolved) + how it was set.
  const [res, setRes] = useState<{ text: string; via: Pick }[]>([]);
  const [isResolved, setResolved] = useState<boolean[]>([]);
  useEffect(() => {
    if (!parsed) return;
    // Start every conflict unresolved.
    setRes(Array.from({ length: parsed.conflicts }, () => ({ text: "", via: "ours" as Pick })));
    setResolved(new Array(parsed.conflicts).fill(false));
  }, [parsed]);

  const setConflict = (idx: number, text: string, via: Pick) => {
    setRes((prev) => { const n = [...prev]; n[idx] = { text, via }; return n; });
    setResolved((prev) => { const n = [...prev]; n[idx] = true; return n; });
  };

  const joinLines = (a: string[]) => a.join("\n");
  const both = (c: Extract<Segment, { kind: "conflict" }>) => [...c.ours, ...c.theirs];

  // Bulk actions.
  const conflictSegs = useMemo(() => (parsed ? parsed.segments.filter((s) => s.kind === "conflict") as Extract<Segment, { kind: "conflict" }>[] : []), [parsed]);
  const takeAll = (side: "ours" | "theirs") => {
    setRes(conflictSegs.map((c) => ({ text: joinLines(side === "ours" ? c.ours : c.theirs), via: side })));
    setResolved(conflictSegs.map(() => true));
  };

  const remaining = isResolved.filter((r) => !r).length;
  const total = parsed?.conflicts ?? 0;

  const assemble = (): string => {
    if (!parsed) return raw ?? "";
    const out: string[] = [];
    let ci = 0;
    for (const seg of parsed.segments) {
      if (seg.kind === "stable") out.push(...seg.lines);
      else { out.push(...(res[ci]?.text ?? "").split("\n")); ci++; }
    }
    return out.join("\n");
  };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      await writeFile(abs, assemble());
      await gitStage(root, [path]);
      onResolved();
    } catch (e) { setErr(String(e)); setSaving(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[85] flex flex-col bg-black/50 backdrop-blur-sm" data-tauri-drag-region>
      {/* Leave the macOS traffic-light band clear at the top. */}
      <div className="switch-dialog mx-3 mb-3 mt-8 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--line)] px-4 py-2.5">
          <MergeIcon />
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">Merge conflicts</span>
          <span className="min-w-0 truncate text-[11.5px] text-[var(--text-tertiary)]">· {path}</span>
          {total > 0 && (
            <span className="rounded-full px-1.5 py-0.5 text-[10.5px] font-medium" style={remaining > 0 ? { background: "#c2410c1a", color: "#c2410c" } : { background: "#1a7f371a", color: "#1a7f37" }}>
              {remaining > 0 ? `${total - remaining}/${total} resolved` : "all resolved"}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => takeAll("ours")} className="btn-bezel px-2.5 py-1 text-[11.5px]">Use all current</button>
            <button onClick={() => takeAll("theirs")} className="btn-bezel px-2.5 py-1 text-[11.5px]">Use all incoming</button>
            <button onClick={() => void save()} disabled={saving || remaining > 0} title={remaining > 0 ? "Resolve every conflict first" : "Write the file and stage it"} className="btn-accent px-3 py-1 text-[11.5px] disabled:opacity-40">
              {saving ? "Saving…" : "Save & mark resolved"}
            </button>
            <button onClick={onClose} className="btn-bezel px-3 py-1 text-[11.5px]">Cancel</button>
          </div>
        </div>

        {/* Column labels */}
        <div className="grid shrink-0 grid-cols-3 gap-px border-b border-[color:var(--line)] bg-[var(--surface-2)] text-[10.5px] font-semibold uppercase tracking-wide">
          <div className="px-3 py-1 text-[#c2410c]">Current (ours)</div>
          <div className="px-3 py-1 text-[var(--text-secondary)]">Result</div>
          <div className="px-3 py-1 text-right text-[#1a7f37]">Incoming (theirs)</div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[1.5]">
          {err && <div className="m-3 rounded bg-red-500/10 p-2 text-[12px] text-red-600">{err}</div>}
          {raw != null && total === 0 && !err && (
            <div className="p-6 text-center text-[12.5px] text-[var(--text-tertiary)]">
              No conflict markers found in this file. It may already be resolved — you can close and Mark resolved from the panel.
            </div>
          )}
          {parsed?.segments.map((seg, si) => {
            if (seg.kind === "stable") {
              const text = seg.lines.join("\n");
              if (seg.lines.length === 1 && seg.lines[0] === "") return null;
              return (
                <pre key={si} className="whitespace-pre-wrap break-words px-3 py-0.5 text-[var(--text-secondary)]">{text}</pre>
              );
            }
            // Conflict row: find its running index.
            const ci = parsed!.segments.slice(0, si).filter((s) => s.kind === "conflict").length;
            const r = res[ci];
            const done = isResolved[ci];
            return (
              <ConflictRow
                key={si}
                seg={seg}
                resText={r?.text ?? ""}
                via={done ? r?.via : undefined}
                onUseOurs={() => setConflict(ci, seg.ours.join("\n"), "ours")}
                onUseTheirs={() => setConflict(ci, seg.theirs.join("\n"), "theirs")}
                onUseBoth={() => setConflict(ci, both(seg).join("\n"), "both")}
                onUseBase={seg.base ? () => setConflict(ci, seg.base!.join("\n"), "base") : undefined}
                onEdit={(v) => setConflict(ci, v, "edited")}
              />
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ConflictRow({ seg, resText, via, onUseOurs, onUseTheirs, onUseBoth, onUseBase, onEdit }: {
  seg: Extract<Segment, { kind: "conflict" }>;
  resText: string;
  via: Pick | undefined;
  onUseOurs: () => void;
  onUseTheirs: () => void;
  onUseBoth: () => void;
  onUseBase?: () => void;
  onEdit: (v: string) => void;
}) {
  return (
    <div className={`grid grid-cols-3 gap-px border-y ${via ? "border-[color:var(--line)]" : "border-[#c2410c]/50 bg-[#c2410c]/5"}`}>
      {/* ours */}
      <div className="min-w-0 bg-[#c2410c]/5">
        <div className="flex items-center gap-1 px-2 py-1">
          <button onClick={onUseOurs} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${via === "ours" ? "bg-[#c2410c] text-white" : "bg-[#c2410c]/15 text-[#c2410c] hover:bg-[#c2410c]/25"}`}>Use current</button>
          {via === "ours" && <Check />}
        </div>
        <pre className="whitespace-pre-wrap break-words px-3 pb-1.5 text-[#9a3412]">{seg.ours.join("\n") || "∅"}</pre>
      </div>
      {/* result */}
      <div className="min-w-0 border-x border-[color:var(--line)]">
        <div className="flex items-center gap-1 px-2 py-1">
          <button onClick={onUseBoth} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${via === "both" ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--hover)]"}`}>Both</button>
          {onUseBase && <button onClick={onUseBase} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${via === "base" ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--hover)]"}`}>Base</button>}
          <span className="ml-auto text-[10px] text-[var(--text-tertiary)]">{via ? (via === "edited" ? "edited" : "resolved") : "unresolved"}</span>
        </div>
        <textarea
          value={resText}
          onChange={(e) => onEdit(e.target.value)}
          rows={Math.max(2, resText.split("\n").length)}
          placeholder="Pick a side, or type the merged result…"
          className={`w-full resize-y bg-transparent px-3 pb-1.5 font-mono text-[12px] leading-[1.5] outline-none ${via ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)]"}`}
        />
      </div>
      {/* theirs */}
      <div className="min-w-0 bg-[#1a7f37]/5 text-right">
        <div className="flex items-center justify-end gap-1 px-2 py-1">
          {via === "theirs" && <Check />}
          <button onClick={onUseTheirs} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${via === "theirs" ? "bg-[#1a7f37] text-white" : "bg-[#1a7f37]/15 text-[#1a7f37] hover:bg-[#1a7f37]/25"}`}>Use incoming</button>
        </div>
        <pre className="whitespace-pre-wrap break-words px-3 pb-1.5 text-left text-[#166534]">{seg.theirs.join("\n") || "∅"}</pre>
      </div>
    </div>
  );
}

function Check() { return <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#1a7f37" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>; }
function MergeIcon() { return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--accent-strong,#0a66c2)]"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" /><path d="M6 8.5v7M8.5 6H12a4 4 0 0 1 4 4v.5M8.5 18H12a4 4 0 0 0 4-4v-.5" /></svg>; }
