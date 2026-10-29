import countries from 'i18n-iso-countries';
// Maintained ISO 3166-1 dataset (249 officially assigned codes + territories) — not a hand-typed list.
// eslint-disable-next-line @typescript-eslint/no-var-requires
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
countries.registerLocale(require('i18n-iso-countries/langs/ar.json'));

export interface Country {
  code: string;
  nameAr: string;
  nameEn: string;
}

const ARAB_LEAGUE = new Set([
  'SA', 'AE', 'EG', 'OM', 'JO', 'IQ', 'QA', 'KW', 'BH', 'YE', 'SY', 'LB', 'PS', 'LY', 'TN', 'DZ',
  'MA', 'SD', 'MR', 'SO', 'DJ', 'KM',
]);

const buildList = (): Country[] => {
  const en = countries.getNames('en', { select: 'official' }) as Record<string, string>;
  const ar = countries.getNames('ar', { select: 'official' }) as Record<string, string>;
  const shared = countries.getNames('en', { select: 'alias' }) as Record<string, string>;
  const list: Country[] = [];
  for (const code of Object.keys(en)) {
    const nameEn = en[code];
    const nameAr = ar[code] || shared[code] || nameEn;
    list.push({ code, nameEn, nameAr });
  }
  return list.sort((a, b) => a.nameEn.localeCompare(b.nameEn, 'en'));
};

export const COUNTRIES: Country[] = buildList();
const BY_CODE = new Map(COUNTRIES.map((c) => [c.code.toUpperCase(), c]));

export function isValidCountryCode(code: unknown): code is string {
  return typeof code === 'string' && BY_CODE.has(code.toUpperCase());
}

export function normalizeCountryCode(code: string): string {
  return code.trim().toUpperCase();
}

export function getCountry(code: string | null): Country | null {
  if (!code) return null;
  return BY_CODE.get(code.toUpperCase()) ?? null;
}

export function countriesPayload(filter?: string, limit = 400): Country[] {
  const q = (filter || '').trim().toLowerCase();
  if (!q) {
    return COUNTRIES.slice()
      .sort((a, b) => {
        const aArab = ARAB_LEAGUE.has(a.code) ? 0 : 1;
        const bArab = ARAB_LEAGUE.has(b.code) ? 0 : 1;
        if (aArab !== bArab) return aArab - bArab;
        return a.nameAr.localeCompare(b.nameAr, 'ar');
      })
      .slice(0, limit);
  }
  return COUNTRIES.filter(
    (c) =>
      c.nameAr.includes(q) ||
      c.nameEn.toLowerCase().includes(q) ||
      c.code.toLowerCase() === q ||
      c.code.toLowerCase().startsWith(q),
  ).slice(0, limit);
}

export function isArabCountry(code: string): boolean {
  return ARAB_LEAGUE.has(code.toUpperCase());
}
