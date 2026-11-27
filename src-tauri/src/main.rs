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

// Navigue la fenêtre « QLYGO en ligne » DÉJÀ ouverte vers une page précise (clic sur une
// notification du launcher -> le bon dossier). Côté Rust car la fenêtre distante n'a pas
// le pont Tauri (contenu web non privilégié) : on ne peut pas la piloter depuis son JS.
#[tauri::command]
fn navigate_qlygo(app: tauri::AppHandle, url: String) -> Result<(), String> {
    // Sécurité : on n'autorise QUE des pages de qlygo.fr (pas d'URL arbitraire).
    if !url.starts_with("https://qlygo.fr/") {
        return Err("URL non autorisée".into());
    }
    let w = app
        .get_webview_window("qlygo-online")
        .ok_or_else(|| "fenêtre QLYGO absente".to_string())?;
    let u = url.parse().map_err(|_| "URL invalide".to_string())?;
    w.navigate(u).map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

// Ouvre (ou revient sur) la fenetre « QLYGO en ligne ».
//
// Pourquoi en Rust alors que le launcher sait creer des fenetres en JS : cette
// fenetre affiche une page DISTANTE (qlygo.fr), et on veut y injecter du code
// AVANT son chargement — clic droit « ouvrir dans une nouvelle fenetre » et
// boite « Enregistrer sous » pour les telechargements, qui sans ca ne font
// rien dans une fenetre Tauri. Le script d'initialisation n'existe que cote
// Rust : l'API JavaScript de Tauri ne l'expose pas.
const CONFORT_QLYGO: &str = r#"
// ════════ Confort « application de bureau » dans la fenetre QLYGO ════════
// Injecte AVANT le chargement de la page (script d'initialisation Tauri).
// Une fenetre Tauri n'est pas un navigateur : window.open ne fait rien, et un
// lien target="_blank" non plus. Tout QLYGO repose dessus, d'ou ce pont.
(function () {
  if (window.__qlygoConfort) return;
  window.__qlygoConfort = true;
  var T = function () { return window.__TAURI__; };

  function dire(texte, erreur) {
    try {
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;'
        + 'background:' + (erreur ? '#2B1416' : '#16281B') + ';border:1px solid '
        + (erreur ? '#E53E3E' : '#3A9215') + ';color:#F2F2F2;padding:11px 16px;'
        + 'font:13px/1.4 Inter,system-ui,sans-serif;max-width:440px';
      d.textContent = texte;
      (document.body || document.documentElement).appendChild(d);
      setTimeout(function () { if (d.parentNode) d.remove(); }, erreur ? 8000 : 3500);
    } catch (e) { }
  }

  function absolue(url) {
    try { return new URL(url, location.href).href; } catch (e) { return url; }
  }

  // ════════ Nouvelle FENETRE independante (barre des taches a part) ════════
  var nFen = 0;
  function nouvelleFenetre(url) {
    var t = T(), u = absolue(url);
    try {
      if (t && t.webviewWindow && t.webviewWindow.WebviewWindow) {
        nFen++;
        new t.webviewWindow.WebviewWindow('qlygo-vue-' + Date.now().toString(36) + '-' + nFen, {
          url: u, title: 'QLYGO', width: 1360, height: 900,
          resizable: true, center: true, skipTaskbar: false
        });
        return true;
      }
    } catch (e) { console.warn('[confort] fenetre impossible', e); }
    dire("Impossible d'ouvrir une nouvelle fenetre.", true);
    return false;
  }

  // window.open est utilise PARTOUT dans QLYGO (menu contextuel compris).
  // Sans cette reprise, tous ces boutons sont muets dans le launcher.
  var ouvrirNatif = window.open;
  window.open = function (url, cible, options) {
    if (!url) return ouvrirNatif ? ouvrirNatif.apply(window, arguments) : null;
    var u = String(url);
    if (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) {
      return ouvrirNatif ? ouvrirNatif.apply(window, arguments) : null;
    }
    if (estUnFichier(u)) { enregistrerSous(u, null); return null; }
    nouvelleFenetre(u);
    return null;
  };

  // ════════ « Enregistrer sous », avec memoire du dernier dossier ════════
  var CLE = 'qlygo.dernierDossierTelechargement';
  function dernierDossier() { try { return localStorage.getItem(CLE) || ''; } catch (e) { return ''; } }
  function noterDossier(chemin) {
    try {
      var c = String(chemin);
      var i = Math.max(c.lastIndexOf('/'), c.lastIndexOf(String.fromCharCode(92)));
      if (i > 0) localStorage.setItem(CLE, c.slice(0, i));
    } catch (e) { }
  }

  var EXT = /\.(pdf|dwg|dxf|zip|jpe?g|png|webp|gif|bmp|txt|csv|xlsx?|docx?|json|xml)(\?|$)/i;
  // Routes QLYGO qui renvoient un FICHIER et non une page.
  var ROUTES = [
    /\/api\/dp-pieces\//i,
    /\/api\/dossiers\/[^/]+\/fichiers\//i,
    /\/api\/explorateur\/dossier\/[^/]+\/zip/i,
    /\/api\/drive\/download/i,
    /\/api\/export\//i
  ];
  function estUnFichier(url) {
    var u = String(url);
    if (EXT.test(u.split('#')[0])) return true;
    for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].test(u)) return true;
    return false;
  }

  function nomPour(url, propose) {
    if (propose) return propose;
    try {
      var sans = String(url).split('#')[0].split('?')[0];
      var d = decodeURIComponent(sans.split('/').pop() || '');
      if (d && d.indexOf('.') > 0) return d;
      // Route sans nom de fichier : on fabrique quelque chose d'ouvrable.
      if (/\/api\/dp-pieces\//i.test(url)) return 'pieces-dp.pdf';
      return 'document-qlygo.pdf';
    } catch (e) { return 'document-qlygo.pdf'; }
  }
  function filtresPour(nom) {
    var p = String(nom).lastIndexOf('.');
    if (p <= 0) return [];
    var e = nom.slice(p + 1);
    return [{ name: 'Fichier ' + e.toUpperCase(), extensions: [e] }];
  }

  async function enregistrerSous(url, propose) {
    var t = T(), nom = nomPour(url, propose);
    if (!t || !t.dialog || !t.dialog.save || !t.upload || !t.upload.download) {
      dire("Enregistrement indisponible : l'application n'a pas acces a la boite de dialogue.", true);
      return;
    }
    try {
      var avant = dernierDossier();
      var cible = await t.dialog.save({
        defaultPath: avant ? (avant + '/' + nom) : nom,
        filters: filtresPour(nom)
      });
      if (!cible) return;                       // renonce
      noterDossier(cible);
      await t.upload.download(absolue(url), cible);
      dire('Enregistre : ' + nom);
    } catch (e) {
      dire('Le telechargement a echoue : ' + (e && e.message ? e.message : e), true);
    }
  }
  window.__qlygoEnregistrerSous = enregistrerSous;

  // ════════ Clics sur les liens ════════
  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(href)) return;
    if (href.indexOf('blob:') === 0 || href.indexOf('data:') === 0) return;   // natif

    var marqueTelecharger = a.hasAttribute('download');
    var nouvelOnglet = (a.target === '_blank');

    if (marqueTelecharger || estUnFichier(href)) {
      ev.preventDefault(); ev.stopPropagation();
      enregistrerSous(href, a.getAttribute('download') || null);
      return;
    }
    if (nouvelOnglet) {                 // une PAGE demandee en nouvel onglet
      ev.preventDefault(); ev.stopPropagation();
      nouvelleFenetre(href);
    }
  }, true);

  // ════════ Clic droit : complement au menu de QLYGO ════════
  // QLYGO a son propre menu sur certaines pages ; on n'ajoute le notre que
  // lorsqu'il ne s'affiche pas, pour ne pas faire doublon.
  var menu = null;
  function fermer() { if (menu) { menu.remove(); menu = null; } }
  document.addEventListener('click', fermer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fermer(); });

  function entree(libelle, action) {
    var b = document.createElement('button');
    b.textContent = libelle;
    b.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:0;'
      + 'color:#E9EBF3;font:13px Inter,system-ui,sans-serif;padding:9px 16px;cursor:pointer';
    b.onmouseenter = function () { b.style.background = 'rgba(255,255,255,.09)'; };
    b.onmouseleave = function () { b.style.background = 'none'; };
    b.onclick = function (e) { e.stopPropagation(); fermer(); action(); };
    return b;
  }

  document.addEventListener('contextmenu', function (ev) {
    if (ev.defaultPrevented) return;                      // QLYGO a pris la main
    if (ev.target && ev.target.closest
        && ev.target.closest('input,textarea,[contenteditable="true"]')) return;
    setTimeout(function () {
      // Si QLYGO a ouvert SON menu entre-temps, on ne fait rien.
      if (document.querySelector('.qcm-menu, .ctx-menu, [data-qlygo-menu]')) return;
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      var href = a ? a.getAttribute('href') : '';
      var utile = href && href.charAt(0) !== '#' && !/^(javascript|mailto|tel):/i.test(href);
      fermer();
      menu = document.createElement('div');
      menu.style.cssText = 'position:fixed;z-index:2147483647;min-width:248px;background:#1B2130;'
        + 'border:1px solid #39415A;box-shadow:0 10px 30px rgba(0,0,0,.45);padding:5px 0';
      if (utile) {
        menu.appendChild(entree('Ouvrir dans une nouvelle fenetre', function () { nouvelleFenetre(href); }));
        menu.appendChild(entree('Enregistrer la cible sous...', function () { enregistrerSous(href, a.getAttribute('download') || null); }));
        menu.appendChild(entree('Copier l adresse du lien', function () {
          try { navigator.clipboard.writeText(absolue(href)); dire('Adresse copiee'); } catch (e) { }
        }));
      }
      menu.appendChild(entree('Ouvrir cette page dans une nouvelle fenetre', function () { nouvelleFenetre(location.href); }));
      menu.appendChild(entree('Actualiser', function () { location.reload(); }));
      document.body.appendChild(menu);
      menu.style.left = Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
      menu.style.top = Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
    }, 0);
  });

  console.info('[QLYGO] confort bureau actif : window.open, telechargements, clic droit');
})();
"#;

