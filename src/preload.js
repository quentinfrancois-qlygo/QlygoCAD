/* QlygoCAD — src/preload.js
 * Pont sécurisé entre la fenêtre et le système (vide pour l'instant).
 * On y ajoutera plus tard : "Enregistrer sous", ouverture de fichiers .qcad, etc.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('qlygocadShell', {
  version: '0.1.0',
  platform: process.platform
});
