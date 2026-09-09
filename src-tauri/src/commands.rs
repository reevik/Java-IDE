use crate::fs_tree::{self, TreeNode};
use crate::projects::{self, ProjectInfo, ProjectRef};
use crate::search::{self, SearchMatch};
use crate::{cargo, llm, AppState};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};

// --- Projects ---------------------------------------------------------------

fn save_projects(state: &AppState) {
    let list = state.projects.lock().unwrap();
    if let Some(dir) = state.projects_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(&*list) {
        let _ = std::fs::write(&state.projects_path, json);
    }
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Vec<ProjectRef> {
    state.projects.lock().unwrap().clone()
}

#[tauri::command]
pub fn add_project(path: String, state: State<'_, AppState>) -> Result<Vec<ProjectRef>, String> {
    {
        let mut list = state.projects.lock().unwrap();
        projects::add(&mut list, Path::new(&path)).map_err(|e| e.to_string())?;
    }
    save_projects(&state);
    Ok(state.projects.lock().unwrap().clone())
}

/// Scaffold a new Maven project under `parent/name` (pom.xml + a `Main` class),
/// then register it. Returns the updated project list (new project first).
#[tauri::command]
pub fn create_project(
    parent: String,
    name: String,
    bin: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ProjectRef>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name is required.".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Project name can't contain path separators.".into());
    }
    let parent = PathBuf::from(&parent);
    if !parent.is_dir() {
        return Err("Choose a valid location folder.".into());
    }
    let dir = parent.join(name);
    if dir.exists() {
        return Err(format!("“{name}” already exists in that folder."));
    }

    // Scaffold a minimal Maven project. `bin` (app vs. library) only decides
    // whether we drop in a runnable Main class.
    let group_id = "com.example";
    let pkg = format!("{group_id}.{}", java_pkg_segment(name));
    let pkg_path = pkg.replace('.', "/");
    let src_main = dir.join("src/main/java").join(&pkg_path);
    std::fs::create_dir_all(&src_main).map_err(|e| format!("creating {}: {e}", src_main.display()))?;
    std::fs::create_dir_all(dir.join("src/test/java").join(&pkg_path))
        .map_err(|e| format!("creating test dir: {e}"))?;

    let pom = maven_pom(group_id, name, &pkg);
    std::fs::write(dir.join("pom.xml"), pom).map_err(|e| format!("writing pom.xml: {e}"))?;
    if bin {
        let main = format!(
            "package {pkg};\n\npublic class Main {{\n    public static void main(String[] args) {{\n        System.out.println(\"Hello, world!\");\n    }}\n}}\n"
        );
        std::fs::write(src_main.join("Main.java"), main).map_err(|e| format!("writing Main.java: {e}"))?;
    }
    // Match cargo new's convenience: initialize a git repo (best-effort).
    let _ = std::process::Command::new("git").arg("init").arg("-q").arg(&dir).output();
    let _ = std::fs::write(dir.join(".gitignore"), "target/\n*.class\n");

    {
        let mut list = state.projects.lock().unwrap();
        projects::add(&mut list, &dir).map_err(|e| e.to_string())?;
    }
    save_projects(&state);
    Ok(state.projects.lock().unwrap().clone())
}

/// Turn a project name into a legal single Java package segment (lowercase,
/// leading digit prefixed) — e.g. "My App 2" → "myapp2", "" → "app".
fn java_pkg_segment(name: &str) -> String {
    let mut s: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase();
    if s.is_empty() {
        return "app".into();
    }
    if s.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        s.insert(0, '_');
    }
    s
}

/// A minimal Maven POM: Java 17, JUnit 5, and the shade/exec-friendly defaults.
fn maven_pom(group_id: &str, artifact_id: &str, main_pkg: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>{group_id}</groupId>
  <artifactId>{artifact_id}</artifactId>
  <version>1.0-SNAPSHOT</version>
  <packaging>jar</packaging>

  <properties>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <maven.compiler.release>17</maven.compiler.release>
    <exec.mainClass>{main_pkg}.Main</exec.mainClass>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
"#
    )
}

static WINDOW_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// Open a project in a brand-new IDE window (a fresh App instance that reads the
/// project from `?open=` on startup). Mirrors the main window's look.
#[tauri::command]
pub fn open_project_window(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    if !projects::is_java_project(&dir) {
        return Err("Not a Java project.".into());
    }
    let n = WINDOW_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let url = format!("index.html?open={}", query_encode(&dir.to_string_lossy()));
    let win = tauri::WebviewWindowBuilder::new(&app, format!("proj-{n}"), tauri::WebviewUrl::App(url.into()))
        .title("Reevik Java ADE")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1000.0, 640.0)
        .transparent(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        let _ = win.set_theme(Some(tauri::Theme::Light));
        let _ = apply_vibrancy(&win, NSVisualEffectMaterial::Sidebar, Some(NSVisualEffectState::Active), None);
    }
    Ok(())
}

/// Percent-encode a string for a URL query value (keeps path separators).
fn query_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Append a line from the frontend to a debug log we can inspect from outside the
/// webview (used to diagnose the intermittent layout/viewport collapse).
#[tauri::command]
pub fn log_client(line: String) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/rustade-client.log")
    {
        let _ = writeln!(f, "{line}");
    }
}

/// Force the calling window's WKWebView to re-lay-out to the full window bounds by
/// bumping its size and restoring it. Fixes the transparent-window webview that
/// occasionally collapses to a short viewport.
#[tauri::command]
pub fn nudge_window(window: tauri::WebviewWindow) {
    if let Ok(sz) = window.inner_size() {
        let _ = window.set_size(tauri::PhysicalSize::new(sz.width, sz.height + 2));
        let w = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            let _ = w.set_size(sz);
        });
    }
}

/// Called by the main window once its React app has mounted and finished the
/// startup bootstrap: dismiss the splash window and reveal the main window.
#[tauri::command]
pub fn close_splashscreen(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
        // The main window was hidden while it loaded, so its transparent WKWebView
        // may not have laid out to full bounds yet — nudge it after reveal.
        #[cfg(target_os = "macos")]
        if let Ok(sz) = main.inner_size() {
            let _ = main.set_size(tauri::PhysicalSize::new(sz.width, sz.height + 1));
            let _ = main.set_size(sz);
        }
    }
}

#[tauri::command]
pub fn remove_project(path: String, state: State<'_, AppState>) -> Vec<ProjectRef> {
    {
        let mut list = state.projects.lock().unwrap();
        list.retain(|p| p.path != path);
    }
    save_projects(&state);
    state.projects.lock().unwrap().clone()
}

#[tauri::command]
pub fn project_info(path: String, state: State<'_, AppState>) -> Result<ProjectInfo, String> {
    let p = PathBuf::from(&path);
    ensure_within_projects(&p, &state)?;
    projects::read_info(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_modules(
    root: String,
    state: State<'_, AppState>,
) -> Result<projects::ProjectModules, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    projects::read_modules(&r).map_err(|e| e.to_string())
}

/// A top-level (or impl/trait-nested) code item in a source file.
#[derive(serde::Serialize)]
pub struct CodeSymbol {
    pub name: String,
    /// fn | struct | enum | trait | impl | type | const | static | macro | union
    pub kind: String,
    /// 1-based line of the declaration.
    pub line: u32,
    pub children: Vec<CodeSymbol>,
}

/// The functions, structs, enums, traits, impls, … declared in a Rust file, for
/// the Modules outline. A lightweight static scan (no rust-analyzer needed).
#[tauri::command]
pub fn file_symbols(path: String, state: State<'_, AppState>) -> Result<Vec<CodeSymbol>, String> {
    let p = PathBuf::from(&path);
    ensure_within_projects(&p, &state)?;
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let is_java = p.extension().and_then(|x| x.to_str()) == Some("java");
    Ok(if is_java { scan_symbols_java(&text) } else { scan_symbols(&text) })
}

/// A tolerant outline scanner for Java: top-level type declarations
/// (class / interface / enum / record / @interface) as containers, with their
/// direct methods and constructors nested underneath.
fn scan_symbols_java(text: &str) -> Vec<CodeSymbol> {
    let blanked = blank_noncode(text);
    let mut out: Vec<CodeSymbol> = Vec::new();
    let mut container: Option<usize> = None;
    let mut container_name = String::new();
    let mut depth: i32 = 0;
    for (i, line) in blanked.lines().enumerate() {
        let start_depth = depth;
        if let Some((kind, name)) = java_type_decl(line) {
            let sym = CodeSymbol { name: name.clone(), kind: kind.to_string(), line: (i as u32) + 1, children: Vec::new() };
            if start_depth == 0 {
                out.push(sym);
                container = Some(out.len() - 1);
                container_name = name;
            }
        } else if start_depth == 1 {
            if let Some(ci) = container {
                if let Some((kind, name)) = java_member(line, &container_name) {
                    out[ci].children.push(CodeSymbol { name, kind: kind.to_string(), line: (i as u32) + 1, children: Vec::new() });
                }
            }
        }
        for ch in line.chars() {
            if ch == '{' { depth += 1; }
            else if ch == '}' { depth -= 1; }
        }
        if depth < 0 { depth = 0; }
        if depth == 0 { container = None; }
    }
    out
}

/// A top-level Java type declaration on a (blanked) line → (kind, name).
fn java_type_decl(line: &str) -> Option<(&'static str, String)> {
    let s = line.trim_start();
    // Find the declaration keyword as a standalone word, ignoring leading
    // modifiers/annotations (`public final class Foo`).
    let words: Vec<&str> = s.split(|c: char| c.is_whitespace() || c == '<' || c == '{').collect();
    let mut it = words.iter().peekable();
    while let Some(w) = it.next() {
        let kind = match *w {
            "class" => "class",
            "interface" => "interface",
            "enum" => "enum",
            "record" => "record",
            "@interface" => "annotation",
            _ => continue,
        };
        let name = it.peek().map(|n| ident_at(n)).unwrap_or_default();
        if !name.is_empty() {
            return Some((kind, name));
        }
    }
    None
}

/// A method or constructor declared directly in a type body → (kind, name).
/// Fields are skipped to avoid the false positives of a heuristic parser.
fn java_member(line: &str, type_name: &str) -> Option<(&'static str, String)> {
    let s = line.trim_start();
    let paren = s.find('(')?;
    let head = &s[..paren];
    // Must open a body or be an abstract/interface method (`;`), not a call.
    let tail = &s[paren..];
    let close = tail.find(')')?;
    let after = tail[close + 1..].trim_start();
    if !after.starts_with('{') && !after.starts_with("throws") && !after.starts_with(';') {
        return None;
    }
    // The token immediately before `(` is the method name.
    let name = head.rsplit(|c: char| c.is_whitespace() || c == '>' || c == '*').next().unwrap_or("").to_string();
    let ok = !name.is_empty()
        && name.chars().next().map(|c| c.is_alphabetic() || c == '_').unwrap_or(false)
        && name.chars().all(|c| c.is_alphanumeric() || c == '_');
    if !ok || matches!(name.as_str(), "if" | "for" | "while" | "switch" | "catch" | "synchronized" | "return" | "new") {
        return None;
    }
    let kind = if name == type_name { "constructor" } else { "method" };
    Some((kind, name))
}

/// Replace comment and string/char contents with spaces (keeping newlines) so
/// brace-counting and keyword detection aren't confused by them.
fn blank_noncode(text: &str) -> String {
    let b = text.as_bytes();
    let n = b.len();
    let mut out: Vec<u8> = Vec::with_capacity(n);
    let mut i = 0;
    let sp = |out: &mut Vec<u8>, c: u8| out.push(if c == b'\n' { b'\n' } else { b' ' });
    while i < n {
        let c = b[i];
        if c == b'/' && i + 1 < n && b[i + 1] == b'/' {
            while i < n && b[i] != b'\n' { out.push(b' '); i += 1; }
            continue;
        }
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            let mut nest = 1;
            out.push(b' '); out.push(b' '); i += 2;
            while i < n && nest > 0 {
                if b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' { nest += 1; out.push(b' '); out.push(b' '); i += 2; continue; }
                if b[i] == b'*' && i + 1 < n && b[i + 1] == b'/' { nest -= 1; out.push(b' '); out.push(b' '); i += 2; continue; }
                sp(&mut out, b[i]); i += 1;
            }
            continue;
        }
        // raw string r"..." / r#"..."#
        if c == b'r' && i + 1 < n && (b[i + 1] == b'"' || b[i + 1] == b'#') {
            let mut j = i + 1;
            let mut hashes = 0;
            while j < n && b[j] == b'#' { hashes += 1; j += 1; }
            if j < n && b[j] == b'"' {
                out.push(b'r');
                for _ in 0..=hashes { out.push(b' '); }
                i = j + 1;
                loop {
                    if i >= n { break; }
                    if b[i] == b'"' {
                        let mut k = i + 1; let mut h = 0;
                        while k < n && h < hashes && b[k] == b'#' { h += 1; k += 1; }
                        if h == hashes {
                            for _ in 0..=hashes { out.push(b' '); }
                            i += 1 + hashes;
                            break;
                        }
                    }
                    sp(&mut out, b[i]); i += 1;
                }
                continue;
            }
        }
        if c == b'"' {
            out.push(b' '); i += 1;
            while i < n {
                if b[i] == b'\\' && i + 1 < n { out.push(b' '); out.push(b' '); i += 2; continue; }
                if b[i] == b'"' { out.push(b' '); i += 1; break; }
                sp(&mut out, b[i]); i += 1;
            }
            continue;
        }
        if c == b'\'' {
            if i + 1 < n && b[i + 1] == b'\\' {
                out.push(b' '); i += 1;
                while i < n {
                    if b[i] == b'\\' && i + 1 < n { out.push(b' '); out.push(b' '); i += 2; continue; }
                    if b[i] == b'\'' { out.push(b' '); i += 1; break; }
                    sp(&mut out, b[i]); i += 1;
                }
                continue;
            } else if i + 2 < n && b[i + 2] == b'\'' {
                out.push(b' '); out.push(b' '); out.push(b' '); i += 3; continue;
            }
        }
        out.push(c);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn ident_at(s: &str) -> String {
    s.trim_start().chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect()
}

/// Strip a leading keyword only at a word boundary.
fn strip_word<'a>(s: &'a str, word: &str) -> Option<&'a str> {
    let r = s.strip_prefix(word)?;
    match r.chars().next() {
        Some(c) if c.is_alphanumeric() || c == '_' => None,
        _ => Some(r.trim_start()),
    }
}

