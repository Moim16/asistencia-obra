// =============================================================================
//  Pagos: marcar como pagados los dias ya trabajados.
//
//  POST   /api/payments { siteId, workerId, from, to }
//         -> marca como PAGADOS los dias trabajados (P o M) del rango que
//            todavia no lo estaban. Devuelve cuantos dias y cuanto suma.
//
//  DELETE /api/payments?siteId=&workerId=&from=&to=
//         -> deshace el pago de ese rango (por si se marco por error).
//
//  El monto se CONGELA al pagar (`paidAmount`). Si despues se le sube el pago
//  al trabajador, lo ya pagado no se reescribe: queda registrado lo que de
//  verdad se le pago ese dia. Los dias sin marcar y las faltas no se pagan.
//
//  ABONOS: al liquidar tambien se marcan como descontados los abonos que el
//  trabajador tenia pendientes, con la MISMA marca de tiempo que los dias. Asi,
//  deshacer el pago devuelve esos abonos a pendientes y las cuentas no quedan
//  mintiendo. La plata que se entrega en mano es dias - abonos.
//
//  Solo el administrador paga; el capataz pasa lista y consulta.
// =============================================================================

import { db, ensureSchema, nowIso } from "../lib/db.js";
import { readJson, parseDay, parseId } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours, canSeeSite } from "../lib/auth.js";

// Pago vigente el dia de la fila, por el valor del dia (1 completo, 0,5 medio).
// Misma regla que RATE_SQL: si el dia es anterior a la primera tarifa registrada,
// rige esa primera tarifa. Va dentro de un UPDATE, asi que referencia la tabla
// por nombre y no por alias.
const AMOUNT_SQL = `
  COALESCE(
    (SELECT r.amount FROM worker_rates r
      WHERE r.workerId = attendance.workerId AND r.fromDay <= attendance.day
      ORDER BY r.fromDay DESC LIMIT 1),
    (SELECT r.amount FROM worker_rates r
      WHERE r.workerId = attendance.workerId
      ORDER BY r.fromDay ASC LIMIT 1),
    0)
  * CASE attendance.status WHEN 'P' THEN 1.0 WHEN 'M' THEN 0.5 ELSE 0 END`;

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "DELETE" ? {} : await readJson(req);
    const me = await currentUser(req, body);
    if (!me) return deny(res);
    if (!isAdmin(me)) return deny(res, true);

    const src = req.method === "DELETE" ? req.query : body;
    const siteId = parseId(src?.siteId);
    const workerId = parseId(src?.workerId);
    const from = parseDay(src?.from);
    const to = parseDay(src?.to);

    if (!siteId) return res.status(400).json({ error: "siteId inválido." });
    if (!workerId) return res.status(400).json({ error: "Trabajador inválido." });
    if (!from || !to) return res.status(400).json({ error: "Fechas inválidas (usa YYYY-MM-DD)." });
    if (from > to) return res.status(400).json({ error: "La fecha inicial es posterior a la final." });
    if (!(await canSeeSite(me, siteId))) return notYours(res);

    /* ------------------------------------------------------------ PAGAR ---- */
    if (req.method === "POST") {
      const ahora = nowIso();

      // Solo dias trabajados y todavia impagos. Las faltas no entran.
      const upd = await db.execute({
        sql: `UPDATE attendance
                 SET paidAt = ?, paidBy = ?, paidAmount = ${AMOUNT_SQL}
               WHERE siteId = ? AND workerId = ? AND day >= ? AND day <= ?
                 AND paidAt IS NULL AND status IN ('P','M')`,
        args: [ahora, me.id, siteId, workerId, from, to],
      });

      // Abonos pendientes hasta el fin del periodo. Se incluyen los anteriores a
      // `from` a proposito: un adelanto de la semana pasada que quedo sin
      // descontar tiene que salir en esta liquidacion.
      const abonos = await db.execute({
        sql: `SELECT COALESCE(SUM(amount), 0) t FROM advances
               WHERE siteId = ? AND workerId = ? AND day <= ? AND settledAt IS NULL`,
        args: [siteId, workerId, to],
      });
      const abonado = Number(abonos.rows[0].t);

      if (!upd.rowsAffected && !abonado) {
        return res.status(200).json({ ok: true, days: 0, amount: 0, advances: 0, net: 0, nada: true });
      }
      if (abonado) {
        // Misma marca de tiempo que los dias: es lo que permite deshacer ambas
        // cosas juntas mas abajo.
        await db.execute({
          sql: `UPDATE advances SET settledAt = ?, settledBy = ?
                 WHERE siteId = ? AND workerId = ? AND day <= ? AND settledAt IS NULL`,
          args: [ahora, me.id, siteId, workerId, to],
        });
      }

      const sum = await db.execute({
        sql: `SELECT COUNT(*) c, COALESCE(SUM(paidAmount), 0) t FROM attendance
               WHERE siteId = ? AND workerId = ? AND day >= ? AND day <= ? AND paidAt IS NOT NULL`,
        args: [siteId, workerId, from, to],
      });
      const dias = Number(sum.rows[0].t);
      return res.status(200).json({
        ok: true,
        days: upd.rowsAffected,
        amount: dias,                                     // suman los dias liquidados
        advances: abonado,                                // lo ya adelantado
        net: Math.round((dias - abonado) * 100) / 100,    // lo que se entrega en mano
        totalDaysPaid: Number(sum.rows[0].c),
      });
    }

    /* ---------------------------------------------------------- DESHACER --- */
    if (req.method === "DELETE") {
      // Primero se anotan las marcas de tiempo de los pagos que se van a
      // deshacer: son la unica forma de saber que abonos se descontaron en ESOS
      // pagos y no en alguno anterior.
      const marcas = await db.execute({
        sql: `SELECT DISTINCT paidAt FROM attendance
               WHERE siteId = ? AND workerId = ? AND day >= ? AND day <= ? AND paidAt IS NOT NULL`,
        args: [siteId, workerId, from, to],
      });
      const upd = await db.execute({
        sql: `UPDATE attendance SET paidAt = NULL, paidBy = NULL, paidAmount = NULL
               WHERE siteId = ? AND workerId = ? AND day >= ? AND day <= ? AND paidAt IS NOT NULL`,
        args: [siteId, workerId, from, to],
      });

      let abonos = 0;
      const ts = marcas.rows.map((r) => r.paidAt).filter(Boolean);
      if (ts.length) {
        const back = await db.execute({
          sql: `UPDATE advances SET settledAt = NULL, settledBy = NULL
                 WHERE workerId = ? AND settledAt IN (${ts.map(() => "?").join(",")})`,
          args: [workerId, ...ts],
        });
        abonos = back.rowsAffected;
      }
      return res.status(200).json({ ok: true, days: upd.rowsAffected, advances: abonos });
    }

    res.setHeader("Allow", "POST, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
