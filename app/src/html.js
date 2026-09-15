/* Escape-by-default HTML templating.

   Every value interpolated into html`` is escaped unless it is itself the
   result of html`` (or an explicit raw()). That makes XSS the exception you
   have to opt into rather than the default you have to remember to prevent --
   which matters because prospect names and call notes are free text. */

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/* A chunk of already-safe markup. */
class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export function raw(value) {
  return new Raw(String(value ?? ""));
}

export function isRaw(value) {
  return value instanceof Raw;
}

function render(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + strings[i + 1];
  }
  return new Raw(out);
}

/* Serialise a plain object into a query string, skipping empty values so
   filter links stay readable. */
export function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
