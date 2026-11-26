;;; QlygoCAD — extrait UNIQUEMENT l'espace Objet d'un DWG et l'enregistre en DXF.
;;; Lancé par convertir-dwg.ps1 via accoreconsole (AutoCAD sans fenêtre).
;;; Le DWG d'origine n'est JAMAIS enregistré : tout se passe en mémoire.
;;;  1) supprime toutes les présentations (DP1, DP5, DP7, DP8, DP11…)
;;;  2) supprime images raster, objets OLE et masques (cadastre, photos) -> DXF léger
;;;  3) purge ce qui n'est plus utilisé
;;;  4) DXFOUT au format 2018 (précision 16 décimales)

(defun qlygo-objet-dxf (out / ss lay)
  (setvar "CMDECHO" 0)
  (setvar "FILEDIA" 0)
  (setvar "EXPERT" 5)
  (setvar "TILEMODE" 1)                                   ; on se place dans l'espace Objet
  ;; 1) présentations
  (foreach lay (layoutlist)
    (command "_.-LAYOUT" "_Delete" lay))
  ;; 2) images, OLE, masques (dans ce qui reste)
  (if (setq ss (ssget "_X" '((0 . "IMAGE,OLE2FRAME,WIPEOUT"))))
    (command "_.ERASE" ss ""))
  ;; 3) purge (3 passes : les éléments imbriqués se libèrent au fur et à mesure)
  (repeat 3 (command "_.-PURGE" "_All" "*" "_No"))
  ;; 4) DXF
  (command "_.DXFOUT" out "_Version" "2018" "16")
  (princ))
