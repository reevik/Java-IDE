import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { addProject, createProject, listProjects, removeProject } from "../lib/api";
import type { ProjectRef } from "../lib/types";

/** Shown before a project is open: pick a recent one, open a Maven/Gradle folder,
 *  or scaffold a brand-new project. */
export default function ProjectLauncher({ onOpen }: { onOpen: (p: ProjectRef) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  // "New project" form
  const [creating, setCreating] = useState(false);
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [bin, setBin] = useState(true);
  const [busy, setBusy] = useState(false);

  async function openFolder() {
    setError(null);
    try {
      const dir = await open({ directory: true, multiple: false, title: "Open a Java project" });
      if (typeof dir !== "string") return;
      const updated = await addProject(dir);
      qc.setQueryData(["projects"], updated);
      const p = updated.find((x) => x.path === dir);
      if (p) onOpen(p);
    } catch (e) {
      setError(String(e));
    }
  }

  function startNew() {
    setError(null);
    setParent(null);
    setName("");
    setBin(true);
    setCreating(true);
  }

  async function pickParent() {
    const dir = await open({ directory: true, multiple: false, title: "Choose a location for the new project" });
    if (typeof dir === "string") setParent(dir);
  }

  async function createNew() {
    if (!parent || !name.trim() || busy) return;
    setError(null);
    setBusy(true);
    try {
      const updated = await createProject(parent, name.trim(), bin);
      qc.setQueryData(["projects"], updated);
      // cargo new inserts the fresh project at the front of the list.
      const created = updated.find((x) => x.path === `${parent}/${name.trim()}`) ?? updated[0];
      if (created) onOpen(created);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function forget(p: ProjectRef, e: React.MouseEvent) {
    e.stopPropagation();
    qc.setQueryData(["projects"], await removeProject(p.path));
  }

  return (
    <div className="relative flex h-screen flex-col" data-tauri-drag-region>
      <div className="vault-aurora" aria-hidden>
        <span className="vault-aurora-accent" />
      </div>

      <div className="h-14 w-full shrink-0" data-tauri-drag-region />

      <div className="relative flex flex-1 items-center justify-center px-8 pb-16" data-tauri-drag-region>
        <div className="rise w-full max-w-sm">
          <div className="mb-6 text-center">
            <AppLogo />
            <p className="mt-3 text-[13px] text-[var(--text-secondary)]">Open a Java project to start.</p>
          </div>

          {creating ? (
            <div className="card vault-card space-y-3 p-4">
              <div className="text-[13px] font-semibold text-[var(--text-primary)]">New Java project</div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-[var(--text-tertiary)]">Location</label>
                <button
                  onClick={pickParent}
                  className="field flex w-full items-center gap-2 px-2.5 py-2 text-left text-[12px]"
                >
                  <FolderIcon />
                  <span className={`min-w-0 flex-1 truncate ${parent ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)]"}`}>
                    {parent ?? "Choose folder…"}
                  </span>
                </button>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-[var(--text-tertiary)]">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void createNew()}
                  placeholder="my_crate"
                  autoFocus
                  className="field w-full px-2.5 py-2 text-[12px]"
                />
              </div>

              <div className="flex gap-1.5">
                {(["bin", "lib"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setBin(k === "bin")}
                    className={`flex-1 rounded-md px-2 py-1.5 text-[11.5px] font-medium ${
                      (k === "bin") === bin ? "btn-accent" : "btn-bezel"
                    }`}
                  >
                    {k === "bin" ? "Application" : "Library"}
                  </button>
                ))}
              </div>

              {parent && name.trim() && (
                <p className="truncate text-[11px] text-[var(--text-tertiary)]">
                  Creates {parent}/{name.trim()}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button onClick={() => { setCreating(false); setError(null); }} className="btn-bezel flex-1 py-2 text-[13px]">
                  Cancel
                </button>
                <button
                  onClick={() => void createNew()}
                  disabled={!parent || !name.trim() || busy}
                  className="btn-accent flex-1 py-2 text-[13px] disabled:opacity-50"
                >
                  {busy ? "Creating…" : "Create"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="card vault-card max-h-[42vh] overflow-auto p-2">
                {projects && projects.length > 0 ? (
                  projects.map((p) => (
                    <button
                      key={p.path}
                      onClick={() => onOpen(p)}
                      className="group nav-row flex w-full items-center gap-3 px-3 py-2.5 text-left"
                    >
                      <CrateIcon />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
                          {p.name}
                        </span>
                        <span className="block truncate text-[11px] text-[var(--text-tertiary)]">{p.path}</span>
                      </span>
                      <span
                        onClick={(e) => forget(p, e)}
                        title="Remove from list (files stay on disk)"
                        className="hidden shrink-0 rounded p-1 text-[var(--text-tertiary)] hover:bg-red-500/25 hover:text-red-600 group-hover:block"
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="px-3 py-8 text-center text-[12px] leading-relaxed text-[var(--text-tertiary)]">
                    No projects yet. Create one, or open a folder containing a <code>pom.xml</code> or <code>build.gradle</code>.
                  </p>
                )}
              </div>

              <div className="mt-4 flex gap-2">
                <button onClick={startNew} className="btn-bezel flex-1 py-2 text-[13px]">
                  New project…
                </button>
                <button onClick={openFolder} className="btn-accent flex-1 py-2 text-[13px]">
                  Open project…
                </button>
              </div>
            </>
          )}

          {error && (
            <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-[11px] leading-relaxed text-red-700">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CrateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" className="shrink-0 text-[var(--text-secondary)]">
      <path d="M12 2l9 5v10l-9 5-9-5V7z" />
      <path d="M3 7l9 5 9-5M12 12v10" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function AppLogo() {
  return (
    <svg width="84" height="84" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" className="mx-auto drop-shadow-[0_8px_20px_rgba(193,64,14,0.4)]">
      <defs>
        <linearGradient id="ra-bg" gradientUnits="userSpaceOnUse" x1="0" y1="72" x2="0" y2="936">
          <stop offset="0" stopColor="#FF8A3D" />
          <stop offset="0.55" stopColor="#E4551F" />
          <stop offset="1" stopColor="#C1400E" />
        </linearGradient>
        <linearGradient id="ra-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.05" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id="ra-badge"><rect x="80" y="72" width="864" height="864" rx="200" /></clipPath>
      </defs>
      <rect x="80" y="72" width="864" height="864" rx="200" fill="url(#ra-bg)" />
      <rect x="80" y="72" width="864" height="864" rx="200" fill="url(#ra-sheen)" clipPath="url(#ra-badge)" />
      <rect x="81.5" y="73.5" width="861" height="861" rx="198.5" fill="none" stroke="#ffffff" strokeOpacity="0.45" strokeWidth="3" />
      {/* Coffee beans, centred in the badge (the 64-unit source is scaled up). */}
      <g clipPath="url(#ra-badge)">
        <g transform="translate(143 143) scale(11.52)" fill="#ffffff">
          <g transform="matrix(1,0,0,1,-1024,-256)">
            <g transform="matrix(0.866025,0.5,-0.5,0.866025,589.93,-387.292)">
              <g transform="matrix(1,0,0,1,0,-0.699553)">
                <path d="M737.673,328.231C738.494,328.056 739.334,328.427 739.757,329.152C739.955,329.463 740.106,329.722 740.106,329.722C740.106,329.722 745.206,338.581 739.429,352.782C737.079,358.559 736.492,366.083 738.435,371.679C738.697,372.426 738.482,373.258 737.89,373.784C737.298,374.31 736.447,374.426 735.735,374.077C730.192,371.375 722.028,365.058 722.021,352C722.015,340.226 728.812,330.279 737.673,328.231ZM737.049,332.302C730.104,335.24 726.021,342.847 726.021,352C726.021,359.27 730.203,365.111 734.111,368.315C733.195,363.785 733.062,357.818 735.724,351.274C739.116,342.936 737.912,335.324 737.049,332.302Z" />
              </g>
              <g transform="matrix(-1,0,0,-1,1483.03,703.293)">
                <path d="M737.609,328.246C738.465,328.06 739.344,328.446 739.785,329.203C739.97,329.49 740.106,329.722 740.106,329.722C740.106,329.722 745.206,338.581 739.429,352.782C737.1,358.507 736.503,365.948 738.383,371.527C738.646,372.304 738.415,373.164 737.796,373.703C737.177,374.243 736.294,374.356 735.56,373.989C730.02,371.241 722.028,364.92 722.021,352C722.016,340.255 728.779,330.328 737.609,328.246ZM737.049,332.302C730.104,335.24 726.021,342.847 726.021,352C726.021,359.27 730.203,365.111 734.111,368.315C733.195,363.785 733.062,357.818 735.724,351.274C739.116,342.936 737.912,335.324 737.049,332.302Z" />
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
