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
import advances from "../api/advances.js";
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
section("Codigo de recuperacion");

// Empresa aparte: recuperar cambia la contraseña y el token, y no vale la pena
// arrastrar eso por el resto de las pruebas.
r = await call(auth, { method: "POST", query: { signup: "1" },
  body: { company: "Constructora Tres", name: "jefe3", password: "obra1234" } });
const C = { token: r.body.token, userId: r.body.user.id };
let codigo = r.body.recovery;
check("crear la empresa entrega un codigo de recuperacion",
  /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codigo || ""), JSON.stringify(codigo));

r = await call(auth, { token: C.token });
check("el codigo NO se puede volver a leer, solo saber que existe",
  r.body.recovery?.has === true && !("code" in (r.body.recovery || {})), JSON.stringify(r.body.recovery));

check("un codigo equivocado no abre nada",
  (await call(auth, { method: "POST", query: { recover: "1" },
    body: { name: "jefe3", code: "AAAA-BBBB-CCCC", password: "nueva123" } })).status === 401);
check("un usuario que no existe da el mismo error",
  (await call(auth, { method: "POST", query: { recover: "1" },
    body: { name: "nadie", code: codigo, password: "nueva123" } })).status === 401);
check("recuperar con una contraseña muy corta -> 400",
  (await call(auth, { method: "POST", query: { recover: "1" },
    body: { name: "jefe3", code: codigo, password: "123" } })).status === 400);

// Se escribe en minusculas y con espacios a proposito: asi lo copia cualquiera
// de un papel.
const comoLoEscriben = codigo.toLowerCase().replace(/-/g, " ");
r = await call(auth, { method: "POST", query: { recover: "1" },
  body: { name: "jefe3", code: comoLoEscriben, password: "recuperada1" } });
check("con el codigo bueno se entra y se cambia la contraseña",
  r.status === 200 && !!r.body.token, JSON.stringify(r.body));
check("y se entrega un codigo NUEVO para la proxima vez",
  !!r.body.recovery && r.body.recovery !== codigo, JSON.stringify(r.body.recovery));
const codigo2 = r.body.recovery;
C.token = r.body.token;

r = await call(auth, { method: "POST", body: { name: "jefe3", password: "recuperada1" } });
check("la contraseña nueva entra", r.status === 200, JSON.stringify(r.body));
C.token = r.body.token;                 // entrar renueva el token de sesion
check("la vieja ya no", (await call(auth, { method: "POST", body: { name: "jefe3", password: "obra1234" } })).status === 401);
check("el codigo usado no sirve dos veces",
  (await call(auth, { method: "POST", query: { recover: "1" },
    body: { name: "jefe3", code: codigo, password: "otramas1" } })).status === 401);

// Renovar el codigo desde Ajustes: exige la contraseña actual.
check("sin la contraseña actual no se genera otro codigo",
  (await call(auth, { method: "PUT", query: { recovery: "1" }, token: C.token,
    body: { currentPassword: "loquesea" } })).status === 401);
r = await call(auth, { method: "PUT", query: { recovery: "1" }, token: C.token,
  body: { currentPassword: "recuperada1" } });
check("con ella si", r.status === 200 && !!r.body.recovery && r.body.recovery !== codigo2, JSON.stringify(r.body));
codigo = r.body.recovery;
check("y el anterior deja de valer",
  (await call(auth, { method: "POST", query: { recover: "1" },
    body: { name: "jefe3", code: codigo2, password: "otramas1" } })).status === 401);

// A un capataz lo rescata su admin, asi que no se le crea codigo hasta que lo
// pida el mismo.
await call(auth, { method: "POST", query: { new: "1" }, token: C.token,
  body: { name: "sincodigo", password: "capataz1", role: "foreman" } });
const SC = { token: (await call(auth, { method: "POST", body: { name: "sincodigo", password: "capataz1" } })).body.token };
check("un usuario creado por el admin no trae codigo",
  (await call(auth, { token: SC.token })).body.recovery?.has === false);
r = await call(auth, { method: "PUT", query: { recovery: "1" }, token: SC.token, body: { currentPassword: "capataz1" } });
check("pero puede sacarse el suyo", r.status === 200 && !!r.body.recovery, JSON.stringify(r.body));

