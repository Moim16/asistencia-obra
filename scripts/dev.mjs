// =============================================================================
//  Servidor de desarrollo. Sirve los archivos estaticos y enruta /api/<x> al
//  handler de api/<x>.js igual que lo hace Vercel, sin necesitar `vercel dev`
//  (que exige login interactivo).
//
//    node --env-file=.env scripts/dev.mjs      -> http://localhost:3000
//    node scripts/dev.mjs                      -> igual, pero contra data/asistencia.db
//
//  Solo para desarrollo: en produccion corre Vercel.
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Las MISMAS cabeceras de seguridad que Vercel aplica en produccion. Se leen de
// vercel.json para que no se desincronicen.
//
// Esto no es un detalle: sin la CSP puesta aqui, en local funcionaba codigo que
// en produccion el navegador bloqueaba. Paso de verdad con una URL blob: en una
// imagen, que la CSP no permite. Si el sitio real tiene reglas, el entorno de
// desarrollo tiene que tenerlas tambien.
const SECURITY_HEADERS = await (async () => {
  try {
    const cfg = JSON.parse(await readFile(join(ROOT, "vercel.json"), "utf8"));
    return cfg.headers?.[0]?.headers ?? [];
  } catch { return []; }
})();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// Cache de handlers ya importados (un import por endpoint).
const handlers = new Map();
async function loadHandler(name) {
  if (!handlers.has(name)) {
    const mod = await import(new URL(`../api/${name}.js`, import.meta.url));
    handlers.set(name, mod.default);
  }
  return handlers.get(name);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);
  for (const h of SECURITY_HEADERS) res.setHeader(h.key, h.value);

  /* ------------------------------------------------------------------- API */
  if (path.startsWith("/api/")) {
    const name = path.slice(5).replace(/\/+$/, "");
    if (!/^[a-z0-9-]+$/.test(name)) return send(res, 404, { error: "No encontrado" });

    // Shims para que el handler vea la misma interfaz que en Vercel.
    req.query = Object.fromEntries(url.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (data) => {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
      return res;
    };
    try {
      const handler = await loadHandler(name);
      if (!handler) return send(res, 404, { error: "No encontrado" });
      await handler(req, res);
    } catch (err) {
      console.error(`[api/${name}]`, err);
      if (!res.headersSent) send(res, 500, { error: String(err) });
    }
    console.log(`${req.method} ${path}${url.search} -> ${res.statusCode}`);
    return;
  }

  /* ---------------------------------------------------------------- static */
  // normalize + prefijo ROOT: evita salir de la carpeta con "..".
  const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) return send(res, 403, { error: "Prohibido" });
  try {
    const buf = await readFile(file);
    res.setHeader("content-type", MIME[extname(file)] || "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.end(buf);
  } catch {
    // SPA: cualquier ruta desconocida devuelve el index.
    try { res.setHeader("content-type", MIME[".html"]); res.end(await readFile(join(ROOT, "index.html"))); }
    catch { send(res, 404, { error: "No encontrado" }); }
  }
}).listen(PORT, () => {
  const remote = !!process.env.TURSO_DATABASE_URL;
  console.log(`\n  Asistencia en Obra  ->  http://localhost:${PORT}`);
  console.log(`  Base de datos: ${remote ? "Turso (remota)" : "data/asistencia.db (local)"}`);
  console.log(`  Cabeceras de seguridad: ${SECURITY_HEADERS.length} (las mismas de produccion)\n`);
});

function send(res, code, data) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}
