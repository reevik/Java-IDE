use anyhow::{bail, Context, Result};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

/// One compiler message, flattened into what the Problems list needs.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Diagnostic {
    /// "error" | "warning" | "note" | "help"
    pub level: String,
    pub message: String,
    /// Absolute path, when the message points at a source span.
    pub file: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    /// e.g. "E0308"
    pub code: Option<String>,
    /// The full rustc rendering, complete with carets and colour stripped.
    pub rendered: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CargoEvent {
    /// A line of human-readable output (cargo's own progress, or the program's).
    Line { stream: String, text: String },
    Diagnostic { diagnostic: Diagnostic },
    Finished { code: i32, secs: f64 },
}

/// The currently running child, so a second Build can cancel the first.
static RUNNING: Mutex<Option<u32>> = Mutex::new(None);
static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn is_running() -> bool {
    RUNNING.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Kill the in-flight cargo process, if any.
pub fn cancel() {
    let pid = RUNNING.lock().ok().and_then(|mut g| g.take());
    if let Some(pid) = pid {
        // SIGTERM lets cargo tear down its own children (rustc, the test binary).
        unsafe {
            libc_kill(pid as i32, 15);
        }
    }
}

// Avoid pulling in the `libc` crate for a single call.
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

/// Detect the build tool in `dir`: (program, is_gradle). Prefers the project's
/// wrapper (`./gradlew` / `./mvnw`) so the pinned tool version is used.
fn detect_tool(dir: &Path) -> Option<(String, bool)> {
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

/// A run configuration parsed from the frontend's semantic `extra` flags.
#[derive(Default)]
struct RunParams {
    main: Option<String>,
    test: Option<String>,
    prog_args: Vec<String>,
}

fn parse_extra(extra: &[String]) -> RunParams {
    let mut p = RunParams::default();
    let mut i = 0;
    while i < extra.len() {
        match extra[i].as_str() {
            "--main" => {
                p.main = extra.get(i + 1).cloned();
                i += 2;
            }
            "--test" => {
                p.test = extra.get(i + 1).cloned();
                i += 2;
            }
            "--" => {
                p.prog_args = extra[i + 1..].to_vec();
                break;
            }
            _ => i += 1,
        }
    }
    p
}

/// Translate an IDE command (+ run params) into Maven/Gradle arguments.
fn tool_args(command: &str, gradle: bool, p: &RunParams) -> Vec<String> {
    let s = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    if gradle {
        let mut v = match command {
            "build" | "check" => s(&["compileJava"]),
            "test" => {
                let mut v = s(&["test"]);
                if let Some(t) = &p.test {
                    // Gradle uses dotted method syntax and glob patterns.
                    v.push("--tests".into());
                    v.push(t.replace('#', "."));
                }
                v
            }
            "run" => {
                let mut v = s(&["run"]);
                if !p.prog_args.is_empty() {
                    v.push(format!("--args={}", p.prog_args.join(" ")));
                }
                // Gradle's `run` uses the application plugin's mainClass; per-config
                // override is passed as a project property the build may read.
                if let Some(m) = &p.main {
                    v.push(format!("-PmainClass={m}"));
                }
                v
            }
            "clippy" => s(&["check", "-x", "test"]),
            "fmt" => s(&["spotlessApply"]),
            other => s(&[other]),
        };
        v.push("--console=plain".into());
        v
    } else {
        let mut v = s(&["-B"]); // batch mode: no ANSI / progress spinners
        match command {
            "build" | "check" | "clippy" => v.extend(s(&["compile"])),
            "test" => {
                v.extend(s(&["test"]));
                if let Some(t) = &p.test {
                    v.push(format!("-Dtest={t}"));
                }
            }
            "run" => {
                v.extend(s(&["compile", "exec:java"]));
                if let Some(m) = &p.main {
                    v.push(format!("-Dexec.mainClass={m}"));
                }
                if !p.prog_args.is_empty() {
                    v.push(format!("-Dexec.args={}", p.prog_args.join(" ")));
                }
            }
            "fmt" => v.extend(s(&["spotless:apply"])),
            other => v.extend(s(&[other])),
        }
        v
    }
}

/// Strip ANSI escapes so the UI can render plain text.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Parse a javac diagnostic from one output line (Maven or Gradle formats), if any.
fn parse_diag_line(line: &str) -> Option<Diagnostic> {
    let clean = strip_ansi(line);
    parse_maven(&clean).or_else(|| parse_javac(&clean))
}

/// Maven: `[ERROR] /abs/File.java:[12,34] message` (column optional).
fn parse_maven(clean: &str) -> Option<Diagnostic> {
    let (level, rest) = if let Some(r) = clean.strip_prefix("[ERROR] ") {
        ("error", r)
    } else if let Some(r) = clean.strip_prefix("[WARNING] ") {
        ("warning", r)
    } else {
        return None;
    };
    let idx = rest.find(".java:[")?;
    let file = &rest[..idx + 5]; // include ".java"
    let after = &rest[idx + 6..]; // "[12,34] message"
    let close = after.find(']')?;
    let mut loc = after[1..close].split(',');
    let line = loc.next()?.trim().parse::<u32>().ok()?;
    let column = loc.next().and_then(|c| c.trim().parse::<u32>().ok());
    Some(Diagnostic {
        level: level.into(),
        message: after[close + 1..].trim().to_string(),
        file: Some(file.to_string()),
        line: Some(line),
        column,
        code: None,
        rendered: Some(clean.to_string()),
    })
}

/// javac / Gradle: `/abs/File.java:12: error: message`.
fn parse_javac(clean: &str) -> Option<Diagnostic> {
    let jidx = clean.find(".java:")?;
    let file = &clean[..jidx + 5];
    let after = &clean[jidx + 6..]; // "12: error: message"
    let colon = after.find(':')?;
    let line = after[..colon].trim().parse::<u32>().ok()?;
    let rest = after[colon + 1..].trim_start();
    let (level, msg) = if let Some(m) = rest.strip_prefix("error:") {
        ("error", m)
    } else if let Some(m) = rest.strip_prefix("warning:") {
        ("warning", m)
    } else {
        return None;
    };
    // A bare path is often prefixed with build noise ("> ", "e: "); keep only the path.
    let file = file.rsplit_once(char::is_whitespace).map(|(_, p)| p).unwrap_or(file);
    Some(Diagnostic {
        level: level.into(),
        message: msg.trim().to_string(),
        file: Some(file.to_string()),
        line: Some(line),
        column: None,
        code: None,
        rendered: Some(clean.to_string()),
    })
}

/// Run a cargo subcommand in `dir`, streaming events to the frontend.
///
/// Diagnostics arrive on stdout as JSON (one object per line); cargo's own
/// progress and the program's output arrive on stderr/stdout as plain text.
pub async fn run(
    app: AppHandle,
    dir: &Path,
    command: &str,
    extra: Vec<String>,
    env: std::collections::HashMap<String, String>,
) -> Result<i32> {
    cancel(); // only one at a time — a new Build supersedes the old
    let seq = RUN_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let started = std::time::Instant::now();

    let Some((program, gradle)) = detect_tool(dir) else {
        let _ = app.emit(
            "cargo:event",
            CargoEvent::Line {
                stream: "stderr".into(),
                text: "No pom.xml or build.gradle found — open a Maven or Gradle project.".into(),
            },
        );
        let _ = app.emit("cargo:event", CargoEvent::Finished { code: 1, secs: 0.0 });
        return Ok(1);
    };

    let params = parse_extra(&extra);
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(tool_args(command, gradle, &params))
        .current_dir(dir)
        // Prefer the IDE-selected JDK: put its bin on PATH and export JAVA_HOME so
        // Maven/Gradle compile and run against it.
        .env("PATH", crate::toolchain::effective_path());
    if let Some(home) = crate::toolchain::java_home() {
        cmd.env("JAVA_HOME", home);
    }
    let mut child = cmd
        // Run-configuration environment variables win (e.g. a per-config JAVA_HOME).
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawning {program} — is it on PATH?"))?;

    if let Some(pid) = child.id() {
        *RUNNING.lock().unwrap() = Some(pid);
    }

    let emit = |ev: CargoEvent| {
        let _ = app.emit("cargo:event", ev);
    };

    let stdout = child.stdout.take().context("cargo stdout unavailable")?;
    let stderr = child.stderr.take().context("cargo stderr unavailable")?;
    let out_lines = BufReader::new(stdout).lines();
    let mut err_lines = BufReader::new(stderr).lines();

    // javac errors surface on stdout (Maven `[ERROR]`) or stderr (Gradle/javac), so
    // parse both: a diagnostic line → Problems, anything else → plain output.
    let pump = |app: AppHandle, mut lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>, stream: &'static str| {
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(d) = parse_diag_line(&line) {
                    let _ = app.emit("cargo:event", CargoEvent::Diagnostic { diagnostic: d });
                } else {
                    let _ = app.emit("cargo:event", CargoEvent::Line { stream: stream.into(), text: strip_ansi(&line) });
                }
            }
        })
    };
    let out_task = pump(app.clone(), out_lines, "stdout");

    // stderr uses a different reader type; handle it inline.
    let app_err = app.clone();
    let err_task = tokio::spawn(async move {
        while let Ok(Some(line)) = err_lines.next_line().await {
            if let Some(d) = parse_diag_line(&line) {
                let _ = app_err.emit("cargo:event", CargoEvent::Diagnostic { diagnostic: d });
            } else {
                let _ = app_err.emit("cargo:event", CargoEvent::Line { stream: "stderr".into(), text: strip_ansi(&line) });
            }
        }
    });

    let status = child.wait().await.context("waiting for cargo")?;
    let _ = tokio::join!(out_task, err_task);

    // Only clear if we're still the current run (a newer one may have replaced us).
    if let Ok(mut g) = RUNNING.lock() {
        if RUN_SEQ.load(Ordering::SeqCst) == seq {
            *g = None;
        }
    }

    let code = status.code().unwrap_or(-1);
    emit(CargoEvent::Finished { code, secs: started.elapsed().as_secs_f64() });
    Ok(code)
}

