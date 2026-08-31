// =============================================================================
//  Capa de datos (libSQL / SQLite).
//
//   - LOCAL (vercel dev): archivo dentro del proyecto -> data/asistencia.db
//     (cero cuenta, cero setup; el archivo NO se commitea, ver .gitignore).
//   - PRODUCCION (Vercel): Turso via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
//
//  El esquema se crea solo (CREATE TABLE IF NOT EXISTS) la primera vez que se usa.
// =============================================================================

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import crypto from "node:crypto";

const url = process.env.TURSO_DATABASE_URL || "file:./data/asistencia.db";
const isRemote = !url.startsWith("file:");

// Remoto (Turso): cliente WEB (JS puro sobre HTTP). El cliente con binding nativo
// no se empaqueta bien en Vercel y hace crashear la funcion al cargar el modulo.
const { createClient } = await import(isRemote ? "@libsql/client/web" : "@libsql/client");

if (!isRemote) {
  try { mkdirSync(dirname(url.slice("file:".length)), { recursive: true }); } catch {}
}

export const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

// Inicializacion del esquema: una sola vez por instancia (promesa cacheada).
let schemaReady = null;
export function ensureSchema() {
  if (!schemaReady) schemaReady = initSchema();
  return schemaReady;
}

async function initSchema() {
  // ----------------------------------------------------------------- cuentas
  // Cada empresa es una CUENTA y no ve nada de las demas: sus obras, su personal
  // y sus usuarios. Todo lo demas cuelga de aqui. Quien crea la cuenta queda
  // como su administrador.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )`);
  // Logo de la empresa como data URI (JPEG). Se guarda aqui y no en un servicio
  // aparte: son unos pocos KB, viaja con la cuenta y funciona sin conexion.
  // JPEG a proposito: es el unico formato que se puede incrustar tal cual en un
  // PDF (filtro DCTDecode), sin recomprimir nada.
  try { await db.execute(`ALTER TABLE accounts ADD COLUMN logo TEXT`); } catch { /* ya existe */ }

  // ---------------------------------------------------------------- usuarios
  // Quien USA la app: capataces y administrador. Los albañiles NO tienen cuenta;
  // el capataz les pasa lista. role: 'admin' (gestiona obras y personal) o
  // 'foreman' (solo pasa lista y ve reportes).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,                  -- nombre de usuario para entrar
      fullName     TEXT,
      role         TEXT NOT NULL DEFAULT 'foreman',
      passwordHash TEXT,
      sessionToken TEXT,
      failedLogins INTEGER DEFAULT 0,
      lockedUntil  TEXT,
      active       INTEGER NOT NULL DEFAULT 1,
      createdAt    TEXT NOT NULL
    )`);
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users (name COLLATE NOCASE)`);
  // A que cuenta pertenece. ALTER idempotente para bases que ya existian.
  try { await db.execute(`ALTER TABLE users ADD COLUMN accountId INTEGER`); } catch { /* ya existe */ }
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_users_account ON users (accountId)`);
  // Codigo de recuperacion: la unica forma de volver a entrar si se pierde la
  // contraseña y no hay otro admin que la resetee. Se guarda HASHEADO igual que
  // la contraseña (mismo scrypt), asi que ni mirando la base se puede leer: se
  // enseña una sola vez, cuando se genera.
  try { await db.execute(`ALTER TABLE users ADD COLUMN recoveryHash TEXT`); } catch { /* ya existe */ }
  try { await db.execute(`ALTER TABLE users ADD COLUMN recoveryAt TEXT`); } catch { /* ya existe */ }

  // ------------------------------------------------------------------- obras
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sites (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL,
      address   TEXT,
      active    INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    )`);
  try { await db.execute(`ALTER TABLE sites ADD COLUMN accountId INTEGER`); } catch { /* ya existe */ }
  // Pedir firma al pasar lista se activa POR OBRA: en una cuadrilla de tres
  // personas estorba, y en una obra grande con reclamos es imprescindible.
  // Apagado por defecto: solo lo tiene quien lo enciende a proposito.
  try { await db.execute(`ALTER TABLE sites ADD COLUMN useSignature INTEGER NOT NULL DEFAULT 0`); } catch { /* ya existe */ }
  // Marcar escaneando el carnet del trabajador, tambien por obra y apagado por
  // defecto: hay que imprimir y repartir carnets antes de que sirva de algo.
  try { await db.execute(`ALTER TABLE sites ADD COLUMN useQr INTEGER NOT NULL DEFAULT 0`); } catch { /* ya existe */ }
  // Firma al ENTREGAR la plata (el sabado), que es otra cosa que firmar la
  // asistencia del dia: una prueba la da el trabajador cuando llega, la otra
  // cuando cobra. Tambien por obra y tambien apagada por defecto.
  try { await db.execute(`ALTER TABLE sites ADD COLUMN useSignPay INTEGER NOT NULL DEFAULT 0`); } catch { /* ya existe */ }
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sites_account ON sites (accountId)`);

  // Que obras ve cada capataz. El admin ve TODAS las de su cuenta y no necesita
  // filas aqui; el capataz solo ve las que tenga asignadas (sin filas, no ve
  // ninguna). Los albañiles cuelgan de la obra, asi que heredan el permiso.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS site_users (
      siteId INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (siteId, userId)
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_site_users_user ON site_users (userId)`);

  // -------------------------------------------------------------- albañiles
  // Pertenecen a una obra. Si uno se traslada, se le cambia siteId: el historial
  // de asistencia no se ve afectado porque cada marca guarda su propio siteId.
  // El jornal NO vive aqui: cambia con el tiempo y vive en worker_rates.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS workers (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      siteId    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      fullName  TEXT NOT NULL,
      docId     TEXT,                              -- RUT / DNI / cedula
      trade     TEXT,                              -- oficio: maestro, albañil, ayudante...
      phone     TEXT,
      active    INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_workers_site ON workers (siteId, active)`);
  // Codigo del carnet. 16 caracteres del alfabeto alfanumerico del QR, sin
  // letras que se confundan al leerlas a mano (I, O, 0, 1).
  try { await db.execute(`ALTER TABLE workers ADD COLUMN qrCode TEXT`); } catch { /* ya existe */ }
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_qr ON workers (qrCode)`);

  // ----------------------------------------------------------------- jornal
  // Cuanto gana cada trabajador por DIA COMPLETO, con historial: cada fila rige
  // DESDE `fromDay` (inclusive) hasta que empieza la siguiente. Asi se le puede
  // subir el jornal a alguien a partir de la proxima semana sin tocar lo que ya
  // trabajo: los dias viejos se siguen pagando a la tarifa que regia ese dia.
  //
  //   jornal del dia D = la fila con el mayor fromDay <= D
  //
  // Medio dia paga la mitad (ver DAY_VALUE). Sin ninguna fila, el trabajador no
  // tiene jornal cargado y su monto es 0 hasta que se le ponga uno.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS worker_rates (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      workerId  INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      amount    REAL NOT NULL,                     -- monto por dia completo
      fromDay   TEXT NOT NULL,                     -- YYYY-MM-DD, rige desde aqui
      createdAt TEXT NOT NULL,
      UNIQUE (workerId, fromDay)
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_rates_worker ON worker_rates (workerId, fromDay)`);

  // ------------------------------------------------------------- asistencia
  // Una fila por trabajador y dia. status: 'P' presente (1 dia), 'M' medio dia
  // (0.5) o 'A' ausente (0). `day` es la fecha LOCAL de la obra en YYYY-MM-DD
  // (no UTC) para que "hoy" signifique lo mismo en la obra que en el reporte.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS attendance (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      siteId    INTEGER NOT NULL,
      workerId  INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      day       TEXT NOT NULL,                     -- YYYY-MM-DD
      status    TEXT NOT NULL,                     -- P | M | A
      reason    TEXT,                              -- motivo si A o M (falta, permiso, lluvia...)
      note      TEXT,
      markedBy  INTEGER,                           -- users.id de quien paso lista
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE (workerId, day)
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_att_site_day ON attendance (siteId, day)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_att_worker ON attendance (workerId, day)`);

  // Pago del dia. `paidAt` NULL = todavia no se paga. `paidAmount` guarda el monto
  // CONGELADO al momento de pagar: si despues se corrige el jornal, lo ya pagado
  // no se reescribe (misma idea que congelar un resultado ya puntuado).
  for (const col of ["paidAt TEXT", "paidAmount REAL", "paidBy INTEGER"]) {
    try { await db.execute(`ALTER TABLE attendance ADD COLUMN ${col}`); } catch { /* ya existe */ }
  }
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_att_paid ON attendance (workerId, paidAt)`);

  // ------------------------------------------------------------------ firma
  // Evidencia de que el trabajador estuvo: firma con el dedo en el telefono del
  // capataz, igual que la planilla de papel que ya se firma en obra.
  //
  // Va en su propia tabla y NO como columna de attendance a proposito: la lista
  // del dia se pide todo el tiempo y no tiene por que arrastrar las imagenes.
  // Ahi solo viaja un booleano; la firma se pide aparte cuando se quiere ver.
  //
  // La clave es (workerId, day), la misma de attendance: una firma por dia.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS attendance_signs (
      workerId INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      day      TEXT NOT NULL,
      siteId   INTEGER NOT NULL,
      image    TEXT NOT NULL,                    -- data URI JPEG
      signedAt TEXT NOT NULL,
      signedBy INTEGER,                          -- users.id de quien tomo la firma
      PRIMARY KEY (workerId, day)
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_signs_site_day ON attendance_signs (siteId, day)`);

  // -------------------------------------------------------- firma de recibido
  // La firma del SABADO: el trabajador firma sobre el detalle de su liquidacion
  // como comprobante de que recibio la plata. No sustituye a la firma diaria:
  // aquella prueba que estuvo, esta prueba que cobro.
  //
  // La clave es (workerId, paidAt), la MISMA marca de tiempo con la que se
  // sellan los dias pagados y los abonos descontados. Es lo que permite que
  // deshacer un pago se lleve tambien su firma: si no, quedaria una firma
  // colgando de un pago que ya no existe.
  //
  // El periodo y los montos se guardan CONGELADOS junto a la imagen: una firma
  // vale por lo que decia el papel cuando se firmo, no por lo que digan los
  // numeros de hoy.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS payment_signs (
      workerId INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      paidAt   TEXT NOT NULL,                    -- sello del pago que se firma
      siteId   INTEGER NOT NULL,
      fromDay  TEXT NOT NULL,                    -- periodo liquidado
      toDay    TEXT NOT NULL,
      amount   REAL NOT NULL,                    -- dias liquidados
      advances REAL NOT NULL DEFAULT 0,          -- abonos descontados
      net      REAL NOT NULL,                    -- lo que recibio en mano
      image    TEXT NOT NULL,                    -- data URI JPEG
      signedAt TEXT NOT NULL,
      signedBy INTEGER,                          -- users.id de quien tomo la firma
      PRIMARY KEY (workerId, paidAt)
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_paysigns_periodo ON payment_signs (siteId, workerId, fromDay)`);

  // ----------------------------------------------------------------- abonos
  // Plata entregada por adelantado, antes del dia de pago. Se descuenta de lo
  // que le toca cobrar. Mientras `settledAt` sea NULL el abono esta PENDIENTE
  // de descontar; al liquidar un periodo se marca con la MISMA marca de tiempo
  // que los dias pagados, para poder deshacer las dos cosas juntas y no dejar
  // un abono consumido por un pago que ya no existe.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS advances (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      siteId    INTEGER NOT NULL,
      workerId  INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      day       TEXT NOT NULL,                     -- YYYY-MM-DD del abono
      amount    REAL NOT NULL,
      note      TEXT,
      createdBy INTEGER,
      createdAt TEXT NOT NULL,
      settledAt TEXT,                              -- NULL = todavia no descontado
      settledBy INTEGER
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_adv_worker ON advances (workerId, day)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_adv_site ON advances (siteId, day)`);

  await migrateToAccounts();
  await backfillQrCodes();
}

