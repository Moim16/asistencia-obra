// =============================================================================
//  Datos de ejemplo para las capturas de la guia.
//
//    node scripts/demo.mjs
//
//  Deja la base local con una empresa, una obra y una cuadrilla creibles, con
//  la semana ya pasada, un abono y todo encendido. Sirve para volver a tomar las
//  capturas cuando cambie el diseno, sin tener que inventar datos a mano ni
//  usar los de una obra de verdad.
//
//  Entrar con:  jefe / demo1234
// =============================================================================

import { db, ensureSchema, nowIso, newRecoveryCode, normalizeRecovery } from "../lib/db.js";
import { hashPassword, newToken } from "../lib/auth.js";
import { today } from "../lib/day.js";

await ensureSchema();

for (const t of ["advances", "attendance_signs", "payment_signs", "attendance", "worker_rates",
                 "workers", "site_users", "sites", "users", "accounts"]) {
  await db.execute(`DELETE FROM ${t}`);
}

const ahora = nowIso();
const dia = (n) => {
  const [y, m, d] = today().split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};

const acc = await db.execute({
  sql: `INSERT INTO accounts (name, createdAt) VALUES (?, ?)`,
  args: ["Constructora Los Pinos", ahora],
});
const accountId = Number(acc.lastInsertRowid);

// El admin con su codigo de recuperacion, para poder probar tambien esa puerta.
const codigoRec = newRecoveryCode();
await db.execute({
  sql: `INSERT INTO users (name, fullName, role, passwordHash, accountId, createdAt, recoveryHash, recoveryAt)
        VALUES (?, ?, 'admin', ?, ?, ?, ?, ?)`,
  args: ["jefe", "Marlon Obando", hashPassword("demo1234"), accountId, ahora,
         hashPassword(normalizeRecovery(codigoRec)), ahora],
});
await db.execute({
  sql: `INSERT INTO users (name, fullName, role, passwordHash, accountId, createdAt)
        VALUES (?, ?, 'foreman', ?, ?, ?)`,
  args: ["capataz", "Elvin Sequeira", hashPassword("demo1234"), accountId, ahora],
});

const obra = await db.execute({
  sql: `INSERT INTO sites (name, address, accountId, useSignature, useQr, useSignPay, createdAt)
        VALUES (?, ?, ?, 1, 1, 1, ?)`,
  args: ["Residencial Las Colinas", "Km 12 Carretera Masaya", accountId, ahora],
});
const siteId = Number(obra.lastInsertRowid);
await db.execute({
  sql: `INSERT INTO sites (name, address, accountId, createdAt) VALUES (?, ?, ?, ?)`,
  args: ["Bodega Tipitapa", "Zona Franca, Tipitapa", accountId, ahora],
});

// Cuadrilla, con su pago por dia vigente desde hace un mes.
const cuadrilla = [
  ["Juan Pérez Mendoza", "Maestro de obra", "001-150478-0001K", 900],
  ["Marvin López Ruiz", "Albañil", "001-220889-0003M", 700],
  ["Douglas Sequeira", "Albañil", "", 700],
  ["Yader Martínez Cruz", "Ayudante", "001-030595-0012B", 500],
  ["Elvin Gutiérrez", "Peón", "", 450],
];

const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codigo = () => Array.from({ length: 16 }, () =>
  ALFABETO[Math.floor(Math.random() * ALFABETO.length)]).join("");

const ids = [];
for (const [nombre, oficio, doc, pago] of cuadrilla) {
  const w = await db.execute({
    sql: `INSERT INTO workers (siteId, fullName, docId, trade, qrCode, createdAt)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [siteId, nombre, doc || null, oficio, codigo(), ahora],
  });
  const id = Number(w.lastInsertRowid);
  ids.push(id);
  await db.execute({
    sql: `INSERT INTO worker_rates (workerId, amount, fromDay, createdAt) VALUES (?, ?, ?, ?)`,
    args: [id, pago, dia(-30), ahora],
  });
}

// La semana: casi todos completos, con un medio dia y una falta por lluvia.
const semana = [
  [dia(-4), ["P", "P", "P", "P", "P"]],
  [dia(-3), ["P", "P", "P", "M", "P"]],
  [dia(-2), ["P", "P", "A", "P", "P"]],
  [dia(-1), ["P", "P", "P", "P", "P"]],
  [dia(0),  ["P", "P", "P", "P", null]],
];
for (const [d, estados] of semana) {
  for (let i = 0; i < estados.length; i++) {
    if (!estados[i]) continue;
    await db.execute({
      sql: `INSERT INTO attendance (siteId, workerId, day, status, reason, markedBy, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      args: [siteId, ids[i], d, estados[i],
             estados[i] === "A" ? "Lluvia" : estados[i] === "M" ? "Permiso" : null, ahora, ahora],
    });
  }
}

// Un adelanto, para que se vea la pestana de pagos con algo real.
await db.execute({
  sql: `INSERT INTO advances (siteId, workerId, day, amount, note, createdBy, createdAt)
        VALUES (?, ?, ?, ?, ?, 1, ?)`,
  args: [siteId, ids[1], dia(-2), 1000, "Adelanto medicina", ahora],
});

console.log("Datos de ejemplo listos.");
console.log("  Empresa: Constructora Los Pinos");
console.log("  Obra:    Residencial Las Colinas (firma, carnets y firma de recibido encendidos)");
console.log("  Entrar:  jefe / demo1234");
console.log(`  Codigo de recuperacion de jefe: ${codigoRec}`);