/* ========================================================================== */
section("Obras y aislamiento entre empresas");

const obraA1 = (await call(sites, { method: "POST", token: A.token, body: { name: "Edificio Los Aromos", address: "Av. Central 123" } })).body.site.id;
const obraA2 = (await call(sites, { method: "POST", token: A.token, body: { name: "Casa Vitacura" } })).body.site.id;
const obraB1 = (await call(sites, { method: "POST", token: B.token, body: { name: "Obra de la otra empresa" } })).body.site.id;

r = await call(sites, { token: A.token });
check("la empresa A ve solo SUS 2 obras", r.body.sites.length === 2, JSON.stringify(r.body.sites.map((s) => s.name)));
r = await call(sites, { token: B.token });
check("la empresa B ve solo SU obra", r.body.sites.length === 1 && r.body.sites[0].id === obraB1, JSON.stringify(r.body.sites.map((s) => s.name)));

// La firma se enciende por obra: apagada de fabrica, para no imponerla donde
// no se usa.
r = await call(sites, { token: A.token });
check("la firma viene apagada al crear la obra",
  r.body.sites.every((x) => x.useSignature === false), JSON.stringify(r.body.sites.map((x) => [x.name, x.useSignature])));
await call(sites, { method: "PUT", token: A.token, query: { id: obraA1 }, body: { useSignature: true } });
r = await call(sites, { token: A.token });
check("se puede encender en una obra sin tocar las otras",
  r.body.sites.find((x) => x.id === obraA1).useSignature === true &&
  r.body.sites.find((x) => x.id === obraA2).useSignature === false,
  JSON.stringify(r.body.sites.map((x) => [x.name, x.useSignature])));
await call(sites, { method: "PUT", token: A.token, query: { id: obraA1 }, body: { useSignature: false } });
check("y se puede volver a apagar",
  (await call(sites, { token: A.token })).body.sites.find((x) => x.id === obraA1).useSignature === false);

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
section("Nombre y logo de la empresa");

// JPEG minimo valido (1x1). Alcanza para comprobar el guardado y el formato.
const JPEG_1PX = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

r = await call(auth, { method: "PUT", query: { account: "1" }, token: A.token,
  body: { name: "Constructora Uno S.A.", logo: JPEG_1PX } });
check("el admin cambia nombre y logo de su empresa",
  r.status === 200 && r.body.account.name === "Constructora Uno S.A." && r.body.account.logo === JPEG_1PX,
  JSON.stringify({ status: r.status, name: r.body.account?.name, tieneLogo: !!r.body.account?.logo }));

r = await call(auth, { token: A.token });
check("el logo vuelve al pedir la cuenta", r.body.account?.logo === JPEG_1PX);

check("un PNG se rechaza (el PDF solo incrusta JPEG)",
  (await call(auth, { method: "PUT", query: { account: "1" }, token: A.token,
    body: { logo: "data:image/png;base64,iVBORw0KGgo=" } })).status === 400);
check("un logo enorme se rechaza",
  (await call(auth, { method: "PUT", query: { account: "1" }, token: A.token,
    body: { logo: "data:image/jpeg;base64," + "A".repeat(500000) } })).status === 400);
check("nombre vacio se rechaza",
  (await call(auth, { method: "PUT", query: { account: "1" }, token: A.token, body: { name: "  " } })).status === 400);

r = await call(auth, { method: "PUT", query: { account: "1" }, token: A.token, body: { logo: null } });
check("se puede quitar el logo", r.status === 200 && r.body.account.logo === null, JSON.stringify(r.body.account));
await call(auth, { method: "PUT", query: { account: "1" }, token: A.token, body: { logo: JPEG_1PX } });

check("la empresa B no ve el logo de A", (await call(auth, { token: B.token })).body.account?.logo == null);

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
section("Carnet con QR");

r = await call(sites, { token: A.token });
check("el escaneo viene apagado al crear la obra", r.body.sites.every((x) => x.useQr === false));
await call(sites, { method: "PUT", token: A.token, query: { id: obraA1 }, body: { useQr: true } });
check("se puede encender por obra",
  (await call(sites, { token: A.token })).body.sites.find((x) => x.id === obraA1).useQr === true);

