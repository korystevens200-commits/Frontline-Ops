/* How many SMS segments a message costs.

   A text is billed per segment. Plain GSM-7 text fits 160 characters in one
   segment and 153 per segment once split. A single character outside GSM-7 --
   and á, í, ó, ú are outside it, though é and ñ are not -- switches the whole
   message to UCS-2: 70 in one, 67 per segment after that. Spanish text almost
   always lands there, which is why the bilingual first text is kept short. */

const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);
/* Escape-table characters: allowed in GSM-7, but each costs two. */
const GSM_EXTENDED = new Set("^{}\\[~]|€\f");

export function countSegments(text) {
  const value = String(text ?? "");
  let gsmLength = 0;
  let gsm = true;
  for (const char of value) {
    if (GSM_BASIC.has(char)) gsmLength += 1;
    else if (GSM_EXTENDED.has(char)) gsmLength += 2;
    else { gsm = false; break; }
  }
  if (gsm) {
    return { encoding: "GSM-7", length: gsmLength, segments: gsmLength <= 160 ? 1 : Math.ceil(gsmLength / 153) };
  }
  /* UCS-2 counts UTF-16 code units: an emoji is two. */
  const units = value.length;
  return { encoding: "UCS-2", length: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}
