# Feuille de route

Nova PDF couvre aujourd'hui l'essentiel de ce que font les lecteurs du marché. Voici ce qui vient ensuite, du plus proche au plus prospectif.

## v0.1 — disponible ✅
Lecture, recherche, annotations, formulaires, signature, organisation des pages, fusion/découpe, filigrane, numérotation, OCR local, caviardage réel, export, comparaison de versions, mode lecture, lecture à voix haute, carnet multi-documents, IA locale (résumé, Q&R citées, explication, traduction, fiches).

## v0.2 — disponible ✅
Panneau de notes, panneau Infos & paramètres avec mises à jour, chiffrement AES-256 et déverrouillage, tampons, mesure, correcteur blanc, création de champs de formulaire, compression forte, réparation, recadrage, pages par feuille, format de page, signets, pièces jointes, préférences d'affichage, aplatissement, export Word/HTML, extraction d'images, PDF vierge et texte → PDF, scan caméra, sauvegarde/restauration des données.

## v0.3 — disponible ✅
Logo chat, applications Windows (.exe/.msi), macOS (.dmg universel), Linux (AppImage/deb/rpm) avec association des fichiers .pdf, Android (.apk) et iOS (.ipa) avec « Ouvrir avec », publication automatique des installeurs, vérification des nouvelles versions dans l'app.

## v0.4 — disponible ✅
Bibliothèque (dossiers, étiquettes, recherche plein texte), IA multi-documents (comparaison de contrats, revue de littérature), fiches à répétition espacée et quiz, anonymisation automatique, profil de remplissage, traduction côte à côte, podcast, mode présentation avec laser, police dyslexie et règle de lecture, références BibTeX/RIS et aperçu au survol, scanner avec redressement, commandes vocales et dictée, raccourcis d'application, connexion pair-à-pair par QR (synchronisation, relecture en direct, demande de signature).

## v0.8 — disponible ✅
Bouton « Arrêter » fiable pour toutes les tâches d'IA (résumé, QCM, fiches, traduction, podcast, anonymisation) et arrêt global dans la barre d'état ; mise en forme du texte inséré (police, taille, gras, italique, souligné, alignement, couleur, fond) et modification d'un texte déjà posé ; carte des couleurs (palette, spectre, couleurs récentes, code hex, pipette) ; un clic gauche ou droit au milieu du document referme les panneaux de droite et de gauche.

## Prochaines idées 💡
- [ ] **Widgets natifs** d'écran d'accueil (Android AppWidget, iOS WidgetKit) : derniers documents, fiches du jour
- [ ] **Reconnaissance vocale 100 % locale** (Whisper en WebGPU)
- [ ] Relecture à plus de deux appareils, curseurs des autres relecteurs
- [ ] Recherche sémantique (embeddings locaux) dans la bibliothèque
- [ ] **Détection des champs** d'un formulaire scanné, et des signatures manquantes
- [ ] Mode présentation : vue présentateur sur un deuxième écran
- [ ] Surlignage synchronisé avec la lecture à voix haute
- [ ] **Thèmes et couleurs** personnalisables, mode sépia
- [ ] **Extensions** : API de plugins pour ajouter des outils

## v0.4 — compléter les fondamentaux
- [ ] Déplacer / redimensionner / modifier une annotation existante
- [ ] Annotations natives éditables (Highlight, Ink, Square…) en plus de l'aplatissement
- [ ] Import / export XFDF des commentaires
- [ ] Recherche avancée : expressions régulières, tous les onglets ouverts
- [ ] Édition du texte existant du PDF
- [ ] Mesure de surfaces et de périmètres
- [ ] Conversion Office → PDF locale (LibreOffice WebAssembly)
- [ ] Linéarisation (affichage web rapide), extraction des images non JPEG
- [ ] Actions en lot (appliquer une suite d'outils à plusieurs fichiers)
- [ ] Internationalisation (anglais, espagnol…)

## v0.5 — lecture augmentée
- [ ] **Recherche sémantique** avec embeddings locaux (transformers.js) en plus de BM25
- [ ] **Vision locale** : expliquer un graphique, un tableau ou une formule (modèle multimodal WebGPU)
- [ ] Reflow intelligent des PDF à colonnes, tableaux et formules (mobile)
- [ ] Références et notes de bas de page en aperçu au survol, même sans lien dans le PDF
- [ ] Extraction de tableaux vers CSV / Excel
- [ ] Répétition espacée des fiches de révision générées
- [ ] Graphe de connaissances reliant les annotations de tous les documents

## v0.6 — accessibilité et conformité
- [ ] Vérification et balisage PDF/UA assisté par IA (European Accessibility Act)
- [ ] Génération de textes alternatifs pour les images
- [ ] Export PDF/A pour l'archivage
- [ ] Signature électronique certifiée (PAdES), vérification des signatures, prépresse (PDF/X)
- [ ] Demande de signatures à des tiers sans serveur (lien P2P chiffré)

## v1.0 — partout
- [ ] Publication sur Microsoft Store, Mac App Store, Google Play et App Store
- [ ] Scan mobile avec détection des bords et correction de perspective
- [ ] **Collaboration temps réel pair-à-pair** chiffrée de bout en bout (CRDT / WebRTC), sans serveur
- [ ] Synchronisation optionnelle des annotations via un dossier choisi (Drive, Nextcloud…)
- [ ] Extensions (plugins) pour ajouter des outils
- [ ] Agent documentaire local : « remplis ce formulaire à partir de ce document », « compare ces 5 contrats »

Vous voulez aider sur un de ces points ? Ouvrez une *issue* pour en discuter.
