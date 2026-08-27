// Tarjeta de precios: la hoja con los códigos de las categorías sueltas.
//
// Son los productos marcados "sin control de stock": zapatillas, ofertas, todo
// lo que no se etiqueta par por par. En vez de una etiqueta pegada a cada par,
// su código vive en esta hoja junto a la caja, y la vendedora le pasa la pistola
// igual que a una sandalia.
//
// Cada fila lleva los dos códigos del producto, como en la etiqueta:
//   - el de barras, con el id en 6 dígitos, que es lo que lee la pistola
//   - el QR, con el SKU, por si se lee con la cámara del celular

const hoja = document.getElementById('hoja');
const cuenta = document.getElementById('cuenta');

const codigoBarras = (p) => String(p.id).padStart(6, '0');
const escapar = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function aviso(html) {
  hoja.innerHTML = `<p class="vacio">${html}</p>`;
  cuenta.textContent = '';
}

async function cargar() {
  let res;
  try {
    res = await fetch('/api/productos');
  } catch (e) {
    return aviso('No se pudo conectar con el servidor.');
  }
  if (res.status === 401 || res.status === 403) {
    return aviso('Tu sesión se cerró. Vuelve a entrar al POS y abre la tarjeta de nuevo.');
  }
  if (!res.ok) return aviso('No se pudo cargar el catálogo.');

  const todos = await res.json();
  const categorias = todos
    .filter((p) => !p.controla_stock && !p.eliminado && p.activo)
    .sort((a, b) => Number(a.precio) - Number(b.precio) || String(a.modelo).localeCompare(b.modelo, 'es'));

  if (categorias.length === 0) {
    return aviso(
      'Todavía no hay categorías sueltas.<br><br>' +
      'En el inventario, crea un producto y marca <strong>«Es una categoría suelta»</strong>: ' +
      'por ejemplo «Zapatilla de dama» a $12. Aparecerá aquí con su código para escanear.'
    );
  }

  render(categorias);
}

function render(categorias) {
  const hoy = new Date().toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const problemas = [];
  let filas = '';

  for (const p of categorias) {
    const sku = p.sku || '(sin código)';
    let qr = '', barras = '';
    try {
      qr = qrSVG(sku, 'M');
      barras = code128SVG(codigoBarras(p));
    } catch (e) {
      problemas.push(`${p.modelo}: ${e.message}`);
      continue;
    }

    filas += `
      <div class="fila">
        <div class="datos">
          <div class="nombre">${escapar(p.modelo)}</div>
          <div class="precio">$${Number(p.precio).toFixed(2)}</div>
          <div class="codigo-texto">${escapar(sku)} · ${codigoBarras(p)}</div>
        </div>
        <div class="qr">${qr}</div>
        <div class="barras">${barras}</div>
      </div>`;
  }

  hoja.innerHTML = `
    <div class="encabezado-hoja">
      <h2>PRECIOS</h2>
      <p>Pásale la pistola al código · Actualizada el ${hoy}</p>
    </div>
    ${filas}
    <p class="pie-hoja">Si cambias un precio en el inventario, vuelve a imprimir esta hoja.</p>`;

  cuenta.textContent = `${categorias.length} categoría(s)`;

  if (problemas.length) {
    hoja.insertAdjacentHTML('afterbegin',
      `<p style="color:#dc2626">No se pudieron generar: ${escapar(problemas.join(' | '))}</p>`);
  }
}

document.getElementById('imprimir').addEventListener('click', () => window.print());

cargar();
