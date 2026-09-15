/* Sign in / sign out.

   The password proves you belong here; the name you pick says who to attribute
   the session's writes to. The name is validated against APP_USERS server-side
   -- a hand-crafted form post cannot invent an operator. */
import { operators, isKnownOperator, verifyPassword, setSession, clearSession } from "../auth.js";
import { loginPage } from "../views/login.js";

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
      error: request.query?.err === "bad" ? "Wrong password, or that name is not set up." : null,
    }).value;
  });

  app.post("/login", async (request, reply) => {
    const body = request.body ?? {};
    const name = typeof body.operator === "string" ? body.operator.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const next = safeNext(body.next);

    const known = isKnownOperator(name);
    const stored = process.env.APP_PASSWORD_HASH || "";
    const ok = await verifyPassword(password, known && stored ? stored : DUMMY_HASH);

    if (!ok || !known) {
      request.log.warn({ name, known }, "failed sign-in");
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
