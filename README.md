# Asistencia en Obra

PWA para llevar la asistencia diaria del personal de una obra, saber **cuántos días trabajó cada albañil** y **cuánto hay que pagarle**.

El **capataz pasa lista** desde su celular: por cada trabajador marca *Presente*, *Medio día* o *Falta* (con motivo). Los albañiles **no necesitan cuenta ni celular**.

---

## Cómo funciona

### Empresas, usuarios y permisos

Cada empresa es una **cuenta aislada**: sus obras, su personal y sus usuarios. Un admin nunca ve nada de otra empresa.

| Rol | Puede |
|---|---|
| **Administrador** | Todo lo de SU empresa: crear obras, dar de alta/baja personal, fijar el pago por día, registrar pagos, crear usuarios y asignarles obras |
| **Capataz** | Pasar lista y ver reportes **solo de las obras que le asignaron**. Sin asignaciones no ve ninguna |

Para empezar, en la pantalla de entrada se usa **Crear cuenta**: se registra la empresa y su primer administrador. Después, los usuarios nuevos los crea ese admin desde *Ajustes → Usuarios del sistema*, marcando qué obras verá cada uno.

Con `ALLOW_SIGNUP=0` se cierra el registro público (la primera cuenta siempre se puede crear, para no quedar sin forma de entrar).

### Días trabajados

| Marca | Vale |
|---|---|
| `P` Presente | **1** día |
| `M` Medio día | **0,5** día |
| `A` Falta | **0** |

Sin marcar ≠ falta: un día sin marcar simplemente no suma (útil para domingos o días que la obra no operó).

### Pago por día

Cada trabajador tiene su **pago por día completo**, y **medio día paga la mitad**. Se guarda con **historial por fecha de vigencia**: se le puede subir el pago a alguien a partir del próximo lunes sin tocar lo que ya trabajó, porque cada día se paga al monto que regía *ese día*.

> **El primer monto cubre hacia atrás.** Si un día es anterior a la primera tarifa registrada, se paga igual con esa primera tarifa. Lo normal es marcar días y recién después cargar cuánto gana la persona; sin esta regla esos días quedarían en cero. Los cambios **programados hacia adelante** sí valen solo desde su fecha.

En *Reporte → Pagos* se ve, por trabajador, lo **ganado**, lo **pagado** y lo **pendiente**, y desde ahí se marca un período como pagado.

> **Al pagar, el monto se congela.** Queda registrado lo que de verdad se le pagó ese día. Si después le subes el pago por día, lo ya pagado no se reescribe.

### Reportes: PDF y WhatsApp

- **Reporte de la obra** en PDF: todos los trabajadores con días, ganado, pagado y pendiente. También en CSV.
- **Detalle por trabajador** en PDF: resumen con lo que le toca recibir y el día a día con montos.
- **Enviar por WhatsApp**: en el celular abre el menú de compartir con el PDF adjunto; donde no se puede adjuntar (computador), manda un resumen en texto con los días trabajados y el total a recibir.

El PDF se genera **sin ninguna librería externa** (ver `MiniPdf` en `index.html`): no hay que tocar el CSP, no hay cientos de KB que bajar y funciona sin señal. Usa las fuentes Helvetica que ya trae todo lector de PDF, con codificación WinAnsi (soporta tildes y eñes).

### La fecha de la obra

Todo el sistema usa la hora de **Nicaragua** (`America/Managua`, UTC-6 todo el año), en el servidor y en la app. No se usa la zona del teléfono: un equipo mal configurado marcaría el día equivocado. Los montos van en **córdobas (C$)**.

### Sin conexión

En obra la señal es mala, así que **pasar lista no depende de la red**:

- Lo que se ve se guarda en el teléfono (obras y estado del día por fecha).
- Lo que se marca sin red va a una **cola** y se envía sola al recuperar la señal (o con el botón *Sincronizar*).
- Si el envío falla, la marca **se conserva** y se reintenta: nunca se descarta en silencio.
- Una barra de estado avisa cuándo hay algo sin enviar.

El reporte y la gestión de personal sí necesitan conexión.

---

## Stack

Igual que `marcador-vivo`, sin build ni framework:

- **Front**: un solo `index.html` (HTML + CSS + JS vanilla) + PWA (`manifest.webmanifest`, `sw.js`). Tema claro/oscuro con opción **Automático**
- **Back**: funciones serverless de Vercel en `api/*.js` (ESM, `export default handler`)
- **DB**: **Turso / libSQL** (SQLite). En local cae solo a `data/asistencia.db` si no hay credenciales
- **Auth**: propia — scrypt (`salt:hash`) + `sessionToken` en el header `x-session-token`. Lockout de 5 intentos / 15 min
- **Esquema**: se auto-crea con `ensureSchema()` (`CREATE TABLE IF NOT EXISTS` + `ALTER` idempotentes). No hay migraciones

### Funciones serverless (6 de las 12 del plan Hobby)

| Endpoint | Qué hace |
|---|---|
| `api/auth.js` | Alta de empresa, login, usuarios y asignación de obras |
| `api/sites.js` | Obras |
| `api/workers.js` | Personal y pago por día (con historial) |
| `api/attendance.js` | Pasar lista de un día (leer y guardar) |
| `api/report.js` | Días trabajados y montos por período |
| `api/payments.js` | Marcar días como pagados (y deshacer) |