// Alfabeto sin caracteres que se confundan (nada de I, O, 0, 1) y todos dentro
// del modo alfanumerico del QR, que es el que usa el codificador.
const QR_ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newQrCode() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => QR_ALFABETO[x % QR_ALFABETO.length]).join("");
}

// Codigo de recuperacion de una cuenta: 12 caracteres del mismo alfabeto sin
// letras confundibles, en grupos de cuatro para poder dictarlo por telefono o
// copiarlo de un papel sin equivocarse. 32^12 = 60 bits: no se adivina.
export function newRecoveryCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(b, (x) => QR_ALFABETO[x % QR_ALFABETO.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

// Como se guarda y se compara: sin guiones, en mayusculas. Asi da igual si lo
// escriben con espacios, con guiones o en minusculas.
export const normalizeRecovery = (v) =>
  (v ?? "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");

// A los trabajadores que ya existian se les asigna su codigo. Es idempotente:
// si no hay ninguno sin codigo, no hace nada.
async function backfillQrCodes() {
  const rs = await db.execute(`SELECT id FROM workers WHERE qrCode IS NULL`);
  if (!rs.rows.length) return;
  await db.batch(rs.rows.map((r) => ({
    sql: `UPDATE workers SET qrCode = ? WHERE id = ?`,
    args: [newQrCode(), Number(r.id)],
  })), "write");
}

// Bases anteriores a las cuentas: todo lo que quedo sin cuenta se recoge en una
// sola, para no perder nada. Es idempotente: si no hay huerfanos, no hace nada.
async function migrateToAccounts() {
  const huerfanos = Number((await db.execute(
    `SELECT COUNT(*) c FROM users WHERE accountId IS NULL`)).rows[0].c);
  const sitesHuerfanos = Number((await db.execute(
    `SELECT COUNT(*) c FROM sites WHERE accountId IS NULL`)).rows[0].c);
  if (!huerfanos && !sitesHuerfanos) return;

  const acc = await db.execute({
    sql: `INSERT INTO accounts (name, createdAt) VALUES (?, ?)`,
    args: ["Mi empresa", nowIso()],
  });
  const id = Number(acc.lastInsertRowid);
  await db.execute({ sql: `UPDATE users SET accountId = ? WHERE accountId IS NULL`, args: [id] });
  await db.execute({ sql: `UPDATE sites SET accountId = ? WHERE accountId IS NULL`, args: [id] });
}

// Pago por dia vigente para una fecha: la tarifa con el mayor fromDay <= day.
//
// Si el dia es ANTERIOR a la primera tarifa registrada, rige igual esa primera
// tarifa (el COALESCE). Sin esa regla, registrar hoy cuanto gana alguien dejaria
// en cero todos los dias que ya se le habian marcado, que es justo lo contrario
// de lo que uno espera al cargar su pago. Los cambios PROGRAMADOS hacia adelante
// siguen valiendo solo desde su fecha.
export const RATE_SQL = `
  COALESCE(
    (SELECT r.amount FROM worker_rates r
      WHERE r.workerId = a.workerId AND r.fromDay <= a.day
      ORDER BY r.fromDay DESC LIMIT 1),
    (SELECT r.amount FROM worker_rates r
      WHERE r.workerId = a.workerId
      ORDER BY r.fromDay ASC LIMIT 1))`;

export const nowIso = () => new Date().toISOString();

// Valor en dias de cada estado (lo usa el reporte).
export const DAY_VALUE = { P: 1, M: 0.5, A: 0 };
export const STATUSES = ["P", "M", "A"];
