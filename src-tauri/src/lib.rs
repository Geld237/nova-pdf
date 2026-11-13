use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Fichiers PDF passés au lancement (double-clic, « Ouvrir avec »), en attente
/// d'être récupérés par l'interface.
#[derive(Default)]
struct OpenedFiles(Mutex<Vec<String>>);

fn pdf_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| a.to_lowercase().ends_with(".pdf"))
        .collect()
}

#[tauri::command]
fn take_opened_files(state: tauri::State<OpenedFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Une seule fenêtre : un second lancement transmet ses fichiers à l'instance ouverte.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = pdf_args(argv);
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
        // Mises à jour automatiques (installeur signé publié sur GitHub Releases)
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(OpenedFiles(Mutex::new(pdf_args(std::env::args()))))
        .invoke_handler(tauri::generate_handler![take_opened_files])
        .build(tauri::generate_context!())
        .expect("erreur au démarrage de Nova PDF");

    app.run(|_app, _event| {
        // macOS : les fichiers ouverts depuis le Finder arrivent par un événement.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            let files: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if !files.is_empty() {
                _app.state::<OpenedFiles>().0.lock().unwrap().extend(files.clone());
                let _ = _app.emit("open-files", files);
            }
        }
    });
}
