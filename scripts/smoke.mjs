// =============================================================================
//  Prueba de humo de la API. Llama a los handlers serverless con req/res falsos,
//  sin levantar servidor. Sirve igual contra el SQLite local que contra Turso.
//
//    node scripts/smoke.mjs            -> corre y BORRA los datos de prueba
//    node scripts/smoke.mjs --keep     -> corre y deja los datos (para mirar la app)
//
//  Contra Turso: exporta TURSO_DATABASE_URL y TURSO_AUTH_TOKEN antes de correrlo.
//  Requiere una base VACIA (la primera prueba crea la primera cuenta).
// =============================================================================

import auth from "../api/auth.js";
import sites from "../api/sites.js";
import workers from "../api/workers.js";
import attendance from "../api/attendance.js";
import report from "../api/report.js";
import payments from "../api/payments.js";
import { db, ensureSchema } from "../lib/db.js";

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
function section(t) { console.log(`\n--- ${t} ${"-".repeat(Math.max(0, 58 - t.length))}`); }

const day = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

await ensureSchema();
const yaHayUsuarios = Number((await db.execute("SELECT COUNT(*) c FROM users")).rows[0].c);
if (yaHayUsuarios) {
  console.error(`\nLa base ya tiene ${yaHayUsuarios} usuario(s). Estas pruebas necesitan una base VACIA.`);
  console.error("Vaciala primero (o usa otra base) y vuelve a correrlas.\n");
  process.exit(1);
}

/* ========================================================================== */
section("Cuentas");

let r = await call(auth, { method: "POST", query: { signup: "1" },
  body: { company: "Constructora Uno", name: "jefe", password: "obra1234" } });
check("signup crea empresa y su admin", r.status === 201 && r.body.user.role === "admin" && !!r.body.account.id, JSON.stringify(r.body));
const A = { token: r.body.token, userId: r.body.user.id, accountId: r.body.account.id };

r = await call(auth, { method: "POST", query: { signup: "1" },
  body: { company: "Constructora Dos", name: "jefe2", password: "obra1234" } });
check("segunda empresa, cuenta distinta", r.status === 201 && r.body.account.id !== A.accountId, JSON.stringify(r.body));
const B = { token: r.body.token, userId: r.body.user.id, accountId: r.body.account.id };

check("usuario repetido se rechaza",
  (await call(auth, { method: "POST", query: { signup: "1" }, body: { company: "X", name: "jefe", password: "obra1234" } })).status === 409);
check("signup sin empresa se rechaza",
  (await call(auth, { method: "POST", query: { signup: "1" }, body: { name: "otro", password: "obra1234" } })).status === 400);

r = await call(auth, { method: "POST", body: { name: "jefe", password: "obra1234" } });
check("login devuelve la empresa", r.status === 200 && r.body.account?.name === "Constructora Uno", JSON.stringify(r.body));
A.token = r.body.token;
check("contraseña incorrecta -> 401", (await call(auth, { method: "POST", body: { name: "jefe", password: "malamala" } })).status === 401);
check("usuario inexistente -> 401", (await call(auth, { method: "POST", body: { name: "nadie", password: "obra1234" } })).status === 401);

/* ========================================================================== */
section("Obras y aislamiento entre empresas");

const obraA1 = (await call(sites, { method: "POST", token: A.token, body: { name: "Edificio Los Aromos", address: "Av. Central 123" } })).body.site.id;
const obraA2 = (await call(sites, { method: "POST", token: A.token, body: { name: "Casa Vitacura" } })).body.site.id;
const obraB1 = (await call(sites, { method: "POST", token: B.token, body: { name: "Obra de la otra empresa" } })).body.site.id;

r = await call(sites, { token: A.token });
check("la empresa A ve solo SUS 2 obras", r.body.sites.length === 2, JSON.stringify(r.body.sites.map((s) => s.name)));
r = await call(sites, { token: B.token });
check("la empresa B ve solo SU obra", r.body.sites.length === 1 && r.body.sites[0].id === obraB1, JSON.stringify(r.body.sites.map((s) => s.name)));

