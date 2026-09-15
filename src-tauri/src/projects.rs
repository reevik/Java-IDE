use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

/// A Java project the user has opened — the directory holding its build file
/// (`pom.xml`, `build.gradle`, or `build.gradle.kts`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProjectRef {
    pub path: String,
    pub name: String,
}

/// What we can learn about a project without invoking Maven/Gradle: enough to
/// label the UI and populate the run/test targets.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub version: String,
    /// Java language level, e.g. "17" (from `maven.compiler.release`,
    /// `<source>`, `java.version`, or Gradle's `sourceCompatibility`). May be "".
    pub edition: String,
    /// True for a multi-module build (Maven `<modules>` / Gradle `include`).
    pub is_workspace: bool,
    /// Sub-module names of a multi-module build; empty for a single project.
    pub members: Vec<String>,
    /// Fully-qualified classes with a `public static void main` — the run/debug
    /// targets. (Field name kept as `bins` for frontend-type stability.)
    pub bins: Vec<String>,
    /// True when the project has a `src/main/java` source root.
    pub has_lib: bool,
}

/// The build tool backing a project directory.
pub enum BuildFile {
    Maven(PathBuf),
    Gradle(PathBuf),
}

/// Locate the project's build file, preferring Maven when both are present.
pub fn build_file(dir: &Path) -> Option<BuildFile> {
    let pom = dir.join("pom.xml");
    if pom.is_file() {
        return Some(BuildFile::Maven(pom));
    }
    for g in ["build.gradle", "build.gradle.kts"] {
        let p = dir.join(g);
        if p.is_file() {
            return Some(BuildFile::Gradle(p));
        }
    }
    None
}

/// True when `dir` is the root of a Java project.
pub fn is_java_project(dir: &Path) -> bool {
    build_file(dir).is_some()
}

/// Extract the inner text of the first `<tag>…</tag>` in `xml` (tolerant, no deps).
fn xml_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let rest = &xml[start..];
    let end = rest.find(&close)?;
    Some(rest[..end].trim())
}

/// The `<properties>` block of a pom (where compiler settings usually live).
fn pom_properties(xml: &str) -> &str {
    xml_tag(xml, "properties").unwrap_or("")
}

