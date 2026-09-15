import { useMemo, useState } from "react";
import MarkdownEditor from "./MarkdownEditor";
import Select from "./Select";
import { generateTasks, type GeneratedTask } from "../lib/api";
import { latestVersion, newSpec, type Spec, type SpecRef } from "../lib/taskBoards";

interface Props {
  specs: Spec[];
  columns: string[];
  onSpecsChange: (specs: Spec[]) => void;
  onAddTasks: (tasks: GeneratedTask[], ref: SpecRef) => void;
  initialSpecId?: string | null;
  initialVersion?: number | null;
  onClose: () => void;
}

/** A standalone popup for authoring immutable, versioned markdown specs and
 *  generating board tasks from a chosen spec version. Editing never mutates a
 *  version — saving always appends a new one. */
export default function SpecDialog({ specs, columns, onSpecsChange, onAddTasks, initialSpecId, initialVersion, onClose }: Props) {
  const [selId, setSelId] = useState<string | null>(initialSpecId ?? specs[0]?.id ?? null);
  const spec = specs.find((s) => s.id === selId) ?? null;
  const latest = spec ? latestVersion(spec) : null;

  const [viewVer, setViewVer] = useState<number>(initialVersion ?? (latest?.version ?? 1));
  const version = spec?.versions.find((v) => v.version === viewVer) ?? latest;
  const isLatest = !!version && !!latest && version.version === latest.version;

  // Editor draft (only meaningful when editing the latest version).
  const [draft, setDraft] = useState<string>(version?.content ?? "");
  const dirty = isLatest && !!version && draft !== version.content;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Re-seed local state when the selected spec / version changes.
  const selectSpec = (id: string) => {
    const s = specs.find((x) => x.id === id);
    const lv = s ? latestVersion(s) : null;
    setSelId(id);
    setViewVer(lv?.version ?? 1);
    setDraft(lv?.content ?? "");
    setErr(null);
    setNote(null);
  };
  const selectVersion = (v: number) => {
    const ver = spec?.versions.find((x) => x.version === v);
    setViewVer(v);
    setDraft(ver?.content ?? "");
    setErr(null);
    setNote(null);
  };

  const patchSpec = (id: string, fn: (s: Spec) => Spec) => onSpecsChange(specs.map((s) => (s.id === id ? fn(s) : s)));

  const createSpec = () => {
    const s = newSpec(`Spec ${specs.length + 1}`);
    onSpecsChange([...specs, s]);
    setSelId(s.id);
    setViewVer(1);
    setDraft(latestVersion(s).content);
    setErr(null);
    setNote(null);
  };

  const deleteSpec = () => {
    if (!spec) return;
    const next = specs.filter((s) => s.id !== spec.id);
    onSpecsChange(next);
    selectSpecSafe(next);
  };
  const selectSpecSafe = (list: Spec[]) => {
    const first = list[0] ?? null;
    setSelId(first?.id ?? null);
    const lv = first ? latestVersion(first) : null;
    setViewVer(lv?.version ?? 1);
    setDraft(lv?.content ?? "");
  };

  const saveVersion = () => {
    if (!spec || !latest || !dirty) return;
    const next = latest.version + 1;
    patchSpec(spec.id, (s) => ({ ...s, versions: [...s.versions, { version: next, content: draft, createdAt: Date.now() }] }));
    setViewVer(next);
    setNote(`Saved version ${next}.`);
  };

  // Immutability-preserving revert: append the old content as a new version.
  const restoreVersion = () => {
    if (!spec || !latest || !version) return;
    const next = latest.version + 1;
    patchSpec(spec.id, (s) => ({ ...s, versions: [...s.versions, { version: next, content: version.content, createdAt: Date.now() }] }));
    setViewVer(next);
    setDraft(version.content);
    setNote(`Restored v${version.version} as version ${next}.`);
  };

  const generate = async () => {
    if (!spec || !version || busy) return;
    if (dirty) { setErr("Save this spec as a new version before generating tasks."); return; }
    if (columns.length === 0) { setErr("The board has no columns."); return; }
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const tasks = await generateTasks(version.content, columns);
      if (tasks.length === 0) { setErr("The AI didn't return any tasks."); return; }
      onAddTasks(tasks, { specId: spec.id, specTitle: spec.title, version: version.version });
      setNote(`Added ${tasks.length} task${tasks.length === 1 ? "" : "s"} from v${version.version} to the board.`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const versions = useMemo(() => (spec ? [...spec.versions].sort((a, b) => b.version - a.version) : []), [spec]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="switch-dialog flex h-full max-h-[900px] w-full max-w-[1280px] overflow-hidden rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Spec list */}
        <aside className="flex w-[248px] shrink-0 flex-col border-r border-[color:var(--line)] bg-[var(--surface-2)]">
          <div className="flex items-center gap-2 px-3 py-3">
            <SparkIcon />
            <span className="text-[13px] font-semibold text-[var(--text-primary)]">Specs</span>
            <button onClick={createSpec} title="New spec" className="ml-auto rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-secondary)]"><PlusIcon /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {specs.length === 0 && <p className="px-2 py-3 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">No specs yet. Create one to describe a feature, then generate tasks from it.</p>}
            {specs.map((s) => {
              const lv = latestVersion(s);
              return (
                <button key={s.id} onClick={() => selectSpec(s.id)} className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] ${s.id === selId ? "bg-[var(--accent-soft,var(--hover))] text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--hover)]"}`}>
                  <DocIcon />
                  <span className="min-w-0 flex-1 truncate">{s.title || "Untitled"}</span>
                  <span className="shrink-0 rounded bg-[var(--surface-1,var(--control-bg))] px-1 text-[10px] text-[var(--text-tertiary)]">v{lv.version}</span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          {spec && version ? (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--line)] px-4 py-2.5">
                <input
                  value={spec.title}
                  onChange={(e) => patchSpec(spec.id, (s) => ({ ...s, title: e.target.value }))}
                  placeholder="Spec title"
                  className="field min-w-0 flex-1 px-2 py-1 text-[13px] font-semibold"
                />
                <label className="flex shrink-0 items-center gap-1 text-[11.5px] text-[var(--text-tertiary)]">
                  Version
                  <Select
                    value={String(viewVer)}
                    onChange={(v) => selectVersion(Number(v))}
                    className="field px-1.5 py-1 text-[12px]"
                    alignRight
                    options={versions.map((v) => ({ value: String(v.version), label: `v${v.version}${v.version === latest!.version ? " (latest)" : ""}` }))}
                  />
                </label>
                <button onClick={deleteSpec} title="Delete spec" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-red-600"><TrashIcon /></button>
                <button onClick={onClose} className="btn-bezel px-3 py-1.5 text-[12.5px]">Close</button>
              </div>

              {/* Status / actions bar */}
              <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[color:var(--line)] bg-[var(--surface-2)] px-4 py-2 text-[11.5px]">
                <span className="text-[var(--text-tertiary)]">
                  Version {version.version} of {latest!.version} · {new Date(version.createdAt).toLocaleString()}
                  {!isLatest && " · read-only (immutable)"}
                  {isLatest && dirty && " · unsaved changes"}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {isLatest ? (
                    <button onClick={saveVersion} disabled={!dirty} className="btn-bezel px-2.5 py-1 text-[11.5px] disabled:opacity-40">Save as new version</button>
                  ) : (
                    <button onClick={restoreVersion} className="btn-bezel px-2.5 py-1 text-[11.5px]">Restore as new version</button>
                  )}
                  <button onClick={() => void generate()} disabled={busy || dirty} title={dirty ? "Save a version first" : undefined} className="btn-accent px-2.5 py-1 text-[11.5px] disabled:opacity-40">
                    {busy ? "Generating…" : `Generate tasks from v${version.version}`}
                  </button>
                </div>
                {err && <span className="w-full text-[11px] text-[var(--danger,#c22)]">{err}</span>}
                {note && !err && <span className="w-full text-[11px] text-[var(--text-tertiary)]">{note}</span>}
              </div>

              <div className="min-h-0 flex-1">
                <MarkdownEditor
                  key={`${spec.id}:${version.version}`}
                  initial={version.content}
                  onChange={(text) => isLatest && setDraft(text)}
                  onSave={saveVersion}
                  readOnly={!isLatest}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <SparkIcon large />
              <p className="max-w-xs text-[12.5px] leading-relaxed text-[var(--text-tertiary)]">
                Write a spec in markdown to describe a feature, save immutable versions, and let AI turn a version into board tasks.
              </p>
              <button onClick={createSpec} className="btn-accent px-3 py-1.5 text-[12.5px]">Create a spec</button>
              <button onClick={onClose} className="btn-bezel px-3 py-1.5 text-[12px]">Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlusIcon() { return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>; }
function TrashIcon() { return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>; }
function DocIcon() { return <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>; }
function SparkIcon({ large }: { large?: boolean }) {
  const s = large ? 30 : 16;
  return <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--accent-strong,#0a66c2)]"><path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15l-1.8-4.2L5.5 9l4.7-1.3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" /></svg>;
}
