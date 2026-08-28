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

  await migrateToAccounts();
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

// Jornal vigente para un dia: la tarifa con el mayor fromDay <= day. Se usa como
// subconsulta correlacionada para no traer todo el historial a memoria.
export const RATE_SQL = `
  (SELECT r.amount FROM worker_rates r
    WHERE r.workerId = a.workerId AND r.fromDay <= a.day
    ORDER BY r.fromDay DESC LIMIT 1)`;

export const nowIso = () => new Date().toISOString();

// Valor en dias de cada estado (lo usa el reporte).
export const DAY_VALUE = { P: 1, M: 0.5, A: 0 };
export const STATUSES = ["P", "M", "A"];
