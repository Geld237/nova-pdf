# Feuille de route

Nova PDF couvre aujourd'hui l'essentiel de ce que font les lecteurs du marché. Voici ce qui vient ensuite, du plus proche au plus prospectif.

## v0.1 — disponible ✅
Lecture, recherche, annotations, formulaires, signature, organisation des pages, fusion/découpe, filigrane, numérotation, OCR local, caviardage réel, export, comparaison de versions, mode lecture, lecture à voix haute, carnet multi-documents, IA locale (résumé, Q&R citées, explication, traduction, fiches).

## v0.2 — compléter les fondamentaux
- [ ] Chiffrement AES et permissions (mot de passe à l'enregistrement)
- [ ] Déplacer / redimensionner / modifier une annotation existante
- [ ] Annotations natives éditables (Highlight, Ink, Square…) en plus de l'aplatissement
- [ ] Import / export XFDF des commentaires
- [ ] Recherche avancée : expressions régulières, tous les onglets ouverts
- [ ] Édition du texte existant du PDF
- [ ] Tampons personnalisés, mesure de distances et surfaces (plans)
- [ ] Internationalisation (anglais, espagnol…)

## v0.3 — lecture augmentée
- [ ] **Recherche sémantique** avec embeddings locaux (transformers.js) en plus de BM25
- [ ] **Vision locale** : expliquer un graphique, un tableau ou une formule (modèle multimodal WebGPU)
- [ ] Reflow intelligent des PDF à colonnes, tableaux et formules (mobile)
- [ ] Références et notes de bas de page en aperçu au survol, même sans lien dans le PDF
- [ ] Extraction de tableaux vers CSV / Excel
- [ ] Répétition espacée des fiches de révision générées
- [ ] Graphe de connaissances reliant les annotations de tous les documents

## v0.4 — accessibilité et conformité
- [ ] Vérification et balisage PDF/UA assisté par IA (European Accessibility Act)
- [ ] Génération de textes alternatifs pour les images
- [ ] Export PDF/A pour l'archivage
- [ ] Signature électronique certifiée (PAdES) et vérification des signatures

## v1.0 — partout
- [ ] Application desktop **Tauri** (Windows, macOS, Linux), avec accès natif aux dossiers
- [ ] Application mobile (Capacitor) avec scan par caméra
- [ ] **Collaboration temps réel pair-à-pair** chiffrée de bout en bout (CRDT / WebRTC), sans serveur
- [ ] Synchronisation optionnelle des annotations via un dossier choisi (Drive, Nextcloud…)
- [ ] Extensions (plugins) pour ajouter des outils
- [ ] Agent documentaire local : « remplis ce formulaire à partir de ce document », « compare ces 5 contrats »

Vous voulez aider sur un de ces points ? Ouvrez une *issue* pour en discuter.
