//! A minimal Debug Adapter Protocol client for `java-debug`.
//!
//! Unlike a standalone adapter, java-debug runs *inside* the JDT language server:
//! the LSP `vscode.java.startDebugSession` command starts a DAP server on a local
//! TCP port, and we connect to it here. DAP uses the same `Content-Length:` framing
//! as LSP, so this mirrors `crate::lsp` closely: a background reader task and a
//! pending-map correlating responses by `request_seq`. Adapter → client *events*
//! (stopped, output, terminated, …) are forwarded to the frontend on a single
//! `dap:event` channel.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Notify};

/// A source breakpoint from the frontend: a line plus optional DAP conditions.
#[derive(serde::Deserialize, Clone, Default)]
pub struct SourceBp {
    pub line: u32,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default, rename = "hitCondition")]
    pub hit_condition: Option<String>,
    #[serde(default, rename = "logMessage")]
    pub log_message: Option<String>,
}

/// Turn java-debug's raw launch-failure `message` into something actionable,
/// calling out a busy debug port (the usual cause: a previous debuggee still
/// running) with guidance the raw message doesn't give.
fn describe_launch_error(msg: &str) -> String {
    let low = msg.to_ascii_lowercase();
    let port_busy = low.contains("address already in use")
        || low.contains("bindexception")
        || low.contains("already in use")
        || low.contains("failed to attach")
        || (low.contains("port") && low.contains("in use"));
    if port_busy {
        format!(
            "the debug port is already in use — a previous debug session is probably still \
             running. Stop it (the ■ Stop button, or kill the leftover Java process) and start \
             debugging again.\n\nAdapter said: {msg}"
        )
    } else {
        format!("launch failed: {msg}")
    }
}

#[derive(serde::Serialize)]
pub struct StackFrame {
    pub id: i64,
    pub name: String,
    /// Absolute source path, when the frame has one (skips runtime/inlined frames).
    pub path: Option<String>,
    pub line: u32,
    pub column: u32,
}

#[derive(serde::Serialize)]
pub struct Scope {
    pub name: String,
    pub variables_reference: i64,
}

#[derive(serde::Serialize)]
pub struct Variable {
    pub name: String,
    pub value: String,
    #[serde(rename = "type")]
    pub ty: Option<String>,
    /// >0 when the value is expandable (struct/array); pass back to `variables`.
    pub variables_reference: i64,
}

#[derive(serde::Serialize)]
pub struct EvalResult {
    pub result: String,
    pub variables_reference: i64,
}

/// One REPL completion proposal from the adapter's `completions` request.
#[derive(serde::Serialize)]
pub struct CompletionItem {
    /// Text shown in the list.
    pub label: String,
    /// Text to insert (defaults to `label` when the adapter omits it).
    pub text: String,
    /// DAP item type ("method", "field", "variable", …) for an icon, if given.
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// When set, the span in the input the insertion replaces (0-based, in UTF-16
    /// code units as DAP specifies). Falls back to whole-word replacement client-side.
    pub start: Option<i64>,
    pub length: Option<i64>,
}

pub struct DapClient {
    writer: Arc<tokio::sync::Mutex<OwnedWriteHalf>>,
    pending: Arc<StdMutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_seq: AtomicI64,
    /// Fired by the reader task when the adapter emits the `initialized` event.
    initialized: Arc<Notify>,
}

async fn write_msg(writer: &Arc<tokio::sync::Mutex<OwnedWriteHalf>>, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    let mut w = writer.lock().await;
    w.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await?;
    w.write_all(&body).await?;
    w.flush().await?;
    Ok(())
}

