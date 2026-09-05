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

/// Find the module directory (nearest ancestor holding a `pom.xml`) that owns the
/// source file for `main_class`, searching under `root`. Returns the module dir.
fn module_dir_of(root: &Path, main_class: &str) -> Option<std::path::PathBuf> {
    let simple = main_class.rsplit('.').next().unwrap_or(main_class);
    let rel = format!("{}.java", main_class.replace('.', "/")); // pkg/Path/Simple.java
    // Bounded recursive walk, skipping build/vcs noise.
    fn walk(dir: &Path, simple: &str, rel: &str, depth: usize) -> Option<std::path::PathBuf> {
        if depth > 12 {
            return None;
        }
        let entries = std::fs::read_dir(dir).ok()?;
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name();
            let name = name.to_string_lossy();
            if p.is_dir() {
                if matches!(name.as_ref(), "target" | "build" | ".git" | "node_modules" | ".metadata") {
                    continue;
                }
                if let Some(hit) = walk(&p, simple, rel, depth + 1) {
                    return Some(hit);
                }
            } else if name == format!("{simple}.java")
                && p.to_string_lossy().replace('\\', "/").ends_with(rel)
            {
                return Some(p);
            }
        }
        None
    }
    let file = walk(root, simple, &rel, 0)?;
    // Walk up from the file to the nearest pom.xml at/below `root`.
    let mut dir = file.parent()?;
    loop {
        if dir.join("pom.xml").exists() {
            return Some(dir.to_path_buf());
        }
        if dir == root {
            return None;
        }
        dir = dir.parent()?;
    }
}

/// If the root pom declares `<module>{name}</module>` only inside a `<profile>`
/// (a common libGDX/multi-target layout), return that profile's `<id>` so we can
/// activate it — otherwise the module isn't in the default reactor and `-pl`
/// can't find it. Light text scan; good enough for the common shapes.
/// The module's own `<artifactId>` (ignoring the one inside `<parent>`), which is
/// the name JDT.LS gives the imported project — java-debug needs it to evaluate
/// expressions.
fn module_artifact_id(module: &Path) -> Option<String> {
    let pom = std::fs::read_to_string(module.join("pom.xml")).ok()?;
    // Drop the <parent>…</parent> block so we read the module's own artifactId.
    let body = match (pom.find("<parent>"), pom.find("</parent>")) {
        (Some(s), Some(e)) if e > s => format!("{}{}", &pom[..s], &pom[e + "</parent>".len()..]),
        _ => pom.clone(),
    };
    let is = body.find("<artifactId>")?;
    let ie = body[is + 12..].find("</artifactId>")?;
    Some(body[is + 12..is + 12 + ie].trim().to_string())
}

fn profile_for_module(root: &Path, name: &str) -> Option<String> {
    let pom = std::fs::read_to_string(root.join("pom.xml")).ok()?;
    let module_tag = format!("<module>{name}</module>");
    // If it's declared as a top-level module (outside any profile), no profile needed.
    let mut search = pom.as_str();
    while let Some(pstart) = search.find("<profile>") {
        let after = &search[pstart..];
        let pend = after.find("</profile>").map(|e| pstart + e).unwrap_or(pom.len());
        let block = &pom[pstart..pend];
        if block.contains(&module_tag) {
            // Extract this profile's <id>…</id>.
            if let Some(is) = block.find("<id>") {
                if let Some(ie) = block[is + 4..].find("</id>") {
                    return Some(block[is + 4..is + 4 + ie].trim().to_string());
                }
            }
        }
        search = &search[pend.min(search.len())..];
    }
    None
}

/// Newest modification time of any file with `ext` under `dir` (recursive,
/// skipping build/vcs noise). `None` if the tree has no such file.
fn newest_mtime(dir: &Path, ext: &str) -> Option<std::time::SystemTime> {
    fn walk(dir: &Path, ext: &str, best: &mut Option<std::time::SystemTime>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name();
            let name = name.to_string_lossy();
            if p.is_dir() {
                if matches!(name.as_ref(), "target" | "build" | ".git" | "node_modules" | ".metadata") {
                    continue;
                }
                walk(&p, ext, best);
            } else if name.ends_with(ext) {
                if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
                    if best.map(|b| m > b).unwrap_or(true) {
                        *best = Some(m);
                    }
                }
            }
        }
    }
    let mut best = None;
    walk(dir, ext, &mut best);
    best
}

/// A signature of the pom files that determine the dependency set, so a cached
/// classpath can be reused until a pom changes.
fn pom_signature(root: &Path, module: &Path) -> String {
    let mt = |p: std::path::PathBuf| {
        std::fs::metadata(&p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    };
    format!("{}:{}", mt(root.join("pom.xml")), mt(module.join("pom.xml")))
}

fn cp_cache_file(module: &Path) -> std::path::PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    module.hash(&mut h);
    std::env::temp_dir().join(format!("java-ade-cp-{:016x}.cache", h.finish()))
}

