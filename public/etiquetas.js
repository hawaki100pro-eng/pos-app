// Hoja de etiquetas. Se abre desde el inventario con los ids de los productos:
//   etiquetas.html?ids=12,13,14
//
// Qué lleva cada código:
//   - El código de barras lleva el ID del producto en 6 dígitos (ej. 000207).
//     Va corto a propósito: el SKU completo en Code 128 no cabe legible en 40 mm
//     (daría barras de 0.16 mm y los lectores de tienda piden 0.25 mm o más).
//   - El QR lleva el SKU completo, que sí le cabe de sobra.
//   - El SKU también va impreso en letra, para leerlo sin aparato.

const params = new URLSearchParams(location.search);
const ids = (params.get('ids') || '')
  .split(',')
  .map((s) => parseInt(s, 10))
  .filter((n) => Number.isInteger(n));

const hoja = document.getElementById('hoja');
const cuenta = document.getElementById('cuenta');
const titulo = document.getElementById('titulo');
const selModo = document.getElementById('modo');
const selCuantas = document.getElementById('cuantas');
const btnConfirmar = document.getElementById('confirmar-impresas');

let productos = [];

const codigoBarras = (p) => String(p.id).padStart(6, '0');
const escapar = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function aviso(texto) {
  hoja.innerHTML = `<p style="max-width:900px;margin:0 auto;color:#5c6270">${escapar(texto)}</p>`;
  cuenta.textContent = '';
}

async function cargar() {
  if (ids.length === 0) return aviso('No se indicó qué productos etiquetar. Abre esta página desde el inventario.');

  let res;
  try {
    res = await fetch('/api/productos');
  } catch (e) {
    return aviso('No se pudo conectar con el servidor.');
  }
  if (res.status === 401 || res.status === 403) {
    return aviso('Tu sesión se cerró. Vuelve a entrar al POS y abre las etiquetas de nuevo.');
  }
  if (!res.ok) return aviso('No se pudo cargar el catálogo.');

  const todos = await res.json();
  const porId = new Map(todos.map((p) => [p.id, p]));
  productos = ids.map((id) => porId.get(id)).filter(Boolean);

  if (productos.length === 0) return aviso('No se encontraron esos productos en el catálogo.');

  const modelos = [...new Set(productos.map((p) => p.modelo))];
  const colores = [...new Set(productos.map((p) => p.color))];
  titulo.textContent = 'Etiquetas — ' + modelos.join(', ') + (colores.length === 1 ? ' · ' + colores[0] : '');
  document.title = titulo.textContent;

  render();
}

// Cuántas etiquetas lleva una talla según lo que se haya elegido arriba.
//   pendientes → las que faltan: los pares que aún no tienen etiqueta pegada
//   par        → una por cada par en bodega, aunque ya estén etiquetados
//   talla      → una sola, para ver cómo queda o pegarla en la caja
function copiasDe(p) {
  const modo = selCuantas.value;
  if (modo === 'talla') return 1;
  if (modo === 'par') return Math.max(1, p.stock);
  return Math.max(0, p.stock - (p.etiquetas_impresas || 0));
}

// La lista de etiquetas a imprimir, ya repetida. La usan tanto la vista de
// pantalla como el PDF, para que salga exactamente lo mismo.
function listaEtiquetas() {
  const lista = [];
  const problemas = [];

  for (const p of productos) {
    const copias = copiasDe(p);
    if (copias === 0) continue;
    const sku = p.sku || '(sin código)';

    try {
      qrMatrix(sku, 'M'); // si el SKU no cabe en el QR, avisa aquí
    } catch (e) {
      problemas.push(`${p.modelo} T${p.talla} ${p.color}: ${e.message}`);
      continue;
    }

    for (let i = 0; i < copias; i++) {
      lista.push({ producto: p, sku, codigoBarras: codigoBarras(p) });
    }
  }

  return { lista, problemas };
}

