/* ============================================================================
   Codificadores de QR y código de barras (Code 128), y armado del SKU.

   Este archivo es una COPIA del generador de etiquetas de Hawaki
   (Desktop/CLAUDE FOR CARL/etiquetas-hawaki/index.html), que ya estaba
   verificado contra generadores de referencia. Se copió tal cual a propósito:
   reescribirlo solo agregaría la posibilidad de errores nuevos.

   No usa ninguna librería de internet, así que las etiquetas se pueden imprimir
   aunque el local se quede sin conexión.
   ============================================================================ */

const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const COMBINING = new RegExp('[\\u0300-\\u036f]', 'g');
const deaccent = s => String(s).normalize('NFD').replace(COMBINING, '');

const RS_BLOCKS = {
  L: [[7,1,19,0,0],[10,1,34,0,0],[15,1,55,0,0],[20,1,80,0,0],[26,1,108,0,0],
      [18,2,68,0,0],[20,2,78,0,0],[24,2,97,0,0],[30,2,116,0,0],[18,2,68,2,69]],
  M: [[10,1,16,0,0],[16,1,28,0,0],[26,1,44,0,0],[18,2,32,0,0],[24,2,43,0,0],
      [16,4,27,0,0],[18,4,31,0,0],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44]],
  Q: [[13,1,13,0,0],[22,1,22,0,0],[18,2,17,0,0],[26,2,24,0,0],[18,2,15,2,16],
      [24,4,19,0,0],[18,2,14,4,15],[22,4,18,2,19],[20,4,16,4,17],[24,6,19,2,20]],
  H: [[17,1,9,0,0],[28,1,16,0,0],[22,2,13,0,0],[16,4,9,0,0],[22,2,11,2,12],
      [28,4,15,0,0],[26,4,13,1,14],[26,4,14,2,15],[24,4,12,4,13],[28,6,15,2,16]]
};
const ALIGN_CENTERS = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
const FMT_BITS = { L:1, M:0, Q:3, H:2 };
const REMAINDER = [0,7,7,7,7,7,0,0,0,0]; // bits sobrantes por versión 1..10

const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];

function polyMul(a, b) {
  const r = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] ^= gmul(a[i], b[j]);
  return r;
}
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) g = polyMul(g, [1, GF_EXP[i]]);
  return g;
}
function rsEncode(data, n) {
  const g = rsGenerator(n);
  const res = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) {
    const f = res[i];
    if (f === 0) continue;
    for (let j = 0; j < g.length; j++) res[i + j] ^= gmul(g[j], f);
  }
  return res.slice(data.length);
}

function buildCodewords(bytes, ver, ecl) {
  const [ecw, n1, d1, n2, d2] = RS_BLOCKS[ecl][ver - 1];
  const total = n1 * d1 + n2 * d2;
  const bits = [];
  const put = (v, len) => { for (let i = len - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = total * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const dc = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    dc.push(v);
  }
  const pads = [0xEC, 0x11];
  let k = 0;
  while (dc.length < total) dc.push(pads[k++ % 2]);

  const blocks = [];
  let p = 0;
  for (let i = 0; i < n1; i++) { blocks.push(dc.slice(p, p + d1)); p += d1; }
  for (let i = 0; i < n2; i++) { blocks.push(dc.slice(p, p + d2)); p += d2; }
  const ecs = blocks.map(b => rsEncode(b, ecw));

  const out = [];
  const maxD = Math.max(d1, d2);
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecw; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function penalty(m) {
  const n = m.length;
  let score = 0;
  // regla 1: corridas de 5 o más
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) {
      let run = 1, prev = pass ? m[0][a] : m[a][0];
      for (let b = 1; b < n; b++) {
        const v = pass ? m[b][a] : m[a][b];
        if (v === prev) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; prev = v; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  // regla 2: bloques 2x2
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  // regla 3: patrón 1:1:3:1:1 con zona clara
  const P1 = [1,0,1,1,1,0,1,0,0,0,0], P2 = [0,0,0,0,1,0,1,1,1,0,1];
  const hit = (arr, i, pat) => { for (let k = 0; k < 11; k++) if (arr[i + k] !== pat[k]) return false; return true; };
  for (let a = 0; a < n; a++) {
    const row = m[a], col = [];
    for (let b = 0; b < n; b++) col.push(m[b][a]);
    for (let i = 0; i + 11 <= n; i++) {
      if (hit(row, i, P1) || hit(row, i, P2)) score += 40;
      if (hit(col, i, P1) || hit(col, i, P2)) score += 40;
    }
  }
  // regla 4: balance de oscuros
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m[r][c];
  const pct = dark * 100 / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

function qrMatrix(text, ecl) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 0;
  for (let v = 1; v <= 10; v++) {
    const [, n1, d1, n2, d2] = RS_BLOCKS[ecl][v - 1];
    const capBits = (n1 * d1 + n2 * d2) * 8;
    const need = 4 + (v < 10 ? 8 : 16) + 8 * bytes.length;
    if (capBits >= need) { ver = v; break; }
  }
  if (!ver) throw new Error('El contenido es muy largo para el QR. Acorta el SKU o baja la corrección a L.');

  const size = 17 + 4 * ver;
  const m = Array.from({ length: size }, () => new Array(size).fill(0));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (r, c, v) => { m[r][c] = v ? 1 : 0; fixed[r][c] = true; };

  // patrones localizadores + separadores
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                   (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      setF(rr, cc, ring);
    }
  }
  // patrones de sincronía
  for (let i = 8; i < size - 8; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  // patrones de alineación
  const centers = ALIGN_CENTERS[ver - 1];
  for (const r of centers) for (const c of centers) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      setF(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // reservas de formato
  for (let i = 0; i <= 8; i++) {
    if (!fixed[8][i]) { fixed[8][i] = true; m[8][i] = 0; }
    if (!fixed[i][8]) { fixed[i][8] = true; m[i][8] = 0; }
  }
  for (let i = 0; i < 8; i++) {
    fixed[size - 1 - i][8] = true;
    fixed[8][size - 1 - i] = true;
  }
  setF(size - 8, 8, true); // módulo oscuro

  // información de versión (v >= 7)
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >> 11) & 1) * 0x1F25);
    const vbits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = (vbits >> i) & 1;
      const a = size - 11 + (i % 3), bb = Math.floor(i / 3);
      setF(a, bb, b); setF(bb, a, b);
    }
  }

  // datos
  const cw = buildCodewords(bytes, ver, ecl);
  const dataBits = [];
  for (const b of cw) for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1);
  for (let i = 0; i < REMAINDER[ver - 1]; i++) dataBits.push(0);

  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!fixed[r][c] && idx < dataBits.length) { m[r][c] = dataBits[idx++]; }
      }
    }
  }

  // máscara: probar las 8 y quedarse con la de menor penalización
  let best = null, bestScore = Infinity;
  for (let mk = 0; mk < 8; mk++) {
    const t = m.map(row => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      if (!fixed[r][c] && MASKS[mk](r, c)) t[r][c] ^= 1;
    applyFormat(t, size, ecl, mk);
    const s = penalty(t);
    if (s < bestScore) { bestScore = s; best = t; }
  }
  return best;
}

