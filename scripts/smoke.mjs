// =============================================================================
//  Prueba de humo de la API. Llama a los handlers serverless con req/res falsos,
//  sin levantar servidor. Sirve igual contra el SQLite local que contra Turso.
//
//    node scripts/smoke.mjs            -> corre y BORRA los datos de prueba
//    node scripts/smoke.mjs --keep     -> corre y deja los datos (para mirar la app)
//
//  Contra Turso: exporta TURSO_DATABASE_URL y TURSO_AUTH_TOKEN antes de correrlo.
//  Requiere una base VACIA (la primera prueba es el arranque del primer admin).
// =============================================================================

import auth from "../api/auth.js";
import sites from "../api/sites.js";
import workers from "../api/workers.js";
import attendance from "../api/attendance.js";
import report from "../api/report.js";
import { db } from "../lib/db.js";

let fails = 0;
function call(h, { method = "GET", query = {}, body, token } = {}) {
  return new Promise((resolve) => {
    const req = { method, query, body, headers: token ? { "x-session-token": token } : {} };
    const res = {
      _s: 200,
      status(c) { this._s = c; return this; },
      json(d) { resolve({ status: this._s, body: d }); return this; },
      setHeader() { return this; },
    };
    h(req, res).catch((e) => resolve({ status: 500, body: { error: String(e) } }));
  });
}
function check(name, cond, extra = "") {
  console.log(`${cond ? "  ok " : "FAIL "} ${name}${cond ? "" : "  <- " + extra}`);
  if (!cond) fails++;
}

const day = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// --- 1. bootstrap admin -----------------------------------------------------
let r = await call(auth, { method: "POST", body: { name: "jefe", password: "obra1234" } });
check("bootstrap crea admin", r.status === 201 && r.body.user.role === "admin", JSON.stringify(r.body));
const admin = r.body.token;
const adminId = r.body.user.id;

r = await call(auth, { method: "POST", body: { name: "jefe", password: "malamala" } });
check("contraseña incorrecta -> 401", r.status === 401, JSON.stringify(r.body));

r = await call(auth, { method: "POST", body: { name: "jefe", password: "obra1234" } });
check("login correcto", r.status === 200 && !!r.body.token, JSON.stringify(r.body));
const adminTok = r.body.token;

check("token viejo invalidado por login nuevo",
  (await call(auth, { token: admin })).status === 401);

// --- 2. capataz -------------------------------------------------------------
r = await call(auth, { method: "POST", query: { new: "1" }, token: adminTok,
  body: { name: "capataz1", password: "capataz1", fullName: "Luis Pérez", role: "foreman" } });
check("admin crea capataz", r.status === 201 && r.body.user.role === "foreman", JSON.stringify(r.body));

r = await call(auth, { method: "POST", body: { name: "capataz1", password: "capataz1" } });
const foremanTok = r.body.token;
check("capataz entra", r.status === 200 && !!foremanTok);

// --- 3. obras ---------------------------------------------------------------
r = await call(sites, { method: "POST", token: foremanTok, body: { name: "Hack" } });
check("capataz NO puede crear obra -> 403", r.status === 403, JSON.stringify(r.body));

r = await call(sites, { method: "POST", token: adminTok, body: { name: "Edificio Los Aromos", address: "Av. Central 123" } });
check("admin crea obra", r.status === 201, JSON.stringify(r.body));
const siteA = r.body.site.id;
const siteB = (await call(sites, { method: "POST", token: adminTok, body: { name: "Casa Vitacura" } })).body.site.id;

r = await call(sites, { token: foremanTok });
check("capataz lista obras", r.status === 200 && r.body.sites.length === 2, JSON.stringify(r.body));

r = await call(sites, { token: "" });
check("sin token -> 401", r.status === 401);

// --- 4. personal ------------------------------------------------------------
const names = ["Juan Soto", "Pedro Ramírez", "Ana Muñoz", "Carlos Díaz"];
const wids = [];
for (const n of names) {
  const x = await call(workers, { method: "POST", token: adminTok, body: { siteId: siteA, fullName: n, trade: "Albañil" } });
  wids.push(x.body.worker.id);
}
check("4 trabajadores creados", wids.every(Boolean), JSON.stringify(wids));

