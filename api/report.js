// =============================================================================
//  Reporte de dias trabajados.
//
//  GET /api/report?siteId=&from=YYYY-MM-DD&to=YYYY-MM-DD
//   -> { from, to, days:[...],
//        rows:[{ workerId, fullName, trade, active, P, M, A, worked, marks:{day:status} }],
//        totals:{ P, M, A, worked } }
//
//  "worked" = dias trabajados = P * 1 + M * 0.5 (los ausentes no suman).
//
//  Incluye a quien ya NO esta activo pero SI tuvo marcas en el rango (una baja a
//  mitad de mes tiene que seguir apareciendo en la liquidacion del mes).
// =============================================================================

import { db, ensureSchema, DAY_VALUE } from "../lib/db.js";
import { parseDay, parseId } from "../lib/http.js";
import { currentUser, deny } from "../lib/auth.js";

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
    if (from > to) return res.status(400).json({ error: "La fecha inicial es posterior a la final." });

    const days = daysBetween(from, to);
    if (days.length > MAX_DAYS) {
      return res.status(400).json({ error: `El rango no puede superar ${MAX_DAYS} días.` });
    }

    // Marcas del periodo en esta obra (incluye trabajadores ya trasladados o de baja).
    const marksRs = await db.execute({
      sql: `SELECT a.workerId, a.day, a.status, w.fullName, w.trade, w.active
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

    const byWorker = new Map();
    const ensureRow = (id, fullName, trade, active) => {
      let r = byWorker.get(id);
      if (!r) {
        r = { workerId: id, fullName, trade: trade || null, active: Number(active), P: 0, M: 0, A: 0, worked: 0, marks: {} };
        byWorker.set(id, r);
      }
      return r;
    };

    for (const w of activeRs.rows) ensureRow(Number(w.id), w.fullName, w.trade, 1);
    for (const m of marksRs.rows) {
      const r = ensureRow(Number(m.workerId), m.fullName, m.trade, m.active);
      const st = m.status;
      if (!(st in DAY_VALUE)) continue;
      r.marks[m.day] = st;
      r[st] += 1;
      r.worked += DAY_VALUE[st];
    }

    const rows = [...byWorker.values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName, "es", { sensitivity: "base" })
    );
    const totals = rows.reduce(
      (t, r) => ({ P: t.P + r.P, M: t.M + r.M, A: t.A + r.A, worked: +(t.worked + r.worked).toFixed(1) }),
      { P: 0, M: 0, A: 0, worked: 0 }
    );

    return res.status(200).json({ siteId, from, to, days, rows, totals });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

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