r = await call(workers, { token: A.token, query: { siteId: obraA1, qr: "1", today: day(0) } });
const conCodigo = r.body.workers.filter((w) => w.qrCode);
check("cada trabajador nace con su codigo", conCodigo.length === r.body.workers.length,
  JSON.stringify(r.body.workers.map((w) => [w.fullName, w.qrCode])));
check("el codigo es de 16 caracteres del alfabeto del QR",
  conCodigo.every((w) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/.test(w.qrCode)),
  JSON.stringify(conCodigo.map((w) => w.qrCode)));
check("no hay codigos repetidos", new Set(conCodigo.map((w) => w.qrCode)).size === conCodigo.length);

// Sin ?qr=1 el codigo no viaja: no hace falta en la pantalla de personal.
check("sin pedirlo, el codigo no viene en la lista",
  (await call(workers, { token: A.token, query: { siteId: obraA1 } })).body.workers.every((w) => !("qrCode" in w)));

// La lista del dia SI lo trae, para poder escanear sin conexion.
r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } });
check("la lista del dia trae el codigo (para escanear sin señal)",
  r.body.workers.every((w) => typeof w.qrCode === "string" && w.qrCode.length === 16),
  JSON.stringify(r.body.workers.map((w) => [w.fullName, w.qrCode])));

// Carnet perdido: se renueva y el viejo deja de valer.
const codigoViejo = conCodigo[0].qrCode;
r = await call(workers, { method: "POST", query: { qr: "1" }, token: A.token, body: { workerId: conCodigo[0].id } });
check("se puede renovar el carnet", r.status === 200 && r.body.qrCode !== codigoViejo, JSON.stringify(r.body));
r = await call(workers, { token: A.token, query: { siteId: obraA1, qr: "1", today: day(0) } });
check("el codigo viejo ya no aparece",
  !r.body.workers.some((w) => w.qrCode === codigoViejo));

check("el capataz no renueva carnets",
  (await call(workers, { method: "POST", query: { qr: "1" }, token: F.token, body: { workerId: conCodigo[0].id } })).status === 403);
check("otra empresa no renueva mis carnets",
  (await call(workers, { method: "POST", query: { qr: "1" }, token: B.token, body: { workerId: conCodigo[0].id } })).status === 404);

await call(sites, { method: "PUT", token: A.token, query: { id: obraA1 }, body: { useQr: false } });

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
section("Firma del trabajador");

const FIRMA = JPEG_1PX;   // basta cualquier JPEG valido para el ida y vuelta

r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } });
check("sin firmar, `signed` viene en false",
  r.body.workers.every((w) => w.signed === false), JSON.stringify(r.body.workers.map((w) => [w.fullName, w.signed])));
check("el resumen cuenta los que trabajaron y no firmaron",
  r.body.summary.unsigned === 2, JSON.stringify(r.body.summary));

// La firma viaja junto con la marca, no en una llamada aparte.
r = await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0),
  marks: [{ workerId: juan, status: "M", reason: "Permiso", sign: FIRMA }] } });
check("se guarda la firma con la marca", r.body.signed === 1, JSON.stringify(r.body));

r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } });
check("ahora aparece como firmado", r.body.workers.find((w) => w.id === juan).signed === true);
check("y baja el conteo de sin firmar", r.body.summary.unsigned === 1, JSON.stringify(r.body.summary));

r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0), sign: juan } });
check("se puede recuperar la imagen de la firma", r.status === 200 && r.body.image === FIRMA, JSON.stringify({ status: r.status }));
check("la lista del dia NO arrastra las imagenes",
  (await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } }))
    .body.workers.every((w) => !("image" in w)));

// Volver a guardar sin mandar `sign` no debe borrar lo que ya habia.
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0),
  marks: [{ workerId: juan, status: "M", reason: "Licencia" }] } });
r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } });
check("corregir el motivo no borra la firma", r.body.workers.find((w) => w.id === juan).signed === true);

// Marcar falta tiene que borrarla: firmar una ausencia no significa nada.
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0),
  marks: [{ workerId: juan, status: "A", reason: "Falta" }] } });
r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } });
check("marcar falta borra la firma", r.body.workers.find((w) => w.id === juan).signed === false);

// Y desmarcar del todo tambien.
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0),
  marks: [{ workerId: juan, status: "P", sign: FIRMA }] } });
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0),
  marks: [{ workerId: juan, status: "" }] } });
