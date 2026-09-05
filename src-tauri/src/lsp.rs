//! A minimal LSP client for rust-analyzer — just enough for code completion.
//!
//! One rust-analyzer process per project. Requests are correlated by id through a
//! pending-map that a background reader task fulfils. The protocol sequence is the
//! one verified against rust-analyzer directly: initialize → initialized →
//! didOpen → textDocument/completion, answering the server's
//! `workspace/configuration` requests so it doesn't stall.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tauri::{AppHandle, Emitter};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

/// One completion candidate, flattened for the editor.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CompletionItem {
    /// Display label, e.g. `clone(as Clone)`.
    pub label: String,
    /// Text the editor matches the typed prefix against — the bare method name,
    /// without any `(as Trait)` display suffix.
    pub filter_text: String,
    /// Text actually inserted. When `snippet` is true this is an LSP snippet
    /// (e.g. `foo(${1:x})$0`) the editor expands; otherwise plain text.
    pub insert: String,
    /// True when `insert` is an LSP snippet (function/method calls).
    pub snippet: bool,
    pub detail: String,
    /// LSP CompletionItemKind as a short slug (method, field, keyword, …).
    pub kind: String,
}

pub struct LspClient {
    root: String,
    writer: Arc<tokio::sync::Mutex<ChildStdin>>,
    pending: Arc<StdMutex<HashMap<i64, oneshot::Sender<Value>>>>,
    /// Latest raw published diagnostics per URI, so code-action requests can pass
    /// rust-analyzer its own diagnostic objects (with their `data`) back as context.
    diagnostics: Arc<StdMutex<HashMap<String, Vec<Value>>>>,
    next_id: AtomicI64,
    version: AtomicI64,
    opened: StdMutex<HashSet<String>>,
    /// Set once JDT.LS reports it has finished importing the project
    /// (`language/status` `ServiceReady`). Main-class / classpath resolution only
    /// returns results after this point.
    ready: Arc<AtomicBool>,
    _child: Child,
}

/// How to launch the Java language server (Eclipse JDT.LS).
pub struct JdtlsLaunch {
    pub program: String,
    pub args: Vec<String>,
}

const JDTLS_MISSING: &str =
    "Java language server (jdtls) not found. Install it with `brew install jdtls` (needs a JDK 21+).";

/// Locate the `jdtls` launcher (Homebrew/pip wrapper first, then a raw
/// `java -jar …launcher.jar` invocation against a JDT.LS install). `data_dir` is a
/// per-project workspace the server keeps its index in.
pub fn find_jdtls(data_dir: &std::path::Path) -> Option<JdtlsLaunch> {
    let data = data_dir.to_string_lossy().into_owned();

    // 1) The `jdtls` wrapper script — handles the java command + config for us.
    let mut candidates = vec![
        "/opt/homebrew/bin/jdtls".to_string(),
        "/usr/local/bin/jdtls".to_string(),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/.local/bin/jdtls"));
    }
    if let Ok(out) = std::process::Command::new("which").arg("jdtls").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                candidates.insert(0, p);
            }
        }
    }
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return Some(JdtlsLaunch { program: c.clone(), args: vec!["-data".into(), data] });
        }
    }

    // 2) Fallback: a raw JDT.LS install (an equinox launcher jar + config dir).
    let java = which_java();
    for home in jdtls_home_candidates() {
        let plugins = home.join("plugins");
        let launcher = std::fs::read_dir(&plugins).ok().and_then(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .find(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with("org.eclipse.equinox.launcher_") && n.ends_with(".jar"))
                        .unwrap_or(false)
                })
        });
        let config = ["config_mac", "config_mac_arm", "config_linux"]
            .iter()
            .map(|c| home.join(c))
            .find(|p| p.exists());
        if let (Some(launcher), Some(config)) = (launcher, config) {
            return Some(JdtlsLaunch {
                program: java,
                args: vec![
                    "-Declipse.application=org.eclipse.jdt.ls.core.id1".into(),
                    "-Dosgi.bundles.defaultStartLevel=4".into(),
                    "-Declipse.product=org.eclipse.jdt.ls.core.product".into(),
                    "--add-modules=ALL-SYSTEM".into(),
                    "--add-opens".into(),
                    "java.base/java.util=ALL-UNNAMED".into(),
                    "--add-opens".into(),
                    "java.base/java.lang=ALL-UNNAMED".into(),
                    "-jar".into(),
                    launcher.to_string_lossy().into_owned(),
                    "-configuration".into(),
                    config.to_string_lossy().into_owned(),
                    "-data".into(),
                    data,
                ],
            });
        }
    }
    None
}

