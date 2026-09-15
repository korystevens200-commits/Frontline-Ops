/* Frontline Ops command center -- server entry point. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";

import "./env-bootstrap.js";
import { migrate, getPool, closePool } from "./db.js";
import { requireAuth, readSession } from "./auth.js";
import authRoutes from "./routes/auth.js";
import todayRoutes from "./routes/today.js";
import pipelineRoutes from "./routes/pipeline.js";
import companyRoutes from "./routes/company.js";
import numbersRoutes from "./routes/numbers.js";
import activityRoutes from "./routes/activity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");

/* Routes reachable without a session. Everything else is behind requireAuth. */
const PUBLIC_PATHS = new Set(["/login", "/logout", "/healthz", "/static/app.css"]);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[boot] ${name} is not set. See app/.env.example.`);
    process.exit(1);
  }
  return value;
}

export async function build() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      /* Never log a request body -- they carry call notes and the password. */
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
      },
    },
    /* Fly terminates TLS upstream; without this every request looks like
       plain http and secure cookies would never be set. */
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await app.register(cookie, { secret: requiredEnv("SESSION_SECRET") });
  await app.register(formbody);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    /* The app ships no client-side JavaScript at all, so the policy can say
       exactly that rather than carving out exceptions. */
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; img-src 'self' data:; " +
      "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    if (process.env.NODE_ENV === "production") {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  /* One stylesheet, read once at boot. Not worth a static-file plugin. */
  const css = await readFile(join(PUBLIC_DIR, "app.css"), "utf8");
  app.get("/static/app.css", async (request, reply) => {
    reply.type("text/css; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=300");
    return css;
  });

  app.get("/healthz", async (request, reply) => {
    try {
      await getPool().query("SELECT 1");
      return { ok: true };
    } catch (err) {
      request.log.error({ err }, "health check failed");
      reply.code(503);
      return { ok: false, error: "database unreachable" };
    }
  });

  app.addHook("preHandler", (request, reply, done) => {
    if (PUBLIC_PATHS.has(request.routeOptions?.url ?? request.url.split("?")[0])) {
      done();
      return;
    }
    requireAuth(request, reply, done);
  });

  await app.register(authRoutes);
  await app.register(todayRoutes);
  await app.register(pipelineRoutes);
  await app.register(companyRoutes);
  await app.register(numbersRoutes);
  await app.register(activityRoutes);

  app.get("/", async (request, reply) => reply.redirect("/today", 303));

  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404).type("text/html; charset=utf-8");
    return notFoundPage(readSession(request));
  });

  /* A failed save has to be visible. Anything unhandled says so in plain
     language rather than rendering a blank screen. */
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error, url: request.url }, "unhandled error");
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(status).type("text/html; charset=utf-8");
    return errorPage(error.message, status, readSession(request));
  });

  return app;
}

function shell(title, message, operator) {
  const home = operator ? "/today" : "/login";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · Frontline Ops</title><link rel="stylesheet" href="/static/app.css"></head>
<body><main class="wrap" style="padding-top:48px;max-width:460px">
<h1 class="grad-text">${title}</h1>
<div class="card"><p class="small">${message}</p></div>
<a class="btn btn-secondary" href="${home}">Back</a>
</main></body></html>`;
}

function notFoundPage(operator) {
  return shell("Not found", "That page does not exist.", operator);
}

function errorPage(message, status, operator) {
  const safe = String(message ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const detail = status >= 500
    ? `Something failed on the server and your change was not saved. ${safe}`
    : safe;
  return shell(status >= 500 ? "Something broke" : "Can't do that", detail, operator);
}

/* Started directly (not imported by a test). */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  requiredEnv("DATABASE_URL");
  requiredEnv("SESSION_SECRET");
  if (!process.env.APP_PASSWORD_HASH) {
    console.error("[boot] APP_PASSWORD_HASH is not set. Run: npm run hash-password -- 'your password'");
    process.exit(1);
  }

  const app = await build();
  try {
    /* Migrating at boot keeps a fresh machine correct even if the release
       command was skipped. It is idempotent and lock-guarded. */
    await migrate({ log: (m) => app.log.info(m) });
    const port = Number(process.env.PORT || 8080);
    await app.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    await closePool().catch(() => {});
    process.exit(1);
  }

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
      app.log.info(`${signal} received, shutting down`);
      await app.close();
      await closePool().catch(() => {});
      process.exit(0);
    });
  }
}
