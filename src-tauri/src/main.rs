#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{path::BaseDirectory, Manager};

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
fn default_installation() -> Result<String, String> {
    let local = std::env::var_os("LOCALAPPDATA").ok_or("Windows Local AppData is unavailable.")?;
    Ok(PathBuf::from(local).join("AgentDispatch").to_string_lossy().into_owned())
}

#[tauri::command]
async fn bridge_action(
    app: tauri::AppHandle,
    action: String,
    root: String,
    input: Value,
) -> Result<Value, String> {
    if !matches!(action.as_str(), "status" | "install" | "configure" | "start" | "register" | "submit") {
        return Err("Unknown AgentDispatch action.".into());
    }
    let script = app.path().resolve("bridge/scripts/desktop.mjs", BaseDirectory::Resource)
        .map_err(|_| "AgentDispatch could not locate its bridge files.")?;
    tauri::async_runtime::spawn_blocking(move || run_bridge(script, action, root, input))
        .await
        .map_err(|_| "AgentDispatch could not complete the request.")?
}

fn run_bridge(script: PathBuf, action: String, root: String, input: Value) -> Result<Value, String> {
    let request = json!({ "action": action, "root": root, "input": input });
    let mut child = Command::new("node.exe")
        .arg(script)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Install Node.js 24 x64 and reopen AgentDispatch.")?;
    let mut stdin = child.stdin.take().ok_or("Could not open the bridge input stream.")?;
    let written = serde_json::to_writer(&mut stdin, &request).is_ok() && stdin.flush().is_ok();
    drop(stdin);
    let output = child.wait_with_output().map_err(|_| "The bridge process could not finish.")?;
    if !written { return Err("Could not send data to the bridge.".into()); }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| "The bridge returned an unreadable response.")?;
    if let Some(error) = value.get("error").and_then(Value::as_str) { return Err(error.into()); }
    if !output.status.success() { return Err("The bridge request failed.".into()); }
    Ok(value)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![default_installation, bridge_action])
        .run(tauri::generate_context!())
        .expect("could not start AgentDispatch");
}
