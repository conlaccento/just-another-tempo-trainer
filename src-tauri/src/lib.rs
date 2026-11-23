// The whole app runs in the webview (Web Audio + WASM): the native side only hosts the window.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Just another Tempo Trainer");
}
