/* Sign in / sign out.

   The password proves you belong here; the name you pick says who to attribute
   the session's writes to. The name is validated against APP_USERS server-side
   -- a hand-crafted form post cannot invent an operator. */
import { operators, isKnownOperator, verifyPassword, setSession, clearSession } from "../auth.js";
import { loginPage } from "../views/login.js";
import { hit, hits, clientIp } from "../security/ratelimit.js";

/* Failed sign-ins allowed per window: per address, and across everyone as a
   backstop against guessing spread over many addresses. The password is
   scrypt-hashed and 10+ characters, so these are about noise and cost, not
   the only line of defence. Successful sign-ins are not counted. */
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_FAILS_PER_IP = 10;
const LOGIN_FAILS_GLOBAL = 100;

const LOGIN_ERRORS = {
  bad: "Wrong password, or that name is not set up.",
  slow: "Too many sign-in attempts. Wait 15 minutes and try again.",
};

/* Same wall-clock cost whether or not the submitted name was valid, so the
   form cannot be used to enumerate who works here. */
const DUMMY_HASH =
  "scrypt$16384$8$1$00000000000000000000000000000000$" + "0".repeat(128);

function safeNext(value) {
  /* Only same-site paths, and never back to /login. */
  const text = typeof value === "string" ? value : "";
  if (!text.startsWith("/") || text.startsWith("//") || text.startsWith("/login")) return "/today";
  return text;
}

export default async function authRoutes(app) {
  app.get("/login", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    return loginPage({
      operators: operators(),
      next: safeNext(request.query?.next),
      error: LOGIN_ERRORS[request.query?.err] ?? null,
    }).value;
  });

  app.post("/login", async (request, reply) => {
    const body = request.body ?? {};
    const name = typeof body.operator === "string" ? body.operator.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const next = safeNext(body.next);
    const ip = clientIp(request);

    const limited =
      (await hits("login_ip", ip, { windowSeconds: LOGIN_WINDOW_SECONDS })) >= LOGIN_FAILS_PER_IP ||
      (await hits("login_all", "*", { windowSeconds: LOGIN_WINDOW_SECONDS })) >= LOGIN_FAILS_GLOBAL;
    if (limited) {
      request.log.warn({ ip }, "sign-in rate limited");
      reply.redirect(`/login?err=slow&next=${encodeURIComponent(next)}`, 303);
      return;
    }

    const known = isKnownOperator(name);
    const stored = process.env.APP_PASSWORD_HASH || "";
    const ok = await verifyPassword(password, known && stored ? stored : DUMMY_HASH);

    if (!ok || !known) {
      request.log.warn({ name, known }, "failed sign-in");
      await hit("login_ip", ip, { windowSeconds: LOGIN_WINDOW_SECONDS });
      await hit("login_all", "*", { windowSeconds: LOGIN_WINDOW_SECONDS });
      reply.redirect(`/login?err=bad&next=${encodeURIComponent(next)}`, 303);
      return;
    }

    setSession(reply, name);
    request.log.info({ operator: name }, "signed in");
    reply.redirect(next, 303);
  });

  app.post("/logout", async (request, reply) => {
    clearSession(reply);
    reply.redirect("/login", 303);
  });
}
