/* Numbers: the whole funnel on one page. Every figure is counted from the
   tables, never cached, so it cannot drift from what actually happened. */
import { query, one } from "../db.js";
import { funnel, dialsPerDay, outcomeBreakdown, missedCallsProfile } from "../stats.js";
import { numbersPage } from "../views/numbers.js";
import { flashFrom } from "../flash.js";
import { getProvider } from "../providers/sms.js";
import { deliveryMetrics, lineCounts } from "../delivery/metrics.js";
import { outboxHealth } from "../delivery/outbox.js";

const DELIVERY_WINDOW_DAYS = 30;

export default async function numbersRoutes(app) {
  app.get("/numbers", async (request, reply) => {
    const now = new Date();
    const from = new Date(now.getTime() - DELIVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const handle = { query, one };
    const [f, series, outcomes, missed, delivery, lines, health] = await Promise.all([
      funnel(), dialsPerDay(30), outcomeBreakdown(), missedCallsProfile(),
      deliveryMetrics(handle, { from, to: now }), lineCounts(handle), outboxHealth({ now }),
    ]);

    reply.type("text/html; charset=utf-8");
    return numbersPage({
      operator: request.operator, f, series, outcomes, missed, flash: flashFrom(request),
      textback: { metrics: delivery, lines, health, provider: getProvider(), days: DELIVERY_WINDOW_DAYS },
    }).value;
  });
}
