/* The languages the service can text, speak and recognise.

   A language is one module in this directory exporting:
     code, name, speechLocale      "pt", "Português", "pt-BR"
     phrases                       every key en.js defines
     optOutKeywords, optInKeywords whole-message keywords
     markers                       common words, for detection

   Adding one (Portuguese is next):
     1. write pt.js with the same phrase keys as en.js
     2. add it to LANGUAGES below
     3. a migration: INSERT INTO languages (code, name) VALUES ('pt', 'Português')
   The test suite checks the registry and the languages table agree, and that
   every module defines every phrase. Nothing else changes: lines, messages
   and conversations all store a language code, not an enumerated list. */
import en from "./en.js";
import es from "./es.js";

const LANGUAGES = [en, es];
const BY_CODE = new Map(LANGUAGES.map((language) => [language.code, language]));

export const PHRASE_KEYS = Object.keys(en.phrases);

export function languageCodes() {
  return LANGUAGES.map((language) => language.code);
}

export function hasLanguage(code) {
  return BY_CODE.has(code);
}

export function languageName(code) {
  return BY_CODE.get(code)?.name ?? String(code ?? "");
}

export function speechLocale(code) {
  return get(code).speechLocale;
}

export function defaultPhrase(code, key) {
  const text = get(code).phrases[key];
  if (text === undefined) throw new Error(`No "${key}" phrase for language "${code}".`);
  return text;
}

export function phrase(code, key, vars = {}) {
  return fill(defaultPhrase(code, key), vars);
}

/* {placeholder} substitution. Unknown placeholders become empty rather than
   leaking a literal "{business}" into a customer's text. */
export function fill(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}

function get(code) {
  const language = BY_CODE.get(code);
  if (!language) throw new Error(`Unsupported language "${code}".`);
  return language;
}

/* --- keywords ------------------------------------------------------------- */

/* A keyword is the whole message, give or take case, spaces and a trailing
   full stop or exclamation mark -- "Stop." counts, "stop by tomorrow" does
   not. Returns { type: 'optout' | 'optin', keyword, language } or null. */
export function matchKeyword(text) {
  const word = String(text ?? "").trim().replace(/[.!]+$/, "").trim().toUpperCase();
  if (!word || /\s/.test(word)) return null;
  for (const language of LANGUAGES) {
    if (language.optOutKeywords.includes(word)) return { type: "optout", keyword: word, language: language.code };
  }
  for (const language of LANGUAGES) {
    if (language.optInKeywords.includes(word)) return { type: "optin", keyword: word, language: language.code };
  }
  return null;
}

/* --- detection ------------------------------------------------------------- */

const MARKER_SETS = new Map(LANGUAGES.map((language) => [language.code, new Set(language.markers)]));

/* Characters that only turn up in one of the supported languages. */
const DISTINCT_CHARACTERS = { es: /[ñ¿¡áíóú]/i };

/* Best guess at the language of a short customer text, or null when it is
   too short or too mixed to say ("ok", "👍", a lone address). Deliberately
   simple: it only has to pick between a few languages, and a wrong guess
   costs one text in the other language, which a bilingual first message has
   already covered. */
export function detectLanguage(text) {
  const tokens = String(text ?? "").toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
  const scores = new Map(LANGUAGES.map((language) => [language.code, 0]));
  for (const token of tokens) {
    for (const [code, markers] of MARKER_SETS) {
      if (markers.has(token)) scores.set(code, scores.get(code) + 1);
    }
  }
  for (const [code, pattern] of Object.entries(DISTINCT_CHARACTERS)) {
    if (scores.has(code) && pattern.test(text ?? "")) scores.set(code, scores.get(code) + 2);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] === 0) return null;
  if (second && second[1] === best[1]) return null;
  return best[0];
}
