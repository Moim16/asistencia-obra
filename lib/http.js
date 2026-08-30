// =============================================================================
//  Utilidades comunes de las funciones serverless.
// =============================================================================

// Lee y parsea el body JSON, tolerando que Vercel ya lo haya parseado (objeto)
// o no (stream sin procesar, como en `vercel dev`).
export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// Texto limpio y acotado; devuelve null si queda vacio (para guardar NULL).
export function clean(v, max = 120) {
  const s = (v ?? "").toString().trim().replace(/\s+/g, " ");
  if (!s) return null;
  return s.slice(0, max);
}

// Valida una fecha YYYY-MM-DD real (rechaza 2026-02-31).
export function parseDay(v) {
  const s = (v ?? "").toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === s ? s : null;
}

// Imagen JPEG en data URI (firmas y logo). Se acepta SOLO jpeg porque es el
// unico formato que se puede incrustar tal cual en un PDF (filtro DCTDecode).
// Devuelve { ok, value } o { ok:false, error } para responder directo.
export function parseDataJpeg(v, maxBytes, nombre = "La imagen") {
  if (v === null || v === "" || v === undefined) return { ok: true, value: null };
  const s = String(v);
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s)) {
    return { ok: false, error: `${nombre} debe ser una imagen JPEG.` };
  }
  if (s.length > maxBytes) return { ok: false, error: `${nombre} es muy pesada.` };
  return { ok: true, value: s };
}

export function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
