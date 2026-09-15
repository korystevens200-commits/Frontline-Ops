/* Server-side validation. The browser's `required` attribute is a convenience
   for the person typing; this is the thing that actually decides. Every POST
   body goes through here before it reaches SQL. */

export class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
    this.statusCode = 400;
  }
}

export function requireString(value, field, { max = 500, min = 1 } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min) throw new ValidationError(`${field} is required.`, field);
  if (text.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer.`, field);
  return text;
}

export function optionalString(value, field, { max = 5000 } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer.`, field);
  return text;
}

export function requireEnum(value, field, allowed) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!allowed.includes(text)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(", ")}.`, field);
  }
  return text;
}

export function optionalEnum(value, field, allowed) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  return requireEnum(text, field, allowed);
}

export function requireInt(value, field, { min = 0, max = 2_147_483_647 } = {}) {
  const text = typeof value === "string" ? value.trim() : value;
  if (text === "" || text === null || text === undefined) {
    throw new ValidationError(`${field} is required.`, field);
  }
  const n = Number(text);
  if (!Number.isInteger(n)) throw new ValidationError(`${field} must be a whole number.`, field);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}.`, field);
  return n;
}

export function optionalInt(value, field, opts = {}) {
  const text = typeof value === "string" ? value.trim() : value;
  if (text === "" || text === null || text === undefined) return null;
  return requireInt(text, field, opts);
}

/* Money arrives as dollars from a human and is stored as integer cents.
   Parsing through cents avoids ever holding a float amount. */
export function requireMoneyCents(value, field, { min = 0, max = 100_000_000 } = {}) {
  const text = String(value ?? "").trim().replace(/[$,\s]/g, "");
  if (!text) throw new ValidationError(`${field} is required.`, field);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new ValidationError(`${field} must be an amount like 297 or 297.00.`, field);
  }
  const [dollars, decimals = ""] = text.split(".");
  const cents = Number(dollars) * 100 + Number(decimals.padEnd(2, "0"));
  if (cents < min || cents > max) throw new ValidationError(`${field} is out of range.`, field);
  return cents;
}

/* E.164. The CSV is already in this shape; this catches hand-entry. */
export function requirePhone(value, field = "phone") {
  const text = String(value ?? "").trim().replace(/[\s()\-.]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(text)) {
    throw new ValidationError(`${field} must be in E.164 format, like +13055551234.`, field);
  }
  return text;
}

/* Lenient version for CSV import and contact rows: normalises a US 10-digit
   number rather than rejecting the whole row over formatting. */
export function normalizePhone(value) {
  const text = String(value ?? "").trim().replace(/[\s()\-.]/g, "");
  if (!text) return null;
  if (/^\+[1-9]\d{7,14}$/.test(text)) return text;
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function requireId(value, field = "id") {
  const n = Number(String(value ?? "").trim());
  if (!Number.isInteger(n) || n < 1) throw new ValidationError(`Invalid ${field}.`, field);
  return n;
}

/* Rating is the one place a fraction is meaningful (4.7 stars). */
export function optionalRating(value, field = "google_rating") {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 5) {
    throw new ValidationError(`${field} must be between 0 and 5.`, field);
  }
  return Math.round(n * 10) / 10;
}
