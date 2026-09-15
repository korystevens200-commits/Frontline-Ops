/* A small RFC-4180 CSV reader.

   Deliberately hand-rolled rather than pulling a dependency: the format we
   accept is one known header row and quoted fields, and a parser you can read
   in one screen is easier to trust with the only list you have. */

export function parseCsv(text) {
  /* Strip a UTF-8 BOM -- Excel writes one and it would otherwise become part
     of the first header name. */
  const input = text.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += char; i += 1; continue;
    }

    if (char === '"') { inQuotes = true; i += 1; continue; }
    if (char === ",") { row.push(field); field = ""; i += 1; continue; }
    if (char === "\r") { i += 1; continue; }
    if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 1; continue; }
    field += char; i += 1;
  }
  /* Trailing field/row when the file does not end in a newline. */
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/* Rows as objects keyed by the header, with headers normalised so
   "Company Name", "company_name" and "COMPANY NAME" all land on the same key. */
export function parseCsvRecords(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const records = rows.slice(1).map((cells, index) => {
    const record = { __line: index + 2 };
    headers.forEach((header, i) => { record[header] = (cells[i] ?? "").trim(); });
    return record;
  });
  return { headers, records };
}