r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0), sign: juan } });
check("desmarcar el dia borra la firma", r.status === 404, JSON.stringify(r.body));

// Se puede quitar a mano mandando cadena vacia.
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0),
  marks: [{ workerId: juan, status: "P", sign: FIRMA }] } });
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0),
  marks: [{ workerId: juan, status: "P", sign: "" }] } });
r = await call(attendance, { token: A.token, query: { siteId: obraA1, day: day(0) } });
check("se puede quitar la firma a mano", r.body.workers.find((w) => w.id === juan).signed === false);

check("un PNG como firma se rechaza",
  (await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0),
    marks: [{ workerId: juan, status: "P", sign: "data:image/png;base64,iVBORw0KGgo=" }] } })).status === 400);
check("una firma enorme se rechaza",
  (await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0),
    marks: [{ workerId: juan, status: "P", sign: "data:image/jpeg;base64," + "A".repeat(300000) }] } })).status === 400);
check("otra empresa no puede leer una firma mia",
  (await call(attendance, { token: B.token, query: { siteId: obraA1, day: day(0), sign: juan } })).status === 404);

// Se deja el dia como lo esperaban las comprobaciones siguientes.
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA1, day: day(0),
  marks: [{ workerId: juan, status: "M", reason: "Permiso" }] } });

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
section("Abonos (adelantos)");

// Trabajador limpio, en la otra obra, para que las cuentas sean faciles de leer.
const abo = (await call(workers, { method: "POST", token: A.token,
  body: { siteId: obraA2, fullName: "Carlos Abono", dailyRate: 500, rateFrom: day(-20) } })).body.worker.id;
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA2, day: day(-4), marks: [{ workerId: abo, status: "P" }] } });
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA2, day: day(-3), marks: [{ workerId: abo, status: "P" }] } });
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA2, day: day(-2), marks: [{ workerId: abo, status: "P" }] } });
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA2, day: day(-1), marks: [{ workerId: abo, status: "M" }] } });
// 3 dias + medio = 3,5 x 500 = 1750

const rango = { siteId: obraA2, from: day(-20), to: day(0) };
r = await call(report, { token: A.token, query: rango });
let c = r.body.rows.find((x) => x.workerId === abo);
check("gana 1750 antes de cualquier abono", c.earned === 1750 && c.pending === 1750, JSON.stringify(c));

r = await call(advances, { method: "POST", token: A.token,
  body: { siteId: obraA2, workerId: abo, day: day(-3), amount: 500, note: "Adelanto" } });
check("se registra un abono", r.status === 201, JSON.stringify(r.body));
await call(advances, { method: "POST", token: A.token,
  body: { siteId: obraA2, workerId: abo, day: day(-1), amount: 250 } });

r = await call(report, { token: A.token, query: rango });
c = r.body.rows.find((x) => x.workerId === abo);
check("los abonos suman 750", c.advances === 750, JSON.stringify(c));
check("y se descuentan: a recibir 1000", c.pending === 1000, JSON.stringify({ earned: c.earned, advances: c.advances, pending: c.pending }));
check("lo ganado NO cambia", c.earned === 1750, JSON.stringify(c));

check("el capataz no registra abonos",
  (await call(advances, { method: "POST", token: F.token, body: { siteId: obraA2, workerId: abo, day: day(0), amount: 100 } })).status === 403);
check("monto cero se rechaza",
  (await call(advances, { method: "POST", token: A.token, body: { siteId: obraA2, workerId: abo, day: day(0), amount: 0 } })).status === 400);
check("otra empresa no registra abonos en mi obra",
  (await call(advances, { method: "POST", token: B.token, body: { siteId: obraA2, workerId: abo, day: day(0), amount: 100 } })).status === 404);
check("otra empresa no ve mis abonos",
  (await call(advances, { token: B.token, query: rango })).status === 404);

// Un abono todavia sin descontar se puede borrar.
r = await call(advances, { token: A.token, query: { ...rango, workerId: abo } });
check("se listan los 2 abonos", r.body.advances.length === 2, JSON.stringify(r.body.advances));
const abonoId = r.body.advances.find((a) => a.amount === 250).id;
check("se puede quitar un abono pendiente",
  (await call(advances, { method: "DELETE", token: A.token, query: { id: abonoId } })).status === 200);
