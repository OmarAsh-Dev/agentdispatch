#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
fn default_installation() -> Result<String, String> {
    let local = std::env::var_os("LOCALAPPDATA").ok_or("Windows Local AppData is unavailable.")?;
    Ok(PathBuf::from(local).join("AgentDispatch").to_string_lossy().into_owned())
}

#[tauri::command]
async fn bridge_action(
    action: String,
    root: String,
    input: Value,
) -> Result<Value, String> {
    if !matches!(action.as_str(), "status" | "install" | "configure" | "start" | "restart" | "register" | "submit") {
        return Err("Unknown AgentDispatch action.".into());
    }
    tauri::async_runtime::spawn_blocking(move || run_bridge(action, root, input))
        .await
        .map_err(|_| "AgentDispatch could not complete the request.")?
}

fn run_bridge(action: String, root: String, input: Value) -> Result<Value, String> {
    // Windows installs bundled resources next to the executable.
    let executable = std::env::current_exe().map_err(|_| "Could not locate AgentDispatch.")?;
    let script = executable.parent().ok_or("Could not locate AgentDispatch.")?
        .join("bridge").join("scripts").join("desktop.mjs");
    if !script.is_file() {
        return Err("AgentDispatch could not locate its bundled bridge files. Reinstall the desktop app.".into());
    }
    let request = json!({ "action": action, "root": root, "input": input });
    let mut child = Command::new("node.exe")
        .arg(script)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Install Node.js 24 x64 and reopen AgentDispatch.")?;
    let mut stdin = child.stdin.take().ok_or("Could not open the bridge input stream.")?;
    let written = serde_json::to_writer(&mut stdin, &request).is_ok() && stdin.flush().is_ok();
    drop(stdin);
    let output = child.wait_with_output().map_err(|_| "The bridge process could not finish.")?;
    if !written { return Err("Could not send data to the bridge.".into()); }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        let diagnostics = String::from_utf8_lossy(&output.stderr);
        let first_line = diagnostics.lines().find(|line| !line.trim().is_empty()).unwrap_or("");
        if first_line.is_empty() {
            "The bridge returned an empty response.".to_string()
        } else {
            format!("The bridge could not start: {}", first_line.chars().take(250).collect::<String>())
        }
    })?;
    if let Some(error) = value.get("error").and_then(Value::as_str) { return Err(error.into()); }
    if !output.status.success() { return Err("The bridge request failed.".into()); }
    Ok(value)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let [_, flag, root, output] = args.as_slice() {
        if flag == "--verify-bridge" {
            let result = run_bridge("status".into(), root.clone(), json!({}));
            let (value, exit_code) = match result {
                Ok(value) => (value, 0),
                Err(error) => (json!({ "error": error }), 1),
            };
            if fs::write(output, value.to_string()).is_err() {
                std::process::exit(2);
            }
            std::process::exit(exit_code);
        }
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![default_installation, bridge_action])
        .run(tauri::generate_context!())
        .expect("could not start AgentDispatch");
}
