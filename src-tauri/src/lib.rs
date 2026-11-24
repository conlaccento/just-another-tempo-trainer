use tauri::ipc::Response;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Audio formats the app can open; anything else is refused.
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "aif", "aiff"];

/// Reads a file dropped on the window. Native drag-and-drop only yields paths, and the
/// webview cannot read a path by itself (WebKitGTK on Linux gives no usable File object).
#[tauri::command]
fn read_audio_file(path: String) -> Result<Response, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("unsupported file type: .{ext}"));
    }
    std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

/// Shrinks the window to fit the screen it opens on, minus the taskbar/dock (e.g. a
/// 1366×768 laptop at 125 % scaling has only ~1093×580 logical pixels), and centres it.
fn fit_to_screen(window: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else { return Ok(()) };
    let area = monitor.work_area();
    let size = window.outer_size()?;
    let (w, h) = (size.width.min(area.size.width), size.height.min(area.size.height));
    if (w, h) != (size.width, size.height) {
        window.set_size(PhysicalSize::new(w, h))?;
        let x = area.position.x + (area.size.width - w) as i32 / 2;
        let y = area.position.y + (area.size.height - h) as i32 / 2;
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

// Playback and analysis run in the webview (Web Audio + WASM); the native side hosts the
// window, reads dropped files and installs updates.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_audio_file])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Not fatal: at worst the window is larger than the screen.
                let _ = fit_to_screen(&window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Just another Tempo Trainer");
}

#[cfg(test)]
mod tests {
    use super::read_audio_file;

    #[test]
    fn reads_audio_and_refuses_other_files() {
        let dir = std::env::temp_dir();
        let audio = dir.join("jatt-test.MP3");
        std::fs::write(&audio, b"ID3data").unwrap();
        assert!(read_audio_file(audio.to_string_lossy().into()).is_ok());
        let text = dir.join("jatt-test.txt");
        std::fs::write(&text, b"secret").unwrap();
        assert!(read_audio_file(text.to_string_lossy().into()).is_err());
        assert!(read_audio_file(dir.join("missing.mp3").to_string_lossy().into()).is_err());
    }
}
