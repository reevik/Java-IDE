use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

/// Shared control for a running agent CLI process: its PID (to kill on Stop) and
/// a cancel flag (so a killed run returns its partial output instead of erroring).
#[derive(Default)]
pub struct AgentHandle {
    pub pid: Mutex<Option<u32>>,
    pub cancel: AtomicBool,
}

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL: &str = "claude-sonnet-4-5-20250929";
const MAX_CODE_CHARS: usize = 48_000;

const KEYRING_SERVICE: &str = "com.reevik.java-ade";
const KEYRING_USER: &str = "anthropic-api-key";

static MODEL_OVERRIDE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn set_model_override(model: Option<String>) {
    *MODEL_OVERRIDE.lock().unwrap() = model.filter(|m| !m.trim().is_empty());
}
fn model_arg() -> Option<String> {
    MODEL_OVERRIDE.lock().unwrap().clone()
}
/// The current model override (None → the default model is used).
pub fn model_override() -> Option<String> {
    model_arg()
}
/// The built-in default model id.
pub fn default_model() -> &'static str {
    DEFAULT_MODEL
}
fn api_model() -> String {
    model_arg().unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

// --- Keychain + CLI discovery ----------------------------------------------

pub fn get_api_key() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .ok()?
        .get_password()
        .ok()
}

pub fn set_api_key(key: &str) -> Result<()> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?
        .set_password(key)
        .context("saving API key to OS keychain")
}

pub fn find_claude_cli() -> Option<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(&home).join(".claude/local/claude"));
        candidates.push(PathBuf::from(&home).join(".local/bin/claude"));
    }
    for c in &candidates {
        if c.exists() {
            return Some(c.clone());
        }
    }
    let out = std::process::Command::new("which").arg("claude").output().ok()?;
    if out.status.success() {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    None
}

// --- Review data model ------------------------------------------------------

/// A single refactoring / fix, applyable as a verbatim `original` → `replacement`.
#[derive(serde::Serialize)]
pub struct Suggestion {
    /// "refactor" | "bug" | "idiom" | "perf" | "style" | "docs"
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub original: String,
    pub replacement: String,
}

/// A 0-100 rating of the file across the axes that matter for Java.
#[derive(serde::Serialize)]
pub struct Quality {
    pub score: u8,
    pub verdict: String,
    pub correctness: u8,
    pub idiomatic: u8,
    pub clarity: u8,
    pub error_handling: u8,
}

#[derive(serde::Serialize)]
pub struct Review {
    pub quality: Option<Quality>,
    pub summary: String,
    pub suggestions: Vec<Suggestion>,
}

const REVIEW_PROMPT: &str = "You are a senior Java engineer reviewing a single source file. Assess it honestly and propose concrete, individually-applicable improvements: refactorings, idiomatic-Java changes, likely bugs, exception-handling gaps, performance issues, and missing Javadoc. Favour idiomatic modern Java (streams over index loops where clearer, `Optional` over null-returns, try-with-resources, immutability and `final`, `var` for obvious locals, records for data carriers, enhanced switch).\n\nRespond with ONLY a single JSON object — no prose, no markdown fences — with exactly these keys:\n- \"quality\": rate the file AS IT IS on an absolute scale where 90+ is production-grade and 50 is a rough draft; do not flatter. Keys: \"score\" (0-100 int), \"verdict\" (<= 4 words), and 0-100 ints for \"correctness\", \"idiomatic\", \"clarity\", \"error_handling\".\n- \"summary\": one sentence on the file overall.\n- \"suggestions\": array (0-8, most important first) of objects with:\n    - \"kind\": one of refactor | bug | idiom | perf | style | docs.\n    - \"title\": short label.\n    - \"detail\": one sentence — what and why.\n    - \"original\": the exact code span to replace, copied VERBATIM from the file so it can be located automatically. Keep it minimal but unique.\n    - \"replacement\": the improved code.\n  Each suggestion must stand alone as a single original→replacement edit. Never restate the whole file. Use an empty array only if the file is already excellent.";

const EXPLAIN_PROMPT: &str = "You are a senior Java engineer. Explain the provided Java code to a competent developer who is new to THIS code: what it does, how the pieces fit, and any non-obvious behaviour, invariants, or gotchas. Be concise and concrete. Use short Markdown (a lead sentence, then tight bullet points). Do not restate the code line by line.";

