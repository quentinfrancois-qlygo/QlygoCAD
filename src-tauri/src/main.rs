// QlygoCAD — shell desktop natif (Tauri v2).
// Rôle unique : ouvrir une fenêtre qui affiche l'app de dessin (poc.html).
// Toute l'intelligence (dessin, rendu, cotation, export PDF/DXF) reste côté web
// dans engine/* et app-poc.js — volontairement indépendante du shell, pour
// pouvoir s'embarquer aussi dans QLYGO.

// Sous Windows en release : pas de console noire derrière la fenêtre.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let builder = tauri::Builder::default();
    // Instance unique (desktop) : DOIT être enregistré EN PREMIER. Avec la feature
    // « deep-link », un 2e lancement (clic 💎 alors que l'app tourne déjà) transmet l'URL
    // « qlygocad://… » à l'instance en cours au lieu d'ouvrir une 2e app sur la base.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        use tauri::{Emitter, Manager};
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_focus();
        }
        // Prévient le front (app DÉJÀ ouverte) qu'un clic 💎 vient d'avoir lieu -> il va
        // demander à QLYGO le dossier en attente et l'ouvrir (relais serveur fiable).
        let _ = app.emit("qlygocad-activated", ());
    }));
    builder
        // Mise à jour automatique (vérifie, télécharge et installe la dernière version)
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Permet de relancer l'appli après l'installation d'une mise à jour
        .plugin(tauri_plugin_process::init())
        // Requêtes HTTP natives (login QLYGO sans contrainte CORS navigateur)
        .plugin(tauri_plugin_http::init())
        // Liens profonds « qlygocad://… » (bouton 💎 QlygoCAD depuis QLYGO en ligne)
        .plugin(tauri_plugin_deep_link::init())
        // Traitement du lien profond CÔTÉ RUST (fiable, couvre démarrage à froid ET à chaud
        // via single-instance) : on navigue directement la fenêtre vers poc.html?dossier=<n>
        // au lieu de dépendre de la lecture JS de l'URL (trop capricieuse).
        .setup(|app| {
            use tauri::Manager;
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let u = url.to_string();
                    if let Some(rest) = u.strip_prefix("qlygocad://dossier/") {
                        let num: String = rest
                            .trim_matches('/')
                            .chars()
                            .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                            .collect();
                        if !num.is_empty() {
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.eval(&format!(
                                    "window.location.href='poc.html?dossier={}'",
                                    num
                                ));
                                let _ = w.set_focus();
                            }
                        }
                        break;
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erreur au lancement de QlygoCAD");
}