check("A no puede editar una obra de B", (await call(sites, { method: "PUT", token: A.token, query: { id: obraB1 }, body: { name: "Hackeada" } })).status === 404);
check("A no puede cerrar una obra de B", (await call(sites, { method: "DELETE", token: A.token, query: { id: obraB1 } })).status === 404);
check("A no puede leer el personal de una obra de B", (await call(workers, { token: A.token, query: { siteId: obraB1 } })).status === 404);
check("A no puede pasar lista en una obra de B", (await call(attendance, { token: A.token, query: { siteId: obraB1, day: day(0) } })).status === 404);
check("A no puede sacar el reporte de una obra de B", (await call(report, { token: A.token, query: { siteId: obraB1, from: day(-5), to: day(0) } })).status === 404);
check("A no puede meter personal en una obra de B",
  (await call(workers, { method: "POST", token: A.token, body: { siteId: obraB1, fullName: "Infiltrado" } })).status === 404);

r = await call(auth, { token: A.token });
check("A ve solo los usuarios de su empresa", r.body.users.length === 1 && r.body.users[0].name === "jefe", JSON.stringify(r.body.users?.map((u) => u.name)));
check("A no puede editar al admin de B", (await call(auth, { method: "PUT", token: A.token, query: { id: B.userId }, body: { fullName: "Robado" } })).status === 404);
check("A no puede desactivar al admin de B", (await call(auth, { method: "DELETE", token: A.token, query: { id: B.userId } })).status === 404);

/* ========================================================================== */
section("Capataces: solo las obras asignadas");

r = await call(auth, { method: "POST", query: { new: "1" }, token: A.token,
  body: { name: "capataz1", password: "capataz1", fullName: "Luis Pérez", role: "foreman", siteIds: [obraA1] } });
check("admin crea capataz con una obra asignada", r.status === 201, JSON.stringify(r.body));
const capatazId = r.body.user.id;
const F = { token: (await call(auth, { method: "POST", body: { name: "capataz1", password: "capataz1" } })).body.token };

r = await call(sites, { token: F.token });
check("el capataz ve SOLO la obra que le asignaron", r.body.sites.length === 1 && r.body.sites[0].id === obraA1, JSON.stringify(r.body.sites.map((s) => s.name)));
check("el capataz no entra a la otra obra de su empresa", (await call(attendance, { token: F.token, query: { siteId: obraA2, day: day(0) } })).status === 404);
check("el capataz puede pasar lista en la suya", (await call(attendance, { token: F.token, query: { siteId: obraA1, day: day(0) } })).status === 200);
check("el capataz no crea obras", (await call(sites, { method: "POST", token: F.token, body: { name: "Mia" } })).status === 403);
check("el capataz no crea usuarios", (await call(auth, { method: "POST", query: { new: "1" }, token: F.token, body: { name: "x1", password: "123456" } })).status === 403);
check("el capataz no ve la lista de usuarios", !(await call(auth, { token: F.token })).body.users);

await call(auth, { method: "POST", query: { new: "1" }, token: A.token,
  body: { name: "capataz0", password: "capataz0", role: "foreman" } });
const F0 = { token: (await call(auth, { method: "POST", body: { name: "capataz0", password: "capataz0" } })).body.token };
check("capataz sin obras asignadas no ve ninguna", (await call(sites, { token: F0.token })).body.sites.length === 0);

await call(auth, { method: "PUT", token: A.token, query: { id: capatazId }, body: { siteIds: [obraA1, obraA2] } });
check("reasignar obras al capataz funciona", (await call(sites, { token: F.token })).body.sites.length === 2);
await call(auth, { method: "PUT", token: A.token, query: { id: capatazId }, body: { siteIds: [obraA1] } });
check("quitarle una obra tambien", (await call(sites, { token: F.token })).body.sites.length === 1);

/* ========================================================================== */
section("Personal y jornal con historial");

const juan = (await call(workers, { method: "POST", token: A.token,
  body: { siteId: obraA1, fullName: "Juan Soto", trade: "Albañil", dailyRate: 20000, rateFrom: day(-30) } })).body.worker.id;
const ana = (await call(workers, { method: "POST", token: A.token,
  body: { siteId: obraA1, fullName: "Ana Muñoz", trade: "Ayudante", dailyRate: 15000, rateFrom: day(-30) } })).body.worker.id;
