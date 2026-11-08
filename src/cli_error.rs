//! The one stderr shape for a failed command (G4, operator decision
//! 2026-11-08): `autophys: REASON` on one line, plus a pointer to the
//! command's `--help` when the arguments were wrong. Nothing goes to stdout,
//! so `--json | jq` never sees usage text, and the full option list stays
//! where `--help` renders it.
use std::sync::Mutex;

/// The command path the hint names (`records`, `train dataset`), recorded by
/// [`crate::scripts::run`] before dispatch. Empty: the hint names the root.
static COMMAND: Mutex<String> = Mutex::new(String::new());

/// Record the command path for this invocation's hint.
pub fn set_command(path: impl Into<String>) {
    *COMMAND.lock().unwrap_or_else(|e| e.into_inner()) = path.into();
}

fn command() -> String {
    COMMAND.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// `Try `autophys COMMAND --help` for the options.`, or the root's hint.
pub fn hint(command: &str) -> String {
    if command.is_empty() {
        "Try `autophys --help` for the commands.".to_string()
    } else {
        format!("Try `autophys {command} --help` for the options.")
    }
}

/// The stderr text for a failure, newline-terminated. A message in
/// autophys's usage convention (`REASON\nusage: autophys ...`) keeps only its
/// reason and counts as a usage error (another program's `usage:` text quoted
/// in a runtime error is left alone); `usage_error` marks the others (argument problems). Only
/// usage errors get the hint; a runtime error is its line alone.
pub fn render(message: &str, usage_error: bool) -> String {
    render_for(&command(), message, usage_error)
}

/// [`render`] for an explicit command path.
pub fn render_for(command: &str, message: &str, usage_error: bool) -> String {
    let (reason, had_usage) = split_usage(message);
    let reason = reason.trim();
    let reason = reason.strip_prefix("autophys: ").unwrap_or(reason);
    let reason = if reason.is_empty() {
        "invalid arguments"
    } else {
        reason
    };
    let mut text = format!("autophys: {reason}\n");
    if usage_error || had_usage {
        text.push_str(&hint(command));
        text.push('\n');
    }
    text
}

/// Write [`render`]'s text to stderr.
pub fn report(message: &str, usage_error: bool) {
    eprint!("{}", render(message, usage_error));
}

fn split_usage(message: &str) -> (&str, bool) {
    if message.trim_start().starts_with("usage: autophys") {
        return ("", true);
    }
    match message.split_once("\nusage: autophys") {
        Some((reason, _)) => (reason, true),
        None => (message, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_usage_message_keeps_its_reason_and_gains_the_hint() {
        assert_eq!(
            render_for(
                "train dataset",
                "unknown option \"--bogus\"\nusage: autophys train dataset [--out DIR]\n       more",
                false
            ),
            "autophys: unknown option \"--bogus\"\n\
             Try `autophys train dataset --help` for the options.\n"
        );
    }

    #[test]
    fn another_programs_usage_text_in_a_runtime_error_is_kept() {
        assert_eq!(
            render_for("bench", "worker failed:\nusage: worker.py [-h]", false),
            "autophys: worker failed:\nusage: worker.py [-h]\n"
        );
    }

    #[test]
    fn a_runtime_error_is_one_line_without_a_hint() {
        assert_eq!(
            render_for("records", "unknown investigation", false),
            "autophys: unknown investigation\n"
        );
    }

    #[test]
    fn an_argument_error_names_the_command_or_the_root() {
        assert_eq!(
            render_for("approve", "missing required option --investigation", true),
            "autophys: missing required option --investigation\n\
             Try `autophys approve --help` for the options.\n"
        );
        assert_eq!(
            render_for("", "unknown command \"fit\"", true),
            "autophys: unknown command \"fit\"\nTry `autophys --help` for the commands.\n"
        );
    }

    #[test]
    fn a_prefixed_or_bare_usage_message_still_reads_as_one_line() {
        assert_eq!(
            render_for("pair", "autophys: pair \nusage: autophys pair list", false),
            "autophys: pair\nTry `autophys pair --help` for the options.\n"
        );
        assert_eq!(
            render_for("serve", "usage: autophys serve [--addr A]", false),
            "autophys: invalid arguments\nTry `autophys serve --help` for the options.\n"
        );
    }
}
