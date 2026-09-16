mod cargo;
mod codestyle;
mod commands;
mod dap;
mod fs_tree;
mod llm;
mod lsp;
mod maven;
mod projects;
mod search;
mod spring;
mod toolchain;

use projects::ProjectRef;
use std::sync::Mutex;
use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{Emitter, Manager};

pub struct AppState {
    pub projects: Mutex<Vec<ProjectRef>>,
    pub projects_path: std::path::PathBuf,
    /// Cache of each file's committed (HEAD) contents, so live git-gutter diffs
    /// don't shell out to git on every keystroke. Keyed by absolute path.
    pub head_cache: Mutex<std::collections::HashMap<String, commands::HeadBlob>>,
}

fn load_projects(path: &std::path::Path) -> Vec<ProjectRef> {
    let mut list: Vec<ProjectRef> = std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    // Canonicalize legacy entries so their paths match rust-analyzer's URIs
    // (symlinks like /tmp → /private/tmp), then drop resulting duplicates.
    let mut seen = std::collections::HashSet::new();
    for p in &mut list {
        if let Ok(c) = std::fs::canonicalize(&p.path) {
            p.path = c.to_string_lossy().to_string();
        }
    }
    list.retain(|p| seen.insert(p.path.clone()));
    list
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Menu item ids are the command-palette ids, so a menu pick and a palette
        // pick run exactly the same action (same scheme as Reevik).
        .menu(|handle| {
            let about = PredefinedMenuItem::about(
                handle,
                Some("About Reevik Java ADE"),
                Some(
                    AboutMetadataBuilder::new()
                        .name(Some("Reevik Java ADE"))
                        .version(Some(env!("CARGO_PKG_VERSION")))
                        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")).ok())
                        .comments(Some("A glossy Java IDE.\nDeveloped by Erhan Bağdemir."))
                        .copyright(Some("© 2026 Erhan Bağdemir"))
                        .build(),
                ),
            )?;
            let preferences =
                MenuItem::with_id(handle, "app.settings", "Preferences…", true, Some("CmdOrCtrl+,"))?;
            let app_menu = SubmenuBuilder::new(handle, "Reevik Java ADE")
                .item(&about)
                .separator()
                .item(&preferences)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let new_file =
                MenuItem::with_id(handle, "file.new-file", "New File", true, None::<&str>)?;
            let new_class =
                MenuItem::with_id(handle, "file.new-class", "New Java Class…", true, None::<&str>)?;
            let new_dir = MenuItem::with_id(
                handle,
                "file.new-dir",
                "New Folder",
                true,
                None::<&str>,
            )?;
            let save = MenuItem::with_id(handle, "file.save", "Save", true, None::<&str>)?;
            let close_tab =
                MenuItem::with_id(handle, "file.close-tab", "Close Tab", true, None::<&str>)?;
            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&new_file)
                .item(&new_class)
                .item(&new_dir)
                .separator()
                .item(&save)
                .item(&close_tab)
                .build()?;

            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let build = MenuItem::with_id(handle, "cargo.build", "Build", true, None::<&str>)?;
            let run_it = MenuItem::with_id(handle, "cargo.run", "Run", true, None::<&str>)?;
            let test = MenuItem::with_id(handle, "cargo.test", "Test", true, None::<&str>)?;
            let clippy =
                MenuItem::with_id(handle, "cargo.clippy", "Check", true, None::<&str>)?;
            // ⌘⇧F is Find in Files (VS Code); format takes ⇧⌥F (also VS Code).
            let fmt = MenuItem::with_id(handle, "cargo.fmt", "Format Project", true, None::<&str>)?;
            let cancel = MenuItem::with_id(handle, "cargo.cancel", "Stop", true, None::<&str>)?;
            let edit_configs =
                MenuItem::with_id(handle, "run.edit", "Edit Run Configurations…", true, None::<&str>)?;
            let cargo_menu = SubmenuBuilder::new(handle, "Build")
                .item(&build)
                .item(&run_it)
                .item(&edit_configs)
                .item(&test)
                .item(&clippy)
                .separator()
                .item(&fmt)
                .separator()
                .item(&cancel)
                .build()?;

            // Code menu: static analysis + formatting of the current file.
            let code_analysis =
                MenuItem::with_id(handle, "cargo.check", "Code Analysis", true, None::<&str>)?;
            let reformat =
                MenuItem::with_id(handle, "code.reformat", "Reformat Code", true, None::<&str>)?;
            // Refactor This / Go to Line: accelerators (⌃T / ⌃G) are handled in-editor;
            // the menu items are for discoverability.
            let organize_imports =
                MenuItem::with_id(handle, "code.organize-imports", "Organize Imports", true, None::<&str>)?;
            let refactor =
                MenuItem::with_id(handle, "code.refactor", "Refactor This…", true, None::<&str>)?;
            let goto_line = MenuItem::with_id(handle, "code.goto-line", "Go to Line…", true, None::<&str>)?;
            // Code folding (the ⌘⌥[ / ⌘⌥] keys are handled in-editor by foldKeymap;
            // the menu items are for discoverability + fold-all/unfold-all).
            let fold = MenuItem::with_id(handle, "code.fold", "Fold at Cursor", true, None::<&str>)?;
            let unfold = MenuItem::with_id(handle, "code.unfold", "Unfold at Cursor", true, None::<&str>)?;
            let fold_all = MenuItem::with_id(handle, "code.fold-all", "Fold All", true, None::<&str>)?;
            let unfold_all = MenuItem::with_id(handle, "code.unfold-all", "Unfold All", true, None::<&str>)?;
            let code_menu = SubmenuBuilder::new(handle, "Code")
                .item(&code_analysis)
                .item(&reformat)
                .item(&organize_imports)
                .item(&refactor)
                .separator()
                .item(&goto_line)
                .separator()
                .item(&fold)
                .item(&unfold)
                .item(&fold_all)
                .item(&unfold_all)
                .build()?;

            // Debug menu. F5 starts or continues; the rest match VS Code/IntelliJ.
            let dbg_start = MenuItem::with_id(handle, "debug.start", "Start / Continue", true, None::<&str>)?;
            let dbg_over = MenuItem::with_id(handle, "debug.step-over", "Step Over", true, None::<&str>)?;
            let dbg_into = MenuItem::with_id(handle, "debug.step-into", "Step Into", true, None::<&str>)?;
            let dbg_out = MenuItem::with_id(handle, "debug.step-out", "Step Out", true, None::<&str>)?;
            let dbg_stop = MenuItem::with_id(handle, "debug.stop", "Stop Debugging", true, None::<&str>)?;
            let bp_toggle =
                MenuItem::with_id(handle, "debug.toggle-breakpoint", "Toggle Breakpoint", true, None::<&str>)?;
            let bp_view =
                MenuItem::with_id(handle, "debug.view-breakpoints", "View Breakpoints", true, None::<&str>)?;
            let bp_toggle_all =
                MenuItem::with_id(handle, "debug.toggle-all-breakpoints", "Enable/Disable All Breakpoints", true, None::<&str>)?;
            let bp_remove_all =
                MenuItem::with_id(handle, "debug.remove-all-breakpoints", "Remove All Breakpoints", true, None::<&str>)?;
            let debug_menu = SubmenuBuilder::new(handle, "Debug")
                .item(&dbg_start)
                .separator()
                .item(&dbg_over)
                .item(&dbg_into)
                .item(&dbg_out)
                .separator()
                .item(&dbg_stop)
                .separator()
                .item(&bp_toggle)
                .item(&bp_view)
                .item(&bp_toggle_all)
                .item(&bp_remove_all)
                .build()?;

            let quickopen =
                MenuItem::with_id(handle, "view.quickopen", "Go to File…", true, None::<&str>)?;
            let search = MenuItem::with_id(
                handle,
                "view.search",
                "Find in Files…",
                true,
                None::<&str>,
            )?;
            let palette = MenuItem::with_id(
                handle,
                "view.palette",
                "Command Palette…",
                true,
                None::<&str>,
            )?;
            let toggle_tree = MenuItem::with_id(
                handle,
                "view.tree",
                "Toggle Explorer",
                true,
                None::<&str>,
            )?;
            let toggle_output = MenuItem::with_id(
                handle,
                "view.output",
                "Toggle Output",
                true,
                None::<&str>,
            )?;
            let show_git =
                MenuItem::with_id(handle, "view.git", "Version Control", true, None::<&str>)?;
            let toggle_ai = MenuItem::with_id(
                handle,
                "view.ai",
                "Toggle Intelligent Review",
                true,
                None::<&str>,
            )?;
            let toggle_chat = MenuItem::with_id(
                handle,
                "view.chat",
                "Toggle AI Assistant",
                true,
                None::<&str>,
            )?;
            let toggle_skills = MenuItem::with_id(
                handle,
                "view.skills",
                "Toggle Skills",
                true,
                None::<&str>,
            )?;
            let split_right =
                MenuItem::with_id(handle, "view.split-right", "Split Right", true, None::<&str>)?;
            let split_down =
                MenuItem::with_id(handle, "view.split-down", "Split Down", true, None::<&str>)?;
            let close_split =
                MenuItem::with_id(handle, "view.close-split", "Close Split", true, None::<&str>)?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&quickopen)
                .item(&search)
                .item(&palette)
                .separator()
                .item(&toggle_tree)
                .item(&toggle_output)
                .item(&show_git)
                .item(&toggle_ai)
                .item(&toggle_chat)
                .item(&toggle_skills)
                .separator()
                .item(&split_right)
                .item(&split_down)
                .item(&close_split)
                .build()?;

            let open_project = MenuItem::with_id(
                handle,
                "project.open",
                "Open Project…",
                true,
                None::<&str>,
            )?;
            let project_settings =
                MenuItem::with_id(handle, "project.settings", "Project Settings…", true, None::<&str>)?;
            let task_board = MenuItem::with_id(handle, "view.taskboard", "Task Board…", true, None::<&str>)?;
            let project_menu = SubmenuBuilder::new(handle, "Project")
                .item(&open_project)
                .separator()
                .item(&project_settings)
                .item(&task_board)
                .build()?;

            let close_window = MenuItem::with_id(
                handle,
                "window.close",
                "Close Window",
                true,
                Some("CmdOrCtrl+Shift+W"),
            )?;
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .separator()
                .item(&close_window)
                .build()?;

            Menu::with_items(
                handle,
                &[
                    &app_menu,
                    &file_menu,
                    &edit_menu,
                    &cargo_menu,
                    &code_menu,
                    &debug_menu,
                    &view_menu,
                    &project_menu,
                    &window_menu,
                ],
            )
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            if id == "window.close" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
                return;
            }
            let _ = app.emit("menu:command", id);
        })
        .manage(commands::LspState::default())
        .manage(commands::DapState::default())
        .manage(commands::AgentState::default())
        .manage(commands::WatcherState::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                let window = app.get_webview_window("main").expect("main window exists");
                let _ = window.set_theme(Some(tauri::Theme::Light));
                apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::Sidebar,
                    Some(NSVisualEffectState::Active),
                    None,
                )
                .expect("failed to apply macOS window vibrancy");

                // WKWebView on a transparent + overlay-titlebar window can come up
                // shorter than its host window, so the whole UI packs into a top
                // strip with the (transparent) window showing through below. A
                // one-off size nudge shortly after launch forces the webview to
                // re-lay-out to the full window bounds.
                let nudge = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(180));
                    if let Ok(sz) = nudge.inner_size() {
                        let _ = nudge.set_size(tauri::PhysicalSize::new(sz.width, sz.height + 1));
                        let _ = nudge.set_size(sz);
                    }
                });
            }

            let config_dir = app
                .path()
                .app_config_dir()
                .expect("failed to resolve app config dir");
            let projects_path = config_dir.join("projects.json");
            let projects = load_projects(&projects_path);

            app.manage(AppState {
                projects: Mutex::new(projects),
                projects_path,
                head_cache: Mutex::new(std::collections::HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::add_project,
            commands::create_project,
            commands::remove_project,
            commands::open_project_window,
            commands::git_log,
            commands::git_status,
            commands::git_commit_files,
            commands::git_file_diff,
            commands::git_working_diff,
            commands::git_stage,
            commands::git_unstage,
            commands::git_commit,
            commands::list_tests,
            commands::set_model,
            commands::ai_settings,
            commands::detect_ai_connectors,
            commands::set_preferred_connector,
            commands::list_skills,
            commands::app_version,
            commands::set_window_theme,
            commands::tool_paths,
            commands::set_toolchain_dir,
            commands::toolchain_info,
            commands::detected_jdks,
            commands::detected_mavens,
            commands::set_maven_path,
            commands::project_modules,
            commands::dependency_tree,
            commands::create_module,
            commands::file_symbols,
            commands::search_crates,
            commands::cargo_add,
            commands::log_client,
            commands::nudge_window,
            commands::close_splashscreen,
            commands::project_info,
            commands::read_project_tree,
            commands::watch_project,
            commands::detect_source_roots_cmd,
            commands::spring_mains,
            commands::spring_overview,
            commands::read_file,
            commands::write_file,
            commands::read_text_file,
            commands::write_text_file,
            commands::create_file,
            commands::create_dir,
            commands::rename_path,
            commands::delete_path,
            commands::move_paths,
            commands::copy_paths,
            commands::cargo_run,
            commands::run_java_main,
            commands::run_maven_goals,
            commands::cargo_cancel,
            commands::cargo_is_running,
            commands::ai_backend,
            commands::set_llm_api_key,
            commands::review_code,
            commands::explain_code,
            commands::fix_error,
            commands::generate_tasks,
            commands::chat_send,
            commands::chat_agent,
            commands::chat_cancel,
            commands::task_agent,
            commands::format_java,
            commands::set_code_style,
            commands::organize_imports,
            commands::lsp_completion,
            commands::lsp_hover,
            commands::lsp_definition,
            commands::lsp_class_file_contents,
            commands::lsp_references,
            commands::lsp_rename,
            commands::code_action,
            commands::refactor_actions,
            commands::resolve_refactor,
            commands::lsp_sync,
            commands::lsp_did_save,
            commands::search_in_files,
            commands::git_branch,
            commands::git_branches,
            commands::git_remote_status,
            commands::git_fetch,
            commands::git_pull,
            commands::git_push,
            commands::generate_commit_message,
            commands::git_checkout,
            commands::git_create_branch,
            commands::git_cherry_pick,
            commands::git_cherry_pick_head,
            commands::git_revert,
            commands::git_reset,
            commands::git_resolve,
            commands::git_diff,
            commands::git_stage_file,
            commands::debugger_adapter,
            commands::install_java_debug,
            commands::debug_start,
            commands::debug_attach,
            commands::debug_set_breakpoints,
            commands::debug_continue,
            commands::debug_next,
            commands::debug_step_in,
            commands::debug_step_out,
            commands::debug_pause,
            commands::debug_stack,
            commands::debug_scopes,
            commands::debug_variables,
            commands::debug_eval,
            commands::debug_completions,
            commands::debug_set_variable,
            commands::debug_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