/// Reads the build file. Deliberately tolerant: a file we can't fully parse
/// still yields a usable project rather than blocking the user.
pub fn read_info(dir: &Path) -> Result<ProjectInfo> {
    let Some(bf) = build_file(dir) else {
        bail!("no pom.xml or build.gradle in {}", dir.display());
    };
    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project")
        .to_string();

    let (name, version, edition, members) = match &bf {
        BuildFile::Maven(pom) => {
            let text = std::fs::read_to_string(pom).unwrap_or_default();
            // Ignore the <parent> block's coordinates when reading our own.
            let own = text.rsplit("</parent>").next().unwrap_or(&text);
            let name = xml_tag(own, "name")
                .filter(|s| !s.contains('<'))
                .or_else(|| xml_tag(own, "artifactId"))
                .unwrap_or(&dir_name)
                .to_string();
            let version = xml_tag(own, "version").unwrap_or("").to_string();
            let props = pom_properties(&text);
            let edition = xml_tag(props, "maven.compiler.release")
                .or_else(|| xml_tag(props, "maven.compiler.source"))
                .or_else(|| xml_tag(props, "java.version"))
                .or_else(|| xml_tag(&text, "source"))
                .unwrap_or("")
                .to_string();
            let members = xml_tag(&text, "modules")
                .map(|m| {
                    m.split("<module>")
                        .skip(1)
                        .filter_map(|s| s.split("</module>").next())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (name, version, edition, members)
        }
        BuildFile::Gradle(g) => {
            let text = std::fs::read_to_string(g).unwrap_or_default();
            let settings = ["settings.gradle", "settings.gradle.kts"]
                .iter()
                .map(|s| dir.join(s))
                .find(|p| p.is_file())
                .and_then(|p| std::fs::read_to_string(p).ok())
                .unwrap_or_default();
            let name = gradle_string(&settings, "rootProject.name")
                .or_else(|| gradle_string(&text, "rootProject.name"))
                .unwrap_or_else(|| dir_name.clone());
            let version = gradle_version(dir, &text).unwrap_or_default();
            let edition = gradle_assign(&text, "sourceCompatibility")
                .map(|s| s.trim_start_matches("JavaVersion.VERSION_").replace('_', "."))
                .unwrap_or_default();
            let members = gradle_includes(&settings);
            (name, version, edition, members)
        }
    };

    Ok(ProjectInfo {
        path: dir.to_string_lossy().to_string(),
        name,
        version,
        edition,
        is_workspace: !members.is_empty(),
        members,
        bins: find_main_classes(dir),
        has_lib: dir.join("src/main/java").is_dir(),
    })
}

/// The project version from a Gradle build. A quoted literal (`version = "1.2"`)
/// is used directly; an unquoted reference (`version = projectVersion`) is
/// resolved against `gradle.properties` and, failing that, left empty — never
/// shown as the bare variable name.
fn gradle_version(dir: &Path, text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("version") else { continue };
        // Boundary after `version` so it doesn't match `versionCode` etc.
        if rest.chars().next().map(|c| c.is_alphanumeric() || c == '_').unwrap_or(false) {
            continue;
        }
        let rest = rest.trim_start().strip_prefix('=').unwrap_or("").trim();
        if rest.is_empty() {
            continue;
        }
        // Quoted literal: use it, unless it interpolates a variable (${…}).
        if let Some(q) = rest.chars().next().filter(|&c| c == '"' || c == '\'') {
            let body = &rest[1..];
            if let Some(end) = body.find(q) {
                let v = &body[..end];
                return (!v.is_empty() && !v.contains('$')).then(|| v.to_string());
            }
            return None;
        }
        // Unquoted → a variable/property reference. Resolve a bare identifier
        // from gradle.properties; give up (empty) on anything more complex.
        let ident: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '.').collect();
        return gradle_property(dir, &ident);
    }
    None
}

