/* Post/Redirect/Get carries its result in the query string.

   Messages are whitelisted by key rather than echoed from the URL, so a
   crafted link cannot put arbitrary text on the screen. */
const MESSAGES = {
  logged: "Call logged.",
  trial_started: "Trial agreed — 14-day trial opened.",
  company_saved: "Company saved.",
  contact_saved: "Contact saved.",
  contact_deleted: "Contact removed.",
  client_saved: "Client saved.",
  payment_saved: "Payment recorded.",
  trial_saved: "Trial updated.",
  note_saved: "Notes saved.",
  signed_out: "Signed out.",
};

const ERRORS = {
  not_found: "That record no longer exists.",
  claim_lost: "Someone else picked that company up first.",
  save_failed: "Save failed — nothing was written. Try again.",
  bad_outcome: "That outcome is not valid.",
};

export function flashFrom(request) {
  const ok = MESSAGES[request.query?.ok];
  const err = ERRORS[request.query?.err] || request.query?.msg;
  if (err) return { error: String(err).slice(0, 300) };
  if (ok) return { ok };
  return null;
}

/* Validation messages are generated server-side and are safe to pass through,
   but they are length-capped and escaped at render time regardless. */
export function errorRedirect(path, message) {
  return `${path}${path.includes("?") ? "&" : "?"}msg=${encodeURIComponent(String(message).slice(0, 300))}`;
}
