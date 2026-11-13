# Feuille de route

Nova PDF couvre aujourd'hui l'essentiel de ce que font les lecteurs du marché. Voici ce qui vient ensuite, du plus proche au plus prospectif.

## v0.1 — disponible ✅
Lecture, recherche, annotations, formulaires, signature, organisation des pages, fusion/découpe, filigrane, numérotation, OCR local, caviardage réel, export, comparaison de versions, mode lecture, lecture à voix haute, carnet multi-documents, IA locale (résumé, Q&R citées, explication, traduction, fiches).

## v0.2 — disponible ✅
Panneau de notes, panneau Infos & paramètres avec mises à jour, chiffrement AES-256 et déverrouillage, tampons, mesure, correcteur blanc, création de champs de formulaire, compression forte, réparation, recadrage, pages par feuille, format de page, signets, pièces jointes, préférences d'affichage, aplatissement, export Word/HTML, extraction d'images, PDF vierge et texte → PDF, scan caméra, sauvegarde/restauration des données.

## v0.3 — compléter les fondamentaux
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

## v0.4 — lecture augmentée
- [ ] **Recherche sémantique** avec embeddings locaux (transformers.js) en plus de BM25
- [ ] **Vision locale** : expliquer un graphique, un tableau ou une formule (modèle multimodal WebGPU)
- [ ] Reflow intelligent des PDF à colonnes, tableaux et formules (mobile)
- [ ] Références et notes de bas de page en aperçu au survol, même sans lien dans le PDF
- [ ] Extraction de tableaux vers CSV / Excel
- [ ] Répétition espacée des fiches de révision générées
- [ ] Graphe de connaissances reliant les annotations de tous les documents

## v0.5 — accessibilité et conformité
- [ ] Vérification et balisage PDF/UA assisté par IA (European Accessibility Act)
- [ ] Génération de textes alternatifs pour les images
- [ ] Export PDF/A pour l'archivage
- [ ] Signature électronique certifiée (PAdES), vérification des signatures, prépresse (PDF/X)
- [ ] Demande de signatures à des tiers sans serveur (lien P2P chiffré)

## v1.0 — partout
- [ ] Application desktop **Tauri** (Windows, macOS, Linux), avec accès natif aux dossiers
- [ ] Application mobile (Capacitor) avec scan par caméra
- [ ] **Collaboration temps réel pair-à-pair** chiffrée de bout en bout (CRDT / WebRTC), sans serveur
- [ ] Synchronisation optionnelle des annotations via un dossier choisi (Drive, Nextcloud…)
- [ ] Extensions (plugins) pour ajouter des outils
- [ ] Agent documentaire local : « remplis ce formulaire à partir de ce document », « compare ces 5 contrats »

Vous voulez aider sur un de ces points ? Ouvrez une *issue* pour en discuter.