function applyFormat(t, size, ecl, mask) {
  const data = (FMT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const b = (bits >> (14 - i)) & 1;   // se coloca del bit más significativo al menos
    if (i < 6) t[8][i] = b;
    else if (i < 8) t[8][i + 1] = b;
    else if (i === 8) t[7][8] = b;
    else t[14 - i][8] = b;

    // segunda copia: 7 módulos en la columna, 8 en la fila
    if (i < 7) t[size - 1 - i][8] = b;
    else t[8][size - 15 + i] = b;
  }
  t[size - 8][8] = 1;
}

function qrSVG(text, ecl) {
  const m = qrMatrix(text, ecl);
  const n = m.length, q = 4, dim = n + 2 * q;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    if (m[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg viewBox="0 0 ${dim} ${dim}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="Código QR ${escapeAttr(text.split('\n')[0])}"><rect width="${dim}" height="${dim}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
}

function qrPNG(text, ecl, scale) {
  const m = qrMatrix(text, ecl);
  const n = m.length, q = 4, dim = (n + 2 * q) * scale;
  const cv = document.createElement('canvas');
  cv.width = cv.height = dim;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    if (m[r][c]) ctx.fillRect((c + q) * scale, (r + q) * scale, scale, scale);
  return cv.toDataURL('image/png');
}

/* ==========================================================================
   Code 128 (subconjunto B) — para pistolas de escáner
   ========================================================================== */

const C128 = ("212222,222122,222221,121223,121322,131222,122213,122312,132212,221213," +
  "221312,231212,112232,122132,122231,113222,123122,123221,223211,221132," +
  "221231,213212,223112,312131,311222,321122,321221,312212,322112,322211," +
  "212123,212321,232121,111323,131123,131321,112313,132113,132311,211313," +
  "231113,231311,112133,112331,132131,113123,113321,133121,313121,211331," +
  "231131,213113,213311,213131,311123,311321,331121,312113,312311,332111," +
  "314111,221411,431111,111224,111422,121124,121421,141122,141221,112214," +
  "112412,122114,122411,142112,142211,241211,221114,413111,241112,134111," +
  "111242,121142,121241,114212,124112,124211,411212,421112,421211,212141," +
  "214121,412121,111143,111341,131141,114113,114311,411113,411311,113141," +
  "114131,311141,411131,211412,211214,211232,2331112").split(',');

function code128SVG(text) {
  const clean = text.replace(/[^\x20-\x7E]/g, '');
  const values = [104];                       // Start B
  let sum = 104;
  for (let i = 0; i < clean.length; i++) {
    const v = clean.charCodeAt(i) - 32;
    values.push(v);
    sum += v * (i + 1);
  }
  values.push(sum % 103);                     // checksum
  values.push(106);                           // Stop

  let x = 10, bars = '';                      // 10 módulos de zona muda
  for (const v of values) {
    const widths = C128[v];
    for (let i = 0; i < widths.length; i++) {
      const w = +widths[i];
      if (i % 2 === 0) bars += `M${x} 0h${w}v100h-${w}z`;
      x += w;
    }
  }
  const total = x + 10;
  return `<svg viewBox="0 0 ${total} 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="Código de barras ${escapeAttr(clean)}"><rect width="${total}" height="100" fill="#ffffff"/><path d="${bars}" fill="#000000"/></svg>`;
}

function normPart(s, mode) {
  const base = deaccent(String(s || '')).toUpperCase();
  if (mode === 'initials') {
    const words = base.split(/[^A-Z0-9]+/).filter(Boolean);
    if (words.length > 1) return words.map(w => w[0]).join('');
    return (words[0] || '').slice(0, 3);
  }
  return base.replace(/[^A-Z0-9]+/g, '');
}

function buildSKU(tpl, model, size, colorMode) {
  return tpl
    .replace(/\{codigo\}/gi, normPart(model.code, 'full'))
    .replace(/\{color\}/gi, normPart(model.color, colorMode))
    .replace(/\{talla\}/gi, normPart(size, 'full'))
    .replace(/\{precio\}/gi, normPart(model.price, 'full'))
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}
