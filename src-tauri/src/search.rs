use anyhow::Result;
use std::path::Path;

#[derive(Debug, serde::Serialize)]
pub struct SearchMatch {
    pub file: String,
    /// 1-based line number.
    pub line: u32,
    /// 1-based column (character index) of the match start.
    pub column: u32,
    /// The matching line, trimmed of leading indentation for display.
    pub text: String,
    /// Character offset of the match within `text` (after trimming).
    pub match_start: u32,
    pub match_len: u32,
}

/// Directories never worth searching, mirroring the file tree.
const SKIP_DIRS: &[&str] = &["target", "node_modules", ".git", ".idea", ".vscode", "dist"];

fn is_searchable(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).unwrap_or(""),
        "rs" | "toml" | "md" | "json" | "yaml" | "yml" | "lock" | "txt" | "sql" | "sh"
    )
}

/// Recursively search text files under `root` for `query`. Case-insensitive
/// unless `case_sensitive`. Stops at `max` matches so a broad query stays bounded.
pub fn search(root: &Path, query: &str, case_sensitive: bool, max: usize) -> Result<Vec<SearchMatch>> {
    let mut out = Vec::new();
    if query.is_empty() {
        return Ok(out);
    }
    let needle = if case_sensitive { query.to_string() } else { query.to_lowercase() };
    walk(root, &needle, case_sensitive, max, &mut out);
    Ok(out)
}

fn walk(dir: &Path, needle: &str, cs: bool, max: usize, out: &mut Vec<SearchMatch>) {
    if out.len() >= max {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    // Deterministic order: shallower/earlier files first.
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if out.len() >= max {
            return;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') && name != ".cargo" {
            continue;
        }
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name) {
                walk(&path, needle, cs, max, out);
            }
        } else if is_searchable(&path) {
            search_file(&path, needle, cs, max, out);
        }
    }
}

fn search_file(path: &Path, needle: &str, cs: bool, max: usize, out: &mut Vec<SearchMatch>) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return; // unreadable or non-UTF-8 (likely binary) — skip
    };
    let file = path.to_string_lossy().to_string();
    for (i, raw) in content.lines().enumerate() {
        if out.len() >= max {
            return;
        }
        let hay = if cs { raw.to_string() } else { raw.to_lowercase() };
        let Some(byte_idx) = hay.find(needle) else {
            continue;
        };
        // Convert byte offset → character column (1-based) for the untrimmed line.
        let col = raw[..byte_idx].chars().count();
        // Trim leading whitespace for display, and adjust the match offset for it.
        let trimmed_leading = raw.len() - raw.trim_start().len();
        let trimmed_leading_chars = raw[..trimmed_leading].chars().count();
        let display = raw.trim_start().chars().take(400).collect::<String>();
        out.push(SearchMatch {
            file: file.clone(),
            line: (i + 1) as u32,
            column: (col + 1) as u32,
            text: display,
            match_start: col.saturating_sub(trimmed_leading_chars) as u32,
            match_len: needle.chars().count() as u32,
        });
    }
}