fn skip_generics(s: &str) -> &str {
    let s = s.trim_start();
    if !s.starts_with('<') {
        return s;
    }
    let mut depth = 0i32;
    for (i, ch) in s.char_indices() {
        if ch == '<' { depth += 1; }
        else if ch == '>' { depth -= 1; if depth == 0 { return s[i + 1..].trim_start(); } }
    }
    s
}

fn impl_target(s: &str) -> String {
    let s = skip_generics(s);
    let end = s.find('{').unwrap_or(s.len());
    let mut t = &s[..end];
    if let Some(w) = t.find(" where ") { t = &t[..w]; }
    let t = t.trim();
    if t.is_empty() { "impl".to_string() } else { t.to_string() }
}

/// Parse one (blanked) line into an item declaration: (kind, name, is_container).
fn parse_item(line: &str) -> Option<(&'static str, String, bool)> {
    let mut s = line.trim_start();
    if s.is_empty() || s.starts_with('#') {
        return None;
    }
    // visibility
    if let Some(r) = s.strip_prefix("pub") {
        match r.chars().next() {
            Some('(') => { if let Some(i) = r.find(')') { s = r[i + 1..].trim_start(); } }
            Some(c) if c.is_whitespace() => s = r.trim_start(),
            None => s = "",
            _ => {}
        }
    }
    // modifiers
    loop {
        if let Some(r) = strip_word(s, "async") { s = r; continue; }
        if let Some(r) = strip_word(s, "unsafe") { s = r; continue; }
        if let Some(r) = strip_word(s, "default") { s = r; continue; }
        if let Some(r) = strip_word(s, "extern") {
            s = r;
            if s.starts_with('"') {
                if let Some(i) = s[1..].find('"') { s = s[1 + i + 1..].trim_start(); }
            }
            continue;
        }
        if let Some(r) = strip_word(s, "const") {
            if strip_word(r, "fn").is_some() { s = r; continue; }
            let name = ident_at(r);
            return (!name.is_empty()).then_some(("const", name, false));
        }
        break;
    }
    let item = |kind: &'static str, name: String| (!name.is_empty()).then_some((kind, name, false));
    if let Some(r) = strip_word(s, "fn") { return item("fn", ident_at(r)); }
    if let Some(r) = strip_word(s, "struct") { return item("struct", ident_at(r)); }
    if let Some(r) = strip_word(s, "enum") { return item("enum", ident_at(r)); }
    if let Some(r) = strip_word(s, "union") { return item("union", ident_at(r)); }
    if let Some(r) = strip_word(s, "trait") {
        let name = ident_at(r);
        return (!name.is_empty()).then_some(("trait", name, true));
    }
    if let Some(r) = strip_word(s, "type") { return item("type", ident_at(r)); }
    if let Some(r) = strip_word(s, "static") {
        let r2 = strip_word(r, "mut").unwrap_or(r);
        return item("static", ident_at(r2));
    }
    if let Some(r) = s.strip_prefix("macro_rules!") { return item("macro", ident_at(r)); }
    if let Some(r) = strip_word(s, "impl") { return Some(("impl", impl_target(r), true)); }
    None
}

fn scan_symbols(text: &str) -> Vec<CodeSymbol> {
    let blanked = blank_noncode(text);
    let mut out: Vec<CodeSymbol> = Vec::new();
    let mut container: Option<usize> = None; // index in `out` of the impl/trait we're inside
    let mut depth: i32 = 0;
    for (i, line) in blanked.lines().enumerate() {
        let start_depth = depth;
        if let Some((kind, name, is_container)) = parse_item(line) {
            let sym = CodeSymbol { name, kind: kind.to_string(), line: (i as u32) + 1, children: Vec::new() };
            if start_depth == 0 {
                out.push(sym);
                container = if is_container { Some(out.len() - 1) } else { None };
            } else if start_depth == 1 {
                if let Some(ci) = container {
                    if matches!(kind, "fn" | "const" | "type") {
                        out[ci].children.push(sym);
                    }
                }
            }
        }
        for ch in line.chars() {
            if ch == '{' { depth += 1; }
            else if ch == '}' { depth -= 1; }
        }
        if depth < 0 { depth = 0; }
        if depth == 0 { container = None; }
    }
    out
}

/// A crates.io search result.
#[derive(serde::Serialize)]
pub struct CrateHit {
    pub name: String,
    pub version: String,
    pub description: String,
    pub downloads: u64,
}

/// Search crates.io for crates matching `query` (for the "Add dependency" UI).
#[tauri::command]
pub async fn search_crates(query: String) -> Result<Vec<CrateHit>, String> {
    let q = query.trim();
    if q.len() < 2 {
        return Ok(vec![]);
    }
    let client = reqwest::Client::builder()
        // crates.io requires a descriptive User-Agent.
        .user_agent("java-ade (https://github.com/reevik/Rust-ADE)")
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!(
        "https://crates.io/api/v1/crates?q={}&per_page=20&sort=relevance",
        query_encode(q)
    );
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("crates.io request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("crates.io returned {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let hits = body
        .get("crates")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .map(|c| CrateHit {
                    name: c.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    version: c
                        .get("max_stable_version")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .or_else(|| c.get("max_version").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .to_string(),
                    description: c.get("description").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
                    downloads: c.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(hits)
}

/// Add a dependency to the project with `cargo add <name>`. Returns cargo's summary.
#[tauri::command]
pub fn cargo_add(root: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let dir = PathBuf::from(&root);
    ensure_within_projects(&dir, &state)?;
    let name = name.trim();
    // Crate names are [A-Za-z0-9_-]; allow an optional @version suffix.
    let base = name.split('@').next().unwrap_or("");
    if base.is_empty() || !base.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("Invalid crate name.".into());
    }
    let out = std::process::Command::new(crate::toolchain::bin("cargo"))
        .arg("add")
        .arg(name)
        .current_dir(&dir)
        .env("PATH", crate::toolchain::effective_path())
        .output()
        .map_err(|e| format!("running cargo add: {e}"))?;
    // `cargo add` writes its human-readable summary to stderr.
    let summary = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(summary)
    } else {
        Err(if summary.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { summary })
    }
}

#[derive(serde::Serialize)]
pub struct DepNode {
    pub name: String,
    pub version: String,
    /// True for a deduplicated node (`(*)`) whose subtree is shown elsewhere.
    pub dedup: bool,
    pub children: Vec<DepNode>,
}

/// The transitive dependency tree via `mvn dependency:tree` (or, for Gradle,
/// `gradle dependencies`). Roots are the project's own artifact(s). Errors (tool
/// missing / offline) so the UI can fall back to the flat manifest list.
#[tauri::command]
pub async fn dependency_tree(root: String, state: State<'_, AppState>) -> Result<Vec<DepNode>, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;

    let (program, gradle) = detect_build_tool(&r)
        .ok_or("No pom.xml or build.gradle found.")?;

    let args: Vec<String> = if gradle {
        vec!["dependencies".into(), "--configuration".into(), "runtimeClasspath".into(), "--console=plain".into(), "-q".into()]
    } else {
        // -B batch mode keeps the ASCII tree glyphs and drops progress spinners.
        vec!["-B".into(), "org.apache.maven.plugins:maven-dependency-plugin:tree".into()]
    };

    // Async spawn so the (potentially slow) build-tool call never blocks the UI.
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args).current_dir(&r).env("PATH", crate::toolchain::effective_path());
    if let Some(home) = crate::toolchain::java_home() {
        cmd.env("JAVA_HOME", home);
    }
    let out = cmd.output().await.map_err(|e| format!("running {program}: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // Maven prints diagnostics to stdout; prefer whichever is non-empty.
        let msg = if err.trim().is_empty() { stdout.trim() } else { err.trim() };
        return Err(msg.lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"));
    }
    let tree = if gradle { parse_gradle_tree(&stdout) } else { parse_maven_tree(&stdout) };
    if tree.is_empty() {
        return Err("No dependencies resolved.".into());
    }
    Ok(tree)
}

/// Detect the build tool + program to run (prefers the project's wrapper).
fn detect_build_tool(dir: &Path) -> Option<(String, bool)> {
    if dir.join("build.gradle").exists() || dir.join("build.gradle.kts").exists() {
        let w = dir.join("gradlew");
        return Some((if w.exists() { w.to_string_lossy().into_owned() } else { "gradle".into() }, true));
    }
    if dir.join("pom.xml").exists() {
        let w = dir.join("mvnw");
        return Some((if w.exists() { w.to_string_lossy().into_owned() } else { "mvn".into() }, false));
    }
    None
}

/// True for a character that's part of a tree-drawing prefix (ASCII or Unicode).
fn is_tree_glyph(c: char) -> bool {
    matches!(c, ' ' | '|' | '+' | '-' | '\\' | '\u{2502}' | '\u{251c}' | '\u{2514}' | '\u{2500}')
}

/// Split a tree line into (depth, coordinate) using a fixed indentation cell
/// width (3 for Maven `+- `, 5 for Gradle `+--- `). Returns None for non-tree
/// lines (log noise, blank lines, headings).
fn split_tree_line<'a>(line: &'a str, cell: usize) -> Option<(usize, &'a str)> {
    let start = line.char_indices().find(|(_, c)| !is_tree_glyph(*c)).map(|(i, _)| i)?;
    let coord = line[start..].trim();
    // A Maven/Gradle coordinate is `group:artifact[:…]` with no spaces before any
    // trailing annotation. Require at least one ':' and a non-space first token.
    let head = coord.split_whitespace().next().unwrap_or("");
    if !head.contains(':') || head.split(':').count() < 2 {
        return None;
    }
    Some((start / cell, coord))
}

const MAVEN_SCOPES: &[&str] = &["compile", "test", "provided", "runtime", "system", "import"];

/// `group:artifact:packaging[:classifier]:version[:scope]` → (name, version).
fn parse_maven_coord(coord: &str) -> (String, String) {
    let parts: Vec<&str> = coord.split(':').collect();
    let name = format!("{}:{}", parts.first().unwrap_or(&""), parts.get(1).unwrap_or(&""));
    let version = if parts.len() >= 4 {
        let last = *parts.last().unwrap();
        if MAVEN_SCOPES.contains(&last) { parts[parts.len() - 2] } else { last }
    } else {
        parts.get(2).copied().unwrap_or("")
    };
    (name, version.to_string())
}

fn parse_maven_tree(text: &str) -> Vec<DepNode> {
    let mut roots: Vec<DepNode> = Vec::new();
    let mut stack: Vec<DepNode> = Vec::new();
    let close_to = |stack: &mut Vec<DepNode>, roots: &mut Vec<DepNode>, depth: usize| {
        while stack.len() > depth {
            let finished = stack.pop().unwrap();
            match stack.last_mut() {
                Some(parent) => parent.children.push(finished),
                None => roots.push(finished),
            }
        }
    };
    for raw in text.lines() {
        // Strip Maven's "[INFO] " prefix but KEEP the tree indentation after it.
        let line = raw.strip_prefix("[INFO] ").unwrap_or(raw);
        // Skip the plugin/section chatter (e.g. "--- dependency:… ---", "BUILD …").
        if line.trim_start().starts_with("---") || line.contains("BUILD ") || line.trim().is_empty() {
            continue;
        }
        let Some((depth, coord)) = split_tree_line(line, 3) else { continue };
        let (name, version) = parse_maven_coord(coord);
        if name == ":" {
            continue;
        }
        close_to(&mut stack, &mut roots, depth);
        stack.push(DepNode { name, version, dedup: coord.contains("(*)") || coord.contains("omitted"), children: Vec::new() });
    }
    close_to(&mut stack, &mut roots, 0);
    roots
}

fn parse_gradle_tree(text: &str) -> Vec<DepNode> {
    let mut roots: Vec<DepNode> = Vec::new();
    let mut stack: Vec<DepNode> = Vec::new();
    let close_to = |stack: &mut Vec<DepNode>, roots: &mut Vec<DepNode>, depth: usize| {
        while stack.len() > depth {
            let finished = stack.pop().unwrap();
            match stack.last_mut() {
                Some(parent) => parent.children.push(finished),
                None => roots.push(finished),
            }
        }
    };
    // Gradle roots each node at depth 1 under the configuration heading; treat the
    // configuration line as depth 0 root, everything else relative to it.
    for raw in text.lines() {
        if raw.trim().is_empty() {
            continue;
        }
        let Some((depth, coord)) = split_tree_line(raw, 5) else { continue };
        let dedup = coord.contains("(*)") || coord.contains("(c)") || coord.contains("(n)");
        // Strip Gradle annotations, then take `group:artifact:version` (version may
        // be `requested -> resolved`).
        let core = coord.split(" (").next().unwrap_or(coord).trim();
        let (name, version) = {
            let parts: Vec<&str> = core.split(':').collect();
            let n = format!("{}:{}", parts.first().unwrap_or(&""), parts.get(1).unwrap_or(&""));
            let v = parts.get(2).copied().unwrap_or("");
            // `1.0 -> 1.2` → the resolved (right-hand) version.
            let v = v.split("->").last().unwrap_or(v).trim().to_string();
            (n, v)
        };
        if name == ":" {
            continue;
        }
        close_to(&mut stack, &mut roots, depth);
        stack.push(DepNode { name, version, dedup, children: Vec::new() });
    }
    close_to(&mut stack, &mut roots, 0);
    roots
}

// --- Source roots -----------------------------------------------------------

/// Content of the first `<tag>…</tag>`, trimmed. (Light scan; fine for the flat
/// pom elements we read.)
fn xml_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let s = text.find(&open)? + open.len();
    let e = text[s..].find(&close)? + s;
    Some(text[s..e].trim().to_string())
}

/// Every `<directory>…</directory>` inside the first `<container>…</container>`.
fn xml_dirs_in(text: &str, container: &str) -> Vec<String> {
    let open = format!("<{container}>");
    let close = format!("</{container}>");
    let Some(s) = text.find(&open).map(|i| i + open.len()) else { return Vec::new() };
    let Some(e) = text[s..].find(&close).map(|i| i + s) else { return Vec::new() };
    let block = &text[s..e];
    let mut out = Vec::new();
    let mut rest = block;
    while let Some(i) = rest.find("<directory>") {
        let from = i + "<directory>".len();
        if let Some(j) = rest[from..].find("</directory>") {
            out.push(rest[from..from + j].trim().to_string());
            rest = &rest[from + j..];
        } else {
            break;
        }
    }
    out
}

/// Resolve a pom-declared directory against `base`, expanding the common
/// `${project.basedir}` / `${basedir}` properties and normalizing `.`/`..`.
fn resolve_dir(base: &Path, raw: &str) -> PathBuf {
    let cleaned = raw
        .replace("${project.basedir}", ".")
        .replace("${basedir}", ".")
        .replace("${project.build.directory}", "target");
    let joined = if Path::new(&cleaned).is_absolute() {
        PathBuf::from(&cleaned)
    } else {
        base.join(&cleaned)
    };
    let mut parts: Vec<std::path::Component> = Vec::new();
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::CurDir => {}
            other => parts.push(other),
        }
    }
    parts.iter().collect()
}

