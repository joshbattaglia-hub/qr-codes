/** Grouping key for scan countries. Stored blobs keep their original keys. */
const NAMES = {
  australia: "AU",
  aus: "AU",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  japan: "JP",
  jpn: "JP",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  gbr: "GB",
  "new zealand": "NZ",
  nzl: "NZ",
  canada: "CA",
  can: "CA",
  germany: "DE",
  deu: "DE",
  france: "FR",
  fra: "FR",
  india: "IN",
  ind: "IN",
  singapore: "SG",
  sgp: "SG",
  ireland: "IE",
  irl: "IE",
  netherlands: "NL",
  nld: "NL",
  china: "CN",
  chn: "CN",
  "south korea": "KR",
  korea: "KR",
  kor: "KR",
  brazil: "BR",
  bra: "BR",
  mexico: "MX",
  mex: "MX",
  italy: "IT",
  ita: "IT",
  spain: "ES",
  esp: "ES",
  indonesia: "ID",
  idn: "ID",
  malaysia: "MY",
  mys: "MY",
  philippines: "PH",
  phl: "PH",
  "hong kong": "HK",
  hkg: "HK",
  taiwan: "TW",
  twn: "TW",
  sweden: "SE",
  swe: "SE",
  norway: "NO",
  nor: "NO",
  denmark: "DK",
  dnk: "DK",
  finland: "FI",
  fin: "FI",
  switzerland: "CH",
  che: "CH",
  "south africa": "ZA",
  zaf: "ZA",
  "united arab emirates": "AE",
  uae: "AE",
  are: "AE",
  thailand: "TH",
  tha: "TH",
  vietnam: "VN",
  vnm: "VN",
};

export function countryGroupKey(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text || /^unknown$/i.test(text)) return "Unknown";
  if (/^[a-z]{2}$/i.test(text)) return text.toUpperCase();
  return NAMES[text.toLowerCase()] || text;
}

export function groupCountryMap(map) {
  const out = {};
  for (const [name, count] of Object.entries(map || {})) {
    const n = Number(count) || 0;
    if (!n) continue;
    const key = countryGroupKey(name);
    out[key] = (out[key] || 0) + n;
  }
  return out;
}
