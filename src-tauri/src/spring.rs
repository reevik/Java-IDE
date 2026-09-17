//! Lightweight Spring model built by scanning source: stereotype beans, @Bean
//! methods, and REST endpoints (mapping annotations) — for the Spring panel.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringBean {
    /// Class name, or @Bean method name.
    pub name: String,
    /// "component" | "service" | "repository" | "controller" | "configuration" | "bean"
    pub kind: &'static str,
    /// The declaring class (for @Bean methods) or empty.
    pub owner: String,
    pub path: String,
    pub line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringEndpoint {
    /// "GET" | "POST" | … | "ANY"
    pub method: String,
    pub path: String,
    /// "Controller#handlerMethod"
    pub handler: String,
    pub file: String,
    pub line: u32,
}

#[derive(Serialize, Default)]
pub struct SpringOverview {
    pub beans: Vec<SpringBean>,
    pub endpoints: Vec<SpringEndpoint>,
}

/// Scan the project's Java source roots for Spring beans and endpoints.
pub fn overview(dir: &Path) -> SpringOverview {
    let mut out = SpringOverview::default();
    for root in crate::projects::java_source_roots(dir) {
        walk(&root, &mut out);
    }
    out.beans.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.endpoints.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn walk(dir: &Path, out: &mut SpringOverview) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("java") {
            if let Ok(text) = std::fs::read_to_string(&p) {
                scan_file(&p, &text, out);
            }
        }
    }
}

fn scan_file(path: &PathBuf, text: &str, out: &mut SpringOverview) {
    let file = path.to_string_lossy().into_owned();
    let lines: Vec<&str> = text.lines().collect();
    let mut class_name = String::new();
    let mut class_base = String::new(); // base path from a class-level @RequestMapping
    let mut pending: Vec<(usize, String)> = Vec::new(); // (line, whole annotation text)

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim().to_string();

        if line.starts_with('@') {
            // Accumulate a multi-line annotation until its parens balance.
            let start = i;
            let mut ann = line.clone();
            while paren_delta(&ann) > 0 && i + 1 < lines.len() {
                i += 1;
                ann.push(' ');
                ann.push_str(lines[i].trim());
            }
            pending.push((start + 1, ann));
            i += 1;
            continue;
        }

        if let Some(name) = class_decl_name(&line) {
            class_name = name.clone();
            class_base.clear();
            for (ln, ann) in &pending {
                if let Some(kind) = stereotype_kind(ann) {
                    out.beans.push(SpringBean { name: name.clone(), kind, owner: String::new(), path: file.clone(), line: *ln as u32 });
                }
                if ann_head(ann) == "RequestMapping" {
                    if let Some(p) = mapping_path(ann) {
                        class_base = p;
                    }
                }
            }
            pending.clear();
            i += 1;
            continue;
        }

        if is_method_decl(&line) {
            let mname = method_name(&line).unwrap_or_default();
            for (ln, ann) in &pending {
                let head = ann_head(ann);
                if head == "Bean" {
                    out.beans.push(SpringBean { name: if mname.is_empty() { "bean".into() } else { mname.clone() }, kind: "bean", owner: class_name.clone(), path: file.clone(), line: *ln as u32 });
                }
                if let Some(method) = http_method(head, ann) {
                    let sub = mapping_path(ann).unwrap_or_default();
                    out.endpoints.push(SpringEndpoint {
                        method,
                        path: join_paths(&class_base, &sub),
                        handler: format!("{}#{}", class_name, mname),
                        file: file.clone(),
                        line: *ln as u32,
                    });
                }
            }
            pending.clear();
            i += 1;
            continue;
        }

        // Any other real line breaks the annotation run (annotations attach only
        // to the immediately-following declaration).
        if !line.is_empty() && !line.starts_with("//") && !line.starts_with('*') && !line.starts_with("/*") {
            pending.clear();
        }
        i += 1;
    }
}

fn paren_delta(s: &str) -> i32 {
    s.chars().fold(0, |acc, c| match c { '(' => acc + 1, ')' => acc - 1, _ => acc })
}

/// The annotation head, e.g. "@GetMapping(\"/x\")" → "GetMapping".
fn ann_head(ann: &str) -> &str {
    let s = ann.trim_start_matches('@');
    let end = s.find(|c: char| c == '(' || c.is_whitespace()).unwrap_or(s.len());
    &s[..end]
}

