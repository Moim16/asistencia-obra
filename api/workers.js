// =============================================================================
//  Albañiles (personal de la obra). No tienen cuenta ni entran a la app.
//
//  GET    /api/workers?siteId=[&all=1]  -> personal activo de la obra (all=1 incluye bajas).
//  POST   /api/workers    { siteId, fullName, docId, trade, phone } -> alta (admin).
//  PUT    /api/workers?id= { ...campos, siteId, active }            -> editar (admin).
//  DELETE /api/workers?id= -> da de baja (active = 0). Su historial se conserva.
// =============================================================================

import { db, ensureSchema, nowIso } from "../lib/db.js";
import { readJson, clean, parseId } from "../lib/http.js";
import { currentUser, isAdmin, deny } from "../lib/auth.js";

const row = (w) => ({
  id: Number(w.id), siteId: Number(w.siteId), fullName: w.fullName,
  docId: w.docId, trade: w.trade, phone: w.phone, active: Number(w.active),
});

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
    const me = await currentUser(req, body);
    if (!me) return deny(res);

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      const siteId = parseId(req.query?.siteId);
      if (!siteId) return res.status(400).json({ error: "siteId inválido." });
      const all = !!req.query?.all;
      const rs = await db.execute({
        sql: `SELECT id, siteId, fullName, docId, trade, phone, active
                FROM workers
               WHERE siteId = ? ${all ? "" : "AND active = 1"}
               ORDER BY active DESC, fullName COLLATE NOCASE`,
        args: [siteId],
      });
      return res.status(200).json({ workers: rs.rows.map(row) });
    }

    if (!isAdmin(me)) return deny(res, true);

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const siteId = parseId(body.siteId);
      const fullName = clean(body.fullName, 80);
      if (!siteId) return res.status(400).json({ error: "Elige la obra." });
      if (!fullName) return res.status(400).json({ error: "El nombre del trabajador es obligatorio." });
      const site = await db.execute({ sql: `SELECT 1 FROM sites WHERE id = ?`, args: [siteId] });
      if (!site.rows.length) return res.status(404).json({ error: "La obra no existe." });

      const args = [siteId, fullName, clean(body.docId, 30), clean(body.trade, 40), clean(body.phone, 30), nowIso()];
      const ins = await db.execute({
        sql: `INSERT INTO workers (siteId, fullName, docId, trade, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
        args,
      });
      return res.status(201).json({
        worker: {
          id: Number(ins.lastInsertRowid), siteId, fullName,
          docId: args[2], trade: args[3], phone: args[4], active: 1,
        },
      });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      const sets = [], args = [];
      if ("fullName" in body) {
        const fullName = clean(body.fullName, 80);
        if (!fullName) return res.status(400).json({ error: "El nombre del trabajador es obligatorio." });
        sets.push("fullName = ?"); args.push(fullName);
      }
      if ("siteId" in body) {
        const siteId = parseId(body.siteId);
        if (!siteId) return res.status(400).json({ error: "Obra inválida." });
        // Traslado de obra: el historial anterior no cambia (cada marca guarda su siteId).
        sets.push("siteId = ?"); args.push(siteId);
      }
      for (const [k, max] of [["docId", 30], ["trade", 40], ["phone", 30]]) {
        if (k in body) { sets.push(`${k} = ?`); args.push(clean(body[k], max)); }
      }
      if ("active" in body) { sets.push("active = ?"); args.push(body.active ? 1 : 0); }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      args.push(id);
      const upd = await db.execute({ sql: `UPDATE workers SET ${sets.join(", ")} WHERE id = ?`, args });
      if (!upd.rowsAffected) return res.status(404).json({ error: "Trabajador no encontrado." });
      return res.status(200).json({ ok: true });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      const upd = await db.execute({ sql: `UPDATE workers SET active = 0 WHERE id = ?`, args: [id] });
      if (!upd.rowsAffected) return res.status(404).json({ error: "Trabajador no encontrado." });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
