//! The user-selected Java code style for formatting. Google/AOSP are handled by
//! google-java-format; an imported Eclipse formatter profile (an `.xml`) is
//! applied through the JDT language server's Eclipse formatter.

use std::sync::Mutex;

#[derive(Clone, PartialEq)]
pub enum Style {
    Google,
    Aosp,
    /// An Eclipse formatter profile: the `.xml` path and optional profile name
    /// (omitted → the first profile in the file).
    Eclipse { path: String, profile: Option<String> },
}

static STYLE: Mutex<Option<Style>> = Mutex::new(None);

pub fn set(style: Style) {
    *STYLE.lock().unwrap() = Some(style);
}

pub fn get() -> Style {
    STYLE.lock().unwrap().clone().unwrap_or(Style::Google)
}