const FIX_PROMPT: &str = "You are a senior Java engineer. The user gives you a javac/compiler error and the relevant source. Explain the root cause in one or two sentences, then give the minimal fix as a Java code block. If several fixes are reasonable, give the most idiomatic one and mention alternatives briefly.";

// --- Parsing ----------------------------------------------------------------

fn score_field(v: &Value, key: &str) -> u8 {
    v.get(key)
        .and_then(|n| n.as_f64().or_else(|| n.as_str().and_then(|s| s.parse().ok())))
        .map(|n| n.round().clamp(0.0, 100.0) as u8)
        .unwrap_or(0)
}

fn build_review(raw: Value) -> Review {
    let quality = raw.get("quality").and_then(|q| {
        let score = score_field(q, "score");
        if score == 0 {
            return None;
        }
        Some(Quality {
            score,
            verdict: q.get("verdict").and_then(Value::as_str).unwrap_or("").trim().to_string(),
            correctness: score_field(q, "correctness"),
            idiomatic: score_field(q, "idiomatic"),
            clarity: score_field(q, "clarity"),
            error_handling: score_field(q, "error_handling"),
        })
    });
    let field = |s: &Value, k: &str| s.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let suggestions = raw
        .get("suggestions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|s| {
                    let title = s.get("title").and_then(Value::as_str)?.to_string();
                    Some(Suggestion {
                        kind: field(s, "kind"),
                        title,
                        detail: field(s, "detail"),
                        original: field(s, "original"),
                        replacement: field(s, "replacement"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Review {
        quality,
        summary: raw.get("summary").and_then(Value::as_str).unwrap_or("").to_string(),
        suggestions,
    }
}

fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    (end > start).then(|| &s[start..=end])
}

fn clip(s: &str) -> String {
    s.chars().take(MAX_CODE_CHARS).collect()
}

// --- Shared transport -------------------------------------------------------

/// Runs `claude -p` in stream-json mode, feeding each accumulated snapshot of the
/// reply to `on_progress`. Returns the final reply. `stream-json` +
/// `--include-partial-messages` is the only mode that yields token-level deltas.
async fn cli_streamed<F, G>(
    cli: &Path,
    prompt: &str,
    cwd: &Path,
    perm: Option<&str>,
    handle: Option<&Arc<AgentHandle>>,
    mut on_progress: F,
    mut on_status: G,
) -> Result<String>
where
    F: FnMut(&str),
    G: FnMut(&str),
{
    let agent = perm.is_some();
    let mut cmd = tokio::process::Command::new(cli);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages");
    if let Some(p) = perm {
        // "acceptEdits" lets it edit files; "plan" makes it plan without editing.
        cmd.arg("--permission-mode").arg(p);
    }
    if let Some(m) = model_arg() {
        cmd.arg("--model").arg(m);
    }
    let mut child = cmd
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawning claude CLI")?;

    // Publish the PID so a Stop request can kill this run.
    if let Some(h) = handle {
        *h.pid.lock().unwrap() = child.id();
    }

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await.context("writing prompt")?;
        stdin.shutdown().await.ok();
    }

    let stdout = child.stdout.take().context("claude CLI stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut acc = String::new();
    let mut final_reply: Option<String> = None;
    let mut is_error = false;
    // Track the in-flight tool call to report the file it edits (Edit/Write).
    let mut cur_tool: Option<String> = None;
    let mut cur_input = String::new();

    let read = async {
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match v.get("type").and_then(Value::as_str) {
                Some("stream_event") => {
                    let ev = v.get("event");
                    let ev_type = ev.and_then(|e| e.get("type")).and_then(Value::as_str);
                    if ev_type == Some("content_block_delta") {
                        let delta = ev.and_then(|e| e.get("delta"));
                        if let Some(t) = delta.and_then(|d| d.get("text")).and_then(Value::as_str) {
                            acc.push_str(t);
                            on_progress(&acc);
                        } else if agent && cur_tool.is_some() {
                            // Accumulate the tool's streamed JSON input (has file_path).
                            if let Some(pj) = delta.and_then(|d| d.get("partial_json")).and_then(Value::as_str) {
                                cur_input.push_str(pj);
                            }
                        }
                    } else if agent && ev_type == Some("content_block_start") {
                        // Surface tool activity as a single live status line (not appended
                        // to the transcript, so it stays one consolidated line).
                        let cb = ev.and_then(|e| e.get("content_block"));
                        if cb.and_then(|c| c.get("type")).and_then(Value::as_str) == Some("tool_use") {
                            let name = cb.and_then(|c| c.get("name")).and_then(Value::as_str).unwrap_or("tool").to_string();
                            let verb = match name.as_str() {
                                "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "Editing files",
                                "Read" => "Reading files",
                                "Bash" => "Running a command",
                                "Glob" | "Grep" => "Searching the code",
                                "WebFetch" | "WebSearch" => "Searching the web",
                                _ => "Working",
                            };
                            on_status(verb);
                            cur_tool = Some(name);
                            cur_input.clear();
                        }
                    } else if agent && ev_type == Some("content_block_stop") {
                        // A tool call finished — if it edited a file, report which one.
                        if let Some(name) = cur_tool.take() {
                            if matches!(name.as_str(), "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
                                if let Ok(input) = serde_json::from_str::<Value>(&cur_input) {
                                    if let Some(fp) = input.get("file_path").and_then(Value::as_str) {
                                        // Prefix marker → the frontend routes this to `ai:agent-edit`.
                                        on_status(&format!("\u{1}EDIT\u{1}{fp}"));
                                    }
                                }
                            }
                        }
                    }
                }
                Some("result") => {
                    // The CLI reports errors (usage limits, auth) here — is_error true,
                    // with the human-readable reason in `result`, not on stderr.
                    if v.get("is_error").and_then(Value::as_bool) == Some(true) {
                        is_error = true;
                    }
                    if let Some(r) = v.get("result").and_then(Value::as_str) {
                        final_reply = Some(r.to_string());
                    }
                }
                _ => {}
            }
        }
        Ok::<(), std::io::Error>(())
    };

    let limit = if agent { 600 } else { 180 };
    tokio::time::timeout(std::time::Duration::from_secs(limit), read)
        .await
        .context("claude CLI timed out")?
        .context("reading claude CLI output")?;

    let status = child.wait().await.context("waiting for claude CLI")?;
    let cancelled = handle.map(|h| h.cancel.load(Ordering::SeqCst)).unwrap_or(false);
    if let Some(h) = handle {
        *h.pid.lock().unwrap() = None;
    }
    // A Stop killed the process → return whatever it produced so far, not an error.
    if cancelled {
        let partial = final_reply.filter(|s| !s.trim().is_empty()).unwrap_or(acc);
        return Ok(if partial.trim().is_empty() { "_(stopped)_".to_string() } else { format!("{}\n\n_⏹ stopped._", partial.trim()) });
    }
    if !status.success() || is_error {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            e.read_to_string(&mut err).await.ok();
        }
        // Prefer stderr, then the CLI's result text, then the exit code — anything
        // but a blank message.
        let detail = [err.trim(), final_reply.as_deref().unwrap_or("").trim(), acc.trim()]
            .into_iter()
            .find(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "claude exited with code {}",
                    status.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
                )
            });
        anyhow::bail!("{detail}");
    }
    Ok(final_reply.unwrap_or(acc))
}

