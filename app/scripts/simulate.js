/* Drive a local server as Twilio would -- a missed call, a customer's text, a
   delivery receipt -- without Twilio. For development and demos only.

   Start the server with SMS_PROVIDER=fake, then:

     npm run simulate -- call +13055550142 +13055550100
     npm run simulate -- text +13055550142 +13055550100 "Tengo una fuga"
     npm run simulate -- status 12 delivered

   (caller, then the line's number). Requests are signed with the fake
   provider's development token, which a server running real Twilio
   credentials rejects -- this cannot touch a live line. */
import "../src/env-bootstrap.js";
import { webhookSignature } from "../src/providers/common.js";
import { FAKE_AUTH_TOKEN } from "../src/providers/fake.js";

const base = (process.env.SIMULATE_BASE_URL || process.env.PUBLIC_BASE_URL ||
              `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, "");
const [command, ...rest] = process.argv.slice(2);
const sid = (prefix) => `${prefix}sim${Date.now()}${Math.floor(Math.random() * 1e6)}`.padEnd(34, "0").slice(0, 34);

async function post(path, params) {
  const url = `${base}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": webhookSignature(FAKE_AUTH_TOKEN, url, params),
    },
    body: new URLSearchParams(params).toString(),
  });
  console.log(`${response.status} ${path}`);
  const text = await response.text();
  if (text) console.log(text);
}

if (command === "call" && rest.length >= 2) {
  await post("/webhooks/twilio/voice", {
    CallSid: sid("CA"), From: rest[0], To: rest[1], Direction: "inbound", CallStatus: "ringing",
  });
} else if (command === "text" && rest.length >= 3) {
  await post("/webhooks/twilio/sms", {
    MessageSid: sid("SM"), From: rest[0], To: rest[1], Body: rest.slice(2).join(" "), NumMedia: "0",
  });
} else if (command === "status" && rest.length >= 2) {
  await post(`/webhooks/twilio/message-status?m=${encodeURIComponent(rest[0])}`, {
    MessageSid: "", MessageStatus: rest[1], ErrorCode: rest[2] ?? "",
  });
} else {
  console.error("Usage: npm run simulate -- call <from> <line>\n" +
                "       npm run simulate -- text <from> <line> <message...>\n" +
                "       npm run simulate -- status <message id> <delivered|failed|undelivered> [error code]");
  process.exit(1);
}