/// Compute the launch classpath for `main_class` ourselves via Maven, scoped to the
/// owning module (`-pl <module> -am`) so a broken sibling module in a multi-module
/// reactor can't stop us. Returns absolute classpath entries (the module's own
/// `target/classes` plus every runtime dependency). Used when the JDT language
/// server can't resolve the project (e.g. its embedded Maven import fails).
///
/// Repeat launches are fast: the resolved dependency list is cached (keyed by the
/// pom mtimes) so `dependency:build-classpath` is skipped until a pom changes, and
/// compilation is skipped entirely when no source is newer than the compiled output.
pub async fn classpath_for_main(app: AppHandle, root: &Path, main_class: &str) -> Result<(String, Vec<String>)> {
    let (program, gradle) = detect_tool(root)
        .ok_or_else(|| anyhow::anyhow!("No pom.xml found at the project root — can't compute a classpath."))?;
    if gradle {
        bail!("Automatic classpath fallback is only implemented for Maven projects so far.");
    }
    let module = module_dir_of(root, main_class)
        .ok_or_else(|| anyhow::anyhow!("Couldn't find the source file for '{main_class}' under the project."))?;
    let rel = module
        .strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| ".".into());

    let emit = |app: &AppHandle, text: String| {
        let _ = app.emit("cargo:event", CargoEvent::Line { stream: "stdout".into(), text });
    };
    let own = module.join("target").join("classes");
    let build_cp = |deps: &str| -> Vec<String> {
        let mut cp: Vec<String> = Vec::new();
        if own.exists() {
            cp.push(own.to_string_lossy().into_owned());
        }
        cp.extend(deps.split(':').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string));
        cp
    };

    // Reuse the cached dependency list unless a pom changed.
    let sig = pom_signature(root, &module);
    let cache = cp_cache_file(&module);
    let cached_deps: Option<String> = std::fs::read_to_string(&cache).ok().and_then(|c| {
        let (first, rest) = c.split_once('\n')?;
        (first == sig).then(|| rest.to_string())
    });

    // Only recompile when a source is newer than the compiled output.
    let need_compile = !own.exists()
        || match (newest_mtime(root, ".java"), newest_mtime(&own, ".class")) {
            (Some(src), Some(cls)) => src > cls,
            _ => true,
        };

    let project = module_artifact_id(&module).unwrap_or_default();

    // Nothing to do: classes are current and the classpath is cached.
    if !need_compile {
        if let Some(deps) = &cached_deps {
            let cp = build_cp(deps);
            if !cp.is_empty() {
                return Ok((project, cp));
            }
        }
    }

    // Build the Maven goal list: compile only when stale, resolve the classpath
    // only when the cache is cold.
    let need_classpath = cached_deps.is_none();
    let out_file = std::env::temp_dir().join(format!("java-ade-cp-{}.txt", std::process::id()));
    let _ = std::fs::remove_file(&out_file);
    emit(&app, format!("Preparing debug classpath for module '{rel}'…"));

    let mut args = vec!["-B".to_string(), "-q".to_string()];
    if let Some(profile) = profile_for_module(root, &rel) {
        args.push(format!("-P{profile}"));
    }
    if rel != "." {
        args.push("-pl".into());
        args.push(rel.clone());
        args.push("-am".into());
    }
    if need_compile {
        args.push("compile".into());
    }
    if need_classpath {
        args.push("dependency:build-classpath".into());
        args.push("-Dmdep.includeScope=runtime".into());
        args.push(format!("-Dmdep.outputFile={}", out_file.display()));
        args.push("-Dmdep.pathSeparator=:".into());
    }

    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args)
        .current_dir(root)
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
    let pump = |app: AppHandle, out: Option<tokio::process::ChildStdout>, err: Option<tokio::process::ChildStderr>| async move {
        let mut o = out.map(|r| BufReader::new(r).lines());
        let mut e = err.map(|r| BufReader::new(r).lines());
        loop {
            tokio::select! {
                l = async { o.as_mut().unwrap().next_line().await }, if o.is_some() => {
                    match l { Ok(Some(l)) => { let _ = app.emit("cargo:event", CargoEvent::Line { stream: "stdout".into(), text: strip_ansi(&l) }); }, _ => o = None }
                }
                l = async { e.as_mut().unwrap().next_line().await }, if e.is_some() => {
                    match l { Ok(Some(l)) => { let _ = app.emit("cargo:event", CargoEvent::Line { stream: "stderr".into(), text: strip_ansi(&l) }); }, _ => e = None }
                }
                else => break,
            }
        }
    };
    pump(app.clone(), child.stdout.take(), child.stderr.take()).await;
    let status = child.wait().await.context("waiting for the classpath build")?;
    if !status.success() {
        bail!("Maven failed while resolving the classpath for '{main_class}' — see the output above.");
    }

    // Freshly resolved deps (and refresh the cache), or the still-valid cached set.
    let deps = if need_classpath {
        let d = std::fs::read_to_string(&out_file)
            .with_context(|| format!("reading the resolved classpath at {}", out_file.display()))?;
        let _ = std::fs::remove_file(&out_file);
        let _ = std::fs::write(&cache, format!("{sig}\n{d}"));
        d
    } else {
        cached_deps.unwrap_or_default()
    };

    let cp = build_cp(&deps);
    if cp.is_empty() {
        bail!("Resolved an empty classpath for '{main_class}'.");
    }
    emit(&app, format!("Debug classpath ready: {} entries.", cp.len()));
    Ok((project, cp))
}
