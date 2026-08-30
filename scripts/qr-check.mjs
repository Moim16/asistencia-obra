// =============================================================================
//  Comprobacion del codificador de QR.
//
//    node scripts/qr-check.mjs
//
//  No se puede decodificar un QR aqui (BarcodeDetector solo existe en Android y
//  no hay librerias en el proyecto), asi que se verifica cada pieza por separado
//  y de forma INDEPENDIENTE del codificador:
//
//   1. Reed-Solomon: los sindromes de la palabra codigo tienen que dar CERO.
//      Se evalua el polinomio en alfa^i, que es un calculo distinto al de
//      codificar, no el mismo repetido.
//   2. Informacion de formato: para nivel M y mascara 0 el estandar dice que
//      vale exactamente 0x5412.
//   3. Estructura: patrones de busqueda, separadores, lineas de sincronismo y
//      modulo oscuro, en las posiciones que fija la norma.
//   4. Los datos se pueden volver a leer: se recorre el zigzag al reves y se
//      tienen que recuperar los codewords originales.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Se extrae el codigo del QR desde index.html y se evalua, para probar EXACTAMENTE
// lo que corre en la app y no una copia que se desincroniza.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const ini = html.indexOf("const QR_ALFA");
const fin = html.indexOf("/* ===========================================================================\n   Vista: reporte", ini);
const fuente = html.slice(ini, fin);

const mod = await import(
  "data:text/javascript;base64," +
  Buffer.from(fuente + "\nexport { qrMatriz, qrEcc, qrFormato, GF_EXP, GF_LOG, QR_ALFA };").toString("base64")
);
const { qrMatriz, qrEcc, qrFormato, GF_EXP, GF_LOG } = mod;

