/* Pieces every SMS/voice provider shares. */
import { createHmac, timingSafeEqual } from "node:crypto";

/* A failed provider call, classified by what the caller should do about it:

     retryable  the request provably did not take effect (connection refused,
                HTTP 429/5xx) -- safe to try again
     ambiguous  it may have taken effect (a timeout after the request left) --
                retrying could text a customer twice, so do not
     neither    it was refused outright (bad number, opted out) -- permanent */
export class ProviderError extends Error {
  constructor(message, { code = "", httpStatus = 0, retryable = false, ambiguous = false } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = String(code);
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.ambiguous = ambiguous;
  }
}

/* Twilio's request signature: HMAC-SHA1 over the full URL it called followed
   by every POST parameter, sorted by name, as name+value. Checked against
   Twilio's published example and its official library in the tests. */
export function webhookSignature(authToken, url, params = {}) {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of [...value].sort()) data += key + item;
    } else {
      data += key + (value ?? "");
    }
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function signatureMatches(authToken, url, params, given) {
  if (!authToken || typeof given !== "string" || !given) return false;
  const expected = Buffer.from(webhookSignature(authToken, url, params));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function escapeXml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

/* A US number that can receive a text. Blocked caller ID arrives as junk
   like +266696687 ("ANONYMOUS" on a keypad) or "anonymous"; neither can be
   texted, and the service only texts within the US. */
export function isTextableUsNumber(number) {
  return /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(String(number ?? ""));
}

export function isE164(number) {
  return /^\+[1-9]\d{7,14}$/.test(String(number ?? ""));
}

/* Outbound statuses in the order a message moves through them. Delivery
   receipts can arrive out of order, and one only ever moves a message
   forward: a late "sent" must not overwrite "delivered". */
const STATUS_RANK = {
  queued: 0, sending: 1, unknown: 2, sent: 3,
  delivered: 4, undelivered: 4, failed: 4, cancelled: 5,
};

export function statusAdvances(current, next) {
  return (STATUS_RANK[next] ?? -1) > (STATUS_RANK[current] ?? -1);
}
