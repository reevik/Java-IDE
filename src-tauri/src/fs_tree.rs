use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: &'static str, // "file" | "dir"
    pub children: Option<Vec<TreeNode>>,
    /// For `.java` files: the declared top-level type — "class" | "interface" |
    /// "enum" | "record" | "annotation" — for a type-specific tree icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_kind: Option<&'static str>,
}

/// Directories that would swamp the tree and are never hand-edited.
pub const SKIP_DIRS: &[&str] = &["target", "node_modules", ".git", ".idea", ".vscode", "dist"];

/// Files worth opening in the editor.
fn is_source(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if matches!(
        ext,
        "java" | "kt" | "kts" | "gradle" | "xml" | "properties"
            | "md" | "json" | "yaml" | "yml" | "txt" | "sql" | "sh"
    ) {
        return true;
    }
    // Build/wrapper files without a matching extension.
    matches!(
        path.file_name().and_then(|n| n.to_str()).unwrap_or(""),
        "pom.xml" | "gradlew" | "mvnw" | ".gitignore" | "Dockerfile"
    )
}

pub fn read_tree(root: &Path, show_hidden: bool) -> Result<Vec<TreeNode>> {
    if !root.is_dir() {
        bail!("{} is not a directory", root.display());
    }
    Ok(collect(root, 0, show_hidden))
}

fn collect(dir: &Path, depth: usize, show_hidden: bool) -> Vec<TreeNode> {
    if depth > 12 {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        // Normally hidden: dotfiles/dot-dirs and the build/tooling dirs. Revealed
        // when `show_hidden` is on (the file tree's toggle).
        if !show_hidden && name.starts_with('.') && name != ".cargo" {
            continue;
        }
        if path.is_dir() {
            if !show_hidden && SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            dirs.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                kind: "dir",
                children: Some(collect(&path, depth + 1, show_hidden)),
                java_kind: None,
            });
        } else if show_hidden || is_source(&path) {
            let java_kind = if name.ends_with(".java") { classify_java(&path) } else { None };
            files.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                kind: "file",
                children: None,
                java_kind,
            });
        }
    }

    let by_name = |a: &TreeNode, b: &TreeNode| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    dirs.into_iter().chain(files).collect()
}

/// Classify a `.java` file by its first top-level type declaration, reading only
/// a bounded prefix (declarations follow the imports, near the top).
fn classify_java(path: &Path) -> Option<&'static str> {
    use std::io::Read;
    let mut buf = [0u8; 8192];
    let n = std::fs::File::open(path).ok()?.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);

    let mut in_block = false;
    for raw in text.lines() {
        let mut line = raw.trim();
        if in_block {
            match line.find("*/") {
                Some(i) => { in_block = false; line = line[i + 2..].trim(); }
                None => continue,
            }
        }
        // Strip a leading line comment / block-comment open on this line.
        if line.starts_with("//") || line.starts_with('*') || line.is_empty() {
            continue;
        }
        if let Some(i) = line.find("/*") {
            in_block = !line[i + 2..].contains("*/");
            line = line[..i].trim();
        }
        if line.contains("@interface") {
            return Some("annotation");
        }
        // Skip modifiers and annotations; the first real keyword wins.
        const MODIFIERS: &[&str] = &[
            "public", "private", "protected", "final", "abstract", "sealed", "non-sealed", "static", "strictfp",
        ];
        for tok in line.split_whitespace() {
            match tok {
                "class" => return Some("class"),
                "interface" => return Some("interface"),
                "enum" => return Some("enum"),
                "record" => return Some("record"),
                t if MODIFIERS.contains(&t) => continue,
                t if t.starts_with('@') => continue,
                _ => break, // not a type-declaration line — try the next line
            }
        }
    }
    None
}

pub fn read_file(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
}

pub fn write_file(path: &Path, contents: &str) -> Result<()> {
    std::fs::write(path, contents).with_context(|| format!("writing {}", path.display()))
}

pub fn create_file(dir: &Path, name: &str) -> Result<PathBuf> {
    let name = sanitize(name)?;
    let target = dir.join(&name);
    if target.exists() {
        bail!("{} already exists", target.display());
    }
    std::fs::write(&target, "").with_context(|| format!("creating {}", target.display()))?;
    Ok(target)
}

pub fn create_dir(dir: &Path, name: &str) -> Result<PathBuf> {
    let name = sanitize(name)?;
    let target = dir.join(&name);
    if target.exists() {
        bail!("{} already exists", target.display());
    }
    std::fs::create_dir_all(&target).with_context(|| format!("creating {}", target.display()))?;
    Ok(target)
}

pub fn rename(from: &Path, name: &str) -> Result<PathBuf> {
    let name = sanitize(name)?;
    let parent = from.parent().context("path has no parent")?;
    let target = parent.join(&name);
    if target != from && target.exists() {
        bail!("{} already exists", target.display());
    }
    std::fs::rename(from, &target).with_context(|| format!("renaming {}", from.display()))?;
    Ok(target)
}

pub fn delete(path: &Path) -> Result<()> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .with_context(|| format!("deleting {}", path.display()))
}

/// Move `src` into directory `dst_dir`, keeping its base name. Refuses to move a
/// directory into itself or a descendant, or to overwrite an existing entry.
pub fn move_into(src: &Path, dst_dir: &Path) -> Result<PathBuf> {
    if !dst_dir.is_dir() {
        bail!("{} is not a directory", dst_dir.display());
    }
    let name = src.file_name().context("source has no file name")?;
    let target = dst_dir.join(name);
    if target == src {
        return Ok(target); // already there — no-op
    }
    if src.is_dir() && target.starts_with(src) {
        bail!("cannot move a folder into itself");
    }
    if target.exists() {
        bail!("{} already exists", target.display());
    }
    std::fs::rename(src, &target).with_context(|| format!("moving {}", src.display()))?;
    Ok(target)
}

/// Copy `src` into directory `dst_dir`, auto-uniquifying the name on collision
/// (`Foo.java` → `Foo copy.java` → `Foo copy 2.java`).
pub fn copy_into(src: &Path, dst_dir: &Path) -> Result<PathBuf> {
    if !dst_dir.is_dir() {
        bail!("{} is not a directory", dst_dir.display());
    }
    let name = src.file_name().and_then(|n| n.to_str()).context("source has no file name")?;
    if src.is_dir() && dst_dir.starts_with(src) {
        bail!("cannot copy a folder into itself");
    }
    let target = unique_in(dst_dir, name);
    if src.is_dir() {
        copy_dir_all(src, &target)?;
    } else {
        std::fs::copy(src, &target).with_context(|| format!("copying {}", src.display()))?;
    }
    Ok(target)
}

/// A path in `dir` for `name` that doesn't collide, inserting " copy" (then
/// " copy 2", …) before the extension.
fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 1.. {
        let suffix = if n == 1 { " copy".to_string() } else { format!(" copy {n}") };
        let cand = dir.join(format!("{stem}{suffix}{ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    unreachable!()
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst).with_context(|| format!("creating {}", dst.display()))?;
    for entry in std::fs::read_dir(src).with_context(|| format!("reading {}", src.display()))?.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let to = dst.join(&name);
        if path.is_dir() {
            copy_dir_all(&path, &to)?;
        } else {
            std::fs::copy(&path, &to).with_context(|| format!("copying {}", path.display()))?;
        }
    }
    Ok(())
}

fn sanitize(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("name cannot be empty");
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed == "." || trimmed == ".." {
        bail!("invalid name: {trimmed}");
    }
    Ok(trimmed.to_string())
}
