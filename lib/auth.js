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
    sql: `SELECT id, name, fullName, role, active FROM users WHERE sessionToken = ? LIMIT 1`,
    args: [token],
  });
  const u = rs.rows[0];
  if (!u || !Number(u.active)) return null;
  return { id: Number(u.id), name: u.name, fullName: u.fullName, role: u.role };
}

export const isAdmin = (user) => user?.role === "admin";

// Respuesta 401/403 estandar para no repetir el texto en cada endpoint.
export function deny(res, admin = false) {
  return admin
    ? res.status(403).json({ error: "Solo un administrador puede hacer esto." })
    : res.status(401).json({ error: "Sesión inválida. Vuelve a entrar." });
}
