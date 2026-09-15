/* Numbers: the whole funnel on one page. Every figure is counted from the
   tables, never cached, so it cannot drift from what actually happened. */
import { funnel, dialsPerDay, outcomeBreakdown, missedCallsProfile } from "../stats.js";
import { numbersPage } from "../views/numbers.js";
import { flashFrom } from "../flash.js";

export default async function numbersRoutes(app) {
  app.get("/numbers", async (request, reply) => {
    const [f, series, outcomes, missed] = await Promise.all([
      funnel(), dialsPerDay(30), outcomeBreakdown(), missedCallsProfile(),
    ]);

    reply.type("text/html; charset=utf-8");
    return numbersPage({
      operator: request.operator, f, series, outcomes, missed, flash: flashFrom(request),
    }).value;
  });
}
