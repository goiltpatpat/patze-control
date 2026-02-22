#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct SidecarState {
    child: Option<Child>,
    port: u16,
}

struct ApiServer(Mutex<SidecarState>);

fn find_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(9700)
}

fn is_port_in_use(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_err()
}

fn pick_port() -> u16 {
    if !is_port_in_use(9700) {
        return 9700;
    }
    find_free_port()
}

fn resolve_sidecar_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    let triple = current_target_triple();
    let name = format!("patze-api-{triple}");

    let candidate = dir.join(&name);
    if candidate.exists() {
        return Some(candidate);
    }

    let candidate = dir.join("patze-api");
    if candidate.exists() {
        return Some(candidate);
    }

    None
}

fn resolve_dev_sidecar() -> Option<(String, Vec<String>)> {
    let cwd = std::env::current_dir().ok()?;

    let mut dir = cwd.as_path();
    for _ in 0..6 {
        let script = dir.join("apps/api-server/src/index.ts");
        if script.exists() {
            let tsx = if cfg!(target_os = "windows") { "tsx" } else { "tsx" };
            return Some((tsx.to_string(), vec![script.to_string_lossy().to_string()]));
        }
        dir = dir.parent()?;
    }
    None
}

fn spawn_api_server(port: u16) -> Option<Child> {
    if let Some(bin) = resolve_sidecar_path() {
        eprintln!("[patze] Starting sidecar: {} (port {port})", bin.display());
        return Command::new(bin)
            .env("PORT", port.to_string())
            .env("HOST", "127.0.0.1")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .ok();
    }

    if let Some((cmd, args)) = resolve_dev_sidecar() {
        eprintln!("[patze] Starting dev server: {cmd} {} (port {port})", args.join(" "));
        return Command::new(cmd)
            .args(&args)
            .env("PORT", port.to_string())
            .env("HOST", "127.0.0.1")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .ok();
    }

    eprintln!("[patze] No API server binary or dev script found");
    None
}

fn wait_for_healthy(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    let url = format!("http://127.0.0.1:{port}/health");

    while start.elapsed() < timeout {
        if let Ok(output) = Command::new("curl")
            .args(["-sf", "--max-time", "1", &url])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            if output.success() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn kill_child(child: &mut Child) {
    let pid = child.id();
    eprintln!("[patze] Stopping API server (pid: {pid})");

    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, libc::SIGTERM); }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
    }

    #[cfg(not(unix))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn current_target_triple() -> &'static str {
    if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        "x86_64-apple-darwin"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        "x86_64-pc-windows-msvc"
    } else {
        "unknown"
    }
}

#[tauri::command]
fn get_api_port(state: tauri::State<'_, ApiServer>) -> u16 {
    state.0.lock().map(|s| s.port).unwrap_or(9700)
}

fn main() {
    let port = pick_port();
    let child = spawn_api_server(port);

    if child.is_some() {
        let healthy = wait_for_healthy(port, Duration::from_secs(10));
        if healthy {
            eprintln!("[patze] API server ready at http://127.0.0.1:{port}");
        } else {
            eprintln!("[patze] API server did not become healthy within 10s");
        }
    }

    let state = ApiServer(Mutex::new(SidecarState { child, port }));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![get_api_port])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(api) = window.try_state::<ApiServer>() {
                    if let Ok(mut guard) = api.0.lock() {
                        if let Some(ref mut child) = guard.child {
                            kill_child(child);
                        }
                        guard.child = None;
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