#[tauri::command]
fn ouvrir_fenetre_qlygo(app: tauri::AppHandle, url: String) -> Result<(), String> {
    // Meme garde que navigate_qlygo : jamais une URL arbitraire.
    if !url.starts_with("https://qlygo.fr/") {
        return Err("URL non autorisee".into());
    }
    if let Some(w) = app.get_webview_window("qlygo-online") {
        let u = url.parse().map_err(|_| "URL invalide".to_string())?;
        w.navigate(u).map_err(|e| e.to_string())?;
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let u = url.parse().map_err(|_| "URL invalide".to_string())?;
    tauri::WebviewWindowBuilder::new(&app, "qlygo-online", tauri::WebviewUrl::External(u))
        .title("QLYGO en ligne")
        .inner_size(1440.0, 900.0)
        .resizable(true)
        .center()
        .initialization_script(CONFORT_QLYGO)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Ouvre une page QLYGO dans une fenetre INDEPENDANTE (barre des taches a part).
//
// Appelee par la page elle-meme (frontend/bureau.js cote QLYGO) quand
// l'utilisateur demande « Ouvrir dans une nouvelle fenetre ». Une page
// d'application ne sait pas le faire seule : window.open n'y produit rien.
//
// Securite : uniquement des pages de qlygo.fr, jamais une URL arbitraire.
/// Relais pour le protocole applicatif `qlygocad://`.
///
/// Dans un navigateur, cliquer un lien `qlygocad://dossier/17110` declenche la
/// boite « ouvrir l'application ». Dans une fenetre d'application, le lien est
/// simplement ignore : le bouton « Ouvrir dans QlygoCAD » de QLYGO restait donc
/// sans effet, et la page finissait par afficher « QlygoCAD n'a pas pris le
/// dossier ». On transmet le lien au systeme, qui active l'app enregistree.
///
/// Le schema est verifie en dur : cette commande ne peut rien ouvrir d'autre.
#[tauri::command]
fn ouvrir_lien_qlygocad(url: String) -> Result<(), String> {
    if !url.starts_with("qlygocad://") {
        return Err("Protocole non autorise".into());
    }
    // On relance NOTRE PROPRE binaire avec le lien en argument, exactement comme
    // le fait Windows via l'inscription du protocole. L'instance unique le
    // transmet ensuite a l'instance deja ouverte.
    //
    // Surtout PAS le plugin opener ici : il delegue a la bibliotheque `open`,
    // qui essaie powershell PUIS explorer.exe en repli. PowerShell lance bien
    // QlygoCAD, mais la chaine enchaine sur explorer.exe, incapable de resoudre
    // un protocole personnalise, d'ou une boite « Application introuvable »
    // affichee EN MEME TEMPS que l'ouverture reussie (constate le 27/11/2026).
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(exe)
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn ouvrir_vue_qlygo(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://qlygo.fr/") {
        return Err("URL non autorisee".into());
    }
    let u: tauri::Url = url.parse().map_err(|_| "URL invalide".to_string())?;
    let etiquette = format!(
        "qlygo-vue-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    tauri::WebviewWindowBuilder::new(&app, &etiquette, tauri::WebviewUrl::External(u))
        .title("QLYGO")
        .inner_size(1360.0, 900.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_upload::init())
        .invoke_handler(tauri::generate_handler![hide_launcher, show_launcher, get_boot_urls, navigate_qlygo, ouvrir_fenetre_qlygo, ouvrir_vue_qlygo, ouvrir_lien_qlygocad])
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
                .icon(
                    Image::from_bytes(include_bytes!("../icons/icon.png"))
                        .unwrap_or_else(|_| app.default_window_icon().unwrap().clone()),
                )
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
