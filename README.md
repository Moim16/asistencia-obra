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

### Evidencia de asistencia

Dos mecanismos, **cada uno se enciende por obra** desde *Ajustes → Obras → editar*. Vienen apagados: solo los tiene quien los pide.

**Firma del trabajador.** Al marcar a alguien Presente o Medio día aparece un botón **Firmar**: se le pasa el teléfono y firma con el dedo, igual que la planilla de papel. La firma sale impresa en el PDF del trabajador, junto a su día.

**Carnet con QR.** Cada trabajador lleva su tarjeta y el capataz la escanea para marcarlo presente. Dos formas de repartirlos:

- *Personal → Carnets* — hoja en PDF con 8 tarjetas por página, para imprimir y recortar.
- *Personal → tocar al trabajador → Carnet con QR* — la tarjeta suelta como imagen, para mandársela por WhatsApp a quien no vaya a imprimirla. Desde ahí también se **renueva** el carnet si se perdió: el código anterior deja de servir.

La tarjeta lleva la **obra** destacada arriba, el nombre, el oficio y el código también en texto, por si el QR se borra o el teléfono no puede escanear.

Prueban cosas distintas: el carnet, que la tarjeta estuvo ahí; la firma, que la persona hizo un gesto en el momento. Juntos son sólidos; el carnet solo no distingue si alguien le prestó la tarjeta a un compañero.

Los dos son **opcionales por día**: se puede guardar sin ellos, y el resumen avisa cuántos trabajaron y todavía no firman.

La firma se borra sola si el día pasa a **falta** o queda **sin marcar** — firmar una ausencia no significa nada.

> **La huella dactilar no se puede hacer desde una app web.** El navegador no da acceso al sensor para leer la huella de otra persona; lo único que existe (WebAuthn) autentica al dueño del teléfono, así que probaría que el capataz estaba ahí, no el trabajador. Además solo funcionan las huellas registradas en los ajustes del teléfono (unas 5 en Android), y quien registre la suya podría desbloquear todo el equipo. Para huellas de verdad harían falta lectores físicos y una app nativa.

Detalles que importan:

- La firma viaja **junto con la marca** en el mismo `POST`, no en una llamada aparte: así la cola de "sin conexión" la arrastra sola.
- La lista del día devuelve solo un booleano `signed`, nunca las imágenes — se piden aparte cuando hay que verlas.
- El escaneo se resuelve **contra la lista que ya está en pantalla**, sin consultar al servidor: en obra no se puede depender de la red por cada carnet. Por eso el código viaja con la lista del día. No es un secreto: quien pasa lista ya puede marcar a mano a quien quiera.
- El escáner usa `BarcodeDetector`, que existe en **Chrome de Android** pero no en iPhone. Donde no está, se escribe el código a mano.

#### El codificador de QR

Los QR se generan **sin librerías** (ver la sección `QR` en `index.html`): la CSP no permite scripts de fuera, y una librería son 40 KB para algo que aquí cabe en 200 líneas. Es versión 1 (21x21), corrección M, modo alfanumérico — la más chica, sin patrón de alineación y con los módulos más grandes, o sea la más fácil de leer en una tarjeta manoseada.

`node scripts/qr-check.mjs` lo verifica sin poder decodificar: comprueba que los síndromes de Reed-Solomon den cero (un cálculo independiente del de codificar), que la información de formato para nivel M y máscara 0 valga exactamente `0x5412` como dice el estándar, que los patrones estén donde deben, y que recorriendo el zigzag al revés se recupere el texto original.

### Abonos y día de pago

El **día de pago es el sábado**. Cuando un trabajador pide plata por adelantado, se registra el **abono** desde *Reporte → Pagos → + Abono* (fecha, monto y motivo).

Un abono resta de lo que le toca cobrar mientras siga pendiente:

```
A recibir = ganado − ya pagado − abonos sin descontar
```

Al liquidar el período, los días quedan pagados **y** los abonos se marcan como descontados en la misma operación, así que deshacer el pago devuelve las dos cosas al estado anterior. Si se le adelantó más de lo que trabajó, el saldo queda **negativo**: es plata a favor de la empresa que se arrastra al período siguiente.

Un abono ya descontado no se puede borrar sin deshacer primero el pago que lo consumió — si no, las cuentas del período quedarían mintiendo.

En *Reporte → Pagos* se ve, por trabajador, lo **ganado**, los **abonos** y lo que hay **a recibir**, y desde ahí se marca un período como pagado.

> **Al pagar, el monto se congela.** Queda registrado lo que de verdad se le pagó ese día. Si después le subes el pago por día, lo ya pagado no se reescribe.

### Reportes: PDF y WhatsApp

