// =============================================================================
//  Usuarios de la app (capataces + admin). Los albañiles NO entran aqui.
//
//  POST   /api/auth                  { name, password }  -> login. Devuelve { user, token }.
//                                    Si la base no tiene ningun usuario, el primero
//                                    que entra queda creado como ADMIN (arranque).
//  POST   /api/auth?new=1            { name, password, fullName, role }  -> admin crea capataz.
//  GET    /api/auth                  -> { me, users? }  (users solo si eres admin).
//  PUT    /api/auth?id=              { fullName, role, active, password } -> admin edita.
//                                    Sin ser admin solo puedes cambiar TU contraseña
//                                    mandando { currentPassword, password }.
//  DELETE /api/auth?id=              -> admin desactiva el usuario (no borra historial).
//
//  Anti fuerza bruta: 5 fallos -> cuenta bloqueada 15 minutos.
// =============================================================================

import { db, ensureSchema, nowIso } from "../lib/db.js";
import { readJson, clean, parseId } from "../lib/http.js";
import {
  hashPassword, verifyPassword, newToken,
  currentUser, isAdmin, deny,
} from "../lib/auth.js";

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const NAME_RE = /^[\p{L}\p{N}._-]{2,20}$/u;

const publicUser = (u) => ({
  id: Number(u.id), name: u.name, fullName: u.fullName,
  role: u.role, active: Number(u.active ?? 1),
});

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      if (!isAdmin(me)) return res.status(200).json({ me });
      const rs = await db.execute(
        `SELECT id, name, fullName, role, active, createdAt FROM users ORDER BY name COLLATE NOCASE`
      );
      return res.status(200).json({ me, users: rs.rows.map(publicUser) });
    }

    /* ----------------------------------------------------------- POST ?new=1 */
    if (req.method === "POST" && req.query?.new) {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      if (!isAdmin(me)) return deny(res, true);

      const name = (body.name ?? "").toString().trim();
      const pw = (body.password ?? "").toString();
      const role = body.role === "admin" ? "admin" : "foreman";
      if (!NAME_RE.test(name)) {
        return res.status(400).json({ error: "Usuario de 2 a 20 caracteres, sin espacios (letras, números, . _ -)." });
      }
      if (pw.length < 6 || pw.length > 64) {
        return res.status(400).json({ error: "La contraseña debe tener entre 6 y 64 caracteres." });
      }
      const dup = await db.execute({ sql: `SELECT 1 FROM users WHERE name = ? COLLATE NOCASE`, args: [name] });
      if (dup.rows.length) return res.status(409).json({ error: "Ese usuario ya existe." });

      const ins = await db.execute({
        sql: `INSERT INTO users (name, fullName, role, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)`,
        args: [name, clean(body.fullName), role, hashPassword(pw), nowIso()],
      });
      return res.status(201).json({
        user: { id: Number(ins.lastInsertRowid), name, fullName: clean(body.fullName), role, active: 1 },
      });
    }

    /* ---------------------------------------------------------- POST (login) */
    if (req.method === "POST") {
      const name = (body.name ?? "").toString().trim();
      const pw = (body.password ?? "").toString();
      if (!NAME_RE.test(name) || pw.length < 6) {
        return res.status(400).json({ error: "Usuario o contraseña inválidos." });
      }

      const found = await db.execute({
        sql: `SELECT id, name, fullName, role, active, passwordHash, failedLogins, lockedUntil
                FROM users WHERE name = ? COLLATE NOCASE`,
        args: [name],
      });

      // Arranque: base vacia -> el primero que entra se crea como administrador.
      if (!found.rows.length) {
        const total = Number((await db.execute(`SELECT COUNT(*) c FROM users`)).rows[0].c);
        if (total === 0) {
          if (pw.length > 64) return res.status(400).json({ error: "La contraseña debe tener entre 6 y 64 caracteres." });
          const token = newToken();
          const ins = await db.execute({
            sql: `INSERT INTO users (name, role, passwordHash, sessionToken, createdAt) VALUES (?, 'admin', ?, ?, ?)`,
            args: [name, hashPassword(pw), token, nowIso()],
          });
          return res.status(201).json({
            user: { id: Number(ins.lastInsertRowid), name, fullName: null, role: "admin", active: 1 },
            token, created: true,
          });
        }
        return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
      }

      const u = found.rows[0];
      if (!Number(u.active)) return res.status(403).json({ error: "Tu usuario está desactivado. Habla con el administrador." });
      if (u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) {
        return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos e intenta de nuevo." });
      }
      if (!verifyPassword(pw, u.passwordHash)) {
        const fails = Number(u.failedLogins || 0) + 1;
        const locked = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS).toISOString() : null;
        await db.execute({ sql: `UPDATE users SET failedLogins = ?, lockedUntil = ? WHERE id = ?`, args: [fails, locked, u.id] });
        return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
      }
      const token = newToken();
      await db.execute({
        sql: `UPDATE users SET sessionToken = ?, failedLogins = 0, lockedUntil = NULL WHERE id = ?`,
        args: [token, u.id],
      });
      return res.status(200).json({ user: publicUser(u), token });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      const id = parseId(req.query?.id) ?? me.id;

      // Cambio de contraseña propia (no admin): exige la contraseña actual.
      if (!isAdmin(me)) {
        if (id !== me.id) return deny(res, true);
        const pw = (body.password ?? "").toString();
        if (pw.length < 6 || pw.length > 64) {
          return res.status(400).json({ error: "La contraseña debe tener entre 6 y 64 caracteres." });
        }
        const rs = await db.execute({ sql: `SELECT passwordHash FROM users WHERE id = ?`, args: [id] });
        if (!verifyPassword((body.currentPassword ?? "").toString(), rs.rows[0]?.passwordHash)) {
          return res.status(401).json({ error: "La contraseña actual no coincide." });
        }
        // Cambiar la contraseña cierra las demas sesiones (token nuevo).
        const token = newToken();
        await db.execute({ sql: `UPDATE users SET passwordHash = ?, sessionToken = ? WHERE id = ?`, args: [hashPassword(pw), token, id] });
        return res.status(200).json({ ok: true, token });
      }

      // Admin: edita datos, rol, estado y puede resetear la contraseña.
      const sets = [], args = [];
      if ("fullName" in body) { sets.push("fullName = ?"); args.push(clean(body.fullName)); }
      if ("role" in body) { sets.push("role = ?"); args.push(body.role === "admin" ? "admin" : "foreman"); }
      if ("active" in body) { sets.push("active = ?"); args.push(body.active ? 1 : 0); }
      if (body.password) {
        const pw = String(body.password);
        if (pw.length < 6 || pw.length > 64) return res.status(400).json({ error: "La contraseña debe tener entre 6 y 64 caracteres." });
        // Reset de contraseña -> se invalida la sesion del usuario afectado.
        sets.push("passwordHash = ?", "sessionToken = NULL", "failedLogins = 0", "lockedUntil = NULL");
        args.push(hashPassword(pw));
      }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });

      // No dejar la app sin ningun admin activo.
      if (id === me.id && (body.role === "foreman" || body.active === false || body.active === 0)) {
        const others = Number((await db.execute({
          sql: `SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`, args: [id],
        })).rows[0].c);
        if (!others) return res.status(400).json({ error: "Debe quedar al menos un administrador activo." });
      }

      args.push(id);
      const upd = await db.execute({ sql: `UPDATE users SET ${sets.join(", ")} WHERE id = ?`, args });
      if (!upd.rowsAffected) return res.status(404).json({ error: "Usuario no encontrado." });
      return res.status(200).json({ ok: true });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const me = await currentUser(req, {});
      if (!me) return deny(res);
      if (!isAdmin(me)) return deny(res, true);
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (id === me.id) return res.status(400).json({ error: "No puedes desactivar tu propio usuario." });
      // Desactivar, no borrar: conserva la trazabilidad de quien paso lista.
      const upd = await db.execute({ sql: `UPDATE users SET active = 0, sessionToken = NULL WHERE id = ?`, args: [id] });
      if (!upd.rowsAffected) return res.status(404).json({ error: "Usuario no encontrado." });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
