/* The one background loop in the app.

   Phase 1 deliberately has no background jobs -- the dial claim expires at
   read time so there is nothing to fail silently. Text-back cannot work that
   way: a text has to go out whether or not anyone is looking at a screen. So
   this loop exists, and it is kept honest:

     - every 5 seconds, and immediately when a webhook queues something, it
       queues due follow-ups and sends due texts
     - every 5 minutes it runs maintenance (stuck sends, retention purges)
     - whether it is keeping up is visible on Today and Numbers
       (outboxHealth), not assumed

   It runs inside the web process. Fly keeps one machine running
   (min_machines_running = 1), so the loop is always somewhere; with more than
   one machine, SKIP LOCKED means they share the work rather than duplicate it. */
import { getProvider } from "../providers/sms.js";
import { dispatchOnce, runMaintenance } from "./outbox.js";
import { enqueueDueFollowups } from "./followups.js";

const INTERVAL_MS = 5_000;
const MAINTENANCE_MS = 5 * 60_000;
const BATCH = 20;
const MAX_BATCHES_PER_TICK = 10;

let timer = null;
let running = false;
let again = false;
let lastMaintenance = 0;
let log = console;

export function startDispatcher({ logger = console, intervalMs = INTERVAL_MS } = {}) {
  if (timer) return;
  log = logger;
  timer = setInterval(tick, intervalMs);
  timer.unref();
  setImmediate(tick);
}

export async function stopDispatcher() {
  if (timer) clearInterval(timer);
  timer = null;
  /* Let a send in flight finish recording its result. */
  for (let i = 0; running && i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/* Called right after a webhook queues a text, so it goes now rather than on
   the next tick. A no-op when the loop is not running (tests, scripts). */
export function kickDispatcher() {
  if (timer) setImmediate(tick);
}

async function tick() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const provider = getProvider();
    if (provider.enabled) {
      await enqueueDueFollowups();
      for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
        const result = await dispatchOnce({ provider, limit: BATCH, log });
        if (result.claimed < BATCH) break;
      }
    }
    if (Date.now() - lastMaintenance > MAINTENANCE_MS) {
      lastMaintenance = Date.now();
      const result = await runMaintenance();
      if (result.stuck) log.warn({ stuck: result.stuck }, "sends interrupted mid-flight marked unknown");
    }
  } catch (err) {
    log.error({ err }, "dispatcher tick failed");
  } finally {
    running = false;
    if (again) {
      again = false;
      setImmediate(tick);
    }
  }
}