check("trabajadores creados con jornal", !!juan && !!ana);

r = await call(workers, { token: A.token, query: { siteId: obraA1, today: day(0) } });
check("el jornal vigente hoy sale en la lista",
  r.body.workers.find((w) => w.id === juan)?.dailyRate === 20000, JSON.stringify(r.body.workers.map((w) => [w.fullName, w.dailyRate])));

// Historial de Juan: 20.000 desde hace 30 dias (la misma fecha del alta, para
// que no queden dos tarifas pisandose), y despues 25.000 desde hace 3.
await call(workers, { method: "POST", query: { rates: "1" }, token: A.token, body: { workerId: juan, amount: 20000, fromDay: day(-30) } });
r = await call(workers, { method: "POST", query: { rates: "1" }, token: A.token, body: { workerId: juan, amount: 25000, fromDay: day(-3) } });
check("se puede fijar un jornal desde una fecha", r.status === 200, JSON.stringify(r.body));

r = await call(workers, { token: A.token, query: { id: juan, rates: "1" } });
check("el historial guarda las tarifas", r.body.rates.length === 2, JSON.stringify(r.body.rates));

// Repetir la misma fecha corrige, no duplica.
await call(workers, { method: "POST", query: { rates: "1" }, token: A.token, body: { workerId: juan, amount: 26000, fromDay: day(-3) } });
r = await call(workers, { token: A.token, query: { id: juan, rates: "1" } });
check("repetir la fecha corrige la tarifa, no la duplica",
  r.body.rates.length === 2 && r.body.rates.find((x) => x.fromDay === day(-3)).amount === 26000, JSON.stringify(r.body.rates));

// Subida programada hacia adelante.
await call(workers, { method: "POST", query: { rates: "1" }, token: A.token, body: { workerId: ana, amount: 18000, fromDay: day(7) } });
r = await call(workers, { token: A.token, query: { siteId: obraA1, today: day(0) } });
const anaRow = r.body.workers.find((w) => w.id === ana);
check("una subida programada NO cambia el jornal de hoy", anaRow.dailyRate === 15000, JSON.stringify(anaRow));
check("y queda avisada como proximo cambio", anaRow.nextRateFrom === day(7), JSON.stringify(anaRow));

// Caso real que se escapo: se marcan dias y DESPUES se registra cuanto gana la
// persona. Esos dias no pueden quedar en cero solo por ser anteriores a la
// fecha de la tarifa; rige la primera tarifa registrada.
const nuevo = (await call(workers, { method: "POST", token: A.token,
  body: { siteId: obraA2, fullName: "Pedro Tardio", trade: "Peón" } })).body.worker.id;
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA2, day: day(-6), marks: [{ workerId: nuevo, status: "P" }] } });
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA2, day: day(-5), marks: [{ workerId: nuevo, status: "P" }] } });
await call(workers, { method: "POST", query: { rates: "1" }, token: A.token,
  body: { workerId: nuevo, amount: 800, fromDay: day(0) } });    // se carga HOY
r = await call(report, { token: A.token, query: { siteId: obraA2, from: day(-30), to: day(0) } });
const tardio = r.body.rows.find((x) => x.workerId === nuevo);
check("los dias marcados ANTES de cargar el pago igual se pagan",
  tardio.earned === 1600, JSON.stringify({ earned: tardio.earned, esperado: 1600 }));

r = await call(payments, { method: "POST", token: A.token, body: { siteId: obraA2, workerId: nuevo, from: day(-30), to: day(0) } });
check("y al pagarlos suman completo", r.body.amount === 1600, JSON.stringify(r.body));
await call(payments, { method: "DELETE", token: A.token, query: { siteId: obraA2, workerId: nuevo, from: day(-30), to: day(0) } });
await call(workers, { method: "DELETE", token: A.token, query: { id: nuevo } });

check("otra empresa no ve el historial de jornales", (await call(workers, { token: B.token, query: { id: juan, rates: "1" } })).status === 404);
check("el capataz no fija jornales", (await call(workers, { method: "POST", query: { rates: "1" }, token: F.token, body: { workerId: juan, amount: 1, fromDay: day(0) } })).status === 403);

