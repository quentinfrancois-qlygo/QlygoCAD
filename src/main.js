/* QlygoCAD — src/main.js
 * Processus principal Electron (le "shell" desktop).
 * Son SEUL rôle : ouvrir une fenêtre qui affiche l'app de dessin (poc.html).
 * Toute l'intelligence (dessin, rendu, export) est dans engine/* — volontairement
 * indépendante d'Electron, pour pouvoir s'embarquer plus tard dans QLYGO.
 */
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0d1117',
    title: 'QlygoCAD',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null); // interface épurée pour le POC
  win.loadFile(path.join(__dirname, '..', 'poc.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
