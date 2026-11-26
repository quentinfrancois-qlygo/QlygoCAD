;;; QlygoCAD - extrait UNIQUEMENT l'espace Objet d'un DWG et l'enregistre en DXF.
;;; Lance par convertir-dwg.ps1 via accoreconsole (AutoCAD sans fenetre).
;;; Le DWG d'origine n'est JAMAIS enregistre : tout se passe en memoire.
;;;  1) supprime toutes les presentations (DP1, DP5, DP7, DP8, DP11...)
;;;  2) supprime images raster, objets OLE et masques (cadastre, photos) -> DXF leger
;;;  3) purge ce qui n'est plus utilise
;;;  4) DXFOUT (format natif de la version d'AutoCAD, precision 16 decimales)

;;; Liste des presentations SANS (layoutlist) : cette fonction n'existe pas dans AutoCAD LT sans
;;; fenetre. On lit le dictionnaire ACAD_LAYOUT du dessin (fonctions LISP de base).
(defun qlygo-presentations (/ d r)
  (setq d (dictsearch (namedobjdict) "ACAD_LAYOUT"))
  (foreach x d
    (if (and (= (car x) 3) (/= (strcase (cdr x)) "MODEL"))
      (setq r (cons (cdr x) r))))
  r)

(defun qlygo-objet-dxf (out / ss lay)
  (setvar "CMDECHO" 1)
  (setvar "FILEDIA" 0)
  (setvar "EXPERT" 5)
  (setvar "TILEMODE" 1)
  (princ "\nQLYGO: suppression des presentations...")
  (foreach lay (qlygo-presentations)
    (command "_.-LAYOUT" "_Delete" lay))
  (princ "\nQLYGO: suppression des images / OLE / masques...")
  (if (setq ss (ssget "_X" '((0 . "IMAGE,OLE2FRAME,WIPEOUT"))))
    (command "_.ERASE" ss ""))
  (princ "\nQLYGO: purge...")
  (repeat 3 (command "_.-PURGE" "_All" "*" "_No"))
  (princ (strcat "\nQLYGO: ecriture du DXF " out))
  (command "_.DXFOUT" out "16")
  (princ "\nQLYGO: termine.")
  (princ))
