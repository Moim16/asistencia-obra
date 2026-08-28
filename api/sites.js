// =============================================================================
//  Obras.
//
//  GET    /api/sites[?all=1]   -> obras activas (all=1 incluye las cerradas; admin).
//  POST   /api/sites           { name, address }        -> crear (admin).
//  PUT    /api/sites?id=       { name, address, active } -> editar (admin).
//  DELETE /api/sites?id=       -> cierra la obra (active = 0). No borra historial.
// =============================================================================

import { db, ensureSchema, nowIso } from "../lib/db.js";
import { readJson, clean, parseId } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours, siteScope, canSeeSite } from "../lib/auth.js";

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
    const me = await currentUser(req, body);
    if (!me) return deny(res);

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      const all = !!req.query?.all && isAdmin(me);
      // Solo las obras que este usuario puede ver: de su cuenta y, si es capataz,
      // ademas asignadas a el. Cada una con su conteo de personal activo.
      const scope = siteScope(me);
      const rs = await db.execute({
        sql: `SELECT s.id, s.name, s.address, s.active, s.createdAt,
                     (SELECT COUNT(*) FROM workers w WHERE w.siteId = s.id AND w.active = 1) AS workers
                FROM sites s
               WHERE ${scope.sql} ${all ? "" : "AND s.active = 1"}
               ORDER BY s.active DESC, s.name COLLATE NOCASE`,
        args: scope.args,
      });
      return res.status(200).json({
        sites: rs.rows.map((s) => ({
          id: Number(s.id), name: s.name, address: s.address,
          active: Number(s.active), workers: Number(s.workers),
        })),
      });
    }

    if (!isAdmin(me)) return deny(res, true);

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const name = clean(body.name, 80);
      if (!name) return res.status(400).json({ error: "El nombre de la obra es obligatorio." });
      if (!me.accountId) return res.status(400).json({ error: "Tu usuario no tiene empresa asignada." });
      const ins = await db.execute({
        sql: `INSERT INTO sites (name, address, accountId, createdAt) VALUES (?, ?, ?, ?)`,
        args: [name, clean(body.address, 160), me.accountId, nowIso()],
      });
      return res.status(201).json({
        site: { id: Number(ins.lastInsertRowid), name, address: clean(body.address, 160), active: 1, workers: 0 },
      });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await canSeeSite(me, id))) return notYours(res);
      const sets = [], args = [];
      if ("name" in body) {
        const name = clean(body.name, 80);
        if (!name) return res.status(400).json({ error: "El nombre de la obra es obligatorio." });
        sets.push("name = ?"); args.push(name);
      }
      if ("address" in body) { sets.push("address = ?"); args.push(clean(body.address, 160)); }
      if ("active" in body) { sets.push("active = ?"); args.push(body.active ? 1 : 0); }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      args.push(id);
      const upd = await db.execute({ sql: `UPDATE sites SET ${sets.join(", ")} WHERE id = ?`, args });
      if (!upd.rowsAffected) return res.status(404).json({ error: "Obra no encontrada." });
      return res.status(200).json({ ok: true });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await canSeeSite(me, id))) return notYours(res);
      const upd = await db.execute({ sql: `UPDATE sites SET active = 0 WHERE id = ?`, args: [id] });
      if (!upd.rowsAffected) return res.status(404).json({ error: "Obra no encontrada." });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
