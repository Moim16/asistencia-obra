// =============================================================================
//  Pasar lista.
//
//  GET  /api/attendance?siteId=&day=YYYY-MM-DD
//       -> { day, workers:[{ id, fullName, trade, status, reason, note }], summary }
//          Devuelve TODO el personal activo de la obra, con su marca del dia si ya
//          la tiene (status null = todavia sin marcar).
//
//  POST /api/attendance { siteId, day, marks:[{ workerId, status, reason, note }] }
//       -> guarda la lista del dia (una marca por trabajador; vuelve a guardar
//          encima si se corrige). status: 'P' presente, 'M' medio dia, 'A' ausente.
//          Un status vacio o desconocido BORRA la marca (dejar sin marcar).
//
//  Cualquier usuario con sesion puede pasar lista; queda registrado en `markedBy`.
// =============================================================================

import { db, ensureSchema, nowIso, STATUSES } from "../lib/db.js";
import { readJson, clean, parseDay, parseId } from "../lib/http.js";
import { currentUser, deny } from "../lib/auth.js";

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "GET" ? {} : await readJson(req);
    const me = await currentUser(req, body);
    if (!me) return deny(res);

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      const siteId = parseId(req.query?.siteId);
      const day = parseDay(req.query?.day);
      if (!siteId) return res.status(400).json({ error: "siteId inválido." });
      if (!day) return res.status(400).json({ error: "Fecha inválida (usa YYYY-MM-DD)." });

      // Personal activo + su marca del dia (LEFT JOIN: los no marcados vienen en null).
      // El JOIN filtra tambien por obra: si un trabajador fue trasladado y ese dia
      // tiene una marca de SU OBRA ANTERIOR, aqui debe salir "sin marcar", igual que
      // en el reporte de esta obra. Si no, la lista y el reporte se contradicen.
      const rs = await db.execute({
        sql: `SELECT w.id, w.fullName, w.trade,
                     a.status, a.reason, a.note, a.updatedAt,
                     u.name AS markedByName
                FROM workers w
                LEFT JOIN attendance a ON a.workerId = w.id AND a.day = ? AND a.siteId = ?
                LEFT JOIN users u ON u.id = a.markedBy
               WHERE w.siteId = ? AND w.active = 1
               ORDER BY w.fullName COLLATE NOCASE`,
        args: [day, siteId, siteId],
      });

      const workers = rs.rows.map((w) => ({
        id: Number(w.id), fullName: w.fullName, trade: w.trade,
        status: w.status || null, reason: w.reason || null, note: w.note || null,
        updatedAt: w.updatedAt || null, markedByName: w.markedByName || null,
      }));
      const summary = {
        total: workers.length,
        P: workers.filter((w) => w.status === "P").length,
        M: workers.filter((w) => w.status === "M").length,
        A: workers.filter((w) => w.status === "A").length,
      };
      summary.pending = summary.total - summary.P - summary.M - summary.A;
      return res.status(200).json({ day, siteId, workers, summary });
    }

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const siteId = parseId(body.siteId);
      const day = parseDay(body.day);
      const marks = Array.isArray(body.marks) ? body.marks : null;
      if (!siteId) return res.status(400).json({ error: "siteId inválido." });
      if (!day) return res.status(400).json({ error: "Fecha inválida (usa YYYY-MM-DD)." });
      if (!marks) return res.status(400).json({ error: "Falta la lista de marcas." });
      if (marks.length > 500) return res.status(400).json({ error: "Demasiadas marcas en una sola llamada." });

      // No se puede pasar lista del futuro. Tolerancia de 1 dia porque el navegador
      // manda la fecha LOCAL de la obra y el servidor razona en UTC.
      const limit = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      if (day > limit) return res.status(400).json({ error: "No se puede pasar lista de una fecha futura." });

      // Solo se aceptan trabajadores que pertenecen a esta obra (evita marcar ajenos).
      const valid = new Set(
        (await db.execute({ sql: `SELECT id FROM workers WHERE siteId = ? AND active = 1`, args: [siteId] }))
          .rows.map((r) => Number(r.id))
      );

      const now = nowIso();
      const stmts = [];
      let saved = 0, cleared = 0;

      for (const m of marks) {
        const workerId = parseId(m?.workerId);
        if (!workerId || !valid.has(workerId)) continue;
        const status = (m?.status ?? "").toString().toUpperCase();

        if (!STATUSES.includes(status)) {
          // Sin estado valido -> se quita la marca (queda "sin marcar").
          stmts.push({ sql: `DELETE FROM attendance WHERE workerId = ? AND day = ?`, args: [workerId, day] });
          cleared++;
          continue;
        }
        // El motivo solo tiene sentido cuando no es una jornada completa.
        const reason = status === "P" ? null : clean(m?.reason, 40);
        stmts.push({
          sql: `INSERT INTO attendance (siteId, workerId, day, status, reason, note, markedBy, createdAt, updatedAt)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (workerId, day) DO UPDATE SET
                     siteId = excluded.siteId, status = excluded.status,
                     reason = excluded.reason, note = excluded.note,
                     markedBy = excluded.markedBy, updatedAt = excluded.updatedAt`,
          args: [siteId, workerId, day, status, reason, clean(m?.note, 120), me.id, now, now],
        });
        saved++;
      }

      if (stmts.length) await db.batch(stmts, "write");
      return res.status(200).json({ ok: true, saved, cleared, day });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
