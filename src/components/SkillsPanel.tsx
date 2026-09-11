import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { listSkills, type Skill } from "../lib/api";
import { loadDeactivated, loadExternalDirs, saveDeactivated, saveExternalDirs } from "../lib/skills";

interface Props {
  root: string;
}

const GROUP_LABEL: Record<Skill["source"], string> = {
  user: "Default · ~/.claude/skills",
  project: "Project · .claude/skills",
  external: "External folders",
};
const GROUP_ORDER: Skill["source"][] = ["user", "project", "external"];

/** The Skills panel: default skills from ~/.claude and the project's .claude,
 *  plus external skill folders, each toggled active/inactive. Default skills are
 *  active unless explicitly turned off. */
export default function SkillsPanel({ root }: Props) {
  const [externalDirs, setExternalDirs] = useState<string[]>(() => loadExternalDirs());
  const [deactivated, setDeactivated] = useState<Set<string>>(() => loadDeactivated());

  const { data: skills, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["skills", root, externalDirs],
    queryFn: () => listSkills(root || null, externalDirs),
  });

  const grouped = useMemo(() => {
    const g: Record<Skill["source"], Skill[]> = { user: [], project: [], external: [] };
    for (const s of skills ?? []) g[s.source].push(s);
    return g;
  }, [skills]);

  const toggle = (id: string, active: boolean) => {
    setDeactivated((prev) => {
      const next = new Set(prev);
      if (active) next.delete(id);
      else next.add(id);
      saveDeactivated(next);
      return next;
    });
  };

  const addFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Add a skill folder" });
    if (typeof picked !== "string") return;
    if (externalDirs.includes(picked)) return;
    const next = [...externalDirs, picked];
    setExternalDirs(next);
    saveExternalDirs(next);
    void refetch();
  };

  const removeFolder = (dir: string) => {
    const next = externalDirs.filter((d) => d !== dir);
    setExternalDirs(next);
    saveExternalDirs(next);
    void refetch();
  };

  const activeCount = (skills ?? []).filter((s) => !deactivated.has(s.id)).length;

  return (
    <aside className="agent-pane flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 px-3" data-tauri-drag-region>
        <SkillsIcon />
        <h2 className="flex-1 text-[12.5px] font-semibold text-[var(--text-primary)]" data-tauri-drag-region>Skills</h2>
        <button onClick={() => void refetch()} title="Re-scan" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-secondary)]">
          <RefreshIcon spinning={isFetching} />
        </button>
        <button onClick={() => void addFolder()} title="Add skill folder" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-secondary)]">
          <PlusIcon />
        </button>
      </header>

      <p className="shrink-0 px-3 pb-2 text-[10.5px] text-[var(--text-tertiary)]">
        {(skills?.length ?? 0)} skill{(skills?.length ?? 0) === 1 ? "" : "s"} · {activeCount} active. Default skills are on unless you turn them off.
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {isLoading ? (
          <p className="px-2 py-4 text-[12px] text-[var(--text-tertiary)]">Scanning…</p>
        ) : (skills?.length ?? 0) === 0 ? (
          <p className="px-2 py-4 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            No skills found. Add a folder that contains a <code>SKILL.md</code> (or a folder of such skills) with the + button.
          </p>
        ) : (
          GROUP_ORDER.filter((g) => grouped[g].length > 0).map((g) => (
            <div key={g} className="mb-3">
              <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{GROUP_LABEL[g]}</div>
              {grouped[g].map((s) => (
                <SkillRow key={s.id} skill={s} active={!deactivated.has(s.id)} onToggle={(a) => toggle(s.id, a)} />
              ))}
            </div>
          ))
        )}

        {externalDirs.length > 0 && (
          <div className="mt-2 border-t border-[color:var(--line)] pt-2">
            <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Added folders</div>
            {externalDirs.map((d) => (
              <div key={d} className="group flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--text-secondary)]">
                <FolderIcon />
                <span className="min-w-0 flex-1 truncate" title={d}>{d}</span>
                <button onClick={() => removeFolder(d)} title="Remove folder" className="rounded p-0.5 text-[var(--text-tertiary)] opacity-0 hover:text-red-600 group-hover:opacity-100"><TrashIcon /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function SkillRow({ skill, active, onToggle }: { skill: Skill; active: boolean; onToggle: (active: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--hover)]">
      <input type="checkbox" checked={active} onChange={(e) => onToggle(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]" />
      <span className={`min-w-0 flex-1 ${active ? "" : "opacity-55"}`}>
        <span className="block text-[12.5px] font-medium text-[var(--text-primary)]">{skill.name}</span>
        {skill.description && <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-tertiary)]">{skill.description}</span>}
      </span>
    </label>
  );
}

function SkillsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function PlusIcon() { return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>; }
function TrashIcon() { return <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>; }
function FolderIcon() { return <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>; }
function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={spinning ? "animate-spin" : ""}><path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6" /></svg>;
}