impl DapClient {
    /// Connect to the java-debug DAP server listening on `127.0.0.1:port` (started
    /// via the JDT `vscode.java.startDebugSession` command), run the
    /// initialize→launch→configurationDone handshake with the given launch config
    /// and breakpoints, and return a client ready to step/inspect.
    pub async fn start(
        app: AppHandle,
        port: u16,
        launch: Value,
        breakpoints: &HashMap<String, Vec<SourceBp>>,
    ) -> Result<DapClient> {
        // The server may need a moment after startDebugSession before it accepts.
        let stream = {
            let mut last = None;
            let mut s = None;
            for _ in 0..40 {
                match TcpStream::connect(("127.0.0.1", port)).await {
                    Ok(c) => {
                        s = Some(c);
                        break;
                    }
                    Err(e) => {
                        last = Some(e);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
            match s {
                Some(c) => c,
                None => {
                    let detail = last
                        .as_ref()
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "no connection attempts made".into());
                    bail!(
                        "couldn't connect to the java-debug server on 127.0.0.1:{port} ({detail}). \
                         The debug adapter didn't start listening. If a previous debug session is \
                         still running, stop it (the ■ Stop button, or kill the leftover Java \
                         process) and try again."
                    );
                }
            }
        };
        let (read_half, write_half) = stream.into_split();
        let writer = Arc::new(tokio::sync::Mutex::new(write_half));
        let pending: Arc<StdMutex<HashMap<i64, oneshot::Sender<Value>>>> =
            Arc::new(StdMutex::new(HashMap::new()));
        let initialized = Arc::new(Notify::new());
        let next_seq = AtomicI64::new(1);

        // Reader task: fulfil responses, signal `initialized`, forward events, and
        // acknowledge any reverse requests so the adapter never stalls.
        {
            let pending = pending.clone();
            let writer = writer.clone();
            let app = app.clone();
            let initialized = initialized.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(read_half);
                loop {
                    let mut len = 0usize;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                            let _ = app.emit("dap:event", json!({ "event": "terminated", "body": {} }));
                            return; // EOF: adapter exited
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

                    match msg.get("type").and_then(Value::as_str) {
                        Some("response") => {
                            if let Some(rs) = msg.get("request_seq").and_then(Value::as_i64) {
                                if let Some(tx) = pending.lock().unwrap().remove(&rs) {
                                    let _ = tx.send(msg);
                                }
                            }
                        }
                        Some("event") => {
                            let event = msg.get("event").and_then(Value::as_str).unwrap_or("");
                            if event == "initialized" {
                                initialized.notify_one();
                            }
                            let _ = app.emit(
                                "dap:event",
                                json!({ "event": event, "body": msg.get("body").cloned().unwrap_or(Value::Null) }),
                            );
                        }
                        Some("request") => {
                            // Reverse request (e.g. runInTerminal). We run the target on
                            // the internal console, so just acknowledge to avoid a stall.
                            let seq = msg.get("seq").cloned().unwrap_or(Value::Null);
                            let command = msg.get("command").cloned().unwrap_or(Value::Null);
                            let _ = write_msg(
                                &writer,
                                &json!({"type":"response","request_seq":seq,"success":true,"command":command,"body":{}}),
                            )
                            .await;
                        }
                        _ => {}
                    }
                }
            });
        }

        let client = DapClient {
            writer,
            pending,
            next_seq,
            initialized,
        };

        // Handshake. `launch` may not answer until after configurationDone, so we
        // hold its receiver and await it last rather than blocking the sequence.
        client
            .request(
                "initialize",
                json!({
                    "clientID": "java-ade",
                    "adapterID": "java",
                    "linesStartAt1": true,
                    "columnsStartAt1": true,
                    "pathFormat": "path",
                    "supportsVariableType": true,
                    "supportsRunInTerminalRequest": false
                }),
                Duration::from_secs(15),
            )
            .await
            .context("initialize")?;

        // The launch config is built by the caller (mainClass/projectName/
        // classPaths/modulePaths/cwd/args/vmArgs), resolved from the JDT server.
        let launch_rx = client.send("launch", launch).await?;

        // The adapter is ready for breakpoints once it emits `initialized`.
        let _ = tokio::time::timeout(Duration::from_secs(15), client.initialized.notified()).await;
        for (path, bps) in breakpoints {
            if !bps.is_empty() {
                let _ = client.set_breakpoints(path, bps).await;
            }
        }
        client
            .request("configurationDone", json!({}), Duration::from_secs(10))
            .await
            .context("configurationDone")?;

        // Now the deferred launch response should arrive.
        match tokio::time::timeout(Duration::from_secs(30), launch_rx).await {
            Ok(Ok(resp)) if resp.get("success").and_then(Value::as_bool) == Some(true) => {}
            Ok(Ok(resp)) => {
                let msg = resp.get("message").and_then(Value::as_str).unwrap_or("launch failed");
                bail!("{}", describe_launch_error(msg));
            }
            _ => bail!("launch timed out"),
        }
        Ok(client)
    }

    /// Write a request and return the receiver for its response (correlated by seq).
    async fn send(&self, command: &str, arguments: Value) -> Result<oneshot::Receiver<Value>> {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(seq, tx);
        write_msg(
            &self.writer,
            &json!({ "seq": seq, "type": "request", "command": command, "arguments": arguments }),
        )
        .await?;
        Ok(rx)
    }