/// What to build before debugging. (Compilation covers the whole project, so the
/// specific target only distinguishes main vs. test sources; `Test` is reserved
/// for upcoming test-debugging support.)
#[allow(dead_code)]
pub enum DebugTarget {
    /// A main class, by fully-qualified name.
    Bin(String),
    /// The project's tests.
    Test,
}

/// Compile the project before debugging so java-debug can resolve up-to-date
/// classes. Streams compiler output to the `cargo:event` channel like a normal
/// build; returns `Ok(())` on success. (java-debug resolves the classpath from the
/// JDT server, so no artifact path is produced here.)
#[allow(dead_code)] // reserved for scoped/test-debug builds; debug_start relies on JDT.LS's incremental build
pub async fn build_for_debug(app: AppHandle, dir: &Path, target: DebugTarget) -> Result<()> {
    let Some((program, gradle)) = detect_tool(dir) else {
        bail!("No pom.xml or build.gradle found — open a Maven or Gradle project.");
    };
    // Main classes compile with the normal build; tests also need test sources.
    let command = match target {
        DebugTarget::Test => "test-compile",
        DebugTarget::Bin(_) => "build",
    };
    let args = if gradle {
        match command {
            "test-compile" => vec!["testClasses".to_string(), "--console=plain".to_string()],
            _ => vec!["compileJava".to_string(), "--console=plain".to_string()],
        }
    } else {
        match command {
            "test-compile" => vec!["-B".to_string(), "test-compile".to_string()],
            _ => vec!["-B".to_string(), "compile".to_string()],
        }
    };

    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args)
        .current_dir(dir)
        .env("PATH", crate::toolchain::effective_path());
    if let Some(home) = crate::toolchain::java_home() {
        cmd.env("JAVA_HOME", home);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawning {program} — is it on PATH?"))?;

    // Drain both pipes concurrently so neither fills its buffer and stalls the build.
    let pump = |app: AppHandle, reader: Option<tokio::process::ChildStdout>, stderr: Option<tokio::process::ChildStderr>| async move {
        let mut out = reader.map(|r| BufReader::new(r).lines());
        let mut err = stderr.map(|r| BufReader::new(r).lines());
        loop {
            tokio::select! {
                line = async { out.as_mut().unwrap().next_line().await }, if out.is_some() => {
                    match line { Ok(Some(l)) => { let _ = app.emit("cargo:event", CargoEvent::Line { stream: "stdout".into(), text: strip_ansi(&l) }); }, _ => out = None }
                }
                line = async { err.as_mut().unwrap().next_line().await }, if err.is_some() => {
                    match line { Ok(Some(l)) => { let _ = app.emit("cargo:event", CargoEvent::Line { stream: "stderr".into(), text: strip_ansi(&l) }); }, _ => err = None }
                }
                else => break,
            }
        }
    };
    pump(app.clone(), child.stdout.take(), child.stderr.take()).await;
    let status = child.wait().await.context("waiting for the build")?;
    if !status.success() {
        bail!("Compilation failed — fix the errors above before debugging.");
    }
    Ok(())
}
