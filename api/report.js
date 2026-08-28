// =============================================================================
//  Reporte de dias trabajados.
//
//  GET /api/report?siteId=&from=YYYY-MM-DD&to=YYYY-MM-DD
//   -> { from, to, days:[...],
//        rows:[{ workerId, fullName, trade, active, P, M, A, worked,
//                earned, paid, advances, pending, marks:{ day:{ s, paid, amount } } }],
//        totals:{ P, M, A, worked, earned, paid, advances, pending } }
//
//  "worked" = dias trabajados = P * 1 + M * 0.5 (los ausentes no suman).
//
//  Plata: cada dia vale el jornal vigente ESE DIA por el valor del dia (completo
//  o medio). Si el dia ya se pago, vale el monto CONGELADO al pagarlo, no el
//  jornal de hoy: subirle el sueldo a alguien no reescribe lo que ya cobro.
//    earned   = todo lo trabajado en el rango
//    paid     = lo que ya se le liquido
//    advances = abonos entregados por adelantado y TODAVIA sin descontar
//    pending  = lo que hay que entregarle  (earned - paid - advances)
//
//  `pending` puede quedar NEGATIVO: si se le adelanto mas de lo que trabajo, ese
//  saldo queda a favor de la empresa y se arrastra al periodo siguiente.
//
//  Incluye a quien ya NO esta activo pero SI tuvo marcas en el rango (una baja a
//  mitad de mes tiene que seguir apareciendo en la liquidacion del mes).
// =============================================================================

import { db, ensureSchema, DAY_VALUE, RATE_SQL } from "../lib/db.js";
import { parseDay, parseId } from "../lib/http.js";
import { currentUser, deny, notYours, canSeeSite } from "../lib/auth.js";

const MAX_DAYS = 186;   // ~6 meses: techo para no devolver una grilla enorme

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const me = await currentUser(req, {});
    if (!me) return deny(res);

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Método no permitido" });
    }

    const siteId = parseId(req.query?.siteId);
    const from = parseDay(req.query?.from);
    const to = parseDay(req.query?.to);
    if (!siteId) return res.status(400).json({ error: "siteId inválido." });
    if (!from || !to) return res.status(400).json({ error: "Fechas inválidas (usa YYYY-MM-DD)." });
    if (!(await canSeeSite(me, siteId))) return notYours(res);
    if (from > to) return res.status(400).json({ error: "La fecha inicial es posterior a la final." });

    const days = daysBetween(from, to);
    if (days.length > MAX_DAYS) {
      return res.status(400).json({ error: `El rango no puede superar ${MAX_DAYS} días.` });
    }

    // Marcas del periodo en esta obra (incluye trabajadores ya trasladados o de baja).
    const marksRs = await db.execute({
      sql: `SELECT a.workerId, a.day, a.status, a.paidAt, a.paidAmount,
                   w.fullName, w.trade, w.active,
                   ${RATE_SQL} AS rate
              FROM attendance a
              JOIN workers w ON w.id = a.workerId
             WHERE a.siteId = ? AND a.day >= ? AND a.day <= ?`,
      args: [siteId, from, to],
    });

    // Personal activo hoy en la obra (para que aparezca aunque no tenga ni una marca).
    const activeRs = await db.execute({
      sql: `SELECT id, fullName, trade FROM workers WHERE siteId = ? AND active = 1`,
      args: [siteId],
    });

    // Abonos TODAVIA sin descontar. No se acotan al inicio del rango: un adelanto
    // de la semana pasada que quedo pendiente sigue restando de lo que hay que
    // pagarle hoy.
    const advRs = await db.execute({
      sql: `SELECT a.workerId, COALESCE(SUM(a.amount), 0) t, w.fullName, w.trade, w.active
              FROM advances a
              JOIN workers w ON w.id = a.workerId
             WHERE a.siteId = ? AND a.day <= ? AND a.settledAt IS NULL
             GROUP BY a.workerId, w.fullName, w.trade, w.active`,
      args: [siteId, to],
    });

    const byWorker = new Map();
    const ensureRow = (id, fullName, trade, active) => {
      let r = byWorker.get(id);
      if (!r) {
        r = {
          workerId: id, fullName, trade: trade || null, active: Number(active),
          P: 0, M: 0, A: 0, worked: 0,
          earned: 0, paid: 0, advances: 0, pending: 0,
          rate: null,              // jornal vigente al final del rango (informativo)
          marks: {},
        };
        byWorker.set(id, r);
      }
      return r;
    };

    for (const w of activeRs.rows) ensureRow(Number(w.id), w.fullName, w.trade, 1);
    for (const m of marksRs.rows) {
      const r = ensureRow(Number(m.workerId), m.fullName, m.trade, m.active);
      const st = m.status;
      if (!(st in DAY_VALUE)) continue;

      const esPagado = !!m.paidAt;
      // Ya pagado -> vale lo congelado. Todavia no -> el jornal vigente ese dia.
      const monto = esPagado
        ? Number(m.paidAmount || 0)
        : Number(m.rate || 0) * DAY_VALUE[st];

      r.marks[m.day] = { s: st, paid: esPagado ? 1 : 0, amount: round2(monto) };
      r[st] += 1;
      r.worked += DAY_VALUE[st];
      r.earned += monto;
      if (esPagado) r.paid += monto;
      if (m.rate != null) r.rate = Number(m.rate);
    }

    for (const a of advRs.rows) {
      const r = ensureRow(Number(a.workerId), a.fullName, a.trade, a.active);
      r.advances = Number(a.t);
    }

    for (const r of byWorker.values()) {
      r.worked = round2(r.worked);
      r.earned = round2(r.earned);
      r.paid = round2(r.paid);
      r.advances = round2(r.advances);
      // Lo que hay que entregarle: lo trabajado, menos lo ya liquidado, menos lo
      // que se le adelanto y sigue sin descontar.
      r.pending = round2(r.earned - r.paid - r.advances);
    }

    const rows = [...byWorker.values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName, "es", { sensitivity: "base" })
    );
    const totals = rows.reduce((t, r) => ({
      P: t.P + r.P, M: t.M + r.M, A: t.A + r.A,
      worked: round2(t.worked + r.worked),
      earned: round2(t.earned + r.earned),
      paid: round2(t.paid + r.paid),
      advances: round2(t.advances + r.advances),
      pending: round2(t.pending + r.pending),
    }), { P: 0, M: 0, A: 0, worked: 0, earned: 0, paid: 0, advances: 0, pending: 0 });

    return res.status(200).json({ siteId, from, to, days, rows, totals });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

// Los montos se acumulan sumando flotantes, asi que se redondea a 2 decimales
// para que no aparezca un 0.30000000000000004 en el total.
const round2 = (n) => Math.round(n * 100) / 100;

// Lista de fechas YYYY-MM-DD entre from y to, inclusive (aritmetica en UTC para
// que no la afecte el horario de verano).
function daysBetween(from, to) {
  const out = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
    if (out.length > 400) break;   // cinturon de seguridad
  }
  return out;
}