    /// Send a request and await its response, returning the `body` (or erroring on a
    /// `success:false` reply).
    async fn request(&self, command: &str, arguments: Value, timeout: Duration) -> Result<Value> {
        let rx = self.send(command, arguments).await?;
        let resp = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => v,
            _ => bail!("DAP request '{command}' timed out"),
        };
        if resp.get("success").and_then(Value::as_bool) == Some(false) {
            let msg = resp.get("message").and_then(Value::as_str).unwrap_or("request failed");
            bail!("{command}: {msg}");
        }
        Ok(resp.get("body").cloned().unwrap_or(Value::Null))
    }

    pub async fn set_breakpoints(&self, path: &str, bps: &[SourceBp]) -> Result<()> {
        let items: Vec<Value> = bps
            .iter()
            .map(|b| {
                let mut o = json!({ "line": b.line });
                let m = o.as_object_mut().unwrap();
                if let Some(c) = b.condition.as_ref().filter(|s| !s.is_empty()) {
                    m.insert("condition".into(), json!(c));
                }
                if let Some(h) = b.hit_condition.as_ref().filter(|s| !s.is_empty()) {
                    m.insert("hitCondition".into(), json!(h));
                }
                if let Some(l) = b.log_message.as_ref().filter(|s| !s.is_empty()) {
                    m.insert("logMessage".into(), json!(l));
                }
                o
            })
            .collect();
        self.request(
            "setBreakpoints",
            json!({ "source": { "path": path }, "breakpoints": items }),
            Duration::from_secs(10),
        )
        .await
        .map(|_| ())
    }

    pub async fn continue_(&self, thread_id: i64) -> Result<()> {
        self.request("continue", json!({ "threadId": thread_id }), Duration::from_secs(10)).await.map(|_| ())
    }
    pub async fn next(&self, thread_id: i64) -> Result<()> {
        self.request("next", json!({ "threadId": thread_id }), Duration::from_secs(10)).await.map(|_| ())
    }
    pub async fn step_in(&self, thread_id: i64) -> Result<()> {
        self.request("stepIn", json!({ "threadId": thread_id }), Duration::from_secs(10)).await.map(|_| ())
    }
    pub async fn step_out(&self, thread_id: i64) -> Result<()> {
        self.request("stepOut", json!({ "threadId": thread_id }), Duration::from_secs(10)).await.map(|_| ())
    }
    pub async fn pause(&self, thread_id: i64) -> Result<()> {
        self.request("pause", json!({ "threadId": thread_id }), Duration::from_secs(10)).await.map(|_| ())
    }

    pub async fn stack_trace(&self, thread_id: i64) -> Result<Vec<StackFrame>> {
        let body = self
            .request(
                "stackTrace",
                json!({ "threadId": thread_id, "startFrame": 0, "levels": 50 }),
                Duration::from_secs(10),
            )
            .await?;
        let frames = body.get("stackFrames").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(frames
            .iter()
            .map(|f| StackFrame {
                id: f.get("id").and_then(Value::as_i64).unwrap_or(0),
                name: f.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                path: f
                    .get("source")
                    .and_then(|s| s.get("path"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                line: f.get("line").and_then(Value::as_u64).unwrap_or(0) as u32,
                column: f.get("column").and_then(Value::as_u64).unwrap_or(0) as u32,
            })
            .collect())
    }

    pub async fn scopes(&self, frame_id: i64) -> Result<Vec<Scope>> {
        let body = self
            .request("scopes", json!({ "frameId": frame_id }), Duration::from_secs(10))
            .await?;
        let scopes = body.get("scopes").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(scopes
            .iter()
            .map(|s| Scope {
                name: s.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                variables_reference: s.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
            })
            .collect())
    }

    pub async fn variables(&self, variables_reference: i64) -> Result<Vec<Variable>> {
        let body = self
            .request(
                "variables",
                json!({ "variablesReference": variables_reference }),
                Duration::from_secs(10),
            )
            .await?;
        let vars = body.get("variables").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(vars
            .iter()
            .map(|v| Variable {
                name: v.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                value: v.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
                ty: v.get("type").and_then(Value::as_str).map(str::to_string),
                variables_reference: v.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
            })
            .collect())
    }

    pub async fn evaluate(&self, frame_id: i64, expr: &str) -> Result<EvalResult> {
        let body = self
            .request(
                "evaluate",
                json!({ "expression": expr, "frameId": frame_id, "context": "repl" }),
                Duration::from_secs(10),
            )
            .await?;
        Ok(EvalResult {
            result: body.get("result").and_then(Value::as_str).unwrap_or("").to_string(),
            variables_reference: body.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
        })
    }

    /// REPL completions for `text` with the caret at `column` (1-based, per DAP),
    /// in the context of `frame_id`.
    ///
    /// java-debug doesn't implement the DAP `completions` request (it always
    /// returns an empty target list), so after trying it we derive completions
    /// ourselves from the live debuggee: for `receiver.<prefix>` we evaluate the
    /// receiver and list its fields; for a bare `<prefix>` we list the locals in
    /// scope. Returns items carrying the `start`/`length` of the prefix so the
    /// client replaces exactly that span.
    pub async fn completions(&self, frame_id: i64, text: &str, column: i64) -> Result<Vec<CompletionItem>> {
        // 1. Give the adapter a chance (future-proof: succeeds if it ever adds it).
        if let Ok(body) = self
            .request(
                "completions",
                json!({ "frameId": frame_id, "text": text, "column": column }),
                Duration::from_secs(6),
            )
            .await
        {
            let targets = body.get("targets").and_then(Value::as_array).cloned().unwrap_or_default();
            if !targets.is_empty() {
                return Ok(targets
                    .iter()
                    .filter_map(|t| {
                        let label = t.get("label").and_then(Value::as_str)?.to_string();
                        let text = t.get("text").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| label.clone());
                        Some(CompletionItem {
                            label,
                            text,
                            kind: t.get("type").and_then(Value::as_str).map(str::to_string),
                            start: t.get("start").and_then(Value::as_i64),
                            length: t.get("length").and_then(Value::as_i64),
                        })
                    })
                    .collect());
            }
        }

        // 2. Derive completions from the debuggee.
        // Split the text left of the caret into an optional receiver and a prefix.
        let left: String = text.chars().take((column - 1).max(0) as usize).collect();
        let is_ident = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
        let prefix: String = {
            let mut p: Vec<char> = left.chars().rev().take_while(|&c| is_ident(c)).collect();
            p.reverse();
            p.into_iter().collect()
        };
        let before = &left[..left.len() - prefix.len()];
        let receiver: Option<String> = before.strip_suffix('.').map(|expr| {
            // Trailing run of an expression before the dot (obj, a.b, arr[0], f()).
            let mut r: Vec<char> = expr
                .chars()
                .rev()
                .take_while(|&c| is_ident(c) || matches!(c, '.' | '[' | ']' | '(' | ')'))
                .collect();
            r.reverse();
            r.into_iter().collect()
        });

        // Candidate names from the debuggee.
        let mut names: Vec<(String, &'static str)> = Vec::new();
        match &receiver {
            Some(expr) if !expr.is_empty() => {
                if let Ok(ev) = self.evaluate(frame_id, expr).await {
                    if ev.variables_reference > 0 {
                        if let Ok(children) = self.variables(ev.variables_reference).await {
                            for c in children {
                                names.push((c.name, "field"));
                            }
                        }
                    }
                }
            }
            Some(_) => {} // dot with no resolvable receiver
            None => {
                // Bare prefix → locals (and `this`, args) from every scope.
                if let Ok(scopes) = self.scopes(frame_id).await {
                    for s in scopes {
                        if let Ok(vars) = self.variables(s.variables_reference).await {
                            for v in vars {
                                names.push((v.name, "variable"));
                            }
                        }
                    }
                }
            }
        }

        // Filter by prefix (case-insensitive), dedupe, keep prefix-matches first.
        let lc = prefix.to_ascii_lowercase();
        let start = (column - 1) - prefix.chars().count() as i64;
        let length = prefix.chars().count() as i64;
        let mut seen = std::collections::HashSet::new();
        let mut out: Vec<CompletionItem> = names
            .into_iter()
            .filter(|(n, _)| lc.is_empty() || n.to_ascii_lowercase().starts_with(&lc))
            // Array/collection children are shown as indices like "0"; drop those.
            .filter(|(n, _)| n.chars().next().map(|c| c.is_alphabetic() || c == '_' || c == '$').unwrap_or(false))
            .filter(|(n, _)| seen.insert(n.clone()))
            .map(|(n, kind)| CompletionItem {
                label: n.clone(),
                text: n,
                kind: Some(kind.to_string()),
                start: Some(start),
                length: Some(length),
            })
            .collect();
        out.sort_by(|a, b| a.label.to_ascii_lowercase().cmp(&b.label.to_ascii_lowercase()));
        Ok(out)
    }

    /// Assign `value` to the variable `name` under `variables_reference` (a scope
    /// or a structured value). Returns the variable's new value string.
    pub async fn set_variable(&self, variables_reference: i64, name: &str, value: &str) -> Result<EvalResult> {
        let body = self
            .request(
                "setVariable",
                json!({ "variablesReference": variables_reference, "name": name, "value": value }),
                Duration::from_secs(10),
            )
            .await?;
        Ok(EvalResult {
            result: body.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
            variables_reference: body.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
        })
    }

    /// Detach and terminate the debuggee. Best-effort — the adapter exits after.
    pub async fn disconnect(&self) -> Result<()> {
        self.request(
            "disconnect",
            json!({ "terminateDebuggee": true }),
            Duration::from_secs(5),
        )
        .await
        .map(|_| ())
    }
}