async fn api_text(api_key: &str, system: &str, user: &str) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("building HTTP client")?;
    let resp = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({
            "model": api_model(),
            "max_tokens": 4096,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
        }))
        .send()
        .await
        .context("calling Anthropic API")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Anthropic API error {status}: {body}");
    }
    let body: Value = resp.json().await.context("parsing Anthropic response")?;
    body["content"][0]["text"]
        .as_str()
        .map(str::to_string)
        .context("missing text in Anthropic response")
}

// --- Public review / explain / fix -----------------------------------------

pub async fn review_via_cli<F>(cli: &Path, path: &str, code: &str, on_progress: F) -> Result<Review>
where
    F: FnMut(&str),
{
    let prompt = format!(
        "{REVIEW_PROMPT}\n\n---\n\nReview this Java file ({path}) and return ONLY the JSON object.\n\n```java\n{}\n```",
        clip(code)
    );
    let reply = cli_streamed(cli, &prompt, std::env::temp_dir().as_path(), None, None, on_progress, |_| {}).await?;
    let json = extract_json_object(&reply).context("no JSON object in reply")?;
    let raw: Value = serde_json::from_str(json).context("parsing review JSON")?;
    Ok(build_review(raw))
}

pub async fn review_via_api(api_key: &str, path: &str, code: &str) -> Result<Review> {
    let user = format!("Review this Java file ({path}):\n\n```java\n{}\n```", clip(code));
    let reply = api_text(api_key, REVIEW_PROMPT, &user).await?;
    let json = extract_json_object(&reply).context("no JSON object in reply")?;
    let raw: Value = serde_json::from_str(json).context("parsing review JSON")?;
    Ok(build_review(raw))
}

