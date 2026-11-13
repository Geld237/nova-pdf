import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/** Génère un PDF de démonstration (texte, formulaire) pour essayer l'application. */
export async function makeDemoPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Découvrir Nova PDF');
  pdf.setAuthor('Nova PDF');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pages: { title: string; body: string[] }[] = [
    {
      title: 'Bienvenue dans Nova PDF',
      body: [
        'Nova PDF est un lecteur PDF libre qui fonctionne entièrement dans votre navigateur.',
        'Vos documents ne quittent jamais votre appareil : le rendu, l\'OCR et l\'intelligence',
        'artificielle s\'exécutent localement.',
        '',
        'Essayez les outils de la barre du haut :',
        '  - Surligner (H) : sélectionnez du texte pour le surligner.',
        '  - Dessin (D), rectangle, ellipse, flèche, texte (T) et note (N).',
        '  - Signature : dessinez ou écrivez votre signature puis cliquez pour la placer.',
        '  - Caviardage : masquez définitivement une zone sensible.',
        '',
        'Le panneau IA (à droite) résume le document, répond aux questions en citant',
        'les pages, explique un passage sélectionné et crée des fiches de révision.',
      ],
    },
    {
      title: 'Chapitre 1 - La photosynthèse',
      body: [
        'La photosynthèse est le processus par lequel les plantes, les algues et certaines',
        'bactéries convertissent l\'énergie lumineuse en énergie chimique.',
        '',
        'Elle se déroule dans les chloroplastes, grâce à la chlorophylle, un pigment vert',
        'qui absorbe surtout la lumière rouge et bleue.',
        '',
        'Équation globale : 6 CO2 + 6 H2O + lumière -> C6H12O6 + 6 O2.',
        '',
        'On distingue deux phases : la phase lumineuse, qui produit de l\'ATP et du NADPH',
        'dans les thylakoïdes, et le cycle de Calvin, qui fixe le CO2 dans le stroma.',
        'Chaque année, la photosynthèse fixe environ 120 milliards de tonnes de carbone.',
      ],
    },
    {
      title: 'Chapitre 2 - Formulaire d\'inscription',
      body: [
        'Remplissez ce formulaire depuis le panneau « Formulaire », puis enregistrez.',
        '',
        'Nom :',
        '',
        '',
        'Courriel :',
        '',
        '',
        'J\'accepte les conditions :',
      ],
    },
  ];

  for (const p of pages) {
    const page = pdf.addPage([595, 842]);
    page.drawRectangle({ x: 0, y: 792, width: 595, height: 50, color: rgb(0.24, 0.32, 0.86) });
    page.drawText('Nova PDF - document de démonstration', { x: 40, y: 810, size: 11, font, color: rgb(1, 1, 1) });
    page.drawText(p.title, { x: 40, y: 740, size: 22, font: bold, color: rgb(0.1, 0.1, 0.2) });
    p.body.forEach((line, i) => page.drawText(line, { x: 40, y: 700 - i * 20, size: 12, font, color: rgb(0.15, 0.15, 0.2) }));
  }

  const form = pdf.getForm();
  const p3 = pdf.getPage(2);
  const name = form.createTextField('Nom');
  name.addToPage(p3, { x: 40, y: 600, width: 300, height: 24 });
  const mail = form.createTextField('Courriel');
  mail.addToPage(p3, { x: 40, y: 540, width: 300, height: 24 });
  const ok = form.createCheckBox('Conditions acceptées');
  ok.addToPage(p3, { x: 230, y: 536, width: 16, height: 16 });
  const country = form.createDropdown('Pays');
  country.addOptions(['Cameroun', 'France', 'Belgique', 'Canada', 'Sénégal', 'Suisse']);
  country.addToPage(p3, { x: 40, y: 470, width: 200, height: 24 });
  p3.drawText('Pays :', { x: 40, y: 500, size: 12, font });

  return pdf.save();
}
