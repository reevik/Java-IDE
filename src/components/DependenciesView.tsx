import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { dependencyTree, projectModules, type DepNode } from "../lib/api";

/** Recursively keep dependencies whose name matches, plus their ancestors. */
function filterDeps(nodes: DepNode[], q: string): DepNode[] {
  if (!q) return nodes;
  const out: DepNode[] = [];
  for (const n of nodes) {
    const kids = filterDeps(n.children, q);
    if (n.name.toLowerCase().includes(q) || kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

/** Left-sidebar "Dependencies" tab: the transitive dependency tree (from
 *  `mvn dependency:tree` / `gradle dependencies`), falling back to the flat
 *  manifest deps when the build tool can't resolve (offline / not installed). */
export default function DependenciesView({ root }: { root: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dep-tree", root],
    queryFn: () => dependencyTree(root),
    retry: false,
  });
  const { data: mods } = useQuery({ queryKey: ["modules", root], queryFn: () => projectModules(root) });
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();

  const tree = useMemo(() => (data ? filterDeps(data, q) : []), [data, q]);
  const fallback = (mods?.deps ?? []).filter((d) => !q || d.name.toLowerCase().includes(q));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 pb-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          placeholder="Filter dependencies…"
          className="field min-w-0 flex-1 px-2 py-1 text-[12px]"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-4 text-[12.5px]">
        {isLoading ? (
          <Center>Resolving dependency tree…</Center>
        ) : isError || !data ? (
          fallback.length === 0 ? (
            <Center>{q ? "No matching dependencies." : "No dependencies (install Maven/Gradle for the full tree)."}</Center>
          ) : (
            <>
              <p className="px-3 pb-1 text-[10.5px] text-[var(--text-tertiary)]">Declared dependencies (install Maven/Gradle for the full tree):</p>
              {fallback.map((d) => (
                <div key={`${d.kind}-${d.name}`} className="flex items-baseline gap-2 px-3 py-0.5">
                  <PackageIcon />
                  <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{d.name}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-tertiary)]">{d.version}</span>
                </div>
              ))}
            </>
          )
        ) : tree.length === 0 ? (
          <Center>{q ? "No matching dependencies." : "No dependencies."}</Center>
        ) : (
          tree.map((n, i) => <DepTreeRow key={`${n.name}-${i}`} node={n} depth={0} forceOpen={!!q} />)
        )}
      </div>
    </div>
  );
}

function DepTreeRow({ node, depth, forceOpen }: { node: DepNode; depth: number; forceOpen?: boolean }) {
  const hasChildren = node.children.length > 0;
  const [openState, setOpen] = useState(depth === 0);
  const open = forceOpen || openState;
  return (
    <div>
      <div className="group flex items-baseline hover:bg-[var(--hover)]" style={{ paddingLeft: 4 + depth * 12 }}>
        <button
          onClick={() => hasChildren && setOpen((o) => !o)}
          className="grid h-5 w-4 shrink-0 place-items-center self-center text-[var(--text-tertiary)]"
        >
          {hasChildren ? (open ? "▾" : "▸") : ""}
        </button>
        {depth === 0 ? <CrateIcon /> : <PackageIcon />}
        <span className="ml-1.5 min-w-0 flex-1 truncate text-[var(--text-primary)]">{node.name}</span>
        {node.dedup && <span className="shrink-0 px-1 text-[10px] text-[var(--text-tertiary)]" title="Repeated — see its first occurrence">↻</span>}
        <span className="shrink-0 pr-2 font-mono text-[10.5px] text-[var(--text-tertiary)]">{node.version}</span>
      </div>
      {open && hasChildren && node.children.map((c, i) => <DepTreeRow key={`${c.name}-${i}`} node={c} depth={depth + 1} forceOpen={forceOpen} />)}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center px-4 text-center text-[12px] text-[var(--text-tertiary)]">{children}</div>;
}

function CrateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 self-center text-[var(--accent)]">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.3 7l8.7 5 8.7-5M12 22V12" />
    </svg>
  );
}
function PackageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 self-center text-[var(--text-tertiary)]">
      <path d="M12 2l9 5v10l-9 5-9-5V7z" />
      <path d="M3 7l9 5 9-5M12 12v10" />
    </svg>
  );
}
