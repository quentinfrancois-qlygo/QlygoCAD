// QlygoCAD — shell desktop natif (Tauri v2).
// Rôle unique : ouvrir une fenêtre qui affiche l'app de dessin (poc.html).
// Toute l'intelligence (dessin, rendu, cotation, export PDF/DXF) reste côté web
// dans engine/* et app-poc.js — volontairement indépendante du shell, pour
// pouvoir s'embarquer aussi dans QLYGO.

// Sous Windows en release : pas de console noire derrière la fenêtre.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("erreur au lancement de QlygoCAD");
}