const intruso = (await call(workers, { method: "POST", token: adminTok, body: { siteId: siteB, fullName: "Ajeno" } })).body.worker.id;

r = await call(workers, { token: foremanTok, query: { siteId: siteA } });
check("personal de la obra A = 4", r.body.workers.length === 4, JSON.stringify(r.body));

// --- 5. pasar lista ---------------------------------------------------------
const hoy = day(0), ayer = day(-1);
r = await call(attendance, { token: foremanTok, query: { siteId: siteA, day: hoy } });
check("GET lista: 4 sin marcar", r.body.summary.pending === 4, JSON.stringify(r.body.summary));

r = await call(attendance, { method: "POST", token: foremanTok, body: { siteId: siteA, day: hoy, marks: [
  { workerId: wids[0], status: "P" },
  { workerId: wids[1], status: "M", reason: "Permiso" },
  { workerId: wids[2], status: "A", reason: "Falta" },
  { workerId: intruso, status: "P" },                        // ajeno: debe ignorarse
]}});
check("guarda 3 marcas e ignora al ajeno", r.body.saved === 3, JSON.stringify(r.body));

r = await call(attendance, { token: foremanTok, query: { siteId: siteA, day: hoy } });
check("resumen del dia P=1 M=1 A=1 pend=1",
  r.body.summary.P === 1 && r.body.summary.M === 1 && r.body.summary.A === 1 && r.body.summary.pending === 1,
  JSON.stringify(r.body.summary));
check("motivo guardado", r.body.workers.find(w => w.id === wids[1]).reason === "Permiso");
check("markedBy registrado", r.body.workers.find(w => w.id === wids[0]).markedByName === "capataz1");

// corregir la marca (mismo dia, mismo trabajador) -> no duplica
await call(attendance, { method: "POST", token: foremanTok, body: { siteId: siteA, day: hoy,
  marks: [{ workerId: wids[2], status: "P" }] }});
r = await call(attendance, { token: foremanTok, query: { siteId: siteA, day: hoy } });
check("corregir marca no duplica (P=2 A=0)", r.body.summary.P === 2 && r.body.summary.A === 0, JSON.stringify(r.body.summary));
check("motivo se limpia al pasar a Presente", r.body.workers.find(w => w.id === wids[2]).reason === null);

// desmarcar
await call(attendance, { method: "POST", token: foremanTok, body: { siteId: siteA, day: hoy,
  marks: [{ workerId: wids[2], status: "" }] }});
r = await call(attendance, { token: foremanTok, query: { siteId: siteA, day: hoy } });
check("desmarcar deja pendiente", r.body.summary.pending === 2, JSON.stringify(r.body.summary));

// dia anterior, independiente
await call(attendance, { method: "POST", token: foremanTok, body: { siteId: siteA, day: ayer,
  marks: wids.map(id => ({ workerId: id, status: "P" })) }});
r = await call(attendance, { token: foremanTok, query: { siteId: siteA, day: ayer } });
check("ayer: 4 presentes", r.body.summary.P === 4, JSON.stringify(r.body.summary));

// futuro rechazado
r = await call(attendance, { method: "POST", token: foremanTok, body: { siteId: siteA, day: day(5), marks: [{ workerId: wids[0], status: "P" }] }});
check("fecha futura rechazada", r.status === 400, JSON.stringify(r.body));

// fecha invalida
r = await call(attendance, { token: foremanTok, query: { siteId: siteA, day: "2026-02-31" } });
check("fecha inexistente rechazada", r.status === 400, JSON.stringify(r.body));