### Tablas

```
accounts      empresas (el cerco duro: nadie ve fuera de la suya)
users         quienes entran a la app (admin / capataz)
site_users    qué obras ve cada capataz
sites         obras
workers       albañiles (pertenecen a una obra)
worker_rates  pago por día del trabajador, vigente DESDE una fecha
attendance    una fila por trabajador y día  ->  UNIQUE (workerId, day)
              paidAt / paidAmount = pago, con el monto congelado
```

Dos decisiones que importan para la liquidación:

- `attendance` guarda su propio `siteId`: si un trabajador se traslada, su historial **queda en la obra donde realmente trabajó**.
- Dar de baja a alguien no borra nada — sigue apareciendo en los reportes del período en que trabajó.

---

## Desarrollo local

```bash
npm install
node scripts/dev.mjs                    # http://localhost:3000  (base local)
node --env-file=.env scripts/dev.mjs    # http://localhost:3000  (contra Turso)
```

`scripts/dev.mjs` sirve los archivos estáticos y enruta `/api/<x>` al handler de `api/<x>.js` igual que Vercel, sin pedir login interactivo (`npx vercel dev` también funciona).

Sin `.env` usa el archivo `data/asistencia.db` (no se commitea). Cero cuenta, cero setup.

### Pruebas

```bash
node scripts/smoke.mjs           # corre y borra los datos de prueba
node scripts/smoke.mjs --keep    # deja datos para mirar la app (jefe / obra1234)
```

74 pruebas contra los handlers reales, sin levantar servidor. Requiere base **vacía**. Cubren, entre otras cosas, que una empresa no pueda tocar los datos de otra, que un capataz solo vea sus obras, que cada día se pague al monto que regía ese día, que subir el pago no reescriba lo ya pagado, y que los dias marcados antes de cargar el pago igual se paguen.

---

## Despliegue

1. **Crear la base en Turso** — en [turso.tech](https://turso.tech) → *Create Database*. Copiar la **URL** `libsql://…` y generar un **token**.
2. **Importar el repo en Vercel** ([vercel.com/new](https://vercel.com/new)) con *Framework Preset* = **Other**, sin Build Command ni Output Directory.
3. **Environment Variables**: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` y, si quieres cerrar el registro, `ALLOW_SIGNUP=0`.
4. Deploy → abrir la URL → **Crear cuenta** con el nombre de la empresa.
5. Desde la app: crear la obra → agregar el personal con su pago por día → pasar lista.

`vercel.json` ya trae las cabeceras de seguridad (CSP, X-Frame-Options, nosniff, etc.).

---

## Convenciones

**Estilo minimalista, dos temas.** Todo el color sale de tokens CSS en `:root`. El tema oscuro se define dos veces (una bajo `prefers-color-scheme: dark` para el automático, otra bajo `:root[data-theme="dark"]` para la elección manual) porque en CSS puro no hay forma de compartir el bloque. Reglas:

- Usar siempre los tokens (`--ink`, `--muted`, `--line`, `--card`…), nunca un color literal. Lo que va encima de `--ink` usa `--on-ink`.
- El color con significado (verde / ámbar / rojo) es **solo** para el estado de la marca. El resto es blanco, negro y grises.
- Sin sombras salvo en lo que flota (diálogo y toast). La jerarquía la dan el espacio y el peso tipográfico.
- Los iconos salen de `icon("nombre")`, que arma un `<svg>` de contorno de 24x24 que hereda color y tamaño del texto.

**Nada de diálogos del navegador.** `confirm()` y `alert()` nativos se ven mal en el celular y, sobre todo, **congelan la página entera** mientras están abiertos. La app usa:

- `await ask({ title, text, ok, cancel, danger })` → promesa que resuelve `true`/`false`, para confirmar
- `toast(texto, "ok" | "err")` → aviso breve que no interrumpe

**Nunca calcular "hoy" con UTC.** Se usa `today()` de `lib/day.js` en el servidor y `todayObra()` en la app: ambos dan la fecha de Nicaragua. De tarde allá ya es el día siguiente en UTC, y un monto fechado así empezaría a regir mañana.

**Los permisos se comprueban por obra.** El personal, la asistencia y los pagos cuelgan de la obra, así que basta con `canSeeSite()` / `canSeeWorker()` de `lib/auth.js`. Quien no tiene acceso recibe **404, no 403**: no debería poder deducir que la obra existe.

**El vocabulario es el de Nicaragua.** Lo que gana el trabajador por día es el **pago por día** (no "jornal"), y los oficios del listado son los de allá (fontanero, armador, maestro de obra…).

---

## Pendientes / posibles mejoras

1. **Horas extras.** El modelo es por jornada (1 / 0,5 / 0). Si se necesitan horas reales, agregar columnas de entrada/salida a `attendance`.
2. **Feriados.** Marcar un día como no laborable para toda la obra de una vez, en lugar de trabajador por trabajador.
3. **Adelantos y descuentos.** Restar del pendiente lo que se entregó a cuenta.
4. **Recuperar contraseña.** Hoy solo el admin puede resetear la de un capataz; si el admin pierde la suya, hay que tocar la base a mano.
5. **Firma del trabajador.** Dejar constancia en el PDF de que recibió el pago.
