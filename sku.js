// Armado del SKU (el código que va impreso en la etiqueta).
//
// Sigue exactamente el mismo formato del generador de etiquetas de Hawaki:
//   {modelo sin espacios}-{iniciales del color}-{talla}   ->   CHUNKYAPR03-AP-37
//
// Se guarda en el producto y NO se recalcula al editarlo: la etiqueta ya está
// pegada en el zapato, así que el código tiene que sobrevivir a que alguien
// corrija después el nombre del color o del modelo.

function sinAcentos(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizar(texto, modo) {
  const base = sinAcentos(texto).toUpperCase();
  if (modo === 'iniciales') {
    const palabras = base.split(/[^A-Z0-9]+/).filter(Boolean);
    if (palabras.length > 1) return palabras.map((p) => p[0]).join('');
    return (palabras[0] || '').slice(0, 3);
  }
  return base.replace(/[^A-Z0-9]+/g, '');
}

function armarSku({ modelo, color, talla }) {
  return [
    normalizar(modelo, 'completo'),
    normalizar(color, 'iniciales'),
    normalizar(talla, 'completo'),
  ].filter(Boolean).join('-');
}

// Dos colores distintos pueden dar las mismas iniciales (Animal Print y Azul
// Perla son los dos "AP"). Si el código ya existe en otro producto, se le agrega
// un número al final para que no haya dos etiquetas iguales.
async function skuUnico(pool, producto, excluirId = null) {
  const base = armarSku(producto);
  let candidato = base;
  for (let n = 2; n < 100; n++) {
    const r = excluirId
      ? await pool.query('SELECT 1 FROM productos WHERE sku = $1 AND id <> $2 LIMIT 1', [candidato, excluirId])
      : await pool.query('SELECT 1 FROM productos WHERE sku = $1 LIMIT 1', [candidato]);
    if (r.rowCount === 0) return candidato;
    candidato = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`; // salida de emergencia, no debería llegar aquí
}

module.exports = { armarSku, skuUnico, normalizar };