/// Insert `abs` (if it's a directory) as a project-relative root of `kind`,
/// without overwriting an existing mark for that path.
fn add_root(root: &Path, abs: &Path, kind: &str, out: &mut std::collections::HashMap<String, String>) {
    if !abs.is_dir() {
        return;
    }
    if let Ok(rel) = abs.strip_prefix(root) {
        let r = rel.to_string_lossy().replace('\\', "/");
        if !r.is_empty() {
            out.entry(r).or_insert_with(|| kind.to_string());
        }
    }
}

/// Conventional source-set leaves: `src/<phase>/<lang>` → role.
const SRC_SETS: &[(&str, &str, &str)] = &[
    ("main", "java", "sources"),
    ("main", "kotlin", "sources"),
    ("main", "scala", "sources"),
    ("main", "groovy", "sources"),
    ("main", "resources", "resources"),
    ("test", "java", "tests"),
    ("test", "kotlin", "tests"),
    ("test", "scala", "tests"),
    ("test", "groovy", "tests"),
    ("test", "resources", "testResources"),
];

/// Walk the project for every `src/` directory and record the conventional
/// source-set leaves inside it. Works regardless of build files — Gradle modules
/// are declared in settings.gradle, so many have no build.gradle of their own.
fn scan_src_dirs(dir: &Path, root: &Path, depth: usize, out: &mut std::collections::HashMap<String, String>) {
    if depth > 10 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name();
        let name = name.to_string_lossy();
        if matches!(name.as_ref(), "target" | "build" | "bin" | "out" | ".git" | "node_modules" | ".idea" | ".gradle" | ".metadata") {
            continue;
        }
        if name == "src" {
            for (phase, lang, kind) in SRC_SETS {
                add_root(root, &p.join(phase).join(lang), kind, out);
            }
            continue; // don't descend into a source tree
        }
        scan_src_dirs(&p, root, depth + 1, out);
    }
}

/// Every `pom.xml` under `root` (skipping build/vcs dirs), for reading Maven
/// `<build>` overrides that a plain convention scan can't see.
fn find_poms(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 8 {
        return;
    }
    if dir.join("pom.xml").exists() {
        out.push(dir.to_path_buf());
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name();
        let name = name.to_string_lossy();
        if matches!(name.as_ref(), "target" | "build" | "bin" | "out" | ".git" | "node_modules" | ".idea" | "src") {
            continue;
        }
        find_poms(&p, depth + 1, out);
    }
}

/// Auto-detect source/resource roots for the whole project: scan for the
/// conventional `src/{main,test}/{java,kotlin,…}` layout (covers Gradle modules
/// with no build.gradle of their own), then layer on any Maven pom `<build>`
/// overrides (`sourceDirectory`, `testSourceDirectory`, `<resources>`,
/// `<testResources>` — e.g. a resource dir pointed outside the module).
fn detect_source_roots(root: &Path) -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    let mut out: HashMap<String, String> = HashMap::new();

    // 1. Convention scan.
    scan_src_dirs(root, root, 0, &mut out);

    // 2. Maven overrides.
    let mut poms = Vec::new();
    find_poms(root, 0, &mut poms);
    for m in poms {
        let pom = std::fs::read_to_string(m.join("pom.xml")).unwrap_or_default();
        if let Some(src) = xml_tag(&pom, "sourceDirectory") {
            add_root(root, &resolve_dir(&m, &src), "sources", &mut out);
        }
        if let Some(tsrc) = xml_tag(&pom, "testSourceDirectory") {
            add_root(root, &resolve_dir(&m, &tsrc), "tests", &mut out);
        }
        for r in xml_dirs_in(&pom, "resources") {
            add_root(root, &resolve_dir(&m, &r), "resources", &mut out);
        }
        for r in xml_dirs_in(&pom, "testResources") {
            add_root(root, &resolve_dir(&m, &r), "testResources", &mut out);
        }
    }
    out
}

/// Auto-detected source/resource roots (Maven `<build>` config, else conventions).
#[tauri::command]
pub async fn detect_source_roots_cmd(
    path: String,
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let p = PathBuf::from(&path);
    ensure_within_projects(&p, &state)?;
    tokio::task::spawn_blocking(move || detect_source_roots(&p))
        .await
        .map_err(|e| e.to_string())
}

// --- Files ------------------------------------------------------------------

