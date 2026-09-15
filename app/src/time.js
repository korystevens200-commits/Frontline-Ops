/* Timestamps are stored UTC and displayed America/New_York, everywhere.

   The subtle direction is inbound: an <input type="datetime-local"> submits a
   naive wall-clock string with no offset. Interpreting that as UTC would put
   every callback four or five hours off, so it is resolved against the New York
   offset in effect at that instant -- including across a DST boundary. */

export const ZONE = "America/New_York";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

/* Offset in milliseconds that ZONE is behind/ahead of UTC at a given instant. */
function zoneOffsetMs(date) {
  const parts = Object.fromEntries(
    PARTS.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUtc - date.getTime();
}

/* "2026-09-15T14:30" (New York wall clock) -> Date (UTC instant).
   Returns null when the string is absent or malformed. */
export function parseLocalDateTime(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  /* First guess using the offset at the naive instant, then correct once --
     two passes settle every case except the hour that does not exist on the
     spring-forward boundary, which lands on the following hour. */
  let guess = new Date(naive - zoneOffsetMs(new Date(naive)));
  guess = new Date(naive - zoneOffsetMs(guess));
  if (Number.isNaN(guess.getTime())) return null;
  return guess;
}

/* Date -> "2026-09-15T14:30" in New York, for pre-filling datetime-local. */
export function toLocalInputValue(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(
    PARTS.formatToParts(d).filter((x) => x.type !== "literal").map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

const DATE_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
});
const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE, month: "short", day: "numeric", year: "numeric",
});
const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE, hour: "numeric", minute: "2-digit", hour12: true,
});

export function formatDateTime(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? "" : DATE_TIME_FMT.format(d);
}

export function formatDate(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? "" : DATE_FMT.format(d);
}

export function formatTime(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? "" : TIME_FMT.format(d);
}

/* "3d ago", "2h ago" -- for last-contact columns where precision is noise. */
export function relativeTime(date) {
  if (!date) return "never";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(d);
}

/* The UTC instants bounding "today" in New York -- used by every counter on
   the Today screen so a 9pm call still counts toward the right day. */
export function nyDayBounds(now = new Date()) {
  const p = Object.fromEntries(
    PARTS.formatToParts(now).filter((x) => x.type !== "literal").map((x) => [x.type, x.value])
  );
  const start = parseLocalDateTime(`${p.year}-${p.month}-${p.day}T00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}