r = await call(report, { token: A.token, query: rango });
c = r.body.rows.find((x) => x.workerId === abo);
check("al quitarlo, vuelve a deber 1250", c.pending === 1250 && c.advances === 500, JSON.stringify(c));

// Liquidacion: se pagan los dias y se descuentan los abonos en una sola pasada.
r = await call(payments, { method: "POST", token: A.token, body: { siteId: obraA2, workerId: abo, from: day(-20), to: day(0) } });
check("al pagar, los dias suman 1750", r.body.amount === 1750, JSON.stringify(r.body));
check("se descuentan 500 de abonos", r.body.advances === 500, JSON.stringify(r.body));
check("se entregan en mano 1250", r.body.net === 1250, JSON.stringify(r.body));

r = await call(report, { token: A.token, query: rango });
c = r.body.rows.find((x) => x.workerId === abo);
check("despues de pagar queda en cero", c.pending === 0 && c.advances === 0, JSON.stringify(c));

r = await call(advances, { token: A.token, query: { ...rango, workerId: abo } });
check("el abono queda marcado como descontado", r.body.advances[0].settled === true, JSON.stringify(r.body.advances));
check("un abono ya descontado NO se puede borrar",
  (await call(advances, { method: "DELETE", token: A.token, query: { id: r.body.advances[0].id } })).status === 400);

// Deshacer el pago tiene que devolver TAMBIEN el abono a pendiente.
r = await call(payments, { method: "DELETE", token: A.token, query: { siteId: obraA2, workerId: abo, from: day(-20), to: day(0) } });
check("deshacer el pago devuelve el abono a pendiente", r.body.advances === 1, JSON.stringify(r.body));
r = await call(report, { token: A.token, query: rango });
c = r.body.rows.find((x) => x.workerId === abo);
check("y las cuentas vuelven a como estaban", c.earned === 1750 && c.advances === 500 && c.pending === 1250, JSON.stringify(c));

// Adelantarle mas de lo que trabajo deja saldo a favor de la empresa.
await call(advances, { method: "POST", token: A.token,
  body: { siteId: obraA2, workerId: abo, day: day(0), amount: 2000 } });
r = await call(report, { token: A.token, query: rango });
c = r.body.rows.find((x) => x.workerId === abo);
check("si se le adelanta de mas, el saldo queda negativo", c.pending === -750, JSON.stringify({ earned: c.earned, advances: c.advances, pending: c.pending }));

// Se limpia para no ensuciar las comprobaciones que vienen despues.
await call(payments, { method: "POST", token: A.token, body: { siteId: obraA2, workerId: abo, from: day(-20), to: day(0) } });
await call(workers, { method: "DELETE", token: A.token, query: { id: abo } });

/* ========================================================================== */
section("Firma al recibir el pago");

r = await call(sites, { token: A.token });
check("la firma de recibido viene apagada al crear la obra",
  r.body.sites.every((x) => x.useSignPay === false), JSON.stringify(r.body.sites.map((x) => [x.name, x.useSignPay])));
await call(sites, { method: "PUT", token: A.token, query: { id: obraA2 }, body: { useSignPay: true } });
check("se enciende por obra, como la firma diaria",
  (await call(sites, { token: A.token })).body.sites.find((x) => x.id === obraA2).useSignPay === true);

// Trabajador limpio: 1 dia completo + medio dia a 400 = 600, con 100 de abono.
const rec = (await call(workers, { method: "POST", token: A.token,
  body: { siteId: obraA2, fullName: "Pedro Recibo", dailyRate: 400, rateFrom: day(-10) } })).body.worker.id;
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA2, day: day(-3), marks: [{ workerId: rec, status: "P" }] } });
await call(attendance, { method: "POST", token: A.token, body: { siteId: obraA2, day: day(-2), marks: [{ workerId: rec, status: "M" }] } });
await call(advances, { method: "POST", token: A.token, body: { siteId: obraA2, workerId: rec, amount: 100, day: day(-2) } });

r = await call(payments, { token: A.token, query: { siteId: obraA2, workerId: rec, from: day(-10), to: day(0) } });
check("sin pagar todavia no hay comprobante", r.status === 200 && r.body.receipts.length === 0, JSON.stringify(r.body));

