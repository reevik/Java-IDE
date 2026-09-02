use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, serde::Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: &'static str, // "file" | "dir"
    pub children: Option<Vec<TreeNode>>,
}

/// Directories that would swamp the tree and are never hand-edited.
const SKIP_DIRS: &[&str] = &["target", "node_modules", ".git", ".idea", ".vscode", "dist"];

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

pub fn read_tree(root: &Path) -> Result<Vec<TreeNode>> {
    if !root.is_dir() {
        bail!("{} is not a directory", root.display());
    }
    Ok(collect(root, 0))
}

fn collect(dir: &Path, depth: usize) -> Vec<TreeNode> {
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
        if name.is_empty() || name.starts_with('.') && name != ".cargo" {
            continue;
        }
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            dirs.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                kind: "dir",
                children: Some(collect(&path, depth + 1)),
            });
        } else if is_source(&path) {
            files.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                kind: "file",
                children: None,
            });
        }
    }

    let by_name = |a: &TreeNode, b: &TreeNode| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    dirs.into_iter().chain(files).collect()
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
