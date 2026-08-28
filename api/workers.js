// =============================================================================
//  Albañiles (personal de la obra). No tienen cuenta ni entran a la app.
//
//  GET    /api/workers?siteId=[&all=1][&today=YYYY-MM-DD]
//                                       -> personal activo de la obra (all=1 incluye
//                                          bajas). Cada uno con su jornal VIGENTE HOY.
//  POST   /api/workers    { siteId, fullName, docId, trade, phone, dailyRate, rateFrom }
//                                       -> alta (admin). `rateFrom` = desde cuando rige
//                                          el jornal inicial (por defecto, hoy).
//  PUT    /api/workers?id= { ...campos, siteId, active }            -> editar (admin).
//  DELETE /api/workers?id= -> da de baja (active = 0). Su historial se conserva.
//
//  Jornal (vive en worker_rates, con historial por fecha de vigencia):
//  GET    /api/workers?id=&rates=1        -> historial de jornales del trabajador.
//  POST   /api/workers?rates=1 { workerId, amount, fromDay }
//                                         -> fija el jornal DESDE fromDay (admin).
//                                            Repetir el mismo fromDay lo corrige.
//  DELETE /api/workers?rate=<rateId>      -> borra una tarifa del historial (admin).
// =============================================================================

import { db, ensureSchema, nowIso } from "../lib/db.js";
import { readJson, clean, parseId, parseDay } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours, canSeeSite, canSeeWorker } from "../lib/auth.js";
import { today } from "../lib/day.js";

// Fecha valida, o la de HOY EN LA OBRA (hora de Nicaragua). Nunca UTC: de tarde
// alla ya es el dia siguiente en UTC, y una tarifa fechada asi empezaria a regir
// manana en vez de hoy.
const localDay = (v) => parseDay(v) || today();

