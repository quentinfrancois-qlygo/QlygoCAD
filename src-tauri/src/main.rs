// QLYGO Launcher — shell desktop natif (Tauri v2).
// Le launcher ouvre QLYGO et QlygoCAD chacun dans sa propre fenêtre. Quand une app
// s'ouvre, le launcher se RANGE dans la zone de notification (tray) ; il réapparaît
// quand plus aucune fenêtre d'app n'est ouverte, et reste accessible par le tray.
// L'appli ne se QUITTE QUE par le menu « Quitter » du tray : fermer une fenêtre ne
// quitte JAMAIS l'appli (sinon fermer QlygoCAD fermait tout). Tout le dessin reste
// côté web (engine/*, app-poc.js).

// Sous Windows en release : pas de console noire derrière la fenêtre.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, WindowEvent,
};

// Icône de barre des tâches PAR fenêtre : chaque outil ouvert depuis le launcher porte
// SON logo, pour les distinguer en bas. main=launcher, qlygocad=éditeur, qlygo-drive=Drive,
// qlygo-online=le site QLYGO.
fn icone_pour(label: &str) -> Option<Image<'static>> {
    match label {
        "main" => Image::from_bytes(include_bytes!("../../assets/logo-launcher.png")).ok(),
        "qlygocad" => Image::from_bytes(include_bytes!("../../assets/logo-qlygocad.png")).ok(),
        "qlygo-drive" => Image::from_bytes(include_bytes!("../../assets/logo-drive.png")).ok(),
        "qlygo-online" => Image::from_bytes(include_bytes!("../../assets/logo-qlygo.png")).ok(),
        _ => None,
    }
}

// Dernières URLs « qlygocad:// » reçues (lancement à froid OU 2e instance). Le JS du
// launcher vient les CHERCHER (commande get_boot_urls) : livraison déterministe, sans
// dépendre d'un évènement qui peut partir avant que la page soit chargée (la cause du
// « QlygoCAD s'ouvre sur la base au lieu du dossier » au démarrage à froid).
struct BootUrls(std::sync::Mutex<Vec<String>>);

// Signale une demande d'ouverture : mémorise les URLs, montre le launcher, prévient le JS.
fn signaler_ouverture(app: &tauri::AppHandle, urls: Vec<String>) {
    if let Some(s) = app.try_state::<BootUrls>() {
        let mut g = s.0.lock().unwrap();
        g.extend(urls.iter().cloned());
    }
    afficher_launcher(app);
    let _ = app.emit("qlygocad-open-url", urls);
    let _ = app.emit("qlygocad-activated", ());
}

// Réaffiche le launcher (fenêtre « main ») et le met au premier plan.
fn afficher_launcher(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Range le launcher dans le tray.
fn cacher_launcher(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

// Si plus aucune fenêtre d'app (hors launcher) n'est ouverte, on réaffiche le launcher.
fn maj_launcher(app: &tauri::AppHandle) {
    let encore_une_app = app.webview_windows().keys().any(|label| label != "main");
    if !encore_une_app {
        afficher_launcher(app);
    }
}

// ── Commandes appelées par le launcher (launcher.html) ──
// Le masquage du launcher se fait CÔTÉ RUST (fiable, pas de souci de permission ACL
// comme avec window.hide() côté JS). Le JS crée la fenêtre puis appelle hide_launcher.
#[tauri::command]
fn hide_launcher(app: tauri::AppHandle) {
    cacher_launcher(&app);
}

#[tauri::command]
fn show_launcher(app: tauri::AppHandle) {
    afficher_launcher(&app);
}

// Le launcher APPELLE cette commande (au boot puis en veille courte) pour récupérer les
// URLs qlygocad:// en attente. On les lui donne UNE fois (la liste est vidée).
#[tauri::command]
fn get_boot_urls(app: tauri::AppHandle) -> Vec<String> {
    app.try_state::<BootUrls>()
        .map(|s| {
            let mut g = s.0.lock().unwrap();
            let v = g.clone();
            g.clear();
            v
        })
        .unwrap_or_default()
}

fn main() {
    let builder = tauri::Builder::default();

    // Instance unique (desktop) : un 2e lancement (« Ouvrir dans QlygoCAD » alors que
    // l'app tourne) transmet l'URL à l'instance en cours.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // Les liens « qlygocad://… » d'un 2e lancement arrivent dans argv : on les
        // transmet nous-mêmes (fiable), sans compter sur le relais du plugin deep-link.
        let urls: Vec<String> = argv
            .iter()
            .filter(|a| a.to_ascii_lowercase().starts_with("qlygocad://"))
            .cloned()
            .collect();
        signaler_ouverture(app, urls);
    }));

    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![hide_launcher, show_launcher, get_boot_urls])
        .setup(|app| {
            app.manage(BootUrls(std::sync::Mutex::new(Vec::new())));
            // Icône du launcher posée dès le départ (pas seulement à la prise de focus).
            if let Some(w) = app.get_webview_window("main") {
                if let Some(ic) = icone_pour("main") {
                    let _ = w.set_icon(ic);
                }
            }
            // Lancement à froid PAR le protocole : l'URL est dans argv. On la range dans
            // BootUrls AVANT que la page du launcher soit chargée -> elle la récupérera
            // par get_boot_urls, impossible de la rater.
            let argv_urls: Vec<String> = std::env::args()
                .filter(|a| a.to_ascii_lowercase().starts_with("qlygocad://"))
                .collect();
            if !argv_urls.is_empty() {
                if let Some(s) = app.try_state::<BootUrls>() {
                    s.0.lock().unwrap().extend(argv_urls);
                }
            }
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                signaler_ouverture(&handle, urls);
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
                    // Quitte VRAIMENT l'appli (contourne le prevent_exit ci-dessous).
                    "quit" => std::process::exit(0),
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
            // À la prise de focus, chaque fenêtre reçoit SON icône de barre des tâches
            // (les fenêtres créées côté JS naissent avec l'icône par défaut de l'appli).
            WindowEvent::Focused(true) => {
                if let Some(ic) = icone_pour(window.label()) {
                    let _ = window.set_icon(ic);
                }
            }
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
        .build(tauri::generate_context!())
        .expect("erreur au lancement du QLYGO Launcher")
        .run(|_app, event| {
            // L'appli VIT dans le tray : fermer une fenêtre ne doit JAMAIS la quitter
            // (sinon fermer QlygoCAD fermait QLYGO + le launcher). On ne quitte que par
            // le menu « Quitter » (std::process::exit) ou une mise à jour.
            if let RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