// --- 6. reporte -------------------------------------------------------------
r = await call(report, { token: foremanTok, query: { siteId: siteA, from: ayer, to: hoy } });
const rep = r.body;
check("reporte 4 filas", rep.rows.length === 4, JSON.stringify(rep.rows?.map(x => x.fullName)));
const juan = rep.rows.find(x => x.fullName === "Juan Soto");
const pedro = rep.rows.find(x => x.fullName === "Pedro Ramírez");
const carlos = rep.rows.find(x => x.fullName === "Carlos Díaz");
check("Juan: 2 dias (P ayer + P hoy)", juan.worked === 2, JSON.stringify(juan));
check("Pedro: 1.5 dias (P ayer + M hoy)", pedro.worked === 1.5, JSON.stringify(pedro));
check("Carlos: 1 dia (P ayer, hoy sin marcar)", carlos.worked === 1, JSON.stringify(carlos));
check("total jornadas = 5.5", rep.totals.worked === 5.5, JSON.stringify(rep.totals));
check("dias del rango = 2", rep.days.length === 2, JSON.stringify(rep.days));

// baja: sigue apareciendo en el reporte del periodo
await call(workers, { method: "DELETE", token: adminTok, query: { id: wids[0] } });
r = await call(attendance, { token: foremanTok, query: { siteId: siteA, day: hoy } });
check("dado de baja sale de la lista del dia", r.body.workers.length === 3, JSON.stringify(r.body.workers.map(w=>w.fullName)));
r = await call(report, { token: foremanTok, query: { siteId: siteA, from: ayer, to: hoy } });
check("dado de baja SIGUE en el reporte del periodo",
  r.body.rows.some(x => x.fullName === "Juan Soto" && x.active === 0), JSON.stringify(r.body.rows.map(x=>[x.fullName,x.active])));

// traslado de obra: el historial queda en la obra original
await call(workers, { method: "PUT", token: adminTok, query: { id: wids[1] }, body: { siteId: siteB } });
r = await call(report, { token: foremanTok, query: { siteId: siteA, from: ayer, to: hoy } });
check("trasladado conserva su historial en la obra A",
  r.body.rows.some(x => x.fullName === "Pedro Ramírez" && x.worked === 1.5), JSON.stringify(r.body.rows.map(x=>[x.fullName,x.worked])));

// La marca del dia que quedo en la obra ANTERIOR no debe verse en la obra nueva:
// si se viera, la lista diaria mostraria un estado que el reporte de esa obra no cuenta.
const rObraB = await call(attendance, { token: foremanTok, query: { siteId: siteB, day: hoy } });
const pedroEnB = rObraB.body.workers.find(x => x.fullName === "Pedro Ramirez" || x.fullName === "Pedro Ramírez");
check("trasladado: su marca de la obra anterior NO aparece en la obra nueva",
  !!pedroEnB && pedroEnB.status === null, JSON.stringify(pedroEnB));

// rango invertido / demasiado largo
check("rango invertido -> 400", (await call(report, { token: foremanTok, query: { siteId: siteA, from: hoy, to: ayer } })).status === 400);
check("rango > 186 dias -> 400", (await call(report, { token: foremanTok, query: { siteId: siteA, from: "2025-01-01", to: "2026-12-31" } })).status === 400);

// --- 7. seguridad admin -----------------------------------------------------
check("capataz no crea usuarios", (await call(auth, { method: "POST", query: { new: "1" }, token: foremanTok, body: { name: "x1", password: "123456" } })).status === 403);
check("capataz no crea personal", (await call(workers, { method: "POST", token: foremanTok, body: { siteId: siteA, fullName: "X" } })).status === 403);
r = await call(auth, { token: foremanTok });
check("capataz no ve la lista de usuarios", r.status === 200 && !r.body.users, JSON.stringify(r.body));
r = await call(auth, { method: "PUT", token: adminTok, query: { id: adminId }, body: { role: "foreman" } });
check("no se puede quedar sin admin", r.status === 400, JSON.stringify(r.body));

// --- limpieza ---------------------------------------------------------------
if (!process.argv.includes("--keep")) {
  for (const t of ["attendance", "workers", "sites", "users"]) await db.execute(`DELETE FROM ${t}`);
  console.log("\nDatos de prueba borrados (usa --keep para conservarlos).");
} else {
  console.log("\nDatos de prueba CONSERVADOS. Entra con  jefe / obra1234  (admin)  o  capataz1 / capataz1.");
}

console.log(fails ? `\n${fails} PRUEBA(S) FALLARON` : "\nTodas las pruebas pasaron");
process.exit(fails ? 1 : 0);
