// =============================================================================
//  Autenticacion: hash de contraseña (scrypt) + token de sesion verificado en el
//  servidor. El token va en el header `x-session-token` y se exige en TODA lectura
//  y escritura: los datos de personal y asistencia no son publicos.
// =============================================================================

import crypto from "node:crypto";
import { db } from "./db.js";

const KEYLEN = 32;

// Devuelve "salt:hash" (nunca se guarda la contraseña en claro).
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

// Compara una contraseña con el "salt:hash" guardado (timing-safe).
export function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  let calc;
  try { calc = crypto.scryptSync(String(pw), salt, KEYLEN).toString("hex"); } catch { return false; }
  const a = Buffer.from(hash, "hex"), b = Buffer.from(calc, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function tokenFromReq(req, body) {
  return (req.headers?.["x-session-token"] || body?.token || "").toString();
}

// Devuelve el usuario dueño del token, o null. Es la puerta de entrada de todos
// los endpoints: `const me = await currentUser(req, body); if (!me) -> 401`.
export async function currentUser(req, body) {
  const token = tokenFromReq(req, body);
  if (!token || token.length < 16) return null;
  const rs = await db.execute({
    sql: `SELECT id, name, fullName, role, active, accountId FROM users WHERE sessionToken = ? LIMIT 1`,
    args: [token],
  });
  const u = rs.rows[0];
  if (!u || !Number(u.active)) return null;
  return {
    id: Number(u.id), name: u.name, fullName: u.fullName, role: u.role,
    accountId: u.accountId == null ? null : Number(u.accountId),
  };
}

export const isAdmin = (user) => user?.role === "admin";

/* ---------------------------------------------------------------------------
   Visibilidad de obras

   Dos cercos, uno dentro del otro:
     1. CUENTA: nadie ve nada fuera de su empresa. Es el cerco duro.
     2. ASIGNACION: dentro de la cuenta, el admin ve todas sus obras y el
        capataz solo las que tenga en site_users (sin asignaciones no ve ninguna).

   El personal, la asistencia y los pagos cuelgan de la obra, asi que basta con
   comprobar la obra para cubrirlos a los tres.
--------------------------------------------------------------------------- */

// Condicion SQL reutilizable. `alias` es la tabla de obras en la consulta.
// Devuelve { sql, args } para pegar dentro de un WHERE.
export function siteScope(user, alias = "s") {
  if (isAdmin(user)) {
    return { sql: `${alias}.accountId = ?`, args: [user.accountId] };
  }
  return {
    sql: `${alias}.accountId = ? AND EXISTS (
            SELECT 1 FROM site_users su WHERE su.siteId = ${alias}.id AND su.userId = ?)`,
    args: [user.accountId, user.id],
  };
}

// True si el usuario puede ver (y por lo tanto tocar) esa obra.
export async function canSeeSite(user, siteId) {
  if (!user || !siteId || !user.accountId) return false;
  const scope = siteScope(user);
  const rs = await db.execute({
    sql: `SELECT 1 FROM sites s WHERE s.id = ? AND ${scope.sql} LIMIT 1`,
    args: [siteId, ...scope.args],
  });
  return rs.rows.length > 0;
}

// True si el usuario puede ver a ese trabajador (via la obra a la que pertenece).
export async function canSeeWorker(user, workerId) {
  if (!user || !workerId || !user.accountId) return false;
  const scope = siteScope(user);
  const rs = await db.execute({
    sql: `SELECT 1 FROM workers w JOIN sites s ON s.id = w.siteId
           WHERE w.id = ? AND ${scope.sql} LIMIT 1`,
    args: [workerId, ...scope.args],
  });
  return rs.rows.length > 0;
}

// Respuesta 401/403 estandar para no repetir el texto en cada endpoint.
export function deny(res, admin = false) {
  return admin
    ? res.status(403).json({ error: "Solo un administrador puede hacer esto." })
    : res.status(401).json({ error: "Sesión inválida. Vuelve a entrar." });
}

// Se responde 404 y no 403 a proposito: quien no tiene acceso a una obra
// tampoco deberia poder deducir que existe.
export function notYours(res) {
  return res.status(404).json({ error: "No encontrado." });
}
