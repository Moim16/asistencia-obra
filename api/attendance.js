// =============================================================================
//  Pasar lista.
//
//  GET  /api/attendance?siteId=&day=YYYY-MM-DD
//       -> { day, workers:[{ id, fullName, trade, status, reason, note }], summary }
//          Devuelve TODO el personal activo de la obra, con su marca del dia si ya
//          la tiene (status null = todavia sin marcar).
//
//  GET  /api/attendance?siteId=&day=&sign=<workerId>
//       -> la firma de ese trabajador ese dia (imagen), para verla o imprimirla.
//
//  GET  /api/attendance?siteId=&signs=<workerId>&from=&to=
//       -> todas sus firmas del periodo, en UNA llamada. Es lo que necesita el
//          PDF del trabajador: pedirlas dia por dia serian 7 idas y vueltas.
//
//  POST /api/attendance { siteId, day, marks:[{ workerId, status, reason, note, sign }] }
//       -> guarda la lista del dia (una marca por trabajador; vuelve a guardar
//          encima si se corrige). status: 'P' presente, 'M' medio dia, 'A' ausente.
//          Un status vacio o desconocido BORRA la marca (dejar sin marcar).
//
//          `sign` es la firma del trabajador (data URI JPEG). Viaja junto con la
//          marca y no por separado: asi la cola de "sin conexion" la arrastra
//          sola, sin plomeria extra. La firma se BORRA si el dia pasa a falta o
//          queda sin marcar: firmar una ausencia no significa nada.
//
//  Cualquier usuario con sesion puede pasar lista; queda registrado en `markedBy`.
// =============================================================================

import { db, ensureSchema, nowIso, STATUSES } from "../lib/db.js";
import { readJson, clean, parseDay, parseId, parseDataJpeg } from "../lib/http.js";
import { currentUser, deny, notYours, canSeeSite } from "../lib/auth.js";
import { today } from "../lib/day.js";

