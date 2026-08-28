# Asistencia en Obra

PWA para llevar la asistencia diaria del personal de una obra y saber **cuántos días trabajó cada albañil** en un período.

El **capataz pasa lista** desde su celular: por cada trabajador marca *Presente*, *Medio día* o *Falta* (con motivo). Los albañiles **no necesitan cuenta ni celular**.

---

## Cómo funciona

| Rol | Puede |
|---|---|
| **Administrador** | Todo: crear obras, dar de alta/baja personal, crear capataces, pasar lista y ver reportes |
| **Capataz** | Pasar lista y ver reportes de cualquier obra |

**Arranque**: la primera vez, la base está vacía y **el primer usuario que entra queda creado como administrador**. Después de eso el registro público se cierra: los usuarios nuevos los crea el admin desde *Ajustes → Usuarios*.

### Cálculo de días trabajados

| Marca | Vale |
|---|---|
| `P` Presente | **1** día |
| `M` Medio día | **0,5** día |
| `A` Falta | **0** |

Sin marcar ≠ falta: un día sin marcar simplemente no suma (útil para domingos o días que la obra no operó).

---

## Stack

Igual que `marcador-vivo`, sin build ni framework:

- **Front**: un solo `index.html` (HTML + CSS + JS vanilla) + PWA (`manifest.webmanifest`, `sw.js`). Tema claro/oscuro, con opción **Automático** que sigue al sistema (se guarda por dispositivo en `localStorage`)
- **Back**: funciones serverless de Vercel en `api/*.js` (ESM, `export default handler`)
- **DB**: **Turso / libSQL** (SQLite). En local cae solo a `data/asistencia.db` si no hay credenciales
- **Auth**: propia — scrypt (`salt:hash`) + `sessionToken` en el header `x-session-token`. Lockout de 5 intentos / 15 min
- **Esquema**: se auto-crea con `ensureSchema()` (`CREATE TABLE IF NOT EXISTS`). No hay migraciones

### Funciones serverless (5 de las 12 del plan Hobby)

| Endpoint | Qué hace |
|---|---|
| `api/auth.js` | Login, arranque del primer admin, gestión de usuarios |
| `api/sites.js` | Obras |
| `api/workers.js` | Personal de cada obra |
| `api/attendance.js` | Pasar lista de un día (leer y guardar) |
| `api/report.js` | Días trabajados por trabajador en un rango |

### Tablas

```
users       quienes entran a la app (admin / capataz)
sites       obras
workers     albañiles (pertenecen a una obra)
attendance  una fila por trabajador y día  ->  UNIQUE (workerId, day)
```

`attendance` guarda su propio `siteId`: si un trabajador se traslada de obra, su historial anterior **queda en la obra donde realmente trabajó**. Dar de baja a alguien no borra nada — sigue apareciendo en los reportes del período en que trabajó.

---

## Desarrollo local

```bash
npm install
node scripts/dev.mjs                    # http://localhost:3000  (base local)
node --env-file=.env scripts/dev.mjs    # http://localhost:3000  (contra Turso)
```

`scripts/dev.mjs` sirve los archivos estaticos y enruta `/api/<x>` al handler de `api/<x>.js` igual que Vercel, sin pedir login interactivo (`npx vercel dev` tambien funciona).

Sin `.env` usa el archivo `data/asistencia.db` (no se commitea). Cero cuenta, cero setup.

### Pruebas

```bash
node scripts/smoke.mjs           # corre y borra los datos de prueba
node scripts/smoke.mjs --keep    # deja datos para mirar la app (jefe / obra1234)
```

Llama a los handlers con `req`/`res` falsos, sin levantar servidor. Requiere base **vacía** (la primera prueba es el arranque del primer admin). Sirve igual contra SQLite local que contra Turso.

---

## Despliegue

1. **Crear la base en Turso** — en [turso.tech](https://turso.tech) → *Create Database* (nombre: `asistencia-obra`). Copiar la **URL** `libsql://…` y generar un **token**.
2. **Env vars en Vercel** (Project → Settings → Environment Variables):
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
3. Deploy. Entrar a la app y **crear el primer usuario** (queda como administrador).
4. Desde la app: crear la obra → agregar el personal → pasar lista.

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

---

## Pendientes / posibles mejoras

1. **Marcar sin conexión.** Hoy el service worker cachea solo el "cascarón": la app **abre** sin señal, pero no se puede cargar ni guardar la lista. En obra la conectividad suele ser mala → guardar las marcas en `localStorage` y sincronizarlas al recuperar red es la mejora de mayor impacto.
2. **Jornal y liquidación.** La columna `workers.dailyRate` ya existe sin uso. Falta la UI y multiplicar por `worked` en el reporte.
3. **Capataces por obra.** Hoy cualquier usuario ve todas las obras. Si hacen falta permisos por obra, agregar una tabla `site_users`.
4. **Horas extras.** El modelo es por jornada (1 / 0,5 / 0). Si se necesitan horas reales, agregar columnas de entrada/salida a `attendance`.
5. **Feriados.** Marcar un día como no laborable para toda la obra de una vez, en lugar de trabajador por trabajador.
