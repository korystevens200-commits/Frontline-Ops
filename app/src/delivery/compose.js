/* Building the words: every text and every spoken greeting the service sends.

   Language choice, in one place:
     - a caller whose language we already know (they have written to us
       before) hears and reads theirs alone
     - anyone else gets the line's first-contact languages: English then
       Spanish by default, one message, business name once at the top
   A client may reword the body of the text-back and follow-up per language
   (line_templates); the greeting, the business name and the compliance
   wording always come from code. */
import { phrase, fill, defaultPhrase, speechLocale } from "./language/index.js";
import { displayPhone } from "../views/components.js";

export const EDITABLE_KEYS = ["textback", "followup"];
const SNIPPET_MAX = 100;

export function contactLanguages(line, conversation = null) {
  if (conversation?.language) return [conversation.language];
  return [line.primary_language, line.secondary_language].filter(Boolean);
}

/* overrides: Map of "key:language" -> body, from line_templates. */
function body(key, language, overrides, vars) {
  return fill(overrides?.get(`${key}:${language}`) ?? defaultPhrase(language, key), vars).trim();
}

function introduced(key, languages, line, overrides) {
  const vars = { business: line.display_name };
  if (languages.length === 1) {
    const [language] = languages;
    return `${phrase(language, `${key}_intro`, vars)} ${body(key, language, overrides, vars)}`;
  }
  return `${line.display_name}: ` + languages.map((language) => body(key, language, overrides, vars)).join("\n");
}

export function composeTextback(line, languages, overrides) {
  return introduced("textback", languages, line, overrides);
}

export function composeFollowup(line, languages, overrides) {
  return introduced("followup", languages, line, overrides);
}

/* Spoken to the caller before the call ends. `texted` says whether a text is
   on its way (or went out in the last few hours) -- the greeting only
   promises one when that is true. */
export function composeGreeting(line, languages, { texted }) {
  return languages.map((language) => ({
    text: phrase(language, texted ? "greeting_texted" : "greeting_plain", { business: line.display_name }),
    locale: speechLocale(language),
  }));
}

/* What the owner reads when a customer writes back, in the owner's language. */
export function composeOwnerAlert(line, { leadPhone, text, mediaCount = 0 }) {
  const language = line.alert_language;
  let snippet = String(text ?? "").replace(/\s+/g, " ").trim();
  if (snippet.length > SNIPPET_MAX) snippet = `${snippet.slice(0, SNIPPET_MAX - 1).trimEnd()}…`;
  if (!snippet && mediaCount > 0) snippet = defaultPhrase(language, "media_placeholder");
  return phrase(language, "owner_alert", {
    business: line.display_name, lead: displayPhone(leadPhone), snippet,
  });
}

export function composeOptOutConfirm(line, language) {
  return phrase(language, "optout_confirm", { business: line.display_name });
}

export function composeTest(line) {
  return phrase(line.alert_language, "test", { business: line.display_name, line: displayPhone(line.number) });
}