/* ========================================================================== */
section("Asistencia");

r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } });
check("lista del dia: 2 sin marcar", r.body.summary.pending === 2, JSON.stringify(r.body.summary));

r = await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(-10), marks: [
  { workerId: juan, status: "P" }, { workerId: ana, status: "P" }] } });
check("se guarda la lista de un dia pasado", r.body.saved === 2, JSON.stringify(r.body));

await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(-1), marks: [{ workerId: juan, status: "P" }] } });
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0), marks: [
  { workerId: juan, status: "M", reason: "Permiso" }, { workerId: ana, status: "A", reason: "Falta" }] } });

r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } });
check("resumen del dia correcto", r.body.summary.M === 1 && r.body.summary.A === 1, JSON.stringify(r.body.summary));
check("el motivo se guarda", r.body.workers.find((w) => w.id === juan).reason === "Permiso");

await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0), marks: [{ workerId: ana, status: "P" }] } });
r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } });
check("corregir una marca no la duplica", r.body.summary.P === 1 && r.body.summary.A === 0, JSON.stringify(r.body.summary));
check("el motivo se limpia al pasar a Presente", r.body.workers.find((w) => w.id === ana).reason === null);

check("fecha futura rechazada",
  (await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(5), marks: [{ workerId: juan, status: "P" }] } })).status === 400);
check("fecha inexistente rechazada", (await call(attendance, { token: A.token, query: { siteId: obraA1, day: "2026-02-31" } })).status === 400);

/* ========================================================================== */
section("Reporte: dias y plata");

r = await call(report, { token: A.token, query: { siteId: obraA1, from: day(-30), to: day(0) } });
const rowJuan = r.body.rows.find((x) => x.fullName === "Juan Soto");
const rowAna = r.body.rows.find((x) => x.fullName === "Ana Muñoz");
check("Juan: 2,5 dias trabajados", rowJuan.worked === 2.5, JSON.stringify(rowJuan));

// Hace 10 dias regia 20.000; hace 1 dia y hoy rige 26.000. Hoy trabajo medio dia.
const esperadoJuan = 20000 + 26000 + 26000 * 0.5;
check(`Juan gana ${esperadoJuan}: cada dia a la tarifa que regia ESE dia`,
  rowJuan.earned === esperadoJuan, JSON.stringify({ earned: rowJuan.earned, esperado: esperadoJuan }));
check("Ana: 2 dias a 15.000 = 30000", rowAna.earned === 30000, JSON.stringify(rowAna));
check("nada pagado todavia", rowJuan.paid === 0 && rowJuan.pending === esperadoJuan, JSON.stringify(rowJuan));
check("el total de la obra suma bien", r.body.totals.earned === esperadoJuan + 30000, JSON.stringify(r.body.totals));
check("el detalle por dia trae monto y estado de pago",
  rowJuan.marks[day(-10)]?.amount === 20000, JSON.stringify(rowJuan.marks));

/* ========================================================================== */
section("Pagos");

check("el capataz no puede pagar",
  (await call(payments, { method: "POST", token: F.token, body: { siteId: obraA1, workerId: juan, from: day(-30), to: day(-2) } })).status === 403);

r = await call(payments, { method: "POST", token: A.token, body: { siteId: obraA1, workerId: juan, from: day(-30), to: day(-2) } });
check("pagar el rango marca 1 dia", r.body.days === 1, JSON.stringify(r.body));
check("y suma 20.000", r.body.amount === 20000, JSON.stringify(r.body));

r = await call(report, { token: A.token, query: { siteId: obraA1, from: day(-30), to: day(0) } });
let j = r.body.rows.find((x) => x.workerId === juan);
check("el reporte muestra 20.000 pagados", j.paid === 20000, JSON.stringify(j));
check("y el resto queda pendiente", j.pending === esperadoJuan - 20000, JSON.stringify(j));
check("el dia pagado queda marcado como tal", j.marks[day(-10)].paid === 1, JSON.stringify(j.marks[day(-10)]));

