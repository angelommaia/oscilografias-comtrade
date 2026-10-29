//! Oscilo desktop: janela Tauri + servidor Python local (PyInstaller).
//!
//! Fluxo:
//! 1. sorteia uma porta livre em 127.0.0.1 e um token aleatório;
//! 2. inicia `server/oscilo-server(.exe)` (recurso empacotado) com
//!    `--port --token --parent-pid` – o servidor encerra sozinho se a janela cair;
//! 3. enquanto ele sobe, mostra a tela de abertura (desktop/splash);
//! 4. com o servidor pronto, concede à página http://127.0.0.1:<porta> apenas a
//!    permissão do diálogo "Abrir" e navega para lá (token na URL, retirado pela
//!    interface na abertura);
//! 5. ao fechar a janela, encerra o servidor.

use std::fs::{self, File};
use std::hash::{BuildHasher, Hasher};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url};

struct Server(Mutex<Option<Child>>);

const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// 128 bits aleatórios (RandomState usa chaves aleatórias do SO) em hexadecimal.
fn random_token() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    (0..2u64)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(i ^ u64::from(std::process::id()));
            h.write_u128(nanos);
            format!("{:016x}", h.finish())
        })
        .collect()
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Arquivo .cfg passado na linha de comando ("Abrir com…" / arrastar no ícone).
fn startup_file() -> Option<String> {
    std::env::args().skip(1).find(|a| a.to_lowercase().ends_with(".cfg"))
}

fn server_command(app: &AppHandle) -> Result<Command, String> {
    let exe_name = if cfg!(windows) { "oscilo-server.exe" } else { "oscilo-server" };
    let bundled = app
        .path()
        .resource_dir()
        .map(|d| d.join("server").join(exe_name))
        .unwrap_or_default();
    if bundled.is_file() {
        return Ok(Command::new(bundled));
    }
    // Desenvolvimento (`npm run desktop` sem empacotar o servidor): usa o Python do sistema/venv.
    if cfg!(debug_assertions) {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../backend/desktop_server.py");
        let python = std::env::var("OSCILO_PYTHON").unwrap_or_else(|_| if cfg!(windows) { "python".into() } else { "python3".into() });
        let mut cmd = Command::new(python);
        cmd.arg(script);
        return Ok(cmd);
    }
    Err(format!("Servidor não encontrado em {}", bundled.display()))
}

fn start_server(app: &AppHandle, port: u16, token: &str) -> Result<Child, String> {
    let mut cmd = server_command(app)?;
    cmd.args(["--port", &port.to_string(), "--token", token, "--parent-pid", &std::process::id().to_string()]);

    // saída do servidor em <logs>/server.log (diagnóstico)
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = fs::create_dir_all(&dir);
        if let Ok(f) = File::create(dir.join("server.log")) {
            if let Ok(f2) = f.try_clone() {
                cmd.stdout(Stdio::from(f)).stderr(Stdio::from(f2));
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("Falha ao iniciar o servidor: {e}"))
}

fn wait_ready(port: u16, child_alive: impl Fn() -> bool) -> Result<(), String> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let start = Instant::now();
    while start.elapsed() < STARTUP_TIMEOUT {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return Ok(());
        }
        if !child_alive() {
            return Err("O servidor encerrou durante a inicialização (veja server.log).".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("Tempo esgotado aguardando o servidor (veja server.log).".into())
}

fn show_error(app: &AppHandle, msg: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let log = app
            .path()
            .app_log_dir()
            .map(|d| d.join("server.log").display().to_string())
            .unwrap_or_default();
        let js = format!(
            "window.showError && window.showError({}, {})",
            serde_json::to_string(msg).unwrap_or_default(),
            serde_json::to_string(&log).unwrap_or_default()
        );
        let _ = w.eval(&js);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let port = free_port()?;
            let token = random_token();
            app.manage(Server(Mutex::new(None)));

            match start_server(&handle, port, &token) {
                Ok(child) => *app.state::<Server>().0.lock().unwrap() = Some(child),
                Err(e) => {
                    let h = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(500));
                        show_error(&h, &e);
                    });
                    return Ok(());
                }
            }

            std::thread::spawn(move || {
                let alive = || {
                    let state = handle.state::<Server>();
                    let mut guard = state.0.lock().unwrap();
                    match guard.as_mut() {
                        Some(c) => matches!(c.try_wait(), Ok(None)),
                        None => false,
                    }
                };
                if let Err(e) = wait_ready(port, alive) {
                    show_error(&handle, &e);
                    return;
                }
                let origin = format!("http://127.0.0.1:{port}");
                // A interface servida pelo backend só pode usar o diálogo "Abrir".
                let cap = CapabilityBuilder::new("local-server")
                    .remote(format!("{origin}/*"))
                    .window("main")
                    .permission("dialog:allow-open");
                if let Err(e) = handle.add_capability(cap) {
                    eprintln!("capability: {e}");
                }
                let open = startup_file().map(|p| format!("&open={}", url_encode(&p))).unwrap_or_default();
                let url = format!("{origin}/?desktop=1&token={token}{open}");
                match (handle.get_webview_window("main"), Url::parse(&url)) {
                    (Some(w), Ok(u)) => {
                        let _ = w.navigate(u);
                    }
                    _ => show_error(&handle, "Janela principal indisponível."),
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Oscilo");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Server>() {
                if let Some(mut child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