pub async fn explain_via_cli<F>(cli: &Path, label: &str, code: &str, on_progress: F) -> Result<String>
where
    F: FnMut(&str),
{
    let prompt = format!("{EXPLAIN_PROMPT}\n\n---\n\nExplain this Java {label}:\n\n```java\n{}\n```", clip(code));
    cli_streamed(cli, &prompt, std::env::temp_dir().as_path(), None, None, on_progress, |_| {}).await
}

pub async fn explain_via_api(api_key: &str, label: &str, code: &str) -> Result<String> {
    let user = format!("Explain this Java {label}:\n\n```java\n{}\n```", clip(code));
    api_text(api_key, EXPLAIN_PROMPT, &user).await
}

pub async fn fix_via_cli<F>(cli: &Path, error: &str, code: &str, on_progress: F) -> Result<String>
where
    F: FnMut(&str),
{
    let prompt = format!(
        "{FIX_PROMPT}\n\n---\n\nCompiler error:\n{error}\n\nSource:\n```java\n{}\n```",
        clip(code)
    );
    cli_streamed(cli, &prompt, std::env::temp_dir().as_path(), None, None, on_progress, |_| {}).await
}

pub async fn fix_via_api(api_key: &str, error: &str, code: &str) -> Result<String> {
    let user = format!("Compiler error:\n{error}\n\nSource:\n```java\n{}\n```", clip(code));
    api_text(api_key, FIX_PROMPT, &user).await
}

// --- Task board: turn a description into tasks -------------------------------

const TASKS_PROMPT: &str = "You break a feature request or description into a small set of actionable development tasks for a Trello-style board. Respond with ONLY a JSON array — no prose, no markdown, no code fences. Each element is an object: {\"title\": string (short, imperative, e.g. \"Add login endpoint\"), \"description\": string (one or two sentences of detail; may be empty), \"column\": string (exactly one of the provided column names)}. Produce between 3 and 8 tasks. Put tasks in the first column unless the description clearly implies another.";

fn tasks_user(description: &str, columns: &[String]) -> String {
    format!("Columns (use these exact names): {}\n\nDescription:\n{}", columns.join(", "), description)
}

pub async fn tasks_via_cli<F>(cli: &Path, description: &str, columns: &[String], on_progress: F) -> Result<String>
where
    F: FnMut(&str),
{
    let prompt = format!("{TASKS_PROMPT}\n\n---\n\n{}", tasks_user(description, columns));
    cli_streamed(cli, &prompt, std::env::temp_dir().as_path(), None, None, on_progress, |_| {}).await
}

pub async fn tasks_via_api(api_key: &str, description: &str, columns: &[String]) -> Result<String> {
    api_text(api_key, TASKS_PROMPT, &tasks_user(description, columns)).await
}

// --- Vibe Coder chat --------------------------------------------------------

const VIBE_PROMPT: &str = "You are the AI Assistant, a friendly, pragmatic Java pair-programmer living inside an IDE. Help the developer write, understand, debug, and refactor Java, grounded in the file they have open and the surrounding project.\n\nSTAY STRICTLY ON TOPIC. You only answer questions about: this project and its code, the currently open file, the Java language and its ecosystem/tooling (Maven, Gradle, the JDK/standard library, JUnit, Spring, streams, generics, etc.), computer science, and software development/engineering. If asked about anything unrelated — politics, sports, celebrities, news, general trivia, personal or life advice, and so on — do NOT answer it; briefly and politely decline and offer to help with the code instead.\n\nKeep replies focused and concrete; use short Markdown with fenced ```java code blocks. Prefer idiomatic modern Java.\n\nWhenever you point at a place in the code, cite it as an inline-code path relative to the project root, with a line number when you know it — e.g. `src/main/java/com/example/App.java` or `src/main/java/com/example/App.java:128`. The IDE turns these into clickable links that open the file at that line, so prefer `path:line` for anything specific.";

