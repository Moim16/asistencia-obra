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
//  GET    /api/payments?siteId=&workerId=&from=&to=
//         -> las firmas de recibido de ese periodo, para el comprobante en PDF.
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
//  FIRMA DE RECIBIDO: si la obra la pide (`useSignPay`), al liquidar se manda
//  tambien `sign` con la firma del trabajador sobre el detalle. Se guarda con la
//  MISMA marca de tiempo que los dias y los abonos, asi que deshacer el pago se
//  lleva la firma con el: una firma sin pago detras no probaria nada. Es
//  opcional dentro de la propia obra que la pide, igual que la firma diaria: si
//  el trabajador no esta delante, se paga igual y queda constancia de que ese
//  pago no se firmo.
//
//  Solo el administrador paga y deshace; leer las firmas puede cualquiera que
//  vea la obra, porque el comprobante en PDF lo saca tambien el capataz.
// =============================================================================

import { db, ensureSchema, nowIso } from "../lib/db.js";
import { readJson, parseDay, parseId, parseDataJpeg } from "../lib/http.js";
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

const MAX_SIGN = 250 * 1024;   // el navegador la manda chica; esto es el tope duro

const round2 = (n) => Math.round(n * 100) / 100;

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "POST" ? await readJson(req) : {};
    const me = await currentUser(req, body);
    if (!me) return deny(res);
    // Pagar y deshacer es cosa del admin; consultar el comprobante, no.
    if (req.method !== "GET" && !isAdmin(me)) return deny(res, true);

    const src = req.method === "POST" ? body : req.query;
    const siteId = parseId(src?.siteId);
    const workerId = parseId(src?.workerId);
    const from = parseDay(src?.from);
    const to = parseDay(src?.to);

    if (!siteId) return res.status(400).json({ error: "siteId inválido." });
    if (!workerId) return res.status(400).json({ error: "Trabajador inválido." });
    if (!from || !to) return res.status(400).json({ error: "Fechas inválidas (usa YYYY-MM-DD)." });
    if (from > to) return res.status(400).json({ error: "La fecha inicial es posterior a la final." });
    if (!(await canSeeSite(me, siteId))) return notYours(res);

    /* ------------------------------------------- FIRMAS DE RECIBIDO (GET) -- */
    if (req.method === "GET") {
      // Solo los pagos que caen ENTEROS dentro del rango consultado: un
      // comprobante vale por su periodo, y mezclarlo con otro lo volveria
      // ilegible.
      const rs = await db.execute({
        sql: `SELECT paidAt, fromDay, toDay, amount, advances, net, image, signedAt
                FROM payment_signs
               WHERE siteId = ? AND workerId = ? AND fromDay >= ? AND toDay <= ?
               ORDER BY paidAt`,
        args: [siteId, workerId, from, to],
      });
      return res.status(200).json({
        receipts: rs.rows.map((r) => ({
          paidAt: r.paidAt, fromDay: r.fromDay, toDay: r.toDay,
          amount: Number(r.amount), advances: Number(r.advances), net: Number(r.net),
          image: r.image, signedAt: r.signedAt,
        })),
      });
    }

    /* ------------------------------------------------------------ PAGAR ---- */
    if (req.method === "POST") {
      const ahora = nowIso();

      // La firma se valida ANTES de tocar nada: si se rechazara despues, los
      // dias ya habrian quedado pagados mientras la app recibe un error y cree
      // que no se pago.
      const sign = "sign" in body && body.sign
        ? parseDataJpeg(body.sign, MAX_SIGN, "La firma")
        : { ok: true, value: null };
      if (!sign.ok) return res.status(400).json({ error: sign.error });

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

      // Firma de recibido. Se guarda por lo que se entrega AHORA (lo liquidado
      // en esta operacion menos los abonos), no por el total del rango: si una
      // parte ya estaba pagada de antes, el trabajador no la recibe hoy y no
      // tiene por que firmarla.
      let firmado = false;
      if (sign.value) {
        const nuevo = Number((await db.execute({
          sql: `SELECT COALESCE(SUM(paidAmount), 0) t FROM attendance WHERE workerId = ? AND paidAt = ?`,
          args: [workerId, ahora],
        })).rows[0].t);
        await db.execute({
          sql: `INSERT INTO payment_signs
                  (workerId, paidAt, siteId, fromDay, toDay, amount, advances, net, image, signedAt, signedBy)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [workerId, ahora, siteId, from, to, nuevo, abonado,
                 round2(nuevo - abonado), sign.value, ahora, me.id],
        });
        firmado = true;
      }

      return res.status(200).json({
        ok: true,
        days: upd.rowsAffected,
        amount: dias,                                     // suman los dias liquidados
        advances: abonado,                                // lo ya adelantado
        net: round2(dias - abonado),                      // lo que se entrega en mano
        signed: firmado,
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

      let abonos = 0, firmas = 0;
      const ts = marcas.rows.map((r) => r.paidAt).filter(Boolean);
      if (ts.length) {
        const huecos = ts.map(() => "?").join(",");
        const back = await db.execute({
          sql: `UPDATE advances SET settledAt = NULL, settledBy = NULL
                 WHERE workerId = ? AND settledAt IN (${huecos})`,
          args: [workerId, ...ts],
        });
        abonos = back.rowsAffected;
        // La firma de recibido se va con su pago: un comprobante de algo que ya
        // no existe solo puede confundir.
        const delF = await db.execute({
          sql: `DELETE FROM payment_signs WHERE workerId = ? AND paidAt IN (${huecos})`,
          args: [workerId, ...ts],
        });
        firmas = delF.rowsAffected;
      }
      return res.status(200).json({ ok: true, days: upd.rowsAffected, advances: abonos, signs: firmas });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