const MAX_SIGN = 250 * 1024;   // el navegador la manda chica; esto es el tope duro

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
      if (!day && !req.query?.signs) return res.status(400).json({ error: "Fecha inválida (usa YYYY-MM-DD)." });
      // Todas las firmas de un trabajador en un rango (para el PDF).
      const signsOf = parseId(req.query?.signs);
      if (signsOf) {
        const from = parseDay(req.query?.from), to = parseDay(req.query?.to);
        if (!siteId) return res.status(400).json({ error: "siteId inválido." });
        if (!from || !to) return res.status(400).json({ error: "Fechas inválidas (usa YYYY-MM-DD)." });
        if (!(await canSeeSite(me, siteId))) return notYours(res);
        const rs = await db.execute({
          sql: `SELECT day, image, signedAt FROM attendance_signs
                 WHERE workerId = ? AND siteId = ? AND day >= ? AND day <= ?
                 ORDER BY day`,
          args: [signsOf, siteId, from, to],
        });
        return res.status(200).json({
          signs: Object.fromEntries(rs.rows.map((r) => [r.day, r.image])),
        });
      }

      if (!(await canSeeSite(me, siteId))) return notYours(res);

      // Una firma concreta, pedida a proposito para verla o imprimirla.
      const signOf = parseId(req.query?.sign);
      if (signOf) {
        const rs = await db.execute({
          sql: `SELECT image, signedAt FROM attendance_signs WHERE workerId = ? AND day = ? AND siteId = ?`,
          args: [signOf, day, siteId],
        });
        if (!rs.rows.length) return res.status(404).json({ error: "Sin firma." });
        return res.status(200).json({ image: rs.rows[0].image, signedAt: rs.rows[0].signedAt });
      }

      // Personal activo + su marca del dia (LEFT JOIN: los no marcados vienen en null).
      // El JOIN filtra tambien por obra: si un trabajador fue trasladado y ese dia
      // tiene una marca de SU OBRA ANTERIOR, aqui debe salir "sin marcar", igual que
      // en el reporte de esta obra. Si no, la lista y el reporte se contradicen.
      // `signed` es un booleano, no la imagen: la lista del dia se pide todo el
      // tiempo y no tiene por que cargar con las firmas.
      const rs = await db.execute({
        sql: `SELECT w.id, w.fullName, w.trade,
                     w.qrCode,
                     a.status, a.reason, a.note, a.updatedAt,
                     u.name AS markedByName,
                     (s.workerId IS NOT NULL) AS signed
                FROM workers w
                LEFT JOIN attendance a ON a.workerId = w.id AND a.day = ? AND a.siteId = ?
                LEFT JOIN attendance_signs s ON s.workerId = w.id AND s.day = ? AND s.siteId = ?
                LEFT JOIN users u ON u.id = a.markedBy
               WHERE w.siteId = ? AND w.active = 1
               ORDER BY w.fullName COLLATE NOCASE`,
        args: [day, siteId, day, siteId, siteId],
      });

      const workers = rs.rows.map((w) => ({
        id: Number(w.id), fullName: w.fullName, trade: w.trade,
        // El codigo del carnet viaja con la lista para poder escanear SIN
        // CONEXION: en obra no se puede depender de consultar al servidor por
        // cada escaneo. No es un secreto: quien pasa lista ya puede marcar a
        // mano a quien quiera, asi que tenerlo no le da ningun poder extra.
        qrCode: w.qrCode || null,
        status: w.status || null, reason: w.reason || null, note: w.note || null,
        updatedAt: w.updatedAt || null, markedByName: w.markedByName || null,
        signed: !!Number(w.signed),
      }));
      const summary = {
        total: workers.length,
        P: workers.filter((w) => w.status === "P").length,
        M: workers.filter((w) => w.status === "M").length,
        A: workers.filter((w) => w.status === "A").length,
      };
      summary.pending = summary.total - summary.P - summary.M - summary.A;
      // Cuantos trabajaron y todavia no firman: es lo que hay que ir a buscar.
      summary.unsigned = workers.filter((w) => (w.status === "P" || w.status === "M") && !w.signed).length;
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
      if (!(await canSeeSite(me, siteId))) return notYours(res);
      if (marks.length > 500) return res.status(400).json({ error: "Demasiadas marcas en una sola llamada." });

      // No se puede pasar lista del futuro. Sin tolerancias: servidor y app usan
      // la misma fecha (hora de Nicaragua), asi que la comparacion es exacta.
      if (day > today()) return res.status(400).json({ error: "No se puede pasar lista de una fecha futura." });

      // Solo se aceptan trabajadores que pertenecen a esta obra (evita marcar ajenos).
      const valid = new Set(
        (await db.execute({ sql: `SELECT id FROM workers WHERE siteId = ? AND active = 1`, args: [siteId] }))
          .rows.map((r) => Number(r.id))
      );

      const now = nowIso();
      const stmts = [];
      let saved = 0, cleared = 0, signed = 0;

      for (const m of marks) {
        const workerId = parseId(m?.workerId);
        if (!workerId || !valid.has(workerId)) continue;
        const status = (m?.status ?? "").toString().toUpperCase();

        if (!STATUSES.includes(status)) {
          // Sin estado valido -> se quita la marca (queda "sin marcar") y con ella
          // la firma: firmar un dia que no se trabajo no significa nada.
          stmts.push({ sql: `DELETE FROM attendance WHERE workerId = ? AND day = ?`, args: [workerId, day] });
          stmts.push({ sql: `DELETE FROM attendance_signs WHERE workerId = ? AND day = ?`, args: [workerId, day] });
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

        // Firma. Solo tiene sentido si el dia se trabajo: en una falta se borra.
        if (status === "A") {
          stmts.push({ sql: `DELETE FROM attendance_signs WHERE workerId = ? AND day = ?`, args: [workerId, day] });
          continue;
        }
        if (!("sign" in (m || {}))) continue;          // no se toca lo que ya hubiera
        const sign = parseDataJpeg(m.sign, MAX_SIGN, "La firma");
        if (!sign.ok) return res.status(400).json({ error: sign.error });
        if (sign.value === null) {
          stmts.push({ sql: `DELETE FROM attendance_signs WHERE workerId = ? AND day = ?`, args: [workerId, day] });
        } else {
          stmts.push({
            sql: `INSERT INTO attendance_signs (workerId, day, siteId, image, signedAt, signedBy)
                       VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT (workerId, day) DO UPDATE SET
                       siteId = excluded.siteId, image = excluded.image,
                       signedAt = excluded.signedAt, signedBy = excluded.signedBy`,
            args: [workerId, day, siteId, sign.value, now, me.id],
          });
          signed++;
        }
      }

      if (stmts.length) await db.batch(stmts, "write");
      return res.status(200).json({ ok: true, saved, cleared, signed, day });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
