// QLYGO Launcher — shell desktop natif (Tauri v2).
// Le launcher ouvre QLYGO et QlygoCAD CHACUN dans sa propre fenêtre, se range dans
// la zone de notification (tray) quand une app est ouverte, et ne se quitte QUE par
// le menu du tray. Tout le dessin reste côté web (engine/*, app-poc.js).

// Sous Windows en release : pas de console noire derrière la fenêtre.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

// Réaffiche le launcher (fenêtre « main ») dès qu'il n'y a plus aucune fenêtre d'app
// ouverte (QlygoCAD / QLYGO). Tant qu'une app tourne, le launcher reste dans le tray.
fn maj_launcher(app: &tauri::AppHandle) {
    let encore_une_app = app.webview_windows().keys().any(|label| label != "main");
    if !encore_une_app {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.set_focus();
        }
    }
}

fn afficher_launcher(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    let builder = tauri::Builder::default();

    // Instance unique (desktop) : DOIT être enregistré EN PREMIER. Un 2e lancement
    // (clic « Ouvrir dans QlygoCAD » alors que l'app tourne) transmet l'URL à l'instance
    // en cours au lieu d'ouvrir une 2e app sur la base.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        afficher_launcher(app);
        let _ = app.emit("qlygocad-activated", ());
    }));

    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |_event| {
                afficher_launcher(&handle);
                let _ = handle.emit("qlygocad-activated", ());
            });

            // ── Tray : le launcher se range dans la zone de notification ──
            let afficher = MenuItem::with_id(app, "show", "Afficher le launcher", true, None::<&str>)?;
            let quitter = MenuItem::with_id(app, "quit", "Quitter QLYGO Launcher", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&afficher, &quitter])?;
            let _tray = TrayIconBuilder::with_id("qlygo-launcher-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("QLYGO Launcher")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => afficher_launcher(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        afficher_launcher(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Fermer le LAUNCHER -> on le range dans le tray (on ne quitte pas l'appli).
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.hide();
            }
            // Une fenêtre d'app (QlygoCAD / QLYGO) fermée -> si plus aucune, on réaffiche le launcher.
            WindowEvent::Destroyed if window.label() != "main" => {
                maj_launcher(window.app_handle());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("erreur au lancement du QLYGO Launcher");
}