#[tauri::command]
pub async fn read_project_tree(path: String, state: State<'_, AppState>) -> Result<Vec<TreeNode>, String> {
    let p = PathBuf::from(&path);
    ensure_within_projects(&p, &state)?;
    // The recursive filesystem walk can be heavy on a large project — run it off
    // the UI thread so the app stays responsive while the tree loads.
    tokio::task::spawn_blocking(move || fs_tree::read_tree(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_file(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    // Reads are also allowed for dependency/toolchain source, so Go to Definition
    // can open std and crate sources (which live outside the project).
    ensure_readable(&p, &state)?;
    fs_tree::read_file(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String, state: State<'_, AppState>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    ensure_within_projects(&p, &state)?;
    fs_tree::write_file(&p, &contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_file(dir: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    ensure_within_projects(&d, &state)?;
    fs_tree::create_file(&d, &name)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir(dir: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    ensure_within_projects(&d, &state)?;
    fs_tree::create_dir(&d, &name)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Create a new Java class. `name` may be a bare class (`Foo`) or a fully-qualified
/// one (`com.example.Foo`). When `parent_file` names an existing class, the new
/// class is created in that same package unless `name` carries its own. Writes the
/// `.java` file under `src/main/java` with a matching `package` line and returns
/// its path.
#[tauri::command]
pub fn create_module(
    root: String,
    name: String,
    parent_file: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let dir = PathBuf::from(&root);
    ensure_within_projects(&dir, &state)?;
    let name = name.trim();

    // Split an optional package prefix off the class name.
    let (typed_pkg, class) = match name.rsplit_once('.') {
        Some((p, c)) => (Some(p.to_string()), c),
        None => (None, name),
    };
    let valid_ident = |s: &str| {
        !s.is_empty()
            && s.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    if !valid_ident(class) {
        return Err("Invalid class name — use letters, digits and underscores.".into());
    }
    if let Some(p) = &typed_pkg {
        if !p.split('.').all(valid_ident) {
            return Err("Invalid package name.".into());
        }
    }

    // Source root; create it if a fresh project doesn't have one yet.
    let src_root = dir.join("src/main/java");
    std::fs::create_dir_all(&src_root).map_err(|e| format!("creating {}: {e}", src_root.display()))?;

    // Package: explicit prefix wins; otherwise inherit the sibling class's package.
    let package = match typed_pkg {
        Some(p) => p,
        None => parent_file
            .as_deref()
            .filter(|p| !p.is_empty())
            .and_then(|p| {
                let pf = PathBuf::from(p);
                std::fs::read_to_string(&pf).ok().and_then(|src| {
                    src.lines().find_map(|l| {
                        l.trim().strip_prefix("package ").map(|r| r.trim().trim_end_matches(';').trim().to_string())
                    })
                })
            })
            .unwrap_or_default(),
    };

    let pkg_dir = if package.is_empty() {
        src_root.clone()
    } else {
        src_root.join(package.replace('.', "/"))
    };
    std::fs::create_dir_all(&pkg_dir).map_err(|e| format!("creating {}: {e}", pkg_dir.display()))?;

    let class_file = pkg_dir.join(format!("{class}.java"));
    if class_file.exists() {
        return Err(format!("{} already exists.", class_file.display()));
    }

    let header = if package.is_empty() { String::new() } else { format!("package {package};\n\n") };
    let body = format!("{header}public class {class} {{\n}}\n");
    std::fs::write(&class_file, body).map_err(|e| format!("creating {}: {e}", class_file.display()))?;
    Ok(class_file.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn rename_path(from: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let f = PathBuf::from(&from);
    ensure_within_projects(&f, &state)?;
    fs_tree::rename(&f, &name)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_path(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    ensure_within_projects(&p, &state)?;
    fs_tree::delete(&p).map_err(|e| e.to_string())
}

/// The current git branch of `root` (reading `.git/HEAD` directly — no git dep).
/// Returns a short SHA for a detached HEAD, or null when not a git repo.
#[tauri::command]
pub fn git_branch(root: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    let head = r.join(".git/HEAD");
    let Ok(content) = std::fs::read_to_string(&head) else {
        return Ok(None); // not a git repo (or a worktree/submodule .git file)
    };
    let content = content.trim();
    Ok(if let Some(branch) = content.strip_prefix("ref: refs/heads/") {
        Some(branch.to_string())
    } else if content.len() >= 7 {
        Some(content[..7].to_string()) // detached HEAD → short SHA
    } else {
        None
    })
}

/// A single commit for the history / branch-graph views.
#[derive(serde::Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    /// Parent hashes (first is the mainline parent; more than one = a merge).
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Author time, unix seconds.
    pub time: i64,
    pub subject: String,
    /// Decoration refs at this commit (e.g. "HEAD -> main", "origin/main", "tag: v1").
    pub refs: Vec<String>,
}

/// Commit log. `all` walks every branch (for the branch graph); otherwise it
/// follows the current HEAD. Newest first, capped at `limit`. Returns an empty
/// list (not an error) when the directory isn't a repo or has no commits.
#[tauri::command]
pub fn git_log(
    root: String,
    all: bool,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<Vec<GitCommit>, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    // Fields separated by US (0x1f); records by newline.
    let fmt = "%H\x1f%h\x1f%P\x1f%an\x1f%ae\x1f%at\x1f%D\x1f%s";
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(&r).arg("log").arg("--date-order").arg(format!("-n{}", limit.max(1)));
    if all {
        cmd.arg("--all");
    }
    cmd.arg(format!("--pretty=format:{fmt}"));
    let out = cmd.output().map_err(|e| format!("running git log: {e}"))?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut commits = Vec::new();
    for line in text.lines() {
        let mut f = line.split('\x1f');
        let hash = f.next().unwrap_or("").to_string();
        if hash.is_empty() {
            continue;
        }
        let short = f.next().unwrap_or("").to_string();
        let parents = f
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        let author = f.next().unwrap_or("").to_string();
        let email = f.next().unwrap_or("").to_string();
        let time = f.next().unwrap_or("0").parse().unwrap_or(0);
        let refs = f
            .next()
            .unwrap_or("")
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let subject = f.next().unwrap_or("").to_string();
        commits.push(GitCommit { hash, short, parents, author, email, time, subject, refs });
    }
    Ok(commits)
}

/// A file touched by a single commit.
#[derive(serde::Serialize)]
pub struct GitFileChange {
    /// One of A M D R C T (added/modified/deleted/renamed/copied/typechange).
    pub status: String,
    /// Path relative to the repo root (the new path for renames).
    pub path: String,
    /// Original path for renames/copies.
    pub orig: Option<String>,
}

/// The files a commit changed, via `git diff-tree`. Empty for a merge commit's
/// combined diff or when the hash isn't found.
#[tauri::command]
pub fn git_commit_files(
    root: String,
    hash: String,
    state: State<'_, AppState>,
) -> Result<Vec<GitFileChange>, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    // Guard against arg injection: a commit id is hex only.
    if hash.is_empty() || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid commit id".into());
    }
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&r)
        .arg("diff-tree")
        .arg("--no-commit-id")
        .arg("-r")
        .arg("--root")
        .arg("--name-status")
        .arg(&hash)
        .output()
        .map_err(|e| format!("running git diff-tree: {e}"))?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut files = Vec::new();
    for line in text.lines() {
        let mut parts = line.split('\t');
        let raw = parts.next().unwrap_or("");
        let Some(code) = raw.chars().next() else { continue };
        let a = parts.next().unwrap_or("").to_string();
        // Renames/copies carry an old and a new path; everything else, one path.
        let (path, orig) = match parts.next() {
            Some(newp) if !newp.is_empty() => (newp.to_string(), Some(a)),
            _ => (a, None),
        };
        if path.is_empty() {
            continue;
        }
        files.push(GitFileChange { status: code.to_string(), path, orig });
    }
    Ok(files)
}

/// The unified diff a commit applied to a single file (empty string if none).
#[tauri::command]
pub fn git_file_diff(
    root: String,
    hash: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    if hash.is_empty() || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid commit id".into());
    }
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&r)
        .arg("diff-tree")
        .arg("--no-commit-id")
        .arg("-p")
        .arg("--root")
        .arg(&hash)
        .arg("--")
        .arg(&path)
        .output()
        .map_err(|e| format!("running git diff-tree: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The working-tree diff for one file: the net change from HEAD (staged +
/// unstaged), or — for an untracked/new file — the whole file as additions.
#[tauri::command]
pub fn git_working_diff(
    root: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&r)
        .arg("diff")
        .arg("HEAD")
        .arg("--")
        .arg(&path)
        .output()
        .map_err(|e| format!("running git diff: {e}"))?;
    if out.status.success() && !out.stdout.is_empty() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    // Untracked/new file (or no commits yet): diff against an empty file.
    let out2 = std::process::Command::new("git")
        .arg("-C")
        .arg(&r)
        .arg("diff")
        .arg("--no-index")
        .arg("/dev/null")
        .arg(&path)
        .output()
        .map_err(|e| format!("running git diff: {e}"))?;
    // `--no-index` exits 1 when the files differ, which is the expected case.
    match out2.status.code() {
        Some(0) | Some(1) => Ok(String::from_utf8_lossy(&out2.stdout).into_owned()),
        _ => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
    }
}

/// Run a git command, returning Err with stderr (or stdout) on failure.
fn run_git(mut cmd: std::process::Command) -> Result<(), String> {
    let out = cmd.output().map_err(|e| format!("running git: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let msg = if err.trim().is_empty() {
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        err.into_owned()
    };
    Err(msg.trim().to_string())
}

/// Stage the given paths (`git add`).
#[tauri::command]
pub fn git_stage(root: String, paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(&r).arg("add").arg("--").args(&paths);
    run_git(cmd)
}

/// Unstage the given paths (`git restore --staged`).
#[tauri::command]
pub fn git_unstage(root: String, paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(&r).arg("restore").arg("--staged").arg("--").args(&paths);
    run_git(cmd)
}

/// Commit the currently-staged changes. Returns git's summary line on success.
#[tauri::command]
pub fn git_commit(root: String, message: String, state: State<'_, AppState>) -> Result<String, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    if message.trim().is_empty() {
        return Err("Commit message is empty.".into());
    }
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&r)
        .arg("commit")
        .arg("-m")
        .arg(&message)
        .output()
        .map_err(|e| format!("running git commit: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout).into_owned()
        } else {
            err.into_owned()
        };
        Err(msg.trim().to_string())
    }
}

/// Run `git -C <r> <args>`, returning trimmed stdout on success or stderr as Err.
fn git_out(r: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(r)
        .args(args)
        .output()
        .map_err(|e| format!("running git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout).into_owned()
        } else {
            err.into_owned()
        };
        Err(msg.trim().to_string())
    }
}

/// Local branch names (short form).
#[tauri::command]
pub fn git_branches(root: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    let out = git_out(&r, &["branch", "--format=%(refname:short)"])?;
    Ok(out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

/// Check out a revision (commit hash, branch, or tag).
#[tauri::command]
pub fn git_checkout(root: String, rev: String, state: State<'_, AppState>) -> Result<String, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    git_out(&r, &["checkout", &rev])
}

/// Create (and switch to) a new branch starting at `start` (a commit hash / ref).
#[tauri::command]
pub fn git_create_branch(root: String, name: String, start: String, state: State<'_, AppState>) -> Result<String, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    if name.trim().is_empty() {
        return Err("Branch name is empty.".into());
    }
    git_out(&r, &["checkout", "-b", name.trim(), &start])
}

/// Cherry-pick a commit onto `branch` (checks it out first).
#[tauri::command]
pub fn git_cherry_pick(root: String, branch: String, hash: String, state: State<'_, AppState>) -> Result<String, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    git_out(&r, &["checkout", &branch])?;
    git_out(&r, &["cherry-pick", &hash])
}

/// Cherry-pick a commit onto the current branch (no checkout).
#[tauri::command]
pub fn git_cherry_pick_head(root: String, hash: String, state: State<'_, AppState>) -> Result<String, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    git_out(&r, &["cherry-pick", &hash])
}

/// Revert a commit (creates a new commit undoing it).
#[tauri::command]
pub fn git_revert(root: String, hash: String, state: State<'_, AppState>) -> Result<String, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    git_out(&r, &["revert", "--no-edit", &hash])
}

/// Reset the current branch to a commit. `mode` is "soft" | "mixed" | "hard".
#[tauri::command]
pub fn git_reset(root: String, hash: String, mode: String, state: State<'_, AppState>) -> Result<String, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    git_out(&r, &["reset", flag, &hash])
}

/// A path with a pending change in the working tree / index.
#[derive(serde::Serialize)]
pub struct GitChange {
    /// Index (staged) status code: one of M A D R C ? ! or a space.
    pub staged: String,
    /// Working-tree (unstaged) status code.
    pub unstaged: String,
    /// Path relative to the repo root.
    pub path: String,
    /// Original path, for renames/copies.
    pub orig: Option<String>,
}

/// `git status --porcelain` parsed into per-file change entries. Empty when clean
/// or not a repo.
#[tauri::command]
pub fn git_status(root: String, state: State<'_, AppState>) -> Result<Vec<GitChange>, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&r)
        .arg("status")
        .arg("--porcelain")
        .arg("-uall")
        .output()
        .map_err(|e| format!("running git status: {e}"))?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut changes = Vec::new();
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let staged = line[0..1].to_string();
        let unstaged = line[1..2].to_string();
        let rest = &line[3..];
        let (path, orig) = match rest.find(" -> ") {
            Some(i) => (rest[i + 4..].to_string(), Some(rest[..i].to_string())),
            None => (rest.to_string(), None),
        };
        changes.push(GitChange { staged, unstaged, path, orig });
    }
    Ok(changes)
}

/// One run of changed lines in the working buffer, relative to the file at HEAD.
#[derive(serde::Serialize)]
pub struct ChangeMarker {
    /// 1-based, inclusive.
    pub start_line: u32,
    pub end_line: u32,
    /// "added" | "modified" | "deleted"
    pub kind: &'static str,
    /// The committed (HEAD) text this hunk replaced — for the peek diff and
    /// Revert. Empty for a pure addition; the removed lines for a deletion.
    pub old_text: String,
}

/// A file's committed (HEAD) contents plus when we last fetched them from git.
pub struct HeadBlob {
    pub fetched: std::time::Instant,
    pub content: String,
}

/// How long a cached HEAD blob is reused before re-reading it from git. Keeps
/// keystroke-time diffs in-memory; picks up external commits/checkouts after this.
const HEAD_TTL: std::time::Duration = std::time::Duration::from_secs(4);

/// Diffs the live buffer `text` against the file's committed (HEAD) version and
/// returns per-line change markers for the editor's gutter. Empty when the path
/// isn't in a git repo or hasn't changed. The HEAD blob is cached so typing does
/// an in-memory diff instead of shelling out to git on every keystroke.
#[tauri::command]
pub fn git_diff(
    root: String,
    path: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChangeMarker>, String> {
    ensure_within_projects(&PathBuf::from(&root), &state)?;
    match head_blob(&path, &state) {
        Some(head) => Ok(diff_markers(&head, &text)),
        None => Ok(vec![]), // not inside a git repo
    }
}

/// Stage a file's current working-tree contents (`git add <path>`). Used by the
/// gutter hunk peek's Stage action. (Per-file, not per-hunk.)
#[tauri::command]
pub fn git_stage_file(root: String, path: String, state: State<'_, AppState>) -> Result<(), String> {
    ensure_within_projects(&PathBuf::from(&root), &state)?;
    let file = PathBuf::from(&path);
    let git_root = find_git_root(file.parent().ok_or("no parent")?).ok_or("not a git repository")?;
    let rel = file.strip_prefix(&git_root).map_err(|_| "file outside the repo")?;
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&git_root)
        .arg("add")
        .arg("--")
        .arg(rel)
        .output()
        .map_err(|e| format!("running git add: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The committed contents of `path`, from the TTL cache or freshly from git.
/// `None` only when the file isn't inside a git repository. An untracked/new file
/// yields `Some("")`, so the whole buffer reads as added.
fn head_blob(path: &str, state: &AppState) -> Option<String> {
    if let Some(e) = state.head_cache.lock().unwrap().get(path) {
        if e.fetched.elapsed() < HEAD_TTL {
            return Some(e.content.clone());
        }
    }

    // Locate the repo root by walking up for `.git` — no git process needed.
    let file = PathBuf::from(path);
    let git_root = find_git_root(file.parent()?)?;
    let rel = file.strip_prefix(&git_root).ok()?;

    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&git_root)
        .arg("show")
        .arg(format!("HEAD:{}", rel.to_string_lossy()))
        .output()
        .ok()?;
    let content = if out.status.success() {
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        String::new() // untracked / not in HEAD yet
    };

    state.head_cache.lock().unwrap().insert(
        path.to_string(),
        HeadBlob { fetched: std::time::Instant::now(), content: content.clone() },
    );
    Some(content)
}

/// Slide a changed run `[s, e)` upward while the line just above it equals the
/// run's last line, without crossing `floor`. Canonicalises an ambiguous hunk to
/// its earliest equivalent position (matches where the edit was actually made).
fn slide_up(mut s: usize, mut e: usize, lines: &[&str], floor: usize) -> (usize, usize) {
    while s > floor && e >= 1 && e <= lines.len() && lines[s - 1] == lines[e - 1] {
        s -= 1;
        e -= 1;
    }
    (s, e)
}

/// Nearest ancestor directory containing a `.git` entry (dir or worktree file).
fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(".git").exists() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// Line-level diff of `old` (HEAD) vs `new` (buffer) → gutter markers.
fn diff_markers(old: &str, new: &str) -> Vec<ChangeMarker> {
    use similar::{DiffTag, TextDiff};
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let total_new = new_lines.len().max(1) as u32;
    let diff = TextDiff::from_lines(old, new);
    let mut out = Vec::new();
    // Lower bounds tracking the previous *change* only (not equal runs), so a hunk
    // can slide up through the equal lines above it but never past an earlier change.
    let (mut floor_new, mut floor_old) = (0usize, 0usize);
    for op in diff.ops() {
        let nr = op.new_range();
        let or = op.old_range();
        match op.tag() {
            DiffTag::Insert => {
                // Myers puts a run of equal lines (e.g. blank lines) below the
                // insertion, so an added line lands lower than the caret. Slide the
                // run up to its earliest equivalent spot — IntelliJ-like placement.
                let (s, e) = slide_up(nr.start, nr.end, &new_lines, floor_new);
                out.push(ChangeMarker {
                    start_line: s as u32 + 1,
                    end_line: e as u32,
                    kind: "added",
                    old_text: String::new(),
                });
                floor_new = e;
                floor_old = or.end;
            }
            DiffTag::Replace => {
                out.push(ChangeMarker {
                    start_line: nr.start as u32 + 1,
                    end_line: nr.end as u32,
                    kind: "modified",
                    old_text: old_lines[or.start..or.end].join("\n"),
                });
                floor_new = nr.end;
                floor_old = or.end;
            }
            DiffTag::Delete => {
                // Slide the deletion up in old-space, then anchor it in new-space.
                let (ds, de) = slide_up(or.start, or.end, &old_lines, floor_old);
                let shift = or.start - ds;
                let anchor = (nr.start.saturating_sub(shift) as u32)
                    .min(total_new.saturating_sub(1))
                    + 1;
                out.push(ChangeMarker {
                    start_line: anchor,
                    end_line: anchor,
                    kind: "deleted",
                    old_text: old_lines[ds..de].join("\n"),
                });
                floor_new = nr.end;
                floor_old = de;
            }
            DiffTag::Equal => {}
        }
    }
    out
}

#[cfg(test)]
mod diff_tests {
    use super::diff_markers;

    #[test]
    fn insert_middle() {
        let m = diff_markers("a\nb\nc\n", "a\nb\nX\nc\n");
        assert_eq!(m.len(), 1);
        assert_eq!((m[0].start_line, m[0].end_line, m[0].kind), (3, 3, "added"));
    }

    #[test]
    fn append_end() {
        let m = diff_markers("a\nb\n", "a\nb\nc\n");
        assert_eq!((m[0].start_line, m[0].end_line, m[0].kind), (3, 3, "added"));
    }

    #[test]
    fn modify_in_place() {
        let m = diff_markers("a\nb\nc\n", "a\nB\nc\n");
        assert_eq!((m[0].start_line, m[0].end_line, m[0].kind), (2, 2, "modified"));
    }

    #[test]
    fn split_line_with_enter() {
        // Cursor mid "hello" on line 2, press Enter → "hel" / "lo".
        let m = diff_markers("a\nhello\nc\n", "a\nhel\nlo\nc\n");
        assert_eq!((m[0].start_line, m[0].end_line, m[0].kind), (2, 3, "modified"));
    }

    #[test]
    fn several_blank_lines_anchor_at_caret() {
        // Press Enter twice at end of line 1 → two new blank lines 2 and 3.
        let m = diff_markers("fn a() {}\n\nfn b() {}\n", "fn a() {}\n\n\n\nfn b() {}\n");
        assert_eq!(m.len(), 1);
        assert_eq!((m[0].start_line, m[0].end_line, m[0].kind), (2, 3, "added"));
    }

    #[test]
    fn blank_line_added_anchors_at_caret() {
        // Press Enter at end of "fn a() {}" (line 1) → a new blank line 2.
        // The green must land on line 2 (where the caret is), not the lower blank.
        let m = diff_markers("fn a() {}\n\nfn b() {}\n", "fn a() {}\n\n\nfn b() {}\n");
        assert_eq!(m.len(), 1);
        assert_eq!((m[0].start_line, m[0].end_line, m[0].kind), (2, 2, "added"));
    }
}

#[tauri::command]
pub fn search_in_files(
    root: String,
    query: String,
    case_sensitive: bool,
    state: State<'_, AppState>,
) -> Result<Vec<SearchMatch>, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    search::search(&r, &query, case_sensitive, 800).map_err(|e| e.to_string())
}

/// Statically discover test function names in the project, for run-config filter
/// suggestions. Scans `.rs` files for functions under a test attribute
/// (`#[test]`, `#[tokio::test]`, …). Not a compile — best-effort, but instant.
#[tauri::command]
pub fn list_tests(root: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    let mut names = std::collections::BTreeSet::new();
    collect_tests(&r, &mut names, 0);
    Ok(names.into_iter().collect())
}

fn collect_tests(dir: &Path, out: &mut std::collections::BTreeSet<String>, depth: usize) {
    if depth > 12 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();
        if p.is_dir() {
            if name == "target" || name == ".git" || name.starts_with('.') {
                continue;
            }
            collect_tests(&p, out, depth + 1);
        } else if p.extension().and_then(|s| s.to_str()) == Some("rs") {
            if let Ok(text) = std::fs::read_to_string(&p) {
                scan_tests(&text, out);
            }
        }
    }
}

fn scan_tests(text: &str, out: &mut std::collections::BTreeSet<String>) {
    let mut pending = false;
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("#[") {
            if attr_is_test(rest) {
                pending = true;
                if let Some(n) = fn_name_after(t) {
                    out.insert(n);
                    pending = false;
                }
            }
            continue;
        }
        if !pending {
            continue;
        }
        if t.is_empty() || t.starts_with("//") {
            continue; // blank/comment between the attribute and the fn
        }
        if let Some(n) = fn_name_after(t) {
            out.insert(n);
            pending = false;
        } else if !(t.starts_with("pub") || t.starts_with("async") || t.starts_with("unsafe") || t.starts_with("const") || t.starts_with("extern")) {
            pending = false; // not a fn qualifier — give up on this attribute
        }
    }
}

/// `rest` is the text right after `#[`. True when the attribute path ends in "test"
/// (`test`, `tokio::test`, `rstest`), but not `cfg(test)`.
fn attr_is_test(rest: &str) -> bool {
    let end = rest.find([']', '(', ' ']).unwrap_or(rest.len());
    rest[..end].trim().ends_with("test")
}

/// The identifier after the first standalone `fn ` on the line.
fn fn_name_after(line: &str) -> Option<String> {
    let idx = line.find("fn ")?;
    if idx > 0 {
        let prev = line.as_bytes()[idx - 1];
        if prev != b' ' && prev != b'\t' {
            return None; // part of a longer word
        }
    }
    let name: String = line[idx + 3..]
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

// --- Cargo ------------------------------------------------------------------

#[tauri::command]
pub async fn cargo_run(
    dir: String,
    command: String,
    extra: Vec<String>,
    env: Option<std::collections::HashMap<String, String>>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<i32, String> {
    let d = PathBuf::from(&dir);
    ensure_within_projects(&d, &state)?;
    cargo::run(app, &d, &command, extra, env.unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

/// Run raw Maven/Gradle goals (the Maven panel: a lifecycle phase, or a custom
/// goal line). Streams to the same output channel as a normal build.
#[tauri::command]
pub async fn run_maven_goals(
    dir: String,
    goals: Vec<String>,
    env: Option<std::collections::HashMap<String, String>>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<i32, String> {
    let d = PathBuf::from(&dir);
    ensure_within_projects(&d, &state)?;
    cargo::run_goals(app, &d, goals, env.unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cargo_cancel() {
    cargo::cancel();
}

#[tauri::command]
pub fn cargo_is_running() -> bool {
    cargo::is_running()
}

// --- AI ---------------------------------------------------------------------

#[tauri::command]
pub fn ai_backend() -> &'static str {
    if llm::find_claude_cli().is_some() {
        "cli"
    } else if llm::get_api_key().is_some() {
        "api"
    } else {
        "none"
    }
}

#[tauri::command]
pub fn set_llm_api_key(key: String) -> Result<(), String> {
    llm::set_api_key(&key).map_err(|e| e.to_string())
}

/// Override the AI model (None → the default). In-memory; the frontend persists
/// the choice and re-applies it on startup.
#[tauri::command]
pub fn set_model(model: Option<String>) {
    llm::set_model_override(model);
}

#[derive(serde::Serialize)]
pub struct AiSettings {
    pub backend: String,
    pub has_api_key: bool,
    pub default_model: String,
    pub model_override: Option<String>,
}

#[tauri::command]
pub fn ai_settings() -> AiSettings {
    AiSettings {
        backend: ai_backend().to_string(),
        has_api_key: llm::get_api_key().is_some(),
        default_model: llm::default_model().to_string(),
        model_override: llm::model_override(),
    }
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Switch the native window appearance (and thus its vibrancy tint) light/dark.
#[tauri::command]
pub fn set_window_theme(window: tauri::WebviewWindow, dark: bool) {
    let _ = window.set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }));
}

/// Set the toolchain bin directory the IDE uses (None → auto via PATH). In-memory;
/// the frontend persists it and re-applies on startup.
///
/// Build and run already pick up the selection on their next invocation. The
/// language server (and the debugger it hosts) is launched once with the JDK's
/// `JAVA_HOME`, so when the selection actually changes we restart it — and drop
/// any live debug session — so editor features and debugging use the new JDK too.
#[tauri::command]
pub async fn set_toolchain_dir(
    dir: Option<String>,
    lsp: State<'_, LspState>,
    dap: State<'_, DapState>,
) -> Result<(), String> {
    let normalized = dir.clone().filter(|d| !d.trim().is_empty());
    let changed = crate::toolchain::dir() != normalized;
    crate::toolchain::set_dir(dir);
    if changed {
        // Dropping the client kills the old jdtls (kill_on_drop); the next LSP
        // request re-spawns it with the new JAVA_HOME.
        *lsp.0.lock().await = None;
        if let Some(prev) = dap.0.lock().await.take() {
            let _ = prev.disconnect().await;
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ToolchainInfo {
    /// The override JDK `bin` directory in effect, or null when using PATH.
    pub dir: Option<String>,
    /// Resolved `java` path.
    pub java: Option<String>,
    /// Resolved `javac` path.
    pub javac: Option<String>,
    /// e.g. "17.0.10".
    pub version: Option<String>,
    /// e.g. "Homebrew" / "Eclipse Adoptium" / "Oracle Corporation".
    pub vendor: Option<String>,
    /// The active `JAVA_HOME` (from `java.home`, or the JAVA_HOME env).
    pub java_home: Option<String>,
}

/// Detect the active JDK (respecting any override): `java`/`javac` paths, version,
/// vendor, and JAVA_HOME — for the Settings → Java tab.
#[tauri::command]
pub fn toolchain_info() -> ToolchainInfo {
    let dir = crate::toolchain::dir();
    let java = which("java");
    let javac = which("javac");

    // `-XshowSettings:properties -version` prints `  key = value` lines to stderr.
    let props = crate::toolchain::capture_all("java", &["-XshowSettings:properties", "-version"]).unwrap_or_default();
    let prop = |key: &str| {
        props.lines().find_map(|l| {
            l.trim().strip_prefix(&format!("{key} = ")).map(|v| v.trim().to_string())
        })
    };
    let version = prop("java.version").or_else(|| prop("java.specification.version"));
    let vendor = prop("java.vendor");
    let java_home = crate::toolchain::java_home()
        .or_else(|| prop("java.home"))
        .or_else(|| std::env::var("JAVA_HOME").ok());

    ToolchainInfo { dir, java, javac, version, vendor, java_home }
}

/// One JDK installed on the machine, for the Settings → Java picker.
#[derive(serde::Serialize)]
pub struct JdkInfo {
    /// e.g. "OpenJDK 23.0.2".
    pub name: String,
    pub version: String,
    pub vendor: String,
    pub arch: String,
    /// JAVA_HOME of this JDK.
    pub home: String,
    /// Its `bin` directory — what we store as the toolchain override.
    pub bin: String,
}

/// Resolve `p` to an actual JDK home (a directory whose `bin/java` exists),
/// trying the common wrappers (bundle `Contents/Home`, Homebrew keg layout).
fn resolve_jdk_home(p: &Path) -> Option<PathBuf> {
    for cand in [
        p.to_path_buf(),
        p.join("Contents").join("Home"),
        p.join("libexec").join("openjdk.jdk").join("Contents").join("Home"),
    ] {
        if cand.join("bin").join("java").exists() {
            return Some(cand);
        }
    }
    None
}

/// Read a JDK's `release` file for version/vendor/arch (falling back to running
/// `java -version` if it's absent).
fn jdk_info(home: &Path) -> Option<JdkInfo> {
    let bin = home.join("bin");
    if !bin.join("java").exists() {
        return None;
    }
    let release = std::fs::read_to_string(home.join("release")).unwrap_or_default();
    let field = |k: &str| {
        release
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{k}=")))
            .map(|v| v.trim().trim_matches('"').to_string())
    };
    let mut version = field("JAVA_VERSION").unwrap_or_default();
    let mut vendor = field("IMPLEMENTOR").unwrap_or_default();
    let arch = field("OS_ARCH").unwrap_or_default();
    if version.is_empty() {
        // No release file — ask the runtime directly (prints to stderr).
        if let Ok(o) = std::process::Command::new(bin.join("java")).arg("-version").output() {
            let s = String::from_utf8_lossy(&o.stderr);
            if let Some(line) = s.lines().next() {
                if let (Some(a), Some(b)) = (line.find('"'), line.rfind('"')) {
                    if b > a {
                        version = line[a + 1..b].to_string();
                    }
                }
                if line.contains("openjdk") && vendor.is_empty() {
                    vendor = "OpenJDK".into();
                }
            }
        }
    }
    if version.is_empty() {
        return None;
    }
    let name = if vendor.is_empty() { format!("Java {version}") } else { format!("{vendor} {version}") };
    Some(JdkInfo {
        name,
        version,
        vendor,
        arch,
        bin: bin.to_string_lossy().into_owned(),
        home: home.to_string_lossy().into_owned(),
    })
}

/// Immediate subdirectories of `dir` (empty when it's missing).
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default()
}

/// Enumerate the JDKs installed on this machine: the macOS-registered ones plus
/// the usual unregistered install locations (Homebrew, SDKMAN, asdf, both
/// JavaVirtualMachines dirs). Deduplicated by canonical path, newest first.
#[tauri::command]
pub fn detected_jdks() -> Vec<JdkInfo> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // macOS-registered JDKs (via java_home -X).
    if let Ok(o) = std::process::Command::new("/usr/libexec/java_home").arg("-X").output() {
        if o.status.success() {
            let text = String::from_utf8_lossy(&o.stdout);
            for chunk in text.split("<dict>").skip(1) {
                let dict = chunk.split("</dict>").next().unwrap_or("");
                if let Some(home) = plist_string(dict, "JVMHomePath") {
                    if !home.is_empty() {
                        candidates.push(PathBuf::from(home));
                    }
                }
            }
        }
    }

    let home_env = std::env::var("HOME").unwrap_or_default();
    // Bundle dirs: each <dir>/<jdk>/Contents/Home.
    for parent in [
        "/Library/Java/JavaVirtualMachines".to_string(),
        format!("{home_env}/Library/Java/JavaVirtualMachines"),
    ] {
        candidates.extend(subdirs(Path::new(&parent)));
    }
    // Homebrew opt symlinks: /opt/homebrew/opt/openjdk*, /usr/local/opt/openjdk*.
    for base in ["/opt/homebrew/opt", "/usr/local/opt"] {
        for d in subdirs(Path::new(base)) {
            if d.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("openjdk")).unwrap_or(false) {
                candidates.push(d);
            }
        }
    }
    // Homebrew Cellar: /opt/homebrew/Cellar/openjdk*/<version>.
    for base in ["/opt/homebrew/Cellar", "/usr/local/Cellar"] {
        for keg in subdirs(Path::new(base)) {
            if keg.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("openjdk")).unwrap_or(false) {
                candidates.extend(subdirs(&keg));
            }
        }
    }
    // Version managers: SDKMAN and asdf.
    candidates.extend(subdirs(Path::new(&format!("{home_env}/.sdkman/candidates/java"))));
    candidates.extend(subdirs(Path::new(&format!("{home_env}/.asdf/installs/java"))));

    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut jdks: Vec<JdkInfo> = Vec::new();
    for c in candidates {
        let Some(home) = resolve_jdk_home(&c) else { continue };
        let canon = std::fs::canonicalize(&home).unwrap_or_else(|_| home.clone());
        if !seen.insert(canon) {
            continue; // same JDK reached via a symlink/alias
        }
        if let Some(info) = jdk_info(&home) {
            jdks.push(info);
        }
    }
    // Newest first (by leading version number, then full string).
    let major = |v: &str| v.split('.').next().unwrap_or("0").parse::<u32>().unwrap_or(0);
    jdks.sort_by(|a, b| major(&b.version).cmp(&major(&a.version)).then(b.version.cmp(&a.version)));
    jdks
}

/// The `<string>` value following `<key>KEY</key>` in a plist `<dict>` fragment.
fn plist_string(dict: &str, key: &str) -> Option<String> {
    let k = format!("<key>{key}</key>");
    let after = &dict[dict.find(&k)? + k.len()..];
    let s = after.find("<string>")? + "<string>".len();
    let e = after[s..].find("</string>")? + s;
    Some(after[s..e].trim().to_string())
}

/// A discovered (or missing) external tool the IDE relies on.
#[derive(serde::Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub path: Option<String>,
    pub hint: String,
}

fn which(bin: &str) -> Option<String> {
    if let Some(d) = crate::toolchain::dir() {
        let p = Path::new(&d).join(bin);
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    let out = std::process::Command::new("which")
        .arg(bin)
        .env("PATH", crate::toolchain::effective_path())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!p.is_empty()).then_some(p)
}

fn tool(name: &str, path: Option<String>, hint: &str) -> ToolInfo {
    ToolInfo { name: name.to_string(), path, hint: hint.to_string() }
}

/// Paths to the external tools the IDE uses, for the Settings → Tools tab.
#[tauri::command]
pub fn tool_paths() -> Vec<ToolInfo> {
    vec![
        tool("java", which("java"), "Java runtime — install a JDK (e.g. `brew install openjdk@17`)."),
        tool("javac", which("javac"), "Java compiler — part of the JDK."),
        tool("mvn", which("mvn"), "Maven build tool — `brew install maven` (or use the wrapper)."),
        tool("gradle", which("gradle"), "Gradle build tool — `brew install gradle` (or use the wrapper)."),
        tool("jdtls", crate::lsp::find_jdtls(&std::env::temp_dir()).map(|l| l.program), "Java language server — `brew install jdtls`."),
        tool("google-java-format", find_google_java_format(), "Code formatter — `brew install google-java-format`."),
        tool("java-debug", crate::lsp::find_java_debug_bundle().map(|p| p.to_string_lossy().into_owned()), "Debugger plugin — install java-debug or set JAVA_DEBUG_BUNDLE to its plugin jar."),
        tool(
            "claude",
            llm::find_claude_cli().map(|p| p.to_string_lossy().into_owned()),
            "Claude CLI — optional AI backend.",
        ),
    ]
}

/// Review the given Rust file: quality rating + individually-applicable
/// suggestions. Partial output streams via the `ai:review-progress` event.
#[tauri::command]
pub async fn review_code(
    path: String,
    code: String,
    app: tauri::AppHandle,
) -> Result<llm::Review, String> {
    let mut last_err: Option<String> = None;
    if let Some(cli) = llm::find_claude_cli() {
        let emit = |acc: &str| {
            let _ = app.emit("ai:review-progress", acc.to_string());
        };
        match llm::review_via_cli(&cli, &path, &code, emit).await {
            Ok(r) => return Ok(r),
            Err(e) => {
                eprintln!("claude CLI review failed: {e}");
                last_err = Some(e.to_string());
            }
        }
    }
    if let Some(key) = llm::get_api_key() {
        return llm::review_via_api(&key, &path, &code).await.map_err(|e| e.to_string());
    }
    Err(last_err.unwrap_or_else(|| {
        "No AI backend. Install the Claude CLI or add an API key in Settings.".to_string()
    }))
}

/// Explain a file or a selection in plain language; streams via `ai:text-progress`.
#[tauri::command]
pub async fn explain_code(
    label: String,
    code: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let emit = |acc: &str| {
        let _ = app.emit("ai:text-progress", acc.to_string());
    };
    let mut last_err: Option<String> = None;
    if let Some(cli) = llm::find_claude_cli() {
        match llm::explain_via_cli(&cli, &label, &code, emit).await {
            Ok(t) => return Ok(t),
            Err(e) => {
                eprintln!("claude CLI explain failed: {e}");
                last_err = Some(e.to_string());
            }
        }
    }
    if let Some(key) = llm::get_api_key() {
        return llm::explain_via_api(&key, &label, &code).await.map_err(|e| e.to_string());
    }
    Err(last_err.unwrap_or_else(|| {
        "No AI backend. Install the Claude CLI or add an API key in Settings.".to_string()
    }))
}

/// Agentic chat: the claude CLI edits files in the project directly (no separate
/// apply step). Streams tokens/tool-activity via `ai:chat-progress`. Requires the
/// CLI backend; errors otherwise so the frontend can fall back to text chat.
#[tauri::command]
pub async fn chat_agent(
    messages: Vec<llm::ChatMsg>,
    root: String,
    file_path: Option<String>,
    plan_only: bool,
    state: State<'_, AppState>,
    agent: State<'_, AgentState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let dir = PathBuf::from(&root);
    ensure_within_projects(&dir, &state)?;
    let cli = llm::find_claude_cli().ok_or("The agent needs the Claude CLI. Install it, or the assistant stays in read-only chat mode.")?;
    agent.0.cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    let emit = |acc: &str| {
        let _ = app.emit("ai:chat-progress", acc.to_string());
    };
    let emit_status = |s: &str| {
        if let Some(path) = s.strip_prefix("\u{1}EDIT\u{1}") {
            let _ = app.emit("ai:agent-edit", path.to_string());
        } else {
            let _ = app.emit("ai:chat-status", s.to_string());
        }
    };
    llm::agent_via_cli(&cli, &dir, file_path.as_deref(), &messages, plan_only, &agent.0, emit, emit_status)
        .await
        .map_err(|e| e.to_string())
}

/// Stop the currently running agent (kills the CLI process).
#[tauri::command]
pub fn chat_cancel(agent: State<'_, AgentState>) {
    agent.0.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    let pid = *agent.0.pid.lock().unwrap();
    if let Some(pid) = pid {
        let _ = std::process::Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
    }
}

/// AI Assistant chat: a multi-turn conversation, grounded in the open file.
/// Streams tokens via `ai:chat-progress`, returns the final assistant reply.
#[tauri::command]
pub async fn chat_send(
    messages: Vec<llm::ChatMsg>,
    context: Option<String>,
    root: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let emit = |acc: &str| {
        let _ = app.emit("ai:chat-progress", acc.to_string());
    };

    // Build the workspace context: the open file first, then a digest of the
    // project's source (paths + contents, budgeted).
    let mut ctx_buf = String::new();
    if let Some(f) = context.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        ctx_buf.push_str("## Currently open file\n\n```rust\n");
        ctx_buf.push_str(f);
        ctx_buf.push_str("\n```\n\n");
    }
    if let Some(r) = root.as_deref() {
        let dir = PathBuf::from(r);
        if ensure_within_projects(&dir, &state).is_ok() {
            let digest = project_digest(&dir, 48_000);
            if !digest.is_empty() {
                ctx_buf.push_str("## Project source\n\n");
                ctx_buf.push_str(&digest);
            }
        }
    }
    let ctx = if ctx_buf.trim().is_empty() { None } else { Some(ctx_buf.as_str()) };

    let mut last_err: Option<String> = None;
    if let Some(cli) = llm::find_claude_cli() {
        match llm::chat_via_cli(&cli, ctx, &messages, emit).await {
            Ok(t) => return Ok(t),
            Err(e) => {
                eprintln!("claude CLI chat failed: {e}");
                last_err = Some(e.to_string());
            }
        }
    }
    if let Some(key) = llm::get_api_key() {
        return llm::chat_via_api(&key, ctx, &messages).await.map_err(|e| e.to_string());
    }
    Err(last_err.unwrap_or_else(|| {
        "No AI backend. Install the Claude CLI or add an API key in Settings.".to_string()
    }))
}

const DIGEST_SKIP: &[&str] = &["target", "node_modules", ".git", ".idea", ".vscode", "dist"];

/// A digest of the project's source for chat context: a file listing followed by
/// each Rust file / manifest's contents, up to `budget` bytes total.
fn project_digest(root: &Path, budget: usize) -> String {
    let mut files: Vec<(String, String)> = Vec::new();
    collect_sources(root, root, &mut files);
    // Cargo.toml(s) first, then the rest by path.
    files.sort_by(|a, b| {
        let am = a.0.ends_with("Cargo.toml");
        let bm = b.0.ends_with("Cargo.toml");
        bm.cmp(&am).then_with(|| a.0.cmp(&b.0))
    });
    if files.is_empty() {
        return String::new();
    }

    let mut out = String::from("Files:\n");
    for (rel, _) in &files {
        out.push_str(&format!("- {rel}\n"));
    }
    out.push('\n');

    let mut used = 0usize;
    for (rel, content) in &files {
        if used >= budget {
            out.push_str("\n…(remaining files omitted for length)…\n");
            break;
        }
        let body = truncate_chars(content, budget - used);
        let lang = if rel.ends_with(".toml") { "toml" } else { "rust" };
        out.push_str(&format!("### {rel}\n```{lang}\n{body}\n```\n\n"));
        used += body.len();
    }
    out
}

fn collect_sources(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if !DIGEST_SKIP.contains(&name) {
                collect_sources(root, &path, out);
            }
        } else if name.ends_with(".rs") || name == "Cargo.toml" {
            if let Ok(content) = std::fs::read_to_string(&path) {
                let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().to_string();
                out.push((rel, content));
            }
        }
    }
}

/// Truncate a string to at most `max` bytes, on a char boundary.
fn truncate_chars(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Locate the `google-java-format` launcher: common Homebrew/user locations, then
/// PATH. The launcher wraps `java -jar …` (with the JDK 16+ `--add-exports` flags),
/// so we don't have to hunt for the jar ourselves.
pub fn find_google_java_format() -> Option<String> {
    for p in [
        "/opt/homebrew/bin/google-java-format",
        "/usr/local/bin/google-java-format",
    ] {
        if Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let c = format!("{home}/.local/bin/google-java-format");
        if Path::new(&c).exists() {
            return Some(c);
        }
    }
    if let Ok(out) = std::process::Command::new("which")
        .arg("google-java-format")
        .env("PATH", crate::toolchain::effective_path())
        .output()
    {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return Some(p);
            }
        }
    }
    None
}

/// Format Java source with google-java-format, reading/writing via stdio so the
/// editor buffer can be reformatted without touching disk. `edition` is accepted
/// for signature compatibility but ignored (the formatter needs no language level).
/// Format via google-java-format reading stdin (`-`), optionally in AOSP style.
fn google_java_format(text: &str, aosp: bool) -> Result<String, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let gjf = find_google_java_format()
        .ok_or("google-java-format not found. Install it with `brew install google-java-format`.")?;
    let mut cmd = Command::new(&gjf);
    if aosp {
        cmd.arg("--aosp");
    }
    let mut child = cmd
        .arg("-")
        .env("PATH", crate::toolchain::effective_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("running google-java-format: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("google-java-format stdin unavailable")?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err.trim().trim_start_matches("error: ").to_string())
    }
}

/// Organize imports for a Java file (JDT source action); returns the new text.
#[tauri::command]
pub async fn organize_imports(
    root: String,
    path: String,
    text: String,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<String, String> {
    let mut guard = lsp.0.lock().await;
    let client = ensure_client(&mut guard, &app, &root).await?;
    client.organize_imports(&path, &text).await.map_err(|e| e.to_string())
}

/// Set the active Java code style. `kind` is "google" | "aosp" | "eclipse";
/// for "eclipse", `path` is the formatter `.xml` and `profile` an optional name.
#[tauri::command]
pub fn set_code_style(kind: String, path: Option<String>, profile: Option<String>) {
    let style = match kind.as_str() {
        "aosp" => crate::codestyle::Style::Aosp,
        "eclipse" => crate::codestyle::Style::Eclipse { path: path.unwrap_or_default(), profile },
        _ => crate::codestyle::Style::Google,
    };
    crate::codestyle::set(style);
}

/// Format Java source with the active code style. Google/AOSP go through
/// google-java-format; an imported Eclipse profile goes through the JDT server.
#[tauri::command]
pub async fn format_java(
    root: Option<String>,
    path: Option<String>,
    text: String,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<String, String> {
    match crate::codestyle::get() {
        crate::codestyle::Style::Google => {
            tokio::task::spawn_blocking(move || google_java_format(&text, false)).await.map_err(|e| e.to_string())?
        }
        crate::codestyle::Style::Aosp => {
            tokio::task::spawn_blocking(move || google_java_format(&text, true)).await.map_err(|e| e.to_string())?
        }
        crate::codestyle::Style::Eclipse { path: xml, profile } => {
            let root = root.ok_or("no project open for Eclipse-profile formatting")?;
            let path = path.ok_or("no file path for Eclipse-profile formatting")?;
            let mut guard = lsp.0.lock().await;
            let client = ensure_client(&mut guard, &app, &root).await?;
            let url = if xml.starts_with("file://") { xml.clone() } else { format!("file://{xml}") };
            client
                .format_eclipse(&path, &text, &url, profile.as_deref())
                .await
                .map_err(|e| format!("Eclipse formatter: {e}"))
        }
    }
}

/// Suggest a fix for a compiler/clippy error; streams via `ai:text-progress`.
#[tauri::command]
pub async fn fix_error(error: String, code: String, app: tauri::AppHandle) -> Result<String, String> {
    let emit = |acc: &str| {
        let _ = app.emit("ai:text-progress", acc.to_string());
    };
    let mut last_err: Option<String> = None;
    if let Some(cli) = llm::find_claude_cli() {
        match llm::fix_via_cli(&cli, &error, &code, emit).await {
            Ok(t) => return Ok(t),
            Err(e) => {
                eprintln!("claude CLI fix failed: {e}");
                last_err = Some(e.to_string());
            }
        }
    }
    if let Some(key) = llm::get_api_key() {
        return llm::fix_via_api(&key, &error, &code).await.map_err(|e| e.to_string());
    }
    Err(last_err.unwrap_or_else(|| {
        "No AI backend. Install the Claude CLI or add an API key in Settings.".to_string()
    }))
}

// --- LSP (rust-analyzer) ----------------------------------------------------

/// Lazily-started rust-analyzer, one per project root. Held in Tauri state.
#[derive(Default)]
pub struct LspState(pub tokio::sync::Mutex<Option<crate::lsp::LspClient>>);

/// Control handle for the running AI agent CLI (for Stop). Held in Tauri state.
#[derive(Default)]
pub struct AgentState(pub std::sync::Arc<llm::AgentHandle>);

/// Ensure rust-analyzer is running for `root`, (re)starting on project change.
async fn ensure_client<'a>(
    guard: &'a mut tokio::sync::MutexGuard<'_, Option<crate::lsp::LspClient>>,
    app: &tauri::AppHandle,
    root: &str,
) -> Result<&'a crate::lsp::LspClient, String> {
    let needs_start = guard.as_ref().map(|c| c.root() != root).unwrap_or(true);
    if needs_start {
        **guard = Some(
            crate::lsp::LspClient::start(app.clone(), root)
                .await
                .map_err(|e| e.to_string())?,
        );
    }
    Ok(guard.as_ref().expect("just started"))
}

#[tauri::command]
pub async fn lsp_completion(
    root: String,
    path: String,
    text: String,
    line: u32,
    character: u32,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<Vec<crate::lsp::CompletionItem>, String> {
    let mut guard = lsp.0.lock().await;
    let client = ensure_client(&mut guard, &app, &root).await?;
    client
        .completion(&path, &text, line, character)
        .await
        .map_err(|e| e.to_string())
}

/// Tell rust-analyzer the current text of a file so it re-checks and pushes
/// diagnostics. Called when a file opens and (debounced) as it is edited.
#[tauri::command]
pub async fn lsp_sync(
    root: String,
    path: String,
    text: String,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<(), String> {
    let mut guard = lsp.0.lock().await;
    let client = ensure_client(&mut guard, &app, &root).await?;
    client.sync(&path, &text).await.map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct Definition {
    pub path: String,
    /// 0-based, as LSP reports it.
    pub line: u32,
    pub character: u32,
}

/// The definition site of the symbol at a position, or null.
#[tauri::command]
pub async fn lsp_definition(
    root: String,
    path: String,
    text: String,
    line: u32,
    character: u32,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<Option<Definition>, String> {
    let mut guard = lsp.0.lock().await;
    let client = ensure_client(&mut guard, &app, &root).await?;
    let target = client
        .definition(&path, &text, line, character)
        .await
        .map_err(|e| e.to_string())?;
    Ok(target.map(|(path, line, character)| Definition { path, line, character }))
}

/// Decompiled/attached source for a `jdt://` class-file URI (library classes
/// reached via Go to Definition), as plain text.
#[tauri::command]
pub async fn lsp_class_file_contents(
    root: String,
    uri: String,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<String, String> {
    let mut guard = lsp.0.lock().await;
    let client = ensure_client(&mut guard, &app, &root).await?;
    client.class_file_contents(&uri).await.map_err(|e| e.to_string())
}

/// Find all usages of the symbol at a position (LSP references).
#[tauri::command]
pub async fn lsp_references(
    root: String,
    path: String,
    text: String,
    line: u32,
    character: u32,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<Vec<crate::lsp::Reference>, String> {
    let mut guard = lsp.0.lock().await;
    let client = ensure_client(&mut guard, &app, &root).await?;
    client.references(&path, &text, line, character).await.map_err(|e| e.to_string())
}

/// Rename the symbol at a position project-wide (LSP rename). Returns per-file edits.
#[tauri::command]
pub async fn lsp_rename(
    root: String,
    path: String,
    text: String,
    line: u32,
    character: u32,
    new_name: String,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<Vec<crate::lsp::FileEdit>, String> {
    let mut guard = lsp.0.lock().await;
    let client = ensure_client(&mut guard, &app, &root).await?;
    client.rename(&path, &text, line, character, &new_name).await.map_err(|e| e.to_string())
}

/// Code actions (quick fixes / assists) for a range — the ⌥⏎ menu.
#[tauri::command]
pub async fn code_action(
    root: String,
    path: String,
    text: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<Vec<crate::lsp::CodeActionItem>, String> {
    let mut guard = lsp.0.lock().await;
    let client = ensure_client(&mut guard, &app, &root).await?;
    client
        .code_action(&path, &text, (start_line, start_character), (end_line, end_character))
        .await
        .map_err(|e| e.to_string())
}

/// Hover info (type + docs) at a position, as Markdown, or null.
#[tauri::command]
pub async fn lsp_hover(
    root: String,
    path: String,
    text: String,
    line: u32,
    character: u32,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<Option<String>, String> {
    let mut guard = lsp.0.lock().await;
    let client = ensure_client(&mut guard, &app, &root).await?;
    client
        .hover(&path, &text, line, character)
        .await
        .map_err(|e| e.to_string())
}

/// The file was saved: sync its text, then send didSave so rust-analyzer re-runs
/// cargo check and clears any now-fixed flycheck diagnostics.
#[tauri::command]
pub async fn lsp_did_save(
    root: String,
    path: String,
    text: String,
    app: tauri::AppHandle,
    lsp: State<'_, LspState>,
) -> Result<(), String> {
    let mut guard = lsp.0.lock().await;
    let client = ensure_client(&mut guard, &app, &root).await?;
    client.sync(&path, &text).await.map_err(|e| e.to_string())?;
    client.did_save(&path).await.map_err(|e| e.to_string())
}

// --- Safety -----------------------------------------------------------------

/// Every filesystem command goes through this: the target (or its nearest
/// existing ancestor, for paths being created) must sit inside a registered
/// project, so a compromised frontend can't read or write arbitrary files.
/// Read guard: within a project, OR under the read-only source roots that Go to
/// Definition legitimately lands in (cargo registry/git checkouts, rustup std).
fn ensure_readable(target: &Path, state: &AppState) -> Result<(), String> {
    if ensure_within_projects(target, state).is_ok() {
        return Ok(());
    }
    let canonical = std::fs::canonicalize(target).map_err(|e| e.to_string())?;
    let home = std::env::var("HOME").unwrap_or_default();
    let roots = [
        format!("{home}/.cargo/registry/src"),
        format!("{home}/.cargo/git/checkouts"),
        format!("{home}/.rustup/toolchains"),
    ];
    if roots.iter().any(|r| canonical.starts_with(r)) {
        Ok(())
    } else {
        Err(format!("not readable: {}", target.display()))
    }
}

fn ensure_within_projects(target: &Path, state: &AppState) -> Result<(), String> {
    let roots: Vec<PathBuf> = state
        .projects
        .lock()
        .unwrap()
        .iter()
        .filter_map(|p| std::fs::canonicalize(&p.path).ok())
        .collect();
    if roots.is_empty() {
        return Err("no project is open".to_string());
    }

    let mut probe = target.to_path_buf();
    let canonical = loop {
        if let Ok(c) = std::fs::canonicalize(&probe) {
            break c;
        }
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => return Err(format!("path is outside any open project: {}", target.display())),
        }
    };

    if roots.iter().any(|r| canonical.starts_with(r)) {
        Ok(())
    } else {
        Err(format!("path is outside any open project: {}", target.display()))
    }
}

// --- Debugger (java-debug over DAP, hosted by the JDT server) ---------------

/// The active debug session, if any. One at a time.
#[derive(Default)]
pub struct DapState(pub tokio::sync::Mutex<Option<crate::dap::DapClient>>);

/// The java-debug plugin bundle path, or null when it isn't installed (so the UI
/// can disable debugging and explain how to install it).
#[tauri::command]
pub fn debugger_adapter() -> Option<String> {
    crate::lsp::find_java_debug_bundle().map(|p| p.to_string_lossy().into_owned())
}

/// Download Microsoft's java-debug plugin (from the official "Debugger for Java"
/// extension on Open VSX) and install just its plugin jar into
/// `~/.local/share/java-debug/`, where the IDE auto-detects it. Returns the jar
/// path. A no-op (returns the existing path) when already installed.
#[tauri::command]
pub async fn install_java_debug() -> Result<String, String> {
    if let Some(p) = crate::lsp::find_java_debug_bundle() {
        return Ok(p.to_string_lossy().into_owned());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    // 1. Resolve the latest VSIX download URL.
    let meta: serde_json::Value = client
        .get("https://open-vsx.org/api/vscjava/vscode-java-debug/latest")
        .send()
        .await
        .map_err(|e| format!("fetching extension metadata: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parsing metadata: {e}"))?;
    let url = meta
        .get("files")
        .and_then(|f| f.get("download"))
        .and_then(|d| d.as_str())
        .ok_or("no download URL in the extension metadata")?;

    // 2. Download the .vsix (a zip) to a temp file.
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("downloading java-debug: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let tmp = std::env::temp_dir().join("vscode-java-debug.vsix");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("writing download: {e}"))?;

    // 3. Extract only the plugin jar (flat) into the auto-detected directory.
    let home = std::env::var("HOME").map_err(|_| "no HOME directory")?;
    let dest = PathBuf::from(&home).join(".local/share/java-debug");
    std::fs::create_dir_all(&dest).map_err(|e| format!("creating {}: {e}", dest.display()))?;
    let out = std::process::Command::new("unzip")
        .arg("-o")
        .arg("-j") // junk paths: land the jar directly in dest
        .arg(&tmp)
        .arg("extension/server/com.microsoft.java.debug.plugin-*.jar")
        .arg("-d")
        .arg(&dest)
        .output()
        .map_err(|e| format!("running unzip: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    if !out.status.success() {
        return Err(format!("extracting the plugin failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }

    crate::lsp::find_java_debug_bundle()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "installed, but the plugin jar wasn't found afterward".into())
}

/// Compile the project, then launch the chosen main class under java-debug with the
/// given breakpoints. The DAP server runs inside the JDT language server: we ask it
/// to start a session (a TCP port) and resolve the launch classpath, then connect.
/// Any prior session is torn down first.
#[tauri::command]
pub async fn debug_start(
    root: String,
    kind: String,
    name: Option<String>,
    args: Vec<String>,
    breakpoints: HashMap<String, Vec<crate::dap::SourceBp>>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    lsp: State<'_, LspState>,
    dap: State<'_, DapState>,
) -> Result<(), String> {
    let r = PathBuf::from(&root);
    ensure_within_projects(&r, &state)?;
    if kind == "test" {
        return Err("Debugging tests isn't supported yet — debug a class with a main method.".into());
    }
    let main_class = name.filter(|s| !s.is_empty()).ok_or("Set a main class on the run configuration to debug it.")?;

    // Note: we deliberately do NOT run `mvn/gradle compile` here. JDT.LS builds
    // the project incrementally (into target/classes) on import and on save, so
    // the classes java-debug launches are already up to date — this is how the
    // VS Code Java debugger works too. Running the build ourselves would compile
    // the whole reactor in a multi-module project (e.g. libGDX android/ios/html
    // modules), which is slow and often fails, hanging the "Building…" step.

    // 1. Ask the JDT server (which hosts java-debug) to resolve the classpath and
    //    start a DAP session. Do the JDT work under the lock; release it before the
    //    (potentially slow) Maven fallback and the debug session itself.
    let (jdt, port) = {
        let mut guard = lsp.0.lock().await;
        let client = ensure_client(&mut guard, &app, &root).await?;
        let jdt = async {
            let (rm, proj) = client.resolve_launch_target(&main_class).await?;
            let (mp, cp) = client.resolve_classpath(&rm, &proj).await?;
            anyhow::Ok((rm, mp, cp, proj))
        }
        .await;
        // The DAP server itself always comes from the JDT plugin.
        let port = client
            .start_debug_session()
            .await
            .map_err(|e| format!("starting debug session: {e}"))?;
        (jdt, port)
    };
    let (main_class, module_paths, class_paths, project) = match jdt {
        Ok((rm, mp, cp, proj)) if !cp.is_empty() => (rm, mp, cp, proj),
        // The JDT server couldn't resolve the project (e.g. its embedded Maven
        // import failed on a sibling module of a multi-module reactor, or the
        // modules are gated behind profiles). Compute the classpath ourselves via
        // Maven, scoped to the owning module.
        other => {
            if let Err(e) = &other {
                let _ = app.emit(
                    "cargo:event",
                    cargo::CargoEvent::Line {
                        stream: "stdout".into(),
                        text: format!("Language server couldn't resolve the classpath ({e}); resolving with Maven…"),
                    },
                );
            }
            let (project, cp) = cargo::classpath_for_main(app.clone(), &r, &main_class)
                .await
                .map_err(|e| format!("resolving classpath with Maven: {e}"))?;
            (main_class.clone(), Vec::new(), cp, project)
        }
    };

    // 2. Build the java-debug launch config and connect to the DAP server.
    // Source roots let the adapter map a paused frame's class back to its .java
    // file (so the editor can follow), which it otherwise gets from the language
    // server — unavailable when the project didn't import cleanly.
    let source_paths = cargo::source_roots(&r);
    let launch = serde_json::json!({
        "type": "java",
        "request": "launch",
        "name": main_class,
        "mainClass": main_class,
        "projectName": project,
        "classPaths": class_paths,
        "modulePaths": module_paths,
        "sourcePaths": source_paths,
        "cwd": root,
        "args": args.join(" "),
        "vmArgs": "",
        "console": "internalConsole",
        "stopOnEntry": false,
        "shortenCommandLine": "auto",
        // Skip stepping through JDK/runtime internals (class loading, reflection,
        // synthetics) so Step Into/Over stays in the user's — and library — code
        // instead of getting lost in ClassLoader.loadClass etc.
        "stepFilters": {
            "classNameFilters": [
                "java.*", "javax.*", "jakarta.*", "sun.*", "com.sun.*",
                "jdk.*", "kotlin.*", "scala.*", "org.junit.*"
            ],
            "skipSynthetics": true,
            "skipStaticInitializers": true,
            "skipConstructors": false
        },
    });

    if let Some(prev) = dap.0.lock().await.take() {
        let _ = prev.disconnect().await;
    }
    let client = crate::dap::DapClient::start(app.clone(), port, launch, &breakpoints)
        .await
        .map_err(|e| e.to_string())?;
    *dap.0.lock().await = Some(client);
    Ok(())
}

/// Update breakpoints for one file mid-session (no-op when not debugging).
#[tauri::command]
pub async fn debug_set_breakpoints(
    path: String,
    breakpoints: Vec<crate::dap::SourceBp>,
    dap: State<'_, DapState>,
) -> Result<(), String> {
    let guard = dap.0.lock().await;
    match guard.as_ref() {
        Some(c) => c.set_breakpoints(&path, &breakpoints).await.map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn debug_continue(thread_id: i64, dap: State<'_, DapState>) -> Result<(), String> {
    let g = dap.0.lock().await;
    g.as_ref().ok_or("no debug session")?.continue_(thread_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn debug_next(thread_id: i64, dap: State<'_, DapState>) -> Result<(), String> {
    let g = dap.0.lock().await;
    g.as_ref().ok_or("no debug session")?.next(thread_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn debug_step_in(thread_id: i64, dap: State<'_, DapState>) -> Result<(), String> {
    let g = dap.0.lock().await;
    g.as_ref().ok_or("no debug session")?.step_in(thread_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn debug_step_out(thread_id: i64, dap: State<'_, DapState>) -> Result<(), String> {
    let g = dap.0.lock().await;
    g.as_ref().ok_or("no debug session")?.step_out(thread_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn debug_pause(thread_id: i64, dap: State<'_, DapState>) -> Result<(), String> {
    let g = dap.0.lock().await;
    g.as_ref().ok_or("no debug session")?.pause(thread_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn debug_stack(
    thread_id: i64,
    dap: State<'_, DapState>,
) -> Result<Vec<crate::dap::StackFrame>, String> {
    let g = dap.0.lock().await;
    g.as_ref().ok_or("no debug session")?.stack_trace(thread_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn debug_scopes(
    frame_id: i64,
    dap: State<'_, DapState>,
) -> Result<Vec<crate::dap::Scope>, String> {
    let g = dap.0.lock().await;
    g.as_ref().ok_or("no debug session")?.scopes(frame_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn debug_variables(
    variables_reference: i64,
    dap: State<'_, DapState>,
) -> Result<Vec<crate::dap::Variable>, String> {
    let g = dap.0.lock().await;
    g.as_ref()
        .ok_or("no debug session")?
        .variables(variables_reference)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn debug_eval(
    frame_id: i64,
    expr: String,
    dap: State<'_, DapState>,
) -> Result<crate::dap::EvalResult, String> {
    let g = dap.0.lock().await;
    g.as_ref().ok_or("no debug session")?.evaluate(frame_id, &expr).await.map_err(|e| e.to_string())
}

/// REPL completions for the Debug Console's evaluate box.
#[tauri::command]
pub async fn debug_completions(
    frame_id: i64,
    text: String,
    column: i64,
    dap: State<'_, DapState>,
) -> Result<Vec<crate::dap::CompletionItem>, String> {
    let g = dap.0.lock().await;
    // No session / adapter without completion support → just no suggestions.
    match g.as_ref() {
        Some(c) => Ok(c.completions(frame_id, &text, column).await.unwrap_or_default()),
        None => Ok(Vec::new()),
    }
}

/// Assign a new value to a variable shown in the debug window.
#[tauri::command]
pub async fn debug_set_variable(
    variables_reference: i64,
    name: String,
    value: String,
    dap: State<'_, DapState>,
) -> Result<crate::dap::EvalResult, String> {
    let g = dap.0.lock().await;
    g.as_ref()
        .ok_or("no debug session")?
        .set_variable(variables_reference, &name, &value)
        .await
        .map_err(|e| e.to_string())
}

/// End the session and terminate the debuggee.
#[tauri::command]
pub async fn debug_stop(dap: State<'_, DapState>) -> Result<(), String> {
    if let Some(c) = dap.0.lock().await.take() {
        let _ = c.disconnect().await;
    }
    Ok(())
}