/// Value of a plain `key=value` line in the project's `gradle.properties`.
fn gradle_property(dir: &Path, key: &str) -> Option<String> {
    let props = std::fs::read_to_string(dir.join("gradle.properties")).ok()?;
    for line in props.lines() {
        let t = line.trim();
        if t.starts_with('#') {
            continue;
        }
        if let Some(rest) = t.strip_prefix(key) {
            if let Some(v) = rest.trim_start().strip_prefix('=') {
                let v = v.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// Value of a Gradle `key = "value"` / `key 'value'` assignment (quotes stripped).
fn gradle_assign(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix(key) else { continue };
        // Require a boundary after the key so `version` doesn't match `versionCode`.
        if rest.chars().next().map(|c| c.is_alphanumeric() || c == '_').unwrap_or(false) {
            continue;
        }
        let rest = rest.trim_start();
        let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
        let v = rest.trim_matches(|c| c == '"' || c == '\'' || c == '(' || c == ')').trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    None
}

/// A quoted Gradle string assigned to `key` anywhere on a line, e.g.
/// `rootProject.name = "demo"`.
fn gradle_string(text: &str, key: &str) -> Option<String> {
    let idx = text.find(key)?;
    let after = &text[idx + key.len()..];
    let q = after.find(['"', '\''])?;
    let quote = after.as_bytes()[q] as char;
    let start = q + 1;
    let end = after[start..].find(quote)? + start;
    Some(after[start..end].to_string())
}

/// Module names from `include 'a', ':b'` lines in a Gradle settings file.
fn gradle_includes(settings: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in settings.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("include") {
            let rest = rest.trim_start_matches(['(', ' ']);
            for part in rest.split(',') {
                let name = part.trim().trim_matches(|c| c == '"' || c == '\'' || c == ')' || c == ' ');
                let name = name.trim_start_matches(':');
                if !name.is_empty() {
                    out.push(name.replace(':', "/"));
                }
            }
        }
    }
    out
}

/// Every fully-qualified class under `src/main/java` (across modules) that
/// declares `public static void main(String…)`.
pub fn find_main_classes(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for root in java_source_roots(dir) {
        scan_mains(&root, &root, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

fn scan_mains(base: &Path, cur: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(cur) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            scan_mains(base, &p, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("java") {
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            if has_main_method(&text) {
                if let Some(fqcn) = fqcn_of(&text, &p) {
                    out.push(fqcn);
                }
            }
        }
    }
}

/// Fully-qualified classes annotated `@SpringBootApplication` (with a main
/// method) — the Spring Boot entry points, for the Spring run configuration.
pub fn find_spring_mains(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for root in java_source_roots(dir) {
        scan_spring(&root, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

fn scan_spring(cur: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(cur) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            scan_spring(&p, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("java") {
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            if text.contains("@SpringBootApplication") && has_main_method(&text) {
                if let Some(fqcn) = fqcn_of(&text, &p) {
                    out.push(fqcn);
                }
            }
        }
    }
}

/// Heuristic detector for a `public static void main(String[] args)` entry point,
/// tolerant of ordering (`static public`), whitespace, and `String...`.
fn has_main_method(src: &str) -> bool {
    for line in src.lines() {
        let t = line.trim();
        if t.contains("void") && t.contains("main") && t.contains("String") {
            let has_pub = t.contains("public");
            let has_static = t.contains("static");
            let before_paren = t.split('(').next().unwrap_or("");
            if has_pub && has_static && before_paren.contains("main") {
                return true;
            }
        }
    }
    false
}

/// Fully-qualified class name from the file's `package` declaration + its stem.
fn fqcn_of(src: &str, file: &Path) -> Option<String> {
    let stem = file.file_stem()?.to_str()?.to_string();
    let pkg = src.lines().find_map(|l| {
        let t = l.trim();
        t.strip_prefix("package ").map(|r| r.trim().trim_end_matches(';').trim().to_string())
    });
    Some(match pkg.filter(|p| !p.is_empty()) {
        Some(p) => format!("{p}.{stem}"),
        None => stem,
    })
}

/// Source roots to scan: `<root>/src/main/java` plus each module's, if any.
fn java_source_roots(dir: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let here = dir.join("src/main/java");
    if here.is_dir() {
        roots.push(here);
    }
    // One level of Maven/Gradle modules (child dirs holding their own build file).
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() && is_java_project(&p) {
                let sr = p.join("src/main/java");
                if sr.is_dir() {
                    roots.push(sr);
                }
            }
        }
    }
    roots
}

/// Registers a directory as a project, keeping the list newest-first and unique.
///
/// The path is canonicalized (resolving symlinks like macOS's `/tmp` →
/// `/private/tmp`) so it matches the paths the language server reports in its
/// diagnostics — otherwise inline error marks never line up.
pub fn add(list: &mut Vec<ProjectRef>, dir: &Path) -> Result<ProjectRef> {
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if !is_java_project(&dir) {
        bail!("{} has no pom.xml or build.gradle", dir.display());
    }
    let info = read_info(&dir)?;
    let entry = ProjectRef {
        path: info.path.clone(),
        name: info.name.clone(),
    };
    list.retain(|p| p.path != entry.path);
    list.insert(0, entry.clone());
    Ok(entry)
}

// --- Packages & dependencies ------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct CrateDep {
    pub name: String,
    pub version: String,
    /// "normal" | "test" | "provided"
    pub kind: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ModuleNode {
    /// Package segment or class name.
    pub name: String,
    /// Dotted package path, e.g. "com.example.net", or the class FQN for a leaf.
    pub path: String,
    /// Absolute `.java` file backing this node (leaf classes only).
    pub file: Option<String>,
    /// Unused for Java (kept for frontend-type stability); always false.
    pub inline: bool,
    pub children: Vec<ModuleNode>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectModules {
    /// The project name (shown as the tree root). Field name kept for stability.
    pub crate_name: String,
    /// Unused for Java (no single root file); always None.
    pub root_file: Option<String>,
    /// The package tree under the source roots.
    pub modules: Vec<ModuleNode>,
    /// Declared dependencies from the build file.
    pub deps: Vec<CrateDep>,
}

/// The project's package tree (folders under `src/main/java`, classes as leaves)
/// plus its declared dependencies (from pom.xml / build.gradle).
pub fn read_modules(dir: &Path) -> Result<ProjectModules> {
    if !is_java_project(dir) {
        bail!("no pom.xml or build.gradle in {}", dir.display());
    }
    let name = read_info(dir).map(|i| i.name).unwrap_or_else(|_| {
        dir.file_name().and_then(|n| n.to_str()).unwrap_or("project").to_string()
    });

    // Merge every source root's packages into one tree.
    let mut modules: Vec<ModuleNode> = Vec::new();
    for root in java_source_roots(dir) {
        for node in package_tree(&root, "") {
            merge_node(&mut modules, node);
        }
    }
    sort_nodes(&mut modules);

    Ok(ProjectModules {
        crate_name: name,
        root_file: None,
        modules,
        deps: read_deps(dir),
    })
}

/// Build package/class nodes for the entries directly under `cur` (a source root
/// or package directory). `prefix` is the dotted package accumulated so far.
fn package_tree(cur: &Path, prefix: &str) -> Vec<ModuleNode> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(cur) else { return out };
    for e in entries.flatten() {
        let p = e.path();
        let Some(seg) = p.file_name().and_then(|n| n.to_str()) else { continue };
        if p.is_dir() {
            let path = if prefix.is_empty() { seg.to_string() } else { format!("{prefix}.{seg}") };
            out.push(ModuleNode {
                name: seg.to_string(),
                path: path.clone(),
                file: None,
                inline: false,
                children: package_tree(&p, &path),
            });
        } else if p.extension().and_then(|x| x.to_str()) == Some("java") {
            let stem = seg.trim_end_matches(".java");
            let fqn = if prefix.is_empty() { stem.to_string() } else { format!("{prefix}.{stem}") };
            out.push(ModuleNode {
                name: stem.to_string(),
                path: fqn,
                file: Some(p.to_string_lossy().into_owned()),
                inline: false,
                children: Vec::new(),
            });
        }
    }
    out
}

/// Merge `node` into `list`, combining packages that share a path (so multiple
/// source roots collapse into one package tree).
fn merge_node(list: &mut Vec<ModuleNode>, node: ModuleNode) {
    if node.file.is_none() {
        if let Some(existing) = list.iter_mut().find(|n| n.file.is_none() && n.path == node.path) {
            for child in node.children {
                merge_node(&mut existing.children, child);
            }
            return;
        }
    }
    list.push(node);
}

fn sort_nodes(nodes: &mut [ModuleNode]) {
    nodes.sort_by(|a, b| {
        // Packages (dirs) before classes, then by name.
        let ad = a.file.is_some();
        let bd = b.file.is_some();
        ad.cmp(&bd).then_with(|| a.name.cmp(&b.name))
    });
    for n in nodes.iter_mut() {
        sort_nodes(&mut n.children);
    }
}

/// Parse declared dependencies from the project's build file.
fn read_deps(dir: &Path) -> Vec<CrateDep> {
    match build_file(dir) {
        Some(BuildFile::Maven(pom)) => maven_deps(&std::fs::read_to_string(pom).unwrap_or_default()),
        Some(BuildFile::Gradle(g)) => gradle_deps(&std::fs::read_to_string(g).unwrap_or_default()),
        None => Vec::new(),
    }
}

fn maven_deps(xml: &str) -> Vec<CrateDep> {
    let mut out = Vec::new();
    for block in xml.split("<dependency>").skip(1) {
        let Some(dep) = block.split("</dependency>").next() else { continue };
        let group = xml_tag(dep, "groupId").unwrap_or("");
        let artifact = xml_tag(dep, "artifactId").unwrap_or("");
        if artifact.is_empty() {
            continue;
        }
        let version = xml_tag(dep, "version").unwrap_or("managed").to_string();
        let scope = match xml_tag(dep, "scope") {
            Some("test") => "test",
            Some("provided") => "provided",
            _ => "normal",
        };
        let name = if group.is_empty() { artifact.to_string() } else { format!("{group}:{artifact}") };
        out.push(CrateDep { name, version, kind: scope.to_string() });
    }
    dedup_sort(out)
}

fn gradle_deps(text: &str) -> Vec<CrateDep> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        let kind = if t.starts_with("testImplementation") || t.starts_with("testRuntimeOnly") || t.starts_with("testCompileOnly") {
            "test"
        } else if t.starts_with("compileOnly") {
            "provided"
        } else if t.starts_with("implementation") || t.starts_with("api") || t.starts_with("runtimeOnly") {
            "normal"
        } else {
            continue;
        };
        // Pull the first quoted "group:artifact:version" coordinate on the line.
        let Some(coord) = first_quoted(t) else { continue };
        let parts: Vec<&str> = coord.split(':').collect();
        if parts.len() < 2 {
            continue;
        }
        let name = format!("{}:{}", parts[0], parts[1]);
        let version = parts.get(2).map(|s| s.to_string()).unwrap_or_else(|| "managed".into());
        out.push(CrateDep { name, version, kind: kind.to_string() });
    }
    dedup_sort(out)
}

/// The first single- or double-quoted substring on a line.
fn first_quoted(s: &str) -> Option<&str> {
    let q = s.find(['"', '\''])?;
    let quote = s.as_bytes()[q] as char;
    let start = q + 1;
    let end = s[start..].find(quote)? + start;
    Some(&s[start..end])
}

fn dedup_sort(mut deps: Vec<CrateDep>) -> Vec<CrateDep> {
    deps.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    deps.dedup_by(|a, b| a.name == b.name && a.kind == b.kind);
    deps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_maven_project() {
        let dir = std::env::temp_dir().join(format!("jade-mvn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/main/java/com/example")).unwrap();
        std::fs::write(
            dir.join("pom.xml"),
            r#"<project>
  <parent><artifactId>parent-thing</artifactId><version>9.9</version></parent>
  <artifactId>demo-app</artifactId>
  <version>1.2.3</version>
  <properties><maven.compiler.release>17</maven.compiler.release></properties>
  <modules><module>core</module><module>web</module></modules>
  <dependencies>
    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>33.0</version></dependency>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10</version><scope>test</scope></dependency>
  </dependencies>
</project>"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("src/main/java/com/example/Main.java"),
            "package com.example;\npublic class Main { public static void main(String[] args) {} }\n",
        )
        .unwrap();

        let info = read_info(&dir).unwrap();
        assert_eq!(info.name, "demo-app");
        assert_eq!(info.version, "1.2.3");
        assert_eq!(info.edition, "17");
        assert!(info.is_workspace);
        assert_eq!(info.members, vec!["core", "web"]);
        assert_eq!(info.bins, vec!["com.example.Main"]);

        let deps = read_deps(&dir);
        assert!(deps.iter().any(|d| d.name == "com.google.guava:guava" && d.kind == "normal"));
        assert!(deps.iter().any(|d| d.name == "org.junit.jupiter:junit-jupiter" && d.kind == "test"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_gradle_project() {
        let dir = std::env::temp_dir().join(format!("jade-gradle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/main/java/app")).unwrap();
        std::fs::write(
            dir.join("build.gradle"),
            "version = '2.0.0'\nsourceCompatibility = '17'\ndependencies {\n  implementation 'com.google.guava:guava:33.0'\n  testImplementation 'org.junit.jupiter:junit-jupiter:5.10'\n}\n",
        )
        .unwrap();
        std::fs::write(dir.join("settings.gradle"), "rootProject.name = 'gr-demo'\n").unwrap();
        std::fs::write(
            dir.join("src/main/java/app/App.java"),
            "package app;\npublic class App { static public void main(String... a) {} }\n",
        )
        .unwrap();

        let info = read_info(&dir).unwrap();
        assert_eq!(info.name, "gr-demo");
        assert_eq!(info.version, "2.0.0");
        assert_eq!(info.edition, "17");
        assert_eq!(info.bins, vec!["app.App"]);

        let deps = read_deps(&dir);
        assert!(deps.iter().any(|d| d.name == "com.google.guava:guava" && d.version == "33.0"));
        assert!(deps.iter().any(|d| d.kind == "test"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