// Monto valido: numero >= 0, con un techo razonable para atajar dedazos.
function parseAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000000) return null;
  return Math.round(n * 100) / 100;
}

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

    /* --------------------------------------------- GET historial de jornales */
    if (req.method === "GET" && req.query?.rates) {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await canSeeWorker(me, id))) return notYours(res);
      const rs = await db.execute({
        sql: `SELECT id, amount, fromDay FROM worker_rates WHERE workerId = ? ORDER BY fromDay DESC`,
        args: [id],
      });
      return res.status(200).json({
        rates: rs.rows.map((r) => ({ id: Number(r.id), amount: Number(r.amount), fromDay: r.fromDay })),
      });
    }

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      const siteId = parseId(req.query?.siteId);
      if (!siteId) return res.status(400).json({ error: "siteId inválido." });
      if (!(await canSeeSite(me, siteId))) return notYours(res);
      const all = !!req.query?.all;
      // `dailyRate` = jornal que rige HOY; `nextRateFrom` avisa si hay un cambio
      // de jornal ya programado hacia adelante.
      const hoy = localDay(req.query?.today);
      const rs = await db.execute({
        sql: `SELECT w.id, w.siteId, w.fullName, w.docId, w.trade, w.phone, w.active,
                     (SELECT r.amount FROM worker_rates r
                       WHERE r.workerId = w.id AND r.fromDay <= ?
                       ORDER BY r.fromDay DESC LIMIT 1) AS dailyRate,
                     (SELECT MIN(r.fromDay) FROM worker_rates r
                       WHERE r.workerId = w.id AND r.fromDay > ?) AS nextRateFrom
                FROM workers w
               WHERE w.siteId = ? ${all ? "" : "AND w.active = 1"}
               ORDER BY w.active DESC, w.fullName COLLATE NOCASE`,
        args: [hoy, hoy, siteId],
      });
      return res.status(200).json({
        workers: rs.rows.map((w) => ({
          ...row(w),
          dailyRate: w.dailyRate == null ? null : Number(w.dailyRate),
          nextRateFrom: w.nextRateFrom || null,
        })),
      });
    }

    if (!isAdmin(me)) return deny(res, true);

    /* ------------------------------------------------- POST fijar un jornal */
    if (req.method === "POST" && req.query?.rates) {
      const workerId = parseId(body.workerId);
      const amount = parseAmount(body.amount);
      const fromDay = parseDay(body.fromDay);
      if (!workerId) return res.status(400).json({ error: "Trabajador inválido." });
      if (amount === null) return res.status(400).json({ error: "El monto debe ser un número mayor o igual a 0." });
      if (!fromDay) return res.status(400).json({ error: "Fecha inválida (usa YYYY-MM-DD)." });
      if (!(await canSeeWorker(me, workerId))) return notYours(res);

      // Repetir la misma fecha CORRIGE esa tarifa en vez de duplicarla.
      await db.execute({
        sql: `INSERT INTO worker_rates (workerId, amount, fromDay, createdAt) VALUES (?, ?, ?, ?)
              ON CONFLICT (workerId, fromDay) DO UPDATE SET amount = excluded.amount`,
        args: [workerId, amount, fromDay, nowIso()],
      });
      return res.status(200).json({ ok: true, amount, fromDay });
    }

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const siteId = parseId(body.siteId);
      const fullName = clean(body.fullName, 80);
      if (!siteId) return res.status(400).json({ error: "Elige la obra." });
      if (!fullName) return res.status(400).json({ error: "El nombre del trabajador es obligatorio." });
      if (!(await canSeeSite(me, siteId))) return notYours(res);

      const args = [siteId, fullName, clean(body.docId, 30), clean(body.trade, 40), clean(body.phone, 30), nowIso()];
      const ins = await db.execute({
        sql: `INSERT INTO workers (siteId, fullName, docId, trade, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
        args,
      });
      const workerId = Number(ins.lastInsertRowid);

      // Jornal inicial: rige desde hoy (la fecha de la obra). Se cambia despues
      // con ?rates=1.
      const rate = "dailyRate" in body ? parseAmount(body.dailyRate) : null;
      if (rate !== null) {
        await db.execute({
          sql: `INSERT INTO worker_rates (workerId, amount, fromDay, createdAt) VALUES (?, ?, ?, ?)`,
          args: [workerId, rate, localDay(body.rateFrom), nowIso()],
        });
      }
      return res.status(201).json({
        worker: {
          id: workerId, siteId, fullName,
          docId: args[2], trade: args[3], phone: args[4], active: 1, dailyRate: rate,
        },
      });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await canSeeWorker(me, id))) return notYours(res);
      const sets = [], args = [];
      if ("fullName" in body) {
        const fullName = clean(body.fullName, 80);
        if (!fullName) return res.status(400).json({ error: "El nombre del trabajador es obligatorio." });
        sets.push("fullName = ?"); args.push(fullName);
      }
      if ("siteId" in body) {
        const siteId = parseId(body.siteId);
        if (!siteId) return res.status(400).json({ error: "Obra inválida." });
        if (!(await canSeeSite(me, siteId))) return notYours(res);   // no mudarlo a una obra ajena
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

    /* ---------------------------------------------------- DELETE una tarifa */
    if (req.method === "DELETE" && req.query?.rate) {
      const rateId = parseId(req.query?.rate);
      if (!rateId) return res.status(400).json({ error: "Tarifa inválida." });
      const owner = await db.execute({ sql: `SELECT workerId FROM worker_rates WHERE id = ?`, args: [rateId] });
      if (!owner.rows.length) return res.status(404).json({ error: "Tarifa no encontrada." });
      if (!(await canSeeWorker(me, Number(owner.rows[0].workerId)))) return notYours(res);
      const del = await db.execute({ sql: `DELETE FROM worker_rates WHERE id = ?`, args: [rateId] });
      if (!del.rowsAffected) return res.status(404).json({ error: "Tarifa no encontrada." });
      return res.status(200).json({ ok: true });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await canSeeWorker(me, id))) return notYours(res);
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
