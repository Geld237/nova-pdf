# Contribuer à Nova PDF

Merci de votre intérêt !

1. Forkez le dépôt et créez une branche : `git checkout -b ma-fonction`
2. Installez et lancez : `npm install && npm run dev`
3. Vérifiez avant de proposer : `npm run typecheck && npm run build`
4. Ouvrez une *pull request* en décrivant le changement et, si possible, avec une capture.

## Principes

- **Local d'abord** : aucune donnée de document ne doit être envoyée à un serveur.
- **Le fichier d'origine est sacré** : les modifications ne sont écrites qu'à l'enregistrement.
- **Léger** : préférer le chargement à la demande (`import()`) pour les gros modules.
- **Accessible** : boutons avec `title`/`aria-label`, navigation au clavier.

## Où commencer

Les tâches de [ROADMAP.md](ROADMAP.md) sont de bons points d'entrée. Les modules sont indépendants :
`src/pdf/*` pour le traitement PDF, `src/ai/*` pour l'IA, `src/components/*` pour l'interface.
