// =============================================================================
//  Usuarios de la app (capataces + admin). Los albañiles NO entran aqui.
//
//  POST   /api/auth                  { name, password }  -> login. Devuelve { user, token }.
//  POST   /api/auth?signup=1         { company, name, password } -> crea una CUENTA
//                                    nueva y su administrador. Se puede cerrar con
//                                    la env var ALLOW_SIGNUP=0.
//  POST   /api/auth?new=1            { name, password, fullName, role, siteIds }
//                                    -> el admin crea un usuario DE SU CUENTA.
//  GET    /api/auth                  -> { me, account, users? } (users solo si admin).
//  PUT    /api/auth?account=1        { name, logo } -> el admin cambia el nombre y
//                                    el logo de SU empresa. `logo` es un data URI
//                                    JPEG (null lo borra).
//  PUT    /api/auth?id=              { fullName, role, active, password, siteIds }
//                                    -> admin edita un usuario de su cuenta.
//                                    Sin ser admin solo puedes cambiar TU contraseña
//                                    mandando { currentPassword, password }.
//  DELETE /api/auth?id=              -> admin desactiva el usuario (no borra historial).
//
//  Cada empresa es una CUENTA aislada: un admin nunca ve usuarios, obras ni
//  personal de otra cuenta. Dentro de la cuenta, al capataz se le asignan obras
//  (siteIds); sin asignaciones no ve ninguna.
//
//  Anti fuerza bruta: 5 fallos -> cuenta bloqueada 15 minutos.
// =============================================================================

import { db, ensureSchema, nowIso } from "../lib/db.js";
import { readJson, clean, parseId, parseDataJpeg } from "../lib/http.js";
import {
  hashPassword, verifyPassword, newToken,
  currentUser, isAdmin, deny, notYours,
} from "../lib/auth.js";

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const NAME_RE = /^[\p{L}\p{N}._-]{2,20}$/u;
const SIGNUP_OPEN = process.env.ALLOW_SIGNUP !== "0";   // cerrar con ALLOW_SIGNUP=0
const MAX_LOGO = 400 * 1024;   // el navegador ya lo achica; esto es el tope duro

const publicUser = (u) => ({
  id: Number(u.id), name: u.name, fullName: u.fullName,
  role: u.role, active: Number(u.active ?? 1),
  accountId: u.accountId == null ? null : Number(u.accountId),
});