/// One chat turn from the frontend.
#[derive(serde::Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// The system prompt with a pre-built context block (open file + project) appended.
fn chat_system(context: Option<&str>) -> String {
    match context.map(str::trim).filter(|c| !c.is_empty()) {
        Some(ctx) => format!("{VIBE_PROMPT}\n\n---\n\n# Workspace context\n\n{ctx}"),
        None => VIBE_PROMPT.to_string(),
    }
}

pub async fn chat_via_cli<F>(cli: &Path, context: Option<&str>, messages: &[ChatMsg], on_progress: F) -> Result<String>
where
    F: FnMut(&str),
{
    // The CLI is single-shot, so fold the whole conversation into one prompt.
    let mut prompt = chat_system(context);
    prompt.push_str("\n\n---\n\nConversation:\n");
    for m in messages {
        let who = if m.role == "assistant" { "Assistant" } else { "User" };
        prompt.push_str(&format!("\n{who}: {}\n", m.content));
    }
    prompt.push_str("\nAssistant:");
    cli_streamed(cli, &prompt, std::env::temp_dir().as_path(), None, None, on_progress, |_| {}).await
}

/// Agentic chat: runs the CLI IN the project dir. When `plan_only`, it runs in
/// plan mode (no edits) and returns a plan prefixed with `SCALE: small|large`;
/// otherwise it edits files directly and returns a summary.
pub async fn agent_via_cli<F, G>(
    cli: &Path,
    root: &Path,
    file_path: Option<&str>,
    messages: &[ChatMsg],
    plan_only: bool,
    handle: &Arc<AgentHandle>,
    on_progress: F,
    on_status: G,
) -> Result<String>
where
    F: FnMut(&str),
    G: FnMut(&str),
{
    let mut prompt = if plan_only {
        String::from(
            "You are planning a change in this Java project. Use read-only tools to research the code. Do NOT edit any files yet.\n\nFirst, assess the size of the requested change and start your reply with EXACTLY one line: `SCALE: small` (a few lines, a single file, no risk) or `SCALE: large` (multiple files, several steps, or anything risky). Then, ONLY if large, give a concise numbered execution plan of the steps you will take. If small, just add a one-line note of what you'll do.\n\n",
        )
    } else {
        String::from(
            "You are an autonomous coding agent working directly in this Java project. Use your tools to read and EDIT the files to carry out the request (and any approved plan above) — APPLY the changes yourself, do not just describe them. Keep edits minimal, focused, and idiomatic. When finished, briefly summarize what you changed (cite files as `path:line`).\n\n",
        )
    };
    if let Some(p) = file_path {
        prompt.push_str(&format!("The user currently has `{p}` open.\n\n"));
    }
    // Scope-ambiguity gate: ask instead of guessing whether it's file-local or project-wide.
    prompt.push_str(
        "IMPORTANT: If it is genuinely ambiguous whether the user means ONLY the currently open file or a broader change across the whole project, do NOT edit or plan anything yet. Instead reply with EXACTLY a first line `CLARIFY: <one short question>`, then 2-4 option lines each starting with `- ` (e.g. `- Only the open file`, `- The whole project`), and stop. Only ask when it truly matters; otherwise proceed.\n\n",
    );
    prompt.push_str("Conversation so far:\n");
    for m in messages {
        let who = if m.role == "assistant" { "Assistant" } else { "User" };
        prompt.push_str(&format!("\n{who}: {}\n", m.content));
    }
    let perm = if plan_only { "plan" } else { "acceptEdits" };
    cli_streamed(cli, &prompt, root, Some(perm), Some(handle), on_progress, on_status).await
}

pub async fn chat_via_api(api_key: &str, context: Option<&str>, messages: &[ChatMsg]) -> Result<String> {
    let system = chat_system(context);
    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| json!({ "role": if m.role == "assistant" { "assistant" } else { "user" }, "content": m.content }))
        .collect();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("building HTTP client")?;
    let resp = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({ "model": api_model(), "max_tokens": 4096, "system": system, "messages": msgs }))
        .send()
        .await
        .context("calling Anthropic API")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Anthropic API error {status}: {body}");
    }
    let body: Value = resp.json().await.context("parsing Anthropic response")?;
    body["content"][0]["text"].as_str().map(str::to_string).context("missing text in Anthropic response")
}