fn which_java() -> String {
    // Prefer the IDE-selected JDK (its `bin` directory).
    if let Some(d) = crate::toolchain::dir() {
        let p = std::path::Path::new(&d).join("java");
        if p.exists() {
            return p.to_string_lossy().into_owned();
        }
    }
    if let Ok(jh) = std::env::var("JAVA_HOME") {
        let p = std::path::Path::new(&jh).join("bin/java");
        if p.exists() {
            return p.to_string_lossy().into_owned();
        }
    }
    "java".to_string()
}

fn jdtls_home_candidates() -> Vec<std::path::PathBuf> {
    let mut v = vec![
        std::path::PathBuf::from("/opt/homebrew/opt/jdtls/libexec"),
        std::path::PathBuf::from("/usr/local/opt/jdtls/libexec"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        v.push(std::path::PathBuf::from(&home).join(".local/share/nvim/mason/packages/jdtls"));
    }
    v
}

fn uri_of(path: &str) -> String {
    format!("file://{path}")
}

/// Locate the java-debug plugin bundle (`com.microsoft.java.debug.plugin-*.jar`).
/// This jar is loaded into JDT.LS via `initializationOptions.bundles` and provides
/// the `vscode.java.*` debug commands. Checks `JAVA_DEBUG_BUNDLE`, then the usual
/// mason / VS Code extension install locations. `None` disables debugging.
pub fn find_java_debug_bundle() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("JAVA_DEBUG_BUNDLE") {
        let path = std::path::PathBuf::from(&p);
        if path.is_file() {
            return Some(path);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [
        format!("{home}/.local/share/nvim/mason/packages/java-debug-adapter/extension/server"),
        format!("{home}/.vscode/extensions"),
        format!("{home}/.local/share/java-debug"),
    ];
    for d in dirs {
        if let Some(jar) = newest_jar_matching(std::path::Path::new(&d), "com.microsoft.java.debug.plugin-") {
            return Some(jar);
        }
    }
    None
}

/// The lexically-greatest (≈ newest version) `<prefix>*.jar` found anywhere under
/// `root` (searched one level deep, then its `*/server` subdirs — enough for the
/// VS Code `extensions/<id>/server/` and mason layouts).
fn newest_jar_matching(root: &std::path::Path, prefix: &str) -> Option<std::path::PathBuf> {
    let mut search = vec![root.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                search.push(p.join("server"));
                search.push(p);
            }
        }
    }
    let mut best: Option<std::path::PathBuf> = None;
    for dir in search {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(prefix) && name.ends_with(".jar") {
                let p = e.path();
                if best.as_ref().map(|b| p > *b).unwrap_or(true) {
                    best = Some(p);
                }
            }
        }
    }
    best
}

async fn write_msg(writer: &Arc<tokio::sync::Mutex<ChildStdin>>, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    let mut w = writer.lock().await;
    w.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await?;
    w.write_all(&body).await?;
    w.flush().await?;
    Ok(())
}

impl LspClient {
    pub async fn start(app: AppHandle, root: &str) -> Result<LspClient> {
        // JDT.LS keeps its index in a per-project workspace directory.
        let data_dir = std::env::temp_dir()
            .join("reevik-java-ade-jdtls")
            .join(root.trim_start_matches('/').replace('/', "%"));
        let _ = std::fs::create_dir_all(&data_dir);
        let launch = find_jdtls(&data_dir).context(JDTLS_MISSING)?;
        let mut cmd = tokio::process::Command::new(&launch.program);
        cmd.args(&launch.args)
            .current_dir(root)
            .env("PATH", crate::toolchain::effective_path());
        if let Some(home) = crate::toolchain::java_home() {
            cmd.env("JAVA_HOME", home);
        }
        let mut child = cmd
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .with_context(|| format!("spawning {}", launch.program))?;

        let stdin = child.stdin.take().context("ra stdin")?;
        let stdout = child.stdout.take().context("ra stdout")?;
        let writer = Arc::new(tokio::sync::Mutex::new(stdin));
        let pending: Arc<StdMutex<HashMap<i64, oneshot::Sender<Value>>>> =
            Arc::new(StdMutex::new(HashMap::new()));
        let diagnostics: Arc<StdMutex<HashMap<String, Vec<Value>>>> =
            Arc::new(StdMutex::new(HashMap::new()));
        let ready = Arc::new(AtomicBool::new(false));

        // Reader task: fulfil responses, answer server requests, forward diagnostics.
        {
            let pending = pending.clone();
            let writer = writer.clone();
            let app = app.clone();
            let diagnostics = diagnostics.clone();
            let ready = ready.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut len = 0usize;
                    // headers
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                            return; // EOF: rust-analyzer exited
                        }
                        let line = line.trim_end();
                        if line.is_empty() {
                            break;
                        }
                        if let Some(v) = line.strip_prefix("Content-Length:") {
                            len = v.trim().parse().unwrap_or(0);
                        }
                    }
                    if len == 0 {
                        continue;
                    }
                    let mut buf = vec![0u8; len];
                    if reader.read_exact(&mut buf).await.is_err() {
                        return;
                    }
                    let Ok(msg) = serde_json::from_slice::<Value>(&buf) else {
                        continue;
                    };