// Deja a `userId` con EXACTAMENTE las obras indicadas, y solo las de esa cuenta
// (asi un admin no puede asignar la obra de otra empresa aunque mande su id).
async function setUserSites(userId, siteIds, accountId) {
  await db.execute({ sql: `DELETE FROM site_users WHERE userId = ?`, args: [userId] });
  const ids = [...new Set((siteIds || []).map(parseId).filter(Boolean))];
  if (!ids.length) return;
  const rs = await db.execute({
    sql: `SELECT id FROM sites WHERE accountId = ? AND id IN (${ids.map(() => "?").join(",")})`,
    args: [accountId, ...ids],
  });
  if (!rs.rows.length) return;
  await db.batch(rs.rows.map((r) => ({
    sql: `INSERT OR IGNORE INTO site_users (siteId, userId) VALUES (?, ?)`,
    args: [Number(r.id), userId],
  })), "write");
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      const acc = await db.execute({ sql: `SELECT name, logo FROM accounts WHERE id = ?`, args: [me.accountId] });
      const account = { id: me.accountId, name: acc.rows[0]?.name || null, logo: acc.rows[0]?.logo || null };
      if (!isAdmin(me)) return res.status(200).json({ me, account });

      // Solo los usuarios de MI cuenta, cada uno con las obras que tiene asignadas.
      const rs = await db.execute({
        sql: `SELECT id, name, fullName, role, active, accountId, createdAt
                FROM users WHERE accountId = ? ORDER BY name COLLATE NOCASE`,
        args: [me.accountId],
      });
      const asign = await db.execute({
        sql: `SELECT su.userId, su.siteId FROM site_users su
                JOIN users u ON u.id = su.userId WHERE u.accountId = ?`,
        args: [me.accountId],
      });
      const porUsuario = new Map();
      for (const a of asign.rows) {
        const k = Number(a.userId);
        if (!porUsuario.has(k)) porUsuario.set(k, []);
        porUsuario.get(k).push(Number(a.siteId));
      }
      return res.status(200).json({
        me, account,
        users: rs.rows.map((u) => ({ ...publicUser(u), siteIds: porUsuario.get(Number(u.id)) || [] })),
      });
    }

    /* -------------------------------------------------- POST ?signup=1 ----- */
    if (req.method === "POST" && req.query?.signup) {
      // Con la base vacia SIEMPRE se deja crear la primera cuenta: si no, un
      // despliegue con ALLOW_SIGNUP=0 se quedaria sin ninguna forma de entrar.
      const totalUsers = Number((await db.execute(`SELECT COUNT(*) c FROM users`)).rows[0].c);
      if (!SIGNUP_OPEN && totalUsers > 0) {
        return res.status(403).json({ error: "El registro está cerrado. Pide una cuenta al administrador." });
      }
      const company = clean(body.company, 80);
      const name = (body.name ?? "").toString().trim();
      const pw = (body.password ?? "").toString();
      if (!company) return res.status(400).json({ error: "Escribe el nombre de la empresa." });
      if (!NAME_RE.test(name)) {
        return res.status(400).json({ error: "Usuario de 2 a 20 caracteres, sin espacios (letras, números, . _ -)." });
      }
      if (pw.length < 6 || pw.length > 64) {
        return res.status(400).json({ error: "La contraseña debe tener entre 6 y 64 caracteres." });
      }
      const dup = await db.execute({ sql: `SELECT 1 FROM users WHERE name = ? COLLATE NOCASE`, args: [name] });
      if (dup.rows.length) return res.status(409).json({ error: "Ese usuario ya existe. Elige otro." });

      const now = nowIso();
      const acc = await db.execute({ sql: `INSERT INTO accounts (name, createdAt) VALUES (?, ?)`, args: [company, now] });
      const accountId = Number(acc.lastInsertRowid);
      const token = newToken();
      const ins = await db.execute({
        sql: `INSERT INTO users (name, role, passwordHash, sessionToken, accountId, createdAt)
              VALUES (?, 'admin', ?, ?, ?, ?)`,
        args: [name, hashPassword(pw), token, accountId, now],
      });
      return res.status(201).json({
        user: { id: Number(ins.lastInsertRowid), name, fullName: null, role: "admin", active: 1, accountId },
        account: { id: accountId, name: company },
        token, created: true,
      });
    }

    /* ----------------------------------------------------------- POST ?new=1 */
    if (req.method === "POST" && req.query?.new) {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      if (!isAdmin(me)) return deny(res, true);

      const name = (body.name ?? "").toString().trim();
      const pw = (body.password ?? "").toString();
      const role = body.role === "admin" ? "admin" : "foreman";
      if (!me.accountId) return res.status(400).json({ error: "Tu usuario no tiene empresa asignada." });
      if (!NAME_RE.test(name)) {
        return res.status(400).json({ error: "Usuario de 2 a 20 caracteres, sin espacios (letras, números, . _ -)." });
      }
      if (pw.length < 6 || pw.length > 64) {
        return res.status(400).json({ error: "La contraseña debe tener entre 6 y 64 caracteres." });
      }
      const dup = await db.execute({ sql: `SELECT 1 FROM users WHERE name = ? COLLATE NOCASE`, args: [name] });
      if (dup.rows.length) return res.status(409).json({ error: "Ese usuario ya existe." });

      const ins = await db.execute({
        sql: `INSERT INTO users (name, fullName, role, passwordHash, accountId, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [name, clean(body.fullName), role, hashPassword(pw), me.accountId, nowIso()],
      });
      const newId = Number(ins.lastInsertRowid);
      if ("siteIds" in body) await setUserSites(newId, body.siteIds, me.accountId);
      return res.status(201).json({
        user: { id: newId, name, fullName: clean(body.fullName), role, active: 1, accountId: me.accountId },
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
        sql: `SELECT id, name, fullName, role, active, accountId, passwordHash, failedLogins, lockedUntil
                FROM users WHERE name = ? COLLATE NOCASE`,
        args: [name],
      });

      // Login y nada mas. Crear una empresa es ?signup=1: si el alta ocurriera
      // aqui, el admin quedaria sin cuenta y no podria ver ni crear obras.
      if (!found.rows.length) {
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
      const acc = await db.execute({ sql: `SELECT id, name, logo FROM accounts WHERE id = ?`, args: [u.accountId] });
      return res.status(200).json({
        user: publicUser(u),
        account: acc.rows[0]
          ? { id: Number(acc.rows[0].id), name: acc.rows[0].name, logo: acc.rows[0].logo || null }
          : null,
        token,
      });
    }

    /* --------------------------------------------- PUT datos de la empresa */
    if (req.method === "PUT" && req.query?.account) {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      if (!isAdmin(me)) return deny(res, true);

      const sets = [], args = [];
      if ("name" in body) {
        const name = clean(body.name, 80);
        if (!name) return res.status(400).json({ error: "El nombre de la empresa es obligatorio." });
        sets.push("name = ?"); args.push(name);
      }
      if ("logo" in body) {
        const logo = parseDataJpeg(body.logo, MAX_LOGO, "El logo");
        if (!logo.ok) return res.status(400).json({ error: logo.error });
        sets.push("logo = ?"); args.push(logo.value);
      }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      args.push(me.accountId);
      await db.execute({ sql: `UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, args });

      const acc = await db.execute({ sql: `SELECT id, name, logo FROM accounts WHERE id = ?`, args: [me.accountId] });
      return res.status(200).json({
        ok: true,
        account: { id: Number(acc.rows[0].id), name: acc.rows[0].name, logo: acc.rows[0].logo || null },
      });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      const id = parseId(req.query?.id) ?? me.id;

      // Un admin solo puede tocar usuarios de SU cuenta.
      if (isAdmin(me) && id !== me.id) {
        const t = await db.execute({ sql: `SELECT accountId FROM users WHERE id = ?`, args: [id] });
        if (!t.rows.length || Number(t.rows[0].accountId) !== me.accountId) return notYours(res);
      }

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
      // Reasignacion de obras: puede venir sola, sin ningun otro cambio.
      if ("siteIds" in body) await setUserSites(id, body.siteIds, me.accountId);
      if (!sets.length) return res.status(200).json({ ok: true });

      // La CUENTA no puede quedarse sin ningun admin activo.
      if (id === me.id && (body.role === "foreman" || body.active === false || body.active === 0)) {
        const others = Number((await db.execute({
          sql: `SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1 AND accountId = ? AND id <> ?`,
          args: [me.accountId, id],
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
      const t = await db.execute({ sql: `SELECT accountId FROM users WHERE id = ?`, args: [id] });
      if (!t.rows.length || Number(t.rows[0].accountId) !== me.accountId) return notYours(res);
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