let fails = 0;
const check = (nombre, ok, extra = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${nombre}${ok ? "" : "  <- " + extra}`);
  if (!ok) fails++;
};

/* --------------------------------------------------------------- 1. RS ---- */
// Sindrome: se evalua la palabra codigo en alfa^i. Si es una palabra valida,
// todos dan cero. Es un calculo INDEPENDIENTE del de codificacion.
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
function sindromes(codeword, cantidad) {
  const out = [];
  for (let i = 0; i < cantidad; i++) {
    let s = 0;
    for (const c of codeword) s = gfMul(s, GF_EXP[i]) ^ c;
    out.push(s);
  }
  return out;
}

for (const prueba of [
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [255, 128, 64, 32, 16, 8, 4, 2, 1, 0, 200, 100, 50, 25, 12, 6],
]) {
  const ecc = qrEcc(prueba, 10);
  const s = sindromes(prueba.concat(ecc), 10);
  check(`Reed-Solomon: sindromes en cero (${prueba.slice(0, 3).join(",")}...)`,
    s.every((x) => x === 0), JSON.stringify(s));
}

// Y con un error introducido a mano, los sindromes NO pueden dar cero: si dieran,
// la comprobacion de arriba no estaria probando nada.
{
  const datos = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const cw = datos.concat(qrEcc(datos, 10));
  cw[3] ^= 0xff;
  check("Reed-Solomon: con un byte danado, los sindromes NO dan cero",
    sindromes(cw, 10).some((x) => x !== 0));
}

/* ---------------------------------------------------------- 2. formato ---- */
check("formato (nivel M, mascara 0) = 0x5412 como dice el estandar",
  qrFormato(0) === 0x5412, "0x" + qrFormato(0).toString(16));
// Las ocho mascaras tienen que dar ocho valores distintos.
const formatos = [0, 1, 2, 3, 4, 5, 6, 7].map(qrFormato);
check("las 8 mascaras dan 8 formatos distintos", new Set(formatos).size === 8, JSON.stringify(formatos.map((f) => f.toString(2))));
check("todos los formatos caben en 15 bits", formatos.every((f) => f >= 0 && f < 32768));

/* -------------------------------------------------------- 3. estructura --- */
const m = qrMatriz("ABCD1234EFGH5678");
check("la matriz es de 21x21", m.length === 21 && m.every((f) => f.length === 21));

const finderOk = (f0, c0) => {
  for (let f = 0; f < 7; f++) {
    for (let c = 0; c < 7; c++) {
      const borde = f === 0 || f === 6 || c === 0 || c === 6;
      const centro = f >= 2 && f <= 4 && c >= 2 && c <= 4;
      if (m[f0 + f][c0 + c] !== (borde || centro ? 1 : 0)) return false;
    }
  }
  return true;
};
check("patron de busqueda arriba-izquierda", finderOk(0, 0));
check("patron de busqueda arriba-derecha", finderOk(0, 14));
check("patron de busqueda abajo-izquierda", finderOk(14, 0));

// Separador: la fila y columna 7 alrededor de cada patron van en blanco.
let sepOk = true;
for (let i = 0; i < 8; i++) {
  if (m[7][i] !== 0 || m[i][7] !== 0) sepOk = false;
  if (m[7][20 - i] !== 0 || m[i][13] !== 0) sepOk = false;
  if (m[13][i] !== 0 || m[20 - i][7] !== 0) sepOk = false;
}
check("separadores en blanco alrededor de los patrones", sepOk);

let syncOk = true;
for (let i = 8; i < 13; i++) {
  if (m[6][i] !== (i % 2 === 0 ? 1 : 0)) syncOk = false;
  if (m[i][6] !== (i % 2 === 0 ? 1 : 0)) syncOk = false;
}
check("lineas de sincronismo alternadas", syncOk);
check("modulo siempre oscuro en (13,8)", m[13][8] === 1);

/* ------------------------------------- 3b. formato leido de la matriz ------
   Un lector NO sabe la mascara: la saca de la informacion de formato que hay en
   el propio codigo, en dos copias. Se leen las dos y tienen que coincidir y ser
   validas. Esto es lo que faltaba antes: se comprobaba el VALOR del formato pero
   no DONDE quedaba escrito, y por eso paso desapercibido que la segunda copia
   estaba corrupta. */
function leerFormato(m, N) {
  const copia1 = [];
  for (let i = 0; i < 6; i++) copia1.push(m[8][i]);
  copia1.push(m[8][7], m[8][8], m[7][8]);
  for (let i = 9; i < 15; i++) copia1.push(m[14 - i][8]);

  const copia2 = [];
  for (let i = 0; i < 7; i++) copia2.push(m[N - 1 - i][8]);
  for (let i = 7; i < 15; i++) copia2.push(m[8][N - 15 + i]);

  const aNum = (bits) => bits.reduce((acc, b, i) => acc | (b << i), 0);
  return { c1: aNum(copia1), c2: aNum(copia2) };
}

// Valida los 15 bits: al dividir por el generador BCH el resto debe ser cero.
function formatoValido(v) {
  let x = v ^ 0b101010000010010;
  for (let i = 14; i >= 10; i--) {
    if (x & (1 << i)) x ^= 0b10100110111 << (i - 10);
  }
  return (x & 0x3ff) === 0;
}

{
  const { c1, c2 } = leerFormato(m, 21);
  check("la copia 1 del formato es valida", formatoValido(c1), "0b" + c1.toString(2));
  check("la copia 2 del formato es valida", formatoValido(c2), "0b" + c2.toString(2));
  check("las dos copias del formato coinciden", c1 === c2,
    JSON.stringify({ c1: c1.toString(2).padStart(15, "0"), c2: c2.toString(2).padStart(15, "0") }));

  const datos = (c1 ^ 0b101010000010010) >> 10;
  const nivel = (datos >> 3) & 0b11;
  const masc = datos & 0b111;
  check("el nivel de correccion leido es M", nivel === 0b00, String(nivel));
  check("la mascara leida coincide con la elegida", masc === m.mascara, `leida=${masc} elegida=${m.mascara}`);
  check("el modulo siempre oscuro esta en (N-8, 8)", m[21 - 8][8] === 1);
}

// Y con todas las mascaras, no solo con la que salio elegida esta vez.
{
  let todasOk = true;
  const vistas = new Set();
  for (const txt of ["AAAA1111BBBB2222", "ZZZZ9999YYYY8888", "MNPQRSTUVWXY2345",
                     "HBH5XQRAUEQJUPYJ", "3AW2SLQE3YMRJW7Z", "LJ47N5K3EZSZ2HKJ",
                     "ABCDEFGHJKLMNPQR", "23456789ABCDEFGH"]) {
    const mm = qrMatriz(txt);
    vistas.add(mm.mascara);
    const { c1, c2 } = leerFormato(mm, 21);
    if (!formatoValido(c1) || !formatoValido(c2) || c1 !== c2) todasOk = false;
  }
  check(`el formato queda bien con las ${vistas.size} mascaras que salieron`, todasOk, JSON.stringify([...vistas]));
}

/* ------------------------------------------------- 4. leer los datos ------ */
// Se recorre el zigzag al reves, se quita la mascara y se recuperan los
// codewords. Si coinciden con los que se codificaron, la colocacion es correcta.
const MASCARAS = [
  (f, c) => (f + c) % 2 === 0, (f) => f % 2 === 0, (f, c) => c % 3 === 0,
  (f, c) => (f + c) % 3 === 0,
  (f, c) => (Math.floor(f / 2) + Math.floor(c / 3)) % 2 === 0,
  (f, c) => ((f * c) % 2) + ((f * c) % 3) === 0,
  (f, c) => (((f * c) % 2) + ((f * c) % 3)) % 2 === 0,
  (f, c) => (((f + c) % 2) + ((f * c) % 3)) % 2 === 0,
];

// Se reconstruye que casillas son de estructura (las mismas reglas de la norma).
const N = 21;
const fijo = Array.from({ length: N }, () => new Array(N).fill(false));
for (const [f0, c0] of [[0, 0], [0, N - 7], [N - 7, 0]]) {
  for (let f = -1; f <= 7; f++) {
    for (let c = -1; c <= 7; c++) {
      const ff = f0 + f, cc = c0 + c;
      if (ff >= 0 && ff < N && cc >= 0 && cc < N) fijo[ff][cc] = true;
    }
  }
}
for (let i = 8; i < N - 8; i++) { fijo[6][i] = true; fijo[i][6] = true; }
fijo[13][8] = true;
for (let i = 0; i < 9; i++) { fijo[8][i] = true; fijo[i][8] = true; }
for (let i = 0; i < 8; i++) { fijo[8][N - 1 - i] = true; fijo[N - 1 - i][8] = true; }

const masc = MASCARAS[m.mascara];
const leidos = [];
let acc = 0, nbits = 0, subiendo = true;
for (let c = N - 1; c > 0; c -= 2) {
  if (c === 6) c--;
  for (let i = 0; i < N; i++) {
    const f = subiendo ? N - 1 - i : i;
    for (const cc of [c, c - 1]) {
      if (fijo[f][cc]) continue;
      const bit = m[f][cc] ^ (masc(f, cc) ? 1 : 0);
      acc = (acc << 1) | bit;
      if (++nbits === 8) { leidos.push(acc); acc = 0; nbits = 0; }
    }
  }
  subiendo = !subiendo;
}

check("se recuperan 26 codewords (16 datos + 10 correccion)", leidos.length === 26, String(leidos.length));
check("la palabra codigo leida es valida (sindromes en cero)",
  sindromes(leidos, 10).every((x) => x === 0), JSON.stringify(sindromes(leidos, 10)));

// Y por ultimo: decodificar los datos y recuperar el texto original.
let bits = "";
for (const cw of leidos.slice(0, 16)) bits += cw.toString(2).padStart(8, "0");
const modo = parseInt(bits.slice(0, 4), 2);
const largo = parseInt(bits.slice(4, 13), 2);
const ALFA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
let texto = "", pos = 13;
for (let i = 0; i + 1 < largo; i += 2) {
  const v = parseInt(bits.slice(pos, pos + 11), 2); pos += 11;
  texto += ALFA[Math.floor(v / 45)] + ALFA[v % 45];
}
if (largo % 2) texto += ALFA[parseInt(bits.slice(pos, pos + 6), 2)];

check("el modo codificado es alfanumerico", modo === 0b0010, String(modo));
check("la longitud coincide", largo === 16, String(largo));
check(`el texto se recupera intacto ("${texto}")`, texto === "ABCD1234EFGH5678", texto);

/* ------------------------------------------------------------------------- */
console.log(fails
  ? `\n${fails} COMPROBACION(ES) FALLARON`
  : "\nEl codificador de QR pasa todas las comprobaciones.\n" +
    "Falta lo unico que no se puede hacer aqui: escanear uno impreso con un telefono.");
process.exit(fails ? 1 : 0);