// EL PUNTO CLAVE: subirle el jornal despues NO reescribe lo ya pagado.
await call(workers, { method: "POST", query: { rates: "1" }, token: A.token, body: { workerId: juan, amount: 99000, fromDay: day(-30) } });
r = await call(report, { token: A.token, query: { siteId: obraA1, from: day(-30), to: day(0) } });
j = r.body.rows.find((x) => x.workerId === juan);
check("subir el jornal NO cambia lo ya pagado (monto congelado)", j.paid === 20000, JSON.stringify({ paid: j.paid }));
check("el dia ya pagado conserva su monto", j.marks[day(-10)].amount === 20000, JSON.stringify(j.marks[day(-10)]));

r = await call(payments, { method: "POST", token: A.token, body: { siteId: obraA1, workerId: juan, from: day(-30), to: day(-2) } });
check("volver a pagar el mismo rango no paga de nuevo", r.body.days === 0, JSON.stringify(r.body));

r = await call(payments, { method: "POST", token: A.token, body: { siteId: obraA1, workerId: ana, from: day(-30), to: day(0) } });
check("las faltas no se pagan (Ana trabajo 2 de 3 dias)", r.body.days === 2, JSON.stringify(r.body));

r = await call(payments, { method: "DELETE", token: A.token, query: { siteId: obraA1, workerId: juan, from: day(-30), to: day(-2) } });
check("se puede deshacer un pago", r.body.days === 1, JSON.stringify(r.body));
r = await call(report, { token: A.token, query: { siteId: obraA1, from: day(-30), to: day(0) } });
j = r.body.rows.find((x) => x.workerId === juan);
check("al deshacer, el dia vuelve a valer la tarifa vigente (99.000)", j.marks[day(-10)].amount === 99000, JSON.stringify(j.marks[day(-10)]));

check("otra empresa no puede pagar en mi obra",
  (await call(payments, { method: "POST", token: B.token, body: { siteId: obraA1, workerId: juan, from: day(-30), to: day(0) } })).status === 404);

/* ========================================================================== */
section("Bajas y traslados");

await call(workers, { method: "DELETE", token: A.token, query: { id: ana } });
r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } });
check("dado de baja sale de la lista del dia", r.body.workers.length === 1, JSON.stringify(r.body.workers.map((w) => w.fullName)));
r = await call(report, { token: A.token, query: { siteId: obraA1, from: day(-30), to: day(0) } });
check("pero SIGUE en el reporte del periodo", r.body.rows.some((x) => x.workerId === ana && x.active === 0));

await call(workers, { method: "PUT", token: A.token, query: { id: juan }, body: { siteId: obraA2 } });
r = await call(report, { token: A.token, query: { siteId: obraA1, from: day(-30), to: day(0) } });
check("el trasladado conserva su historial en la obra anterior", r.body.rows.some((x) => x.workerId === juan && x.worked === 2.5));
r = await call(attendance, { token: A.token, query: { siteId: obraA2, day: day(0) } });
check("y su marca vieja no aparece en la obra nueva",
  r.body.workers.find((w) => w.id === juan)?.status === null, JSON.stringify(r.body.workers));

check("rango invertido -> 400", (await call(report, { token: A.token, query: { siteId: obraA1, from: day(0), to: day(-5) } })).status === 400);
check("rango > 186 dias -> 400", (await call(report, { token: A.token, query: { siteId: obraA1, from: "2025-01-01", to: "2026-12-31" } })).status === 400);
check("sin token -> 401", (await call(sites, { token: "" })).status === 401);

r = await call(auth, { method: "PUT", token: A.token, query: { id: A.userId }, body: { role: "foreman" } });
check("la empresa no puede quedarse sin admin", r.status === 400, JSON.stringify(r.body));

/* ========================================================================== */
if (!process.argv.includes("--keep")) {
  for (const t of ["attendance", "worker_rates", "workers", "site_users", "sites", "users", "accounts"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  console.log("\nDatos de prueba borrados (usa --keep para conservarlos).");
} else {
  console.log("\nDatos CONSERVADOS. Entra con  jefe / obra1234  (admin de Constructora Uno)");
  console.log("                        o con  capataz1 / capataz1  (ve solo una obra).");
}

console.log(fails ? `\n${fails} PRUEBA(S) FALLARON` : "\nTodas las pruebas pasaron");
process.exit(fails ? 1 : 0);