fn stereotype_kind(ann: &str) -> Option<&'static str> {
    match ann_head(ann) {
        "Component" => Some("component"),
        "Service" => Some("service"),
        "Repository" => Some("repository"),
        "Controller" | "RestController" => Some("controller"),
        "Configuration" => Some("configuration"),
        // The Spring Boot entry point (meta-@Configuration + @ComponentScan). Listed
        // so a reactor/app whose only Spring annotation is the main class still
        // registers as a Spring project.
        "SpringBootApplication" => Some("configuration"),
        _ => None,
    }
}

fn http_method(head: &str, ann: &str) -> Option<String> {
    Some(match head {
        "GetMapping" => "GET".into(),
        "PostMapping" => "POST".into(),
        "PutMapping" => "PUT".into(),
        "DeleteMapping" => "DELETE".into(),
        "PatchMapping" => "PATCH".into(),
        "RequestMapping" => {
            // method = RequestMethod.POST → POST, else ANY.
            if let Some(idx) = ann.find("RequestMethod.") {
                ann[idx + "RequestMethod.".len()..]
                    .split(|c: char| !c.is_ascii_alphabetic())
                    .next()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("ANY")
                    .to_string()
            } else {
                "ANY".into()
            }
        }
        _ => return None,
    })
}

/// The path from a mapping annotation: `value=`/`path=`, else the first string.
fn mapping_path(ann: &str) -> Option<String> {
    for key in ["value=", "path="] {
        if let Some(idx) = ann.find(key) {
            if let Some(p) = first_string(&ann[idx..]) {
                return Some(p);
            }
        }
    }
    first_string(ann)
}

fn first_string(s: &str) -> Option<String> {
    let a = s.find('"')?;
    let b = s[a + 1..].find('"')?;
    Some(s[a + 1..a + 1 + b].to_string())
}

fn join_paths(base: &str, sub: &str) -> String {
    let b = base.trim_end_matches('/');
    let s = sub.trim_start_matches('/');
    if b.is_empty() {
        format!("/{s}")
    } else if s.is_empty() {
        b.to_string()
    } else {
        format!("{b}/{s}")
    }
}

fn class_decl_name(line: &str) -> Option<String> {
    let mods = ["public", "private", "protected", "final", "abstract", "sealed", "non-sealed", "static", "strictfp"];
    let mut it = line.split_whitespace().peekable();
    let mut saw_kw = false;
    while let Some(tok) = it.next() {
        if saw_kw {
            let name = tok.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
            let name: String = name.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            return (!name.is_empty()).then_some(name);
        }
        match tok {
            "class" | "interface" | "record" | "enum" => saw_kw = true,
            t if mods.contains(&t) || t.starts_with('@') => continue,
            _ => return None,
        }
    }
    None
}

/// Heuristic: a method declaration line (has `name(` before a `{` or `;`, and
/// isn't a control statement or a call).
fn is_method_decl(line: &str) -> bool {
    let open = match line.find('(') { Some(i) => i, None => return false };
    let before = line[..open].trim();
    // The token right before '(' must be an identifier (the method name).
    let name = before.rsplit(|c: char| c.is_whitespace() || c == '*' || c == '>').next().unwrap_or("");
    if name.is_empty() || !name.chars().next().map(|c| c.is_alphabetic() || c == '_').unwrap_or(false) {
        return false;
    }
    // Reject control keywords and obvious calls (`foo.bar(` / `return foo(` / `=`).
    for kw in ["if", "for", "while", "switch", "catch", "return", "new", "synchronized"] {
        if before.split_whitespace().any(|t| t == kw) {
            return false;
        }
    }
    if before.contains('=') || before.contains('.') {
        return false;
    }
    // A method decl has a return type / modifiers before the name (≥2 tokens) OR
    // a constructor (name only) — require at least a type unless it looks like one.
    before.split_whitespace().count() >= 2 && (line.contains('{') || line.trim_end().ends_with(')') || line.contains(") throws"))
}

fn method_name(line: &str) -> Option<String> {
    let open = line.find('(')?;
    let before = line[..open].trim();
    let name = before.rsplit(|c: char| c.is_whitespace() || c == '*' || c == '>').next()?;
    (!name.is_empty()).then(|| name.to_string())
}
