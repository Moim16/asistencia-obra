// =============================================================================
//  Abonos: plata entregada por adelantado, antes del dia de pago.
//
//  GET    /api/advances?siteId=&from=&to=[&workerId=]
//         -> abonos del periodo, con quien los registro.
//  POST   /api/advances { siteId, workerId, day, amount, note }
//         -> registra un abono (admin).
//  DELETE /api/advances?id=
//         -> borra un abono. Solo si todavia NO se descontó en una liquidacion;
//            si ya se descontó hay que deshacer ese pago primero, para que las
//            cuentas del periodo no queden mintiendo.
//
//  Un abono resta de lo que el trabajador tiene por cobrar mientras siga
//  PENDIENTE (settledAt NULL). Al liquidar un periodo se marca como descontado.
// =============================================================================

import { db, ensureSchema, nowIso } from "../lib/db.js";
import { readJson, clean, parseDay, parseId } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours, canSeeSite, canSeeWorker } from "../lib/auth.js";

function parseAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100000000) return null;
  return Math.round(n * 100) / 100;
}

const row = (a) => ({
  id: Number(a.id),
  workerId: Number(a.workerId),
  workerName: a.workerName,
  day: a.day,
  amount: Number(a.amount),
  note: a.note || null,
  settled: !!a.settledAt,
  byName: a.byName || null,
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
      const from = parseDay(req.query?.from);
      const to = parseDay(req.query?.to);
      const workerId = parseId(req.query?.workerId);
      if (!siteId) return res.status(400).json({ error: "siteId inválido." });
      if (!from || !to) return res.status(400).json({ error: "Fechas inválidas (usa YYYY-MM-DD)." });
      if (!(await canSeeSite(me, siteId))) return notYours(res);

      const rs = await db.execute({
        sql: `SELECT a.id, a.workerId, a.day, a.amount, a.note, a.settledAt,
                     w.fullName AS workerName, u.name AS byName
                FROM advances a
                JOIN workers w ON w.id = a.workerId
                LEFT JOIN users u ON u.id = a.createdBy
               WHERE a.siteId = ? AND a.day >= ? AND a.day <= ?
                 ${workerId ? "AND a.workerId = ?" : ""}
               ORDER BY a.day DESC, a.id DESC`,
        args: workerId ? [siteId, from, to, workerId] : [siteId, from, to],
      });
      return res.status(200).json({ advances: rs.rows.map(row) });
    }

    if (!isAdmin(me)) return deny(res, true);

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const siteId = parseId(body.siteId);
      const workerId = parseId(body.workerId);
      const day = parseDay(body.day);
      const amount = parseAmount(body.amount);
      if (!siteId) return res.status(400).json({ error: "siteId inválido." });
      if (!workerId) return res.status(400).json({ error: "Elige al trabajador." });
      if (!day) return res.status(400).json({ error: "Fecha inválida (usa YYYY-MM-DD)." });
      if (amount === null) return res.status(400).json({ error: "El monto debe ser mayor que 0." });
      if (!(await canSeeSite(me, siteId))) return notYours(res);
      if (!(await canSeeWorker(me, workerId))) return notYours(res);

      const ins = await db.execute({
        sql: `INSERT INTO advances (siteId, workerId, day, amount, note, createdBy, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [siteId, workerId, day, amount, clean(body.note, 120), me.id, nowIso()],
      });
      return res.status(201).json({
        advance: { id: Number(ins.lastInsertRowid), workerId, day, amount, settled: false },
      });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      const rs = await db.execute({
        sql: `SELECT workerId, settledAt FROM advances WHERE id = ?`, args: [id],
      });
      if (!rs.rows.length) return res.status(404).json({ error: "Abono no encontrado." });
      if (!(await canSeeWorker(me, Number(rs.rows[0].workerId)))) return notYours(res);
      if (rs.rows[0].settledAt) {
        return res.status(400).json({
          error: "Este abono ya se descontó en un pago. Deshaz ese pago primero.",
        });
      }
      await db.execute({ sql: `DELETE FROM advances WHERE id = ?`, args: [id] });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