                    let has_id = msg.get("id").is_some();
                    let is_response = has_id && (msg.get("result").is_some() || msg.get("error").is_some());
                    if is_response {
                        if let Some(id) = msg.get("id").and_then(Value::as_i64) {
                            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                                let _ = tx.send(msg);
                            }
                        }
                    } else if has_id && msg.get("method").is_some() {
                        // Server → client request: reply so it doesn't block.
                        let id = msg.get("id").cloned().unwrap_or(Value::Null);
                        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
                        let result = if method == "workspace/configuration" {
                            let n = msg
                                .get("params")
                                .and_then(|p| p.get("items"))
                                .and_then(Value::as_array)
                                .map(|a| a.len())
                                .unwrap_or(0);
                            Value::Array(vec![Value::Null; n])
                        } else {
                            Value::Null
                        };
                        let _ = write_msg(&writer, &json!({"jsonrpc":"2.0","id":id,"result":result})).await;
                    } else if msg.get("method").and_then(Value::as_str)
                        == Some("textDocument/publishDiagnostics")
                    {
                        // rust-analyzer pushes {uri, diagnostics:[…]} as it re-checks.
                        if let Some(params) = msg.get("params") {
                            if let (Some(uri), Some(diags)) = (
                                params.get("uri").and_then(Value::as_str),
                                params.get("diagnostics").and_then(Value::as_array),
                            ) {
                                diagnostics.lock().unwrap().insert(uri.to_string(), diags.clone());
                            }
                            let _ = app.emit("lsp:diagnostics", params.clone());
                        }
                    } else if msg.get("method").and_then(Value::as_str) == Some("language/status") {
                        // JDT.LS import lifecycle: {type: "Starting"|"Started"|
                        // "ServiceReady"|"ProjectStatus"|..., message}. ServiceReady
                        // means the project model is built and main-class / classpath
                        // resolution will return results.
                        if let Some(params) = msg.get("params") {
                            let kind = params.get("type").and_then(Value::as_str).unwrap_or("");
                            if kind == "ServiceReady" || kind == "Started" {
                                ready.store(true, Ordering::SeqCst);
                            }
                            let _ = app.emit("lsp:status", params.clone());
                        }
                    }
                    // other notifications (progress, logs) are ignored.
                }
            });
        }

        let client = LspClient {
            root: root.to_string(),
            writer,
            pending,
            diagnostics,
            next_id: AtomicI64::new(1),
            version: AtomicI64::new(1),
            opened: StdMutex::new(HashSet::new()),
            ready,
            _child: child,
        };

        // Load the java-debug plugin bundle (if installed) so the `vscode.java.*`
        // debug commands become available via workspace/executeCommand.
        let bundles: Vec<String> = find_java_debug_bundle()
            .map(|p| vec![p.to_string_lossy().into_owned()])
            .unwrap_or_default();

        // Handshake.
        client
            .request(
                "initialize",
                json!({
                    "processId": std::process::id(),
                    "rootUri": uri_of(root),
                    "initializationOptions": { "bundles": bundles },
                    "capabilities": {
                        "textDocument": {
                            // Snippets let rust-analyzer add call parens (`foo($0)`)
                            // and argument tab stops; we expand them client-side.
                            "completion": { "completionItem": { "snippetSupport": true } },
                            // Code actions (quick fixes / assists). We do NOT advertise
                            // resolveSupport or snippetTextEdit, so rust-analyzer returns
                            // fully-computed plain-text edits we can apply directly.
                            "codeAction": {
                                "codeActionLiteralSupport": {
                                    "codeActionKind": {
                                        "valueSet": ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source"]
                                    }
                                }
                            }
                        },
                        "workspace": { "configuration": true }
                    }
                }),
                Duration::from_secs(30),
            )
            .await
            .context("initialize")?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        write_msg(&self.writer, &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).await?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => Ok(v),
            _ => {
                self.pending.lock().unwrap().remove(&id);
                anyhow::bail!("LSP request '{method}' timed out")
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        write_msg(&self.writer, &json!({"jsonrpc":"2.0","method":method,"params":params})).await
    }

    /// Ensure rust-analyzer has the current text of `path`.
    pub async fn sync(&self, path: &str, text: &str) -> Result<()> {
        let uri = uri_of(path);
        let first = self.opened.lock().unwrap().insert(path.to_string());
        let version = self.version.fetch_add(1, Ordering::SeqCst);
        if first {
            self.notify(
                "textDocument/didOpen",
                json!({"textDocument":{"uri":uri,"languageId":"java","version":version,"text":text}}),
            )
            .await
        } else {
            // A single content change with no range = full replace (verified OK).
            self.notify(
                "textDocument/didChange",
                json!({"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":text}]}),
            )
            .await
        }
    }

    /// Notify rust-analyzer the file was saved, so it re-runs `cargo check`.
    /// Without this, flycheck (cargo-check) diagnostics never refresh and a fixed
    /// error's mark lingers until the next check — which only save triggers.
    pub async fn did_save(&self, path: &str) -> Result<()> {
        self.notify(
            "textDocument/didSave",
            json!({ "textDocument": { "uri": uri_of(path) } }),
        )
        .await
    }

    // --- java-debug: driven through the JDT server's executeCommand ------------

    /// Run a `workspace/executeCommand` and return its `result` (erroring on a
    /// JSON-RPC error reply).
    pub async fn execute_command(&self, command: &str, arguments: Vec<Value>) -> Result<Value> {
        let resp = self
            .request(
                "workspace/executeCommand",
                json!({ "command": command, "arguments": arguments }),
                Duration::from_secs(30),
            )
            .await?;
        if let Some(err) = resp.get("error") {
            let msg = err.get("message").and_then(Value::as_str).unwrap_or("executeCommand failed");
            anyhow::bail!("{command}: {msg}");
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Start a java-debug DAP server; returns the local TCP port it listens on.
    pub async fn start_debug_session(&self) -> Result<u16> {
        let result = self.execute_command("vscode.java.startDebugSession", vec![]).await?;
        result
            .as_u64()
            .map(|n| n as u16)
            .context("startDebugSession did not return a port")
    }

    /// Resolve the runnable main classes in the workspace: a list of
    /// `{ mainClass, projectName, filePath }`.
    pub async fn resolve_main_class(&self) -> Result<Vec<Value>> {
        let result = self
            .execute_command("vscode.java.resolveMainClass", vec![json!(uri_of(&self.root))])
            .await?;
        Ok(result.as_array().cloned().unwrap_or_default())
    }

    /// Resolve the launch target for `desired` (a main class) into the exact
    /// `(mainClass, projectName)` the JDT server knows. Retries because project
    /// import is asynchronous — `resolveMainClass` is empty until it completes.
    /// `Err` carries a message describing why nothing matched.
    pub async fn resolve_launch_target(&self, desired: &str) -> Result<(String, String)> {
        let simple = desired.rsplit('.').next().unwrap_or(desired);
        // A cold Maven/Gradle import (first open, no cached workspace) resolves
        // dependencies and builds the project model before any main class is
        // known — that can take well over a minute. Wait generously, polling
        // resolveMainClass until the list is populated.
        let deadline = std::time::Instant::now() + Duration::from_secs(150);
        let mut attempt = 0u32;
        let mut ready_since: Option<std::time::Instant> = None;
        loop {
            let list = self.resolve_main_class().await.unwrap_or_default();
            if !list.is_empty() {
                let name_of = |m: &Value| m.get("mainClass").and_then(Value::as_str).map(str::to_string);
                let proj_of = |m: &Value| m.get("projectName").and_then(Value::as_str).unwrap_or("").to_string();
                // Prefer an exact FQN match, else a simple-name match.
                if let Some(m) = list.iter().find(|m| name_of(m).as_deref() == Some(desired)) {
                    return Ok((desired.to_string(), proj_of(m)));
                }
                if let Some(m) = list
                    .iter()
                    .find(|m| name_of(m).map(|c| c.rsplit('.').next().unwrap_or(&c) == simple).unwrap_or(false))
                {
                    return Ok((name_of(m).unwrap_or_else(|| desired.to_string()), proj_of(m)));
                }
                // Non-empty but no match → the class isn't a recognized main class.
                let known: Vec<String> = list.iter().filter_map(name_of).collect();
                anyhow::bail!(
                    "'{desired}' isn't a runnable main class in this project. Known main classes: {}",
                    if known.is_empty() { "(none)".into() } else { known.join(", ") }
                );
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            // If the server has reported ready but still lists no main classes,
            // waiting longer won't help (it can't resolve this project) — bail
            // after a short grace so the caller can fall back to another strategy.
            if self.ready.load(Ordering::SeqCst) {
                let since = *ready_since.get_or_insert(now);
                if now.duration_since(since) >= Duration::from_secs(8) {
                    break;
                }
            }
            // Empty list → still importing. Back off (fast at first, then steady).
            tokio::time::sleep(Duration::from_millis(if attempt < 4 { 400 } else { 1200 })).await;
            attempt += 1;
        }
        if self.ready.load(Ordering::SeqCst) {
            anyhow::bail!(
                "no runnable main classes found in this project. Ensure the class has a `public static void main(String[])` and the file is under a source root (e.g. src/main/java)."
            )
        }
        anyhow::bail!(
            "the Java language server is still importing the project (this can take a minute on first open while dependencies download). Wait for indexing to finish, then try again."
        )
    }

    /// Resolve `(modulePaths, classPaths)` for launching `main_class` in
    /// `project_name` (empty project name lets JDT infer it).
    pub async fn resolve_classpath(&self, main_class: &str, project_name: &str) -> Result<(Vec<String>, Vec<String>)> {
        let result = self
            .execute_command(
                "vscode.java.resolveClasspath",
                vec![json!(main_class), json!(project_name)],
            )
            .await?;
        // The command returns `[modulePaths, classPaths]`.
        let arr = result.as_array().cloned().unwrap_or_default();
        let to_vec = |v: Option<&Value>| {
            v.and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        Ok((to_vec(arr.first()), to_vec(arr.get(1))))
    }

    pub async fn completion(
        &self,
        path: &str,
        text: &str,
        line: u32,
        character: u32,
    ) -> Result<Vec<CompletionItem>> {
        self.sync(path, text).await?;
        let resp = self
            .request(
                "textDocument/completion",
                json!({
                    "textDocument": { "uri": uri_of(path) },
                    "position": { "line": line, "character": character }
                }),
                Duration::from_secs(8),
            )
            .await?;

        let result = resp.get("result");
        let items = match result {
            Some(Value::Object(o)) => o.get("items").and_then(Value::as_array).cloned().unwrap_or_default(),
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        };

        // rust-analyzer returns the whole candidate set (e.g. all of a glob-imported
        // prelude, 879 items) and expects the CLIENT to filter by what was typed. So
        // we MUST match against the typed prefix before capping — otherwise a prefix
        // match like `build_app` is truncated away behind hundreds of A-named types.
        let prefix = prefix_at(text, line, character).to_lowercase();

        let mut ranked: Vec<(u8, String, &Value)> = items
            .iter()
            .filter_map(|it| {
                let ft = it
                    .get("filterText")
                    .and_then(Value::as_str)
                    .or_else(|| it.get("label").and_then(Value::as_str))
                    .unwrap_or("");
                let rank = fuzzy_rank(&ft.to_lowercase(), &prefix)?; // None ⇒ no match
                let sort = it.get("sortText").and_then(Value::as_str).unwrap_or(ft).to_string();
                Some((rank, sort, it))
            })
            .collect();
        // Best matches first (prefix > substring > subsequence), sortText as tiebreak.
        ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

        let out = ranked
            .iter()
            .filter_map(|(_, _, it)| {
                let label = it.get("label").and_then(Value::as_str)?.to_string();
                // insert text: textEdit.newText > insertText > label sans "(as …)" tag
                let insert = it
                    .get("textEdit")
                    .and_then(|e| e.get("newText"))
                    .and_then(Value::as_str)
                    .or_else(|| it.get("insertText").and_then(Value::as_str))
                    .map(str::to_string)
                    .unwrap_or_else(|| label.split(" (").next().unwrap_or(&label).trim().to_string());
                // Match the typed prefix against rust-analyzer's filterText, or a
                // cleaned label (drop the "(as Trait)" tag and any trailing `()`).
                let filter_text = it
                    .get("filterText")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        label
                            .split(" (")
                            .next()
                            .unwrap_or(&label)
                            .trim_end_matches("()")
                            .to_string()
                    });
                // insertTextFormat 2 = Snippet (parens + arg tab stops).
                let snippet = it.get("insertTextFormat").and_then(Value::as_i64) == Some(2);
                Some(CompletionItem {
                    label,
                    filter_text,
                    insert,
                    snippet,
                    detail: it.get("detail").and_then(Value::as_str).unwrap_or("").to_string(),
                    kind: kind_slug(it.get("kind").and_then(Value::as_i64).unwrap_or(0)),
                })
            })
            .take(200)
            .collect();
        Ok(out)
    }

    /// The definition site of the symbol at a position: (absolute path, 0-based
    /// line, 0-based character). `None` when there isn't one.
    pub async fn definition(
        &self,
        path: &str,
        text: &str,
        line: u32,
        character: u32,
    ) -> Result<Option<(String, u32, u32)>> {
        self.sync(path, text).await?;
        let resp = self
            .request(
                "textDocument/definition",
                json!({
                    "textDocument": { "uri": uri_of(path) },
                    "position": { "line": line, "character": character }
                }),
                Duration::from_secs(6),
            )
            .await?;
        Ok(resp.get("result").and_then(first_location))
    }

    /// Hover info (type signature + docs) at a position, as Markdown. `None` when
    /// there's nothing to show.
    pub async fn hover(&self, path: &str, text: &str, line: u32, character: u32) -> Result<Option<String>> {
        self.sync(path, text).await?;
        let resp = self
            .request(
                "textDocument/hover",
                json!({
                    "textDocument": { "uri": uri_of(path) },
                    "position": { "line": line, "character": character }
                }),
                Duration::from_secs(6),
            )
            .await?;
        Ok(resp.get("result").and_then(hover_text))
    }

    /// Code actions (quick fixes + assists) for a range, à la IntelliJ ⌥⏎. Only
    /// edits that target the current file are returned (multi-file assists are
    /// filtered out so every listed action is directly applicable).
    pub async fn code_action(
        &self,
        path: &str,
        text: &str,
        start: (u32, u32),
        end: (u32, u32),
    ) -> Result<Vec<CodeActionItem>> {
        self.sync(path, text).await?;
        let uri = uri_of(path);
        // Feed rust-analyzer the diagnostics overlapping the requested range so its
        // diagnostic-specific quick fixes are returned regardless of caret column.
        let ctx_diags: Vec<Value> = self
            .diagnostics
            .lock()
            .unwrap()
            .get(&uri)
            .map(|list| list.iter().filter(|d| diag_intersects(d, start, end)).cloned().collect())
            .unwrap_or_default();
        let resp = self
            .request(
                "textDocument/codeAction",
                json!({
                    "textDocument": { "uri": uri },
                    "range": {
                        "start": { "line": start.0, "character": start.1 },
                        "end": { "line": end.0, "character": end.1 }
                    },
                    "context": { "diagnostics": ctx_diags }
                }),
                Duration::from_secs(6),
            )
            .await?;
        Ok(parse_code_actions(resp.get("result"), &uri))
    }

    /// All references to the symbol at a position ("Find Usages"), each with a
    /// trimmed source-line preview. Includes the declaration.
    pub async fn references(
        &self,
        path: &str,
        text: &str,
        line: u32,
        character: u32,
    ) -> Result<Vec<Reference>> {
        self.sync(path, text).await?;
        let resp = self
            .request(
                "textDocument/references",
                json!({
                    "textDocument": { "uri": uri_of(path) },
                    "position": { "line": line, "character": character },
                    "context": { "includeDeclaration": true }
                }),
                Duration::from_secs(8),
            )
            .await?;
        let locs = parse_locations(resp.get("result"));
        // Attach a source-line preview + a read/write/decl classification, reading
        // each referenced file at most once.
        let mut cache: HashMap<String, Vec<String>> = HashMap::new();
        let mut out = Vec::with_capacity(locs.len());
        for (p, l, c, end_c) in locs {
            let lines = cache.entry(p.clone()).or_insert_with(|| {
                std::fs::read_to_string(&p)
                    .map(|s| s.lines().map(str::to_string).collect())
                    .unwrap_or_default()
            });
            let raw = lines.get(l as usize).cloned().unwrap_or_default();
            let kind = classify_usage(&raw, c as usize, end_c as usize).to_string();
            out.push(Reference { path: p, line: l, character: c, preview: raw.trim().to_string(), kind });
        }
        Ok(out)
    }

    /// Rename the symbol at a position everywhere (LSP rename). Returns the edits
    /// grouped per file, for the client to apply across open buffers + on disk.
    pub async fn rename(
        &self,
        path: &str,
        text: &str,
        line: u32,
        character: u32,
        new_name: &str,
    ) -> Result<Vec<FileEdit>> {
        self.sync(path, text).await?;
        let resp = self
            .request(
                "textDocument/rename",
                json!({
                    "textDocument": { "uri": uri_of(path) },
                    "position": { "line": line, "character": character },
                    "newName": new_name
                }),
                Duration::from_secs(15),
            )
            .await?;
        Ok(parse_workspace_edit(resp.get("result")))
    }

    pub fn root(&self) -> &str {
        &self.root
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    pub path: String,
    pub edits: Vec<TextEditItem>,
}

/// Collect every file's edits from a `WorkspaceEdit` (both `changes` and
/// `documentChanges` forms). Paths are absolute (file:// stripped + decoded).
fn parse_workspace_edit(result: Option<&Value>) -> Vec<FileEdit> {
    let edit = match result {
        Some(e) if !e.is_null() => e,
        _ => return Vec::new(),
    };
    let mut out: Vec<FileEdit> = Vec::new();
    let uri_to_path = |uri: &str| percent_decode(uri.strip_prefix("file://").unwrap_or(uri));

    if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
        for (uri, list) in changes {
            let mut edits = Vec::new();
            if let Some(arr) = list.as_array() {
                for te in arr {
                    push_text_edit(te, &mut edits);
                }
            }
            if !edits.is_empty() {
                out.push(FileEdit { path: uri_to_path(uri), edits });
            }
        }
    }
    if let Some(dcs) = edit.get("documentChanges").and_then(Value::as_array) {
        for dc in dcs {
            let Some(uri) = dc.get("textDocument").and_then(|t| t.get("uri")).and_then(Value::as_str) else {
                continue; // skip create/rename/delete file ops
            };
            let mut edits = Vec::new();
            if let Some(arr) = dc.get("edits").and_then(Value::as_array) {
                for te in arr {
                    push_text_edit(te, &mut edits);
                }
            }
            if !edits.is_empty() {
                out.push(FileEdit { path: uri_to_path(uri), edits });
            }
        }
    }
    out
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub path: String,
    pub line: u32,
    pub character: u32,
    pub preview: String,
    /// "decl" | "write" | "read" — a best-effort classification of the usage.
    pub kind: String,
}

/// Best-effort read/write/decl classification from the source line (LSP references
/// don't carry this). `start`/`end` are 0-based character columns of the token.
fn classify_usage(line: &str, start: usize, end: usize) -> &'static str {
    let chars: Vec<char> = line.chars().collect();
    let before: String = chars.iter().take(start).collect();
    let trimmed_before = before.trim_end();
    // A declaration: `let x`, `let mut x`, or a function/param context `fn x` / `: x`.
    if trimmed_before.ends_with("let") || trimmed_before.ends_with("mut") {
        return "decl";
    }
    // A write: the token is directly assigned to (`x =`, `x +=`, …) — but not `==`,
    // `=>`, `<=`, `>=`, `!=`.
    let after: String = chars.iter().skip(end).collect();
    let a = after.trim_start();
    let assign = a.starts_with("+=")
        || a.starts_with("-=")
        || a.starts_with("*=")
        || a.starts_with("/=")
        || a.starts_with("%=")
        || a.starts_with("&=")
        || a.starts_with("|=")
        || a.starts_with("^=")
        || (a.starts_with('=') && !a.starts_with("==") && !a.starts_with("=>"));
    if assign {
        return "write";
    }
    "read"
}