- **Reporte de la obra** en PDF: todos los trabajadores con días, ganado, pagado y pendiente.
- **Detalle por trabajador** en PDF: resumen con lo que le toca recibir y el día a día con montos.
- **Enviar por WhatsApp**, en dos acciones separadas a propósito:
  - **Resumen** → abre WhatsApp con el mensaje ya escrito (días, ganado, abonos y total a recibir).
  - **PDF** → abre el menú de compartir con el archivo adjunto.

  Van separadas porque **WhatsApp descarta el texto cuando recibe un archivo**: mandar los dos juntos siempre perdía uno. En computador, donde no se puede adjuntar desde el navegador, el botón de PDF lo descarga y avisa.

Los dos llevan el **logo de la empresa** arriba a la derecha.

El PDF se genera **sin ninguna librería externa** (ver `MiniPdf` en `index.html`): no hay que tocar el CSP, no hay cientos de KB que bajar y funciona sin señal. Usa las fuentes Helvetica que ya trae todo lector de PDF, con codificación WinAnsi (soporta tildes y eñes), y el logo se incrusta como XObject con filtro `DCTDecode`.

### Logo de la empresa

Se carga desde *Ajustes → Empresa → Nombre y logo*, y aparece en la cabecera de la app y en los PDF. El navegador lo achica a 320px y lo convierte a **JPEG** antes de subirlo, así que lo que llega al servidor son unos pocos KB y no la foto de 4 MB del teléfono.

Es JPEG a propósito: es el único formato que se puede incrustar tal cual en un PDF, sin recomprimir nada. Se guarda como data URI en la tabla `accounts`, así que viaja con la sesión y funciona sin conexión.

### Instalar en el teléfono

La app se instala como una aplicación normal: en Android, desde *Ajustes → Aplicación → Instalar en el teléfono* (o el menú de Chrome); en iPhone, desde Safari con *Compartir → Añadir a pantalla de inicio*. La app detecta si ya está instalada y esconde la opción.

Los iconos PNG los genera `node scripts/make-icons.mjs` a partir de la misma geometría de `icon.svg`, dibujando pixel a pixel y codificando el PNG con `zlib` — sin dependencias de imagen.

> **Chrome en Android no ofrece instalar si el manifest solo trae un SVG**: exige al menos un PNG de 192x192. Ese era el motivo de que nunca apareciera la opción. El icono `maskable` va con margen porque Android lo recorta con su propia forma.

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

### Funciones serverless (7 de las 12 del plan Hobby)

| Endpoint | Qué hace |
|---|---|
| `api/auth.js` | Alta de empresa, login, usuarios y asignación de obras |
| `api/sites.js` | Obras |
| `api/workers.js` | Personal y pago por día (con historial) |
| `api/attendance.js` | Pasar lista de un día (leer y guardar), con la firma |
| `api/workers.js` | ...y el código del carnet de cada trabajador |
| `api/report.js` | Días trabajados y montos por período |
| `api/payments.js` | Marcar días como pagados (y deshacer), descontando abonos |
| `api/advances.js` | Abonos: registrar, listar y quitar |

### Tablas

```
accounts      empresas (el cerco duro: nadie ve fuera de la suya) + logo
users         quienes entran a la app (admin / capataz)
site_users    qué obras ve cada capataz
sites         obras (useSignature / useQr: la evidencia se activa por obra)
workers       albañiles (pertenecen a una obra) + qrCode del carnet
worker_rates  pago por día del trabajador, vigente DESDE una fecha
attendance    una fila por trabajador y día  ->  UNIQUE (workerId, day)
              paidAt / paidAmount = pago, con el monto congelado
attendance_signs  firma del trabajador, misma clave (workerId, day)
advances      abonos entregados por adelantado
              settledAt = cuándo se descontó (NULL = todavía pendiente)
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

130 pruebas contra los handlers reales, sin levantar servidor. Requiere base **vacía**. Cubren, entre otras cosas, que una empresa no pueda tocar los datos de otra, que un capataz solo vea sus obras, que cada día se pague al monto que regía ese día, que subir el pago no reescriba lo ya pagado, que los días marcados antes de cargar el pago igual se paguen, que los abonos se descuenten y se devuelvan bien al deshacer un pago, que la firma se borre al marcar falta o desmarcar el día, y que los carnets sean únicos y se puedan renovar.

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
4. **Recuperar contraseña.** Hoy solo el admin puede resetear la de un capataz; si el admin pierde la suya, hay que tocar la base a mano.
5. **Firma al recibir el pago.** Hoy se firma la asistencia diaria; falta que firme el sábado sobre el detalle, como comprobante de que recibió la plata.
6. **Escanear en iPhone.** `BarcodeDetector` no existe en Safari; ahí hay que escribir el código del carnet a mano. Se podría resolver con un decodificador propio, pero es bastante más código que el codificador.
7. **Foto como evidencia.** Una foto grupal diaria de la cuadrilla sería la prueba más difícil de discutir, y cuesta un solo gesto para todos.
