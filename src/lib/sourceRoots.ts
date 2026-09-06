/** How a directory is treated in the project structure. */
export type RootKind = "sources" | "resources" | "tests" | "testResources" | "excluded";

export const ROOT_LABEL: Record<RootKind, string> = {
  sources: "Sources",
  resources: "Resources",
  tests: "Tests",
  testResources: "Test Resources",
  excluded: "Excluded",
};

/** Heading used in the grouped summary (IntelliJ wording). */
export const ROOT_GROUP: Record<RootKind, string> = {
  sources: "Source Folders",
  tests: "Test Source Folders",
  resources: "Resource Folders",
  testResources: "Test Resource Folders",
  excluded: "Excluded Folders",
};

/** Tailwind text-colour class per role, shared by the tree and the dialog. */
export const ROOT_COLOR: Record<RootKind, string> = {
  sources: "text-blue-600",
  tests: "text-green-600",
  resources: "text-violet-600",
  testResources: "text-amber-600",
  excluded: "text-red-600",
};

/** Source roots whose packages are shown flattened as `com.foo.bar`. */
export function isPackageRoot(kind: RootKind): boolean {
  return kind === "sources" || kind === "tests";
}

/** Map of project-relative directory path → its role. */
export type SourceRoots = Record<string, RootKind>;

/** The conventional Maven/Gradle layout, used when nothing is saved yet. */
export const DEFAULT_ROOTS: SourceRoots = {
  "src/main/java": "sources",
  "src/main/resources": "resources",
  "src/test/java": "tests",
  "src/test/resources": "testResources",
};

const KEY = (root: string) => `sourceRoots:${root}`;

export function loadSourceRoots(root: string): SourceRoots {
  try {
    const raw = localStorage.getItem(KEY(root));
    if (!raw) return { ...DEFAULT_ROOTS };
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SourceRoots) : { ...DEFAULT_ROOTS };
  } catch {
    return { ...DEFAULT_ROOTS };
  }
}

export function saveSourceRoots(root: string, roots: SourceRoots) {
  localStorage.setItem(KEY(root), JSON.stringify(roots));
}

/** Whether the user has explicitly configured roots for this project (an override
 *  of the auto-detected ones). */
export function hasSavedSourceRoots(root: string): boolean {
  try {
    return localStorage.getItem(KEY(root)) != null;
  } catch {
    return false;
  }
}

/** Project-relative path of an absolute path under `rootPath` (posix separators). */
export function relOf(rootPath: string, absPath: string): string {
  const a = absPath.replace(/\\/g, "/");
  const r = rootPath.replace(/\\/g, "/");
  return a.startsWith(r) ? a.slice(r.length).replace(/^\/+/, "") : a;
}