// Una firma invalida NO puede dejar los dias pagados: se rechaza antes de tocar
// nada.
check("un PNG como firma de recibido se rechaza",
  (await call(payments, { method: "POST", token: A.token, body: { siteId: obraA2, workerId: rec,
    from: day(-10), to: day(0), sign: "data:image/png;base64,iVBORw0KGgo=" } })).status === 400);
r = await call(report, { token: A.token, query: { siteId: obraA2, from: day(-10), to: day(0) } });
check("y el pago no se llego a hacer", r.body.rows.find((x) => x.workerId === rec).paid === 0,
  JSON.stringify(r.body.rows.find((x) => x.workerId === rec)));

r = await call(payments, { method: "POST", token: A.token,
  body: { siteId: obraA2, workerId: rec, from: day(-10), to: day(0), sign: JPEG_1PX } });
check("pagar con firma responde que quedo firmado", r.body.signed === true, JSON.stringify(r.body));
check("y en mano recibe 600 menos 100 de abono", r.body.net === 500, JSON.stringify(r.body));

r = await call(payments, { token: A.token, query: { siteId: obraA2, workerId: rec, from: day(-10), to: day(0) } });
const comp = r.body.receipts[0];
check("el comprobante guarda el periodo y los montos congelados",
  r.body.receipts.length === 1 && comp.amount === 600 && comp.advances === 100 && comp.net === 500, JSON.stringify(comp));
check("y la imagen de la firma", comp.image === JPEG_1PX);

await call(auth, { method: "PUT", token: A.token, query: { id: capatazId }, body: { siteIds: [obraA1, obraA2] } });
check("el capataz puede ver el comprobante (el PDF lo saca el tambien)",
  (await call(payments, { token: F.token, query: { siteId: obraA2, workerId: rec, from: day(-10), to: day(0) } })).status === 200);
check("pero sigue sin poder pagar",
  (await call(payments, { method: "POST", token: F.token, body: { siteId: obraA2, workerId: rec, from: day(-10), to: day(0) } })).status === 403);
await call(auth, { method: "PUT", token: A.token, query: { id: capatazId }, body: { siteIds: [obraA1] } });

check("otra empresa no puede leer mis comprobantes",
  (await call(payments, { token: B.token, query: { siteId: obraA2, workerId: rec, from: day(-10), to: day(0) } })).status === 404);

// Deshacer el pago tiene que llevarse la firma: un comprobante de algo que ya no
// existe solo confunde.
r = await call(payments, { method: "DELETE", token: A.token, query: { siteId: obraA2, workerId: rec, from: day(-10), to: day(0) } });
check("deshacer el pago borra tambien su firma", r.body.signs === 1, JSON.stringify(r.body));
check("y el comprobante ya no aparece",
  (await call(payments, { token: A.token, query: { siteId: obraA2, workerId: rec, from: day(-10), to: day(0) } })).body.receipts.length === 0);
check("el abono vuelve a estar pendiente", r.body.advances === 1, JSON.stringify(r.body));

// La firma es opcional incluso donde la obra la pide: si el trabajador no esta
// delante, se paga igual y queda constancia de que ese pago no se firmo.
r = await call(payments, { method: "POST", token: A.token, body: { siteId: obraA2, workerId: rec, from: day(-10), to: day(0) } });
check("se puede pagar sin firma", r.body.signed === false && r.body.net === 500, JSON.stringify(r.body));
check("y ese pago queda sin comprobante firmado",
  (await call(payments, { token: A.token, query: { siteId: obraA2, workerId: rec, from: day(-10), to: day(0) } })).body.receipts.length === 0);

await call(workers, { method: "DELETE", token: A.token, query: { id: rec } });

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
  for (const t of ["advances", "attendance_signs", "payment_signs", "attendance", "worker_rates", "workers", "site_users", "sites", "users", "accounts"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  console.log("\nDatos de prueba borrados (usa --keep para conservarlos).");
} else {
  console.log("\nDatos CONSERVADOS. Entra con  jefe / obra1234  (admin de Constructora Uno)");
  console.log("                        o con  capataz1 / capataz1  (ve solo una obra).");
}

console.log(fails ? `\n${fails} PRUEBA(S) FALLARON` : "\nTodas las pruebas pasaron");
process.exit(fails ? 1 : 0);