/// Parse a `Location[]` result into (absolute path, 0-based line, start char, end char).
fn parse_locations(result: Option<&Value>) -> Vec<(String, u32, u32, u32)> {
    let Some(arr) = result.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for loc in arr {
        let (Some(uri), Some(range)) =
            (loc.get("uri").and_then(Value::as_str), loc.get("range"))
        else {
            continue;
        };
        let g = |k: &str, f: &str| range.get(k).and_then(|o| o.get(f)).and_then(Value::as_u64).unwrap_or(0) as u32;
        let line = g("start", "line");
        let ch = g("start", "character");
        let end_ch = g("end", "character");
        out.push((percent_decode(uri.strip_prefix("file://").unwrap_or(uri)), line, ch, end_ch));
    }
    out
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEditItem {
    pub start_line: u32,
    pub start_character: u32,
    pub end_line: u32,
    pub end_character: u32,
    pub new_text: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeActionItem {
    pub title: String,
    pub kind: Option<String>,
    pub is_preferred: bool,
    /// Edits for the current file, in the order the server gave them.
    pub edits: Vec<TextEditItem>,
}

/// Whether a diagnostic's range overlaps the (inclusive) line span `[start.0, end.0]`.
/// Line-granular on purpose: ⌥⏎ anywhere on a warned line should offer its fix.
fn diag_intersects(d: &Value, start: (u32, u32), end: (u32, u32)) -> bool {
    let range = match d.get("range") {
        Some(r) => r,
        None => return false,
    };
    let g = |k: &str, f: &str| range.get(k).and_then(|o| o.get(f)).and_then(Value::as_u64).unwrap_or(0) as u32;
    let (d_start, d_end) = (g("start", "line"), g("end", "line"));
    d_start <= end.0 && start.0 <= d_end
}

/// Turn a `textDocument/codeAction` result into applicable, in-file actions.
fn parse_code_actions(result: Option<&Value>, uri: &str) -> Vec<CodeActionItem> {
    let Some(arr) = result.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<CodeActionItem> = Vec::new();
    for a in arr {
        let title = match a.get("title").and_then(Value::as_str) {
            Some(t) if !t.is_empty() => t.to_string(),
            _ => continue,
        };
        // Plain `Command` entries (and assists whose edit only touches other files)
        // aren't applicable here, so drop them.
        let edits = a.get("edit").map(|e| collect_edits(e, uri)).unwrap_or_default();
        if edits.is_empty() {
            continue;
        }
        out.push(CodeActionItem {
            title,
            kind: a.get("kind").and_then(Value::as_str).map(str::to_string),
            is_preferred: a.get("isPreferred").and_then(Value::as_bool).unwrap_or(false),
            edits,
        });
    }
    // Surface the server's preferred fix first; keep original order otherwise.
    out.sort_by(|x, y| y.is_preferred.cmp(&x.is_preferred));
    out
}

/// Collect the `TextEdit`s in a `WorkspaceEdit` that target `uri` (both the
/// `changes` map and the `documentChanges` array forms).
fn collect_edits(edit: &Value, uri: &str) -> Vec<TextEditItem> {
    let mut out = Vec::new();
    if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
        if let Some(list) = changes.get(uri).and_then(Value::as_array) {
            for te in list {
                push_text_edit(te, &mut out);
            }
        }
    }
    if let Some(dcs) = edit.get("documentChanges").and_then(Value::as_array) {
        for dc in dcs {
            let dc_uri = dc.get("textDocument").and_then(|t| t.get("uri")).and_then(Value::as_str);
            if dc_uri == Some(uri) {
                if let Some(list) = dc.get("edits").and_then(Value::as_array) {
                    for te in list {
                        push_text_edit(te, &mut out);
                    }
                }
            }
        }
    }
    out
}

fn push_text_edit(te: &Value, out: &mut Vec<TextEditItem>) {
    let (Some(range), Some(new_text)) =
        (te.get("range"), te.get("newText").and_then(Value::as_str))
    else {
        return;
    };
    let g = |o: Option<&Value>, k: &str| o.and_then(|v| v.get(k)).and_then(Value::as_u64).unwrap_or(0) as u32;
    let s = range.get("start");
    let e = range.get("end");
    out.push(TextEditItem {
        start_line: g(s, "line"),
        start_character: g(s, "character"),
        end_line: g(e, "line"),
        end_character: g(e, "character"),
        new_text: new_text.to_string(),
    });
}

/// First target from a definition result: `Location`, `Location[]`, or
/// `LocationLink[]`. Returns (absolute path, 0-based line, 0-based character).
fn first_location(result: &Value) -> Option<(String, u32, u32)> {
    let pick = |v: &Value| -> Option<(String, u32, u32)> {
        let uri = v
            .get("uri")
            .or_else(|| v.get("targetUri"))
            .and_then(Value::as_str)?;
        let range = v
            .get("range")
            .or_else(|| v.get("targetSelectionRange"))
            .or_else(|| v.get("targetRange"))?;
        let start = range.get("start")?;
        let line = start.get("line").and_then(Value::as_u64)? as u32;
        let ch = start.get("character").and_then(Value::as_u64)? as u32;
        let path = percent_decode(uri.strip_prefix("file://").unwrap_or(uri));
        Some((path, line, ch))
    };
    match result {
        Value::Array(a) => a.first().and_then(pick),
        Value::Object(_) => pick(result),
        _ => None,
    }
}

/// Decode `%XX` escapes in a file URI path (registry paths can contain them).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extract the text from an LSP Hover result's `contents`, which may be a
/// `MarkupContent` object, a `MarkedString`, or an array of them.
fn hover_text(result: &Value) -> Option<String> {
    let contents = result.get("contents")?;
    let one = |v: &Value| -> Option<String> {
        match v {
            Value::String(s) => Some(s.clone()),
            Value::Object(o) => o.get("value").and_then(Value::as_str).map(str::to_string),
            _ => None,
        }
    };
    let text = match contents {
        Value::Array(items) => items.iter().filter_map(one).collect::<Vec<_>>().join("\n\n"),
        other => one(other)?,
    };
    (!text.trim().is_empty()).then_some(text)
}

/// The identifier being typed, scanned back from the completion position. Rust
/// identifiers are ASCII, so treating `character` (a UTF-16 offset) as a char
/// count is exact here.
fn prefix_at(text: &str, line: u32, character: u32) -> String {
    let line_str = text.lines().nth(line as usize).unwrap_or("");
    let upto: String = line_str.chars().take(character as usize).collect();
    let rev: String = upto
        .chars()
        .rev()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    rev.chars().rev().collect()
}

/// How well `text` (lowercased filterText) matches the typed `prefix` (lowercased).
/// Lower is better; `None` means no match, so the item is dropped. Mirrors what a
/// fuzzy completion UI keeps: prefix > substring > subsequence.
fn fuzzy_rank(text: &str, prefix: &str) -> Option<u8> {
    if prefix.is_empty() {
        return Some(3);
    }
    if text.starts_with(prefix) {
        return Some(0);
    }
    if text.contains(prefix) {
        return Some(1);
    }
    let mut chars = text.chars();
    if prefix.chars().all(|c| chars.by_ref().any(|x| x == c)) {
        return Some(2);
    }
    None
}

/// LSP CompletionItemKind → a short slug the UI turns into an icon.
fn kind_slug(k: i64) -> String {
    match k {
        2 | 3 => "method",
        5 => "field",
        6 => "variable",
        7 => "class",
        8 => "interface",
        9 => "module",
        10 => "property",
        13 => "enum",
        14 => "keyword",
        21 => "constant",
        22 => "struct",
        _ => "text",
    }
    .to_string()
}
