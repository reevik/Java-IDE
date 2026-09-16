//! Maven auto-detection and a user-selectable Maven installation.
//!
//! A GUI app launched from Finder inherits only launchd's minimal PATH (no
//! `/opt/homebrew/bin`), so a bare `mvn` isn't found even when Homebrew installed
//! it. Like the JDK discovery, we scan the common install locations on the
//! filesystem instead of relying on PATH, and let the user pick or override the
//! `mvn` to use.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The user's chosen `mvn` executable, or None for auto (first detected).
static MVN: Mutex<Option<String>> = Mutex::new(None);

/// Set the `mvn` executable path. Empty clears it (back to auto-detect).
pub fn set_path(path: Option<String>) {
    *MVN.lock().unwrap() = path.filter(|p| !p.trim().is_empty());
}

/// The current override, if any.
pub fn path() -> Option<String> {
    MVN.lock().unwrap().clone()
}

/// The `mvn` program to spawn: the user's override (if it still exists), else the
/// first auto-detected install, else the bare name (found via PATH, if present).
pub fn program() -> String {
    if let Some(p) = path() {
        if Path::new(&p).exists() {
            return p;
        }
    }
    found().unwrap_or_else(|| "mvn".into())
}

/// The resolved `mvn` path when one actually exists (override or first detected),
/// for the Tools status — None means "nothing found on this machine".
pub fn found() -> Option<String> {
    if let Some(p) = path() {
        if Path::new(&p).exists() {
            return Some(p);
        }
    }
    detect().into_iter().next().map(|m| m.path)
}

/// One detected Maven installation.
#[derive(Clone, serde::Serialize)]
pub struct MavenInstall {
    /// The `mvn` executable.
    pub path: String,
    /// e.g. "3.9.9", or "unknown" when it couldn't be read.
    pub version: String,
    /// Maven home (the parent of `bin`).
    pub home: String,
    /// Where it was found: "Homebrew" | "SDKMAN" | "MAVEN_HOME" | "System".
    pub source: String,
}

/// The Maven version from `<lib>/maven-core-<version>.jar`, if present.
fn version_in_lib(lib: &Path) -> Option<String> {
    let rd = std::fs::read_dir(lib).ok()?;
    for e in rd.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if let Some(rest) = name.strip_prefix("maven-core-") {
            if let Some(ver) = rest.strip_suffix(".jar") {
                return Some(ver.to_string());
            }
        }
    }
    None
}

/// Resolve an `mvn` executable to its real Maven home + version. `<home>` is the
/// parent of `bin`, but Homebrew's `bin/mvn` is a thin wrapper whose jars live in
/// `<home>/libexec/lib`, so we check both. Returns (home, version).
fn resolve_home(exe: &Path) -> (PathBuf, String) {
    let base = exe
        .parent()
        .and_then(|bin| bin.parent())
        .map(|h| h.to_path_buf())
        .unwrap_or_else(|| exe.to_path_buf());
    for home in [base.clone(), base.join("libexec")] {
        if let Some(v) = version_in_lib(&home.join("lib")) {
            return (home, v);
        }
    }
    (base, "unknown".to_string())
}

/// Candidate `mvn` executables with a source label, before existence/dedup.
fn candidates() -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();
    let home_env = std::env::var("HOME").unwrap_or_default();

    // Explicit MAVEN_HOME / M2_HOME.
    for var in ["MAVEN_HOME", "M2_HOME"] {
        if let Ok(h) = std::env::var(var) {
            if !h.trim().is_empty() {
                out.push((PathBuf::from(h).join("bin").join("mvn"), "MAVEN_HOME"));
            }
        }
    }

    // Homebrew: symlinks in bin, the opt keg, and the versioned Cellar.
    for p in ["/opt/homebrew/bin/mvn", "/usr/local/bin/mvn"] {
        out.push((PathBuf::from(p), "Homebrew"));
    }
    for base in ["/opt/homebrew/opt/maven", "/usr/local/opt/maven"] {
        out.push((PathBuf::from(base).join("bin").join("mvn"), "Homebrew"));
        out.push((PathBuf::from(base).join("libexec").join("bin").join("mvn"), "Homebrew"));
    }
    for base in ["/opt/homebrew/Cellar/maven", "/usr/local/Cellar/maven"] {
        if let Ok(rd) = std::fs::read_dir(base) {
            for keg in rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
                out.push((keg.join("libexec").join("bin").join("mvn"), "Homebrew"));
                out.push((keg.join("bin").join("mvn"), "Homebrew"));
            }
        }
    }

    // SDKMAN.
    let sdk = PathBuf::from(&home_env).join(".sdkman/candidates/maven");
    if let Ok(rd) = std::fs::read_dir(&sdk) {
        for ver in rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
            out.push((ver.join("bin").join("mvn"), "SDKMAN"));
        }
    }

    // Common system locations.
    for p in ["/usr/bin/mvn", "/usr/share/maven/bin/mvn", "/opt/maven/bin/mvn", "/usr/local/maven/bin/mvn"] {
        out.push((PathBuf::from(p), "System"));
    }

    out
}

/// Enumerate the Maven installations on this machine, deduplicated by canonical
/// path (newest version first). Scans the filesystem, so it works even when the
/// app's PATH is the minimal one a Finder-launched app inherits.
pub fn detect() -> Vec<MavenInstall> {
    // Dedup by the resolved Maven home so a symlink (e.g. /opt/homebrew/bin/mvn)
    // and the keg it points into aren't listed as two installs. The first
    // candidate for a home wins its (stable, readable) path.
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut installs: Vec<MavenInstall> = Vec::new();

    for (cand, source) in candidates() {
        if !cand.exists() {
            continue;
        }
        let canon = std::fs::canonicalize(&cand).unwrap_or_else(|_| cand.clone());
        let (home, version) = resolve_home(&canon);
        let key = std::fs::canonicalize(&home).unwrap_or_else(|_| home.clone());
        if !seen.insert(key) {
            continue; // same Maven reached via a symlink/alias
        }
        installs.push(MavenInstall {
            // Keep the original (un-canonicalized) candidate — a Homebrew symlink
            // like /opt/homebrew/bin/mvn is more stable across version bumps.
            path: cand.to_string_lossy().into_owned(),
            version,
            home: home.to_string_lossy().into_owned(),
            source: source.to_string(),
        });
    }

    // Newest first (by leading version number, then full string); "unknown" last.
    let major = |v: &str| v.split('.').next().unwrap_or("0").parse::<u32>().unwrap_or(0);
    installs.sort_by(|a, b| major(&b.version).cmp(&major(&a.version)).then(b.version.cmp(&a.version)));
    installs
}