function render() {
  let html = '';
  let total = 0;
  const problemas = [];

  for (const p of productos) {
    const copias = copiasDe(p);
    if (copias === 0) continue;
    const sku = p.sku || '(sin código)';

    let qr = '', barras = '';
    try {
      qr = qrSVG(sku, 'M');
      barras = code128SVG(codigoBarras(p));
    } catch (e) {
      problemas.push(`${p.modelo} T${p.talla} ${p.color}: ${e.message}`);
      continue;
    }

    for (let i = 0; i < copias; i++) {
      total++;
      html += `
        <article class="etiqueta">
          <div class="et-arriba">
            <div class="et-qr">${qr}</div>
            <div class="et-datos">
              <div class="et-modelo">${escapar(p.modelo)}</div>
              <div class="et-variante">T${escapar(p.talla)} · ${escapar(p.color)}</div>
              <div class="et-precio">$${Number(p.precio).toFixed(2)}</div>
            </div>
          </div>
          <div class="et-barras">${barras}</div>
          <div class="et-pie">
            <span class="et-sku">${escapar(sku)}</span>
            <span class="et-num">${codigoBarras(p)}</span>
          </div>
        </article>`;
    }
  }

  hoja.innerHTML = html;

  const modo = selCuantas.value;
  const pares = productos.reduce((a, p) => a + Math.max(0, p.stock), 0);
  if (modo === 'pendientes') {
    cuenta.textContent = total === 0
      ? 'Nada pendiente: todo este modelo ya está etiquetado'
      : `${total} pendiente(s) de ${pares} par(es)`;
  } else if (modo === 'par') {
    cuenta.textContent = `${total} etiquetas · ${productos.length} talla(s), ${pares} par(es)`;
  } else {
    cuenta.textContent = `${total} etiquetas · una por talla`;
  }

  // Sin nada que imprimir no tiene sentido ofrecer el PDF
  document.getElementById('descargar-pdf').disabled = total === 0;
  btnConfirmar.classList.add('hidden');

  if (total === 0 && modo === 'pendientes') {
    hoja.innerHTML = `<p style="max-width:900px;margin:0 auto;color:#5c6270">
      Todos los pares de este modelo ya tienen su etiqueta. Si necesitas reponer alguna
      (se despegó, salió mal impresa), elige <strong>«Todas: una por par»</strong> arriba.</p>`;
  }

  if (problemas.length) {
    hoja.insertAdjacentHTML('afterbegin',
      `<p class="error" style="flex:1 1 100%;color:#dc2626">No se pudieron generar: ${escapar(problemas.join(' | '))}</p>`);
  }
}

// El tamaño de página se cambia escribiendo la regla @page, que no se puede
// activar con una clase.
function aplicarModo() {
  const modo = selModo.value;
  document.body.dataset.modo = modo;
  document.getElementById('regla-pagina').textContent = modo === 'rollo'
    ? '@page { size: 40mm 20mm; margin: 0; }'
    : '@page { size: A4; margin: 8mm; }';
}

// Nombre del archivo: sirve para encontrarlo en Descargas desde el celular.
function nombreArchivo(cuantas) {
  const modelos = [...new Set(productos.map((p) => p.modelo))].join('-');
  const limpio = deaccent(modelos).replace(/[^A-Za-z0-9-]+/g, '_').slice(0, 40) || 'etiquetas';
  return `etiquetas-${limpio}-${cuantas}.pdf`;
}

document.getElementById('descargar-pdf').addEventListener('click', () => {
  const { lista, problemas } = listaEtiquetas();
  if (problemas.length) {
    alert('No se pudieron generar estas etiquetas:\n\n' + problemas.join('\n'));
  }
  if (lista.length === 0) return;

  const url = URL.createObjectURL(pdfEtiquetas(lista));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo(lista.length);
  a.click();
  // Se libera después de que el navegador alcanzó a empezar la descarga
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  // Recién ahora se ofrece confirmar: descargar no es imprimir, y el rollo se
  // puede trabar. La cuenta solo avanza cuando el papel salió de verdad.
  btnConfirmar.classList.remove('hidden');
});

// Cuántas etiquetas lleva cada talla en la tanda que se acaba de descargar
function tandaPorProducto() {
  const conteo = new Map();
  for (const p of productos) {
    const copias = copiasDe(p);
    if (copias > 0) conteo.set(p.id, copias);
  }
  return [...conteo].map(([id, cantidad]) => ({ id, cantidad }));
}

btnConfirmar.addEventListener('click', async () => {
  const items = tandaPorProducto();
  if (items.length === 0) return;

  btnConfirmar.disabled = true;
  try {
    const res = await fetch('/api/etiquetas/impresas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'No se pudo guardar. Revisa la conexión e inténtalo de nuevo.');
      return;
    }
    // Se recargan los productos para que la cuenta de pendientes quede al día
    await cargar();
    cuenta.textContent = 'Listo: quedaron registradas como impresas';
  } finally {
    btnConfirmar.disabled = false;
  }
});

selModo.addEventListener('change', aplicarModo);
selCuantas.addEventListener('change', render);
document.getElementById('imprimir').addEventListener('click', () => window.print());

aplicarModo();
cargar();
