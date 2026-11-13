import { loadSetting, saveSetting } from './memory';

/** Profil de remplissage, conservé uniquement sur l'appareil. */
export interface Profile {
  civilite: string;
  prenom: string;
  nom: string;
  dateNaissance: string;
  lieuNaissance: string;
  nationalite: string;
  email: string;
  telephone: string;
  adresse: string;
  complement: string;
  codePostal: string;
  ville: string;
  pays: string;
  profession: string;
  entreprise: string;
  siret: string;
  iban: string;
  numeroSecu: string;
}

export const PROFILE_LABELS: Record<keyof Profile, string> = {
  civilite: 'Civilité', prenom: 'Prénom', nom: 'Nom', dateNaissance: 'Date de naissance', lieuNaissance: 'Lieu de naissance',
  nationalite: 'Nationalité', email: 'E-mail', telephone: 'Téléphone', adresse: 'Adresse', complement: "Complément d'adresse",
  codePostal: 'Code postal', ville: 'Ville', pays: 'Pays', profession: 'Profession', entreprise: 'Entreprise / organisme',
  siret: 'SIRET', iban: 'IBAN', numeroSecu: 'N° de sécurité sociale',
};

export const EMPTY_PROFILE: Profile = Object.fromEntries(Object.keys(PROFILE_LABELS).map((k) => [k, ''])) as unknown as Profile;

export const loadProfile = () => loadSetting<Profile>('profile', EMPTY_PROFILE);
export const saveProfile = (p: Profile) => saveSetting('profile', p);

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Règles : mots-clés repérés dans le nom du champ → valeur du profil. L'ordre compte. */
const RULES: [RegExp, (p: Profile) => string][] = [
  [/\b(e ?mail|courriel|mel)\b/, (p) => p.email],
  [/\b(tel|telephone|phone|portable|mobile|gsm)\b/, (p) => p.telephone],
  [/\b(nom complet|full ?name|nom et prenom|nom prenom|prenom nom|signataire|soussigne)\b/, (p) => `${p.prenom} ${p.nom}`.trim()],
  [/\b(prenom|first ?name|given ?name|forename)\b/, (p) => p.prenom],
  [/\b(nom de famille|last ?name|surname|family ?name)\b/, (p) => p.nom],
  [/\b(date (de )?naissance|ne le|nee le|birth ?date|date of birth|dob|naissance date)\b/, (p) => p.dateNaissance],
  [/\b(lieu (de )?naissance|ne a|nee a|place of birth|birth ?place)\b/, (p) => p.lieuNaissance],
  [/\b(nationalite|nationality|citizenship)\b/, (p) => p.nationalite],
  [/\b(code postal|cp|postal ?code|zip)\b/, (p) => p.codePostal],
  [/\b(ville|commune|localite|city|town)\b/, (p) => p.ville],
  [/\b(pays|country)\b/, (p) => p.pays],
  [/\b(complement|adresse 2|address 2|address line 2|batiment|appartement)\b/, (p) => p.complement],
  [/\b(adresse|address|rue|domicile|street)\b/, (p) => p.adresse],
  [/\b(profession|metier|occupation|emploi|fonction|job)\b/, (p) => p.profession],
  [/\b(entreprise|societe|employeur|organisme|company|organisation|organization|raison sociale)\b/, (p) => p.entreprise],
  [/\b(siret|siren)\b/, (p) => p.siret],
  [/\b(iban|rib)\b/, (p) => p.iban],
  [/\b(securite sociale|secu|nir|insee|social security)\b/, (p) => p.numeroSecu],
  [/\b(civilite|title|titre|salutation)\b/, (p) => p.civilite],
  [/^(nom|name)\b/, (p) => p.nom],
];

/** Propose une valeur du profil pour un nom de champ, ou null. */
export function matchField(fieldName: string, profile: Profile): string | null {
  const n = norm(fieldName);
  for (const [re, get] of RULES) if (re.test(n)) return get(profile) || null;
  return null;
}
