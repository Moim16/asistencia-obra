// =============================================================================
//  La fecha de la obra.
//
//  Todo el sistema trabaja con la hora de NICARAGUA (America/Managua, UTC-6 todo
//  el año, sin horario de verano). Da igual donde este el servidor o como tenga
//  configurado el celular el capataz: "hoy" significa lo mismo para todos.
//
//  Antes se usaba UTC en el servidor y la hora del dispositivo en la app. De
//  tarde en Nicaragua ya es el dia siguiente en UTC, asi que las dos no
//  coincidian y un jornal fechado "hoy" empezaba a regir manana.
// =============================================================================

export const TZ = "America/Managua";

// "en-CA" formatea como YYYY-MM-DD, que es justo como se guardan las fechas.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

// Fecha de hoy en la obra, en YYYY-MM-DD.
export const today = (d = new Date()) => fmt.format(d);
