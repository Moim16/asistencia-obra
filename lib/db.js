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

  // ------------------------------------------------------------------- obras
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sites (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL,
      address   TEXT,
      active    INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    )`);

  // -------------------------------------------------------------- albañiles
  // Pertenecen a una obra. Si uno se traslada, se le cambia siteId: el historial
  // de asistencia no se ve afectado porque cada marca guarda su propio siteId.
  // `dailyRate` queda listo para cuando se agregue el calculo de pago (hoy sin uso).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS workers (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      siteId    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      fullName  TEXT NOT NULL,
      docId     TEXT,                              -- RUT / DNI / cedula
      trade     TEXT,                              -- oficio: maestro, albañil, ayudante...
      phone     TEXT,
      dailyRate REAL,                              -- jornal (reservado, aun no se usa)
      active    INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_workers_site ON workers (siteId, active)`);

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
}

export const nowIso = () => new Date().toISOString();

// Valor en dias de cada estado (lo usa el reporte).
export const DAY_VALUE = { P: 1, M: 0.5, A: 0 };
export const STATUSES = ["P", "M", "A"];
