/* One shared password, then you pick which operator you are.

   Rationale: a single credential is all two people want to remember, but
   calls.called_by and activity_log.actor are worthless if the server cannot
   tell who acted. So the password authenticates, and the name selected at
   login -- validated against APP_USERS, never trusted from the form alone --
   becomes the actor for everything that session writes. */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = "fo_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/* "scrypt$N$r$p$saltHex$hashHex" */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("hex"), derived.toString("hex")].join("$");
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== "string" || typeof password !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  let expected;
  try {
    expected = Buffer.from(hashHex, "hex");
    const derived = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* The operator roster. Names live in an env var rather than the schema so
   adding a third caller is a config change, not a migration. */
export function operators() {
  return (process.env.APP_USERS || "Kory")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function isKnownOperator(name) {
  return operators().includes(name);
}

/* --- session cookie ------------------------------------------------------ */

export function setSession(reply, user) {
  const payload = JSON.stringify({ user, iat: Math.floor(Date.now() / 1000) });
  reply.setCookie(SESSION_COOKIE, Buffer.from(payload, "utf8").toString("base64url"), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    /* Fly terminates TLS in front of the app; trustProxy lets Fastify see the
       original scheme so this is not accidentally false behind the proxy. */
    secure: process.env.NODE_ENV === "production",
    signed: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSession(reply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/* Returns the operator name, or null when there is no valid, unexpired,
   correctly-signed session naming a operator still on the roster. */
export function readSession(request) {
  const cookie = request.cookies?.[SESSION_COOKIE];
  if (!cookie) return null;
  const unsigned = request.unsignCookie(cookie);
  if (!unsigned.valid || !unsigned.value) return null;
  try {
    const data = JSON.parse(Buffer.from(unsigned.value, "base64url").toString("utf8"));
    if (!data || typeof data.user !== "string" || typeof data.iat !== "number") return null;
    if (Math.floor(Date.now() / 1000) - data.iat > SESSION_MAX_AGE_SECONDS) return null;
    /* Removing a name from APP_USERS invalidates their sessions immediately. */
    if (!isKnownOperator(data.user)) return null;
    return data.user;
  } catch {
    return null;
  }
}

/* preHandler guard for every route except /login, /logout and /healthz. */
export function requireAuth(request, reply, done) {
  const user = readSession(request);
  if (!user) {
    const target = request.raw.url || "/";
    const next = target.startsWith("/login") ? "" : `?next=${encodeURIComponent(target)}`;
    reply.redirect(`/login${next}`, 303);
    return;
  }
  request.operator = user;
  done();
}
