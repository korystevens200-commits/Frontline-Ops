/* Cross-site request forgery protection for an app with no JavaScript.

   Phase 1 leaned on the session cookie being SameSite=Lax, which modern
   browsers do not send on a cross-site POST. Phase 2 adds actions that spend
   money and text real customers, so that is no longer enough on its own. Two
   independent checks now sit in front of every state-changing request:

   1. Origin. A browser says where a POST came from. Anything that names
      another site is refused before it reaches a handler.
   2. A synchronizer token. Every POST form carries a hidden field derived
      from the session, which a page on another origin cannot read.

   The token is an HMAC of the session's user and issue time under
   SESSION_SECRET: stateless, stable for the life of a session (so the back
   button and an old tab keep working), and dead the moment the session is.

   Forms get the field automatically. A hook rewrites every rendered
   <form method="POST"> on the way out, so a form added later cannot forget
   it. That is safe to do on rendered HTML because every value interpolated
   into a template is escaped: user text can never contain a literal "<form". */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CSRF_FIELD = "_csrf";

export function csrfToken(session) {
  const secret = process.env.SESSION_SECRET || "";
  return createHmac("sha256", secret)
    .update(`csrf\u0000${session.user}\u0000${session.iat}`)
    .digest("base64url");
}

export function verifyCsrfToken(session, given) {
  if (!session || typeof given !== "string" || !given) return false;
  const expected = Buffer.from(csrfToken(session));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const POST_FORM = /<form\b[^>]*\bmethod="POST"[^>]*>/gi;

export function injectCsrfField(markup, token) {
  return markup.replace(POST_FORM, (tag) =>
    `${tag}<input type="hidden" name="${CSRF_FIELD}" value="${token}">`);
}

/* Browsers send Origin on every POST; Sec-Fetch-Site on every request. A
   request carrying neither is not from a browser form, and is left to the
   token check. */
export function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (origin) {
    if (origin === "null") return false;
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  }
  const site = request.headers["sec-fetch-site"];
  return !site || site === "same-origin" || site === "none";
}
