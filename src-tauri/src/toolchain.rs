//! A user-selectable JDK location. When set, the IDE resolves `java`, `javac`,
//! and the other JDK tools from this directory (a JDK's `bin`), prepends it to
//! the PATH of every tool it spawns, and exports the matching `JAVA_HOME`, so the
//! chosen JDK drives build/run, the language server, and formatting end-to-end.

use std::path::Path;
use std::sync::Mutex;

static DIR: Mutex<Option<String>> = Mutex::new(None);

/// Set the JDK `bin` directory (e.g. `/opt/homebrew/opt/openjdk@17/bin`). Empty
/// clears it.
pub fn set_dir(dir: Option<String>) {
    *DIR.lock().unwrap() = dir.filter(|d| !d.trim().is_empty());
}

/// The current override directory, if any.
pub fn dir() -> Option<String> {
    DIR.lock().unwrap().clone()
}

/// The `JAVA_HOME` implied by the override (the JDK `bin`'s parent), if set.
pub fn java_home() -> Option<String> {
    dir().and_then(|d| {
        Path::new(&d).parent().map(|p| p.to_string_lossy().into_owned())
    })
}

/// Resolve a tool name to `<dir>/<name>` when the override dir holds it, else the
/// bare name (to be found via PATH).
pub fn bin(name: &str) -> String {
    if let Some(d) = dir() {
        let p = Path::new(&d).join(name);
        if p.exists() {
            return p.to_string_lossy().into_owned();
        }
    }
    name.to_string()
}

/// PATH with the override dir prepended (or the current PATH unchanged).
pub fn effective_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    match dir() {
        Some(d) => format!("{d}:{existing}"),
        None => existing,
    }
}

/// Run a toolchain tool and return stdout + stderr combined on success
/// (PATH-augmented). The JVM prints `-version` and `-XshowSettings` output to
/// stderr, so we capture both streams.
pub fn capture_all(name: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(bin(name))
        .args(args)
        .env("PATH", effective_path())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(s.trim().to_string())
}
