// Comprobante de egreso de un gasto (egreso.html?id=12). Con ?imprimir=1 saca
// el cuadro de impresión solo y, al terminar, cierra la pestaña, igual que la
// nota de venta. El título de la página es el nombre que propone el navegador
// al "Guardar como PDF": "Comprobante de egreso CE-000012".

// Monto en letras, como se escribe en los comprobantes:
// 25.5 → "VEINTICINCO DÓLARES CON 50/100"
const UNIDADES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis',
  'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos',
  'setecientos', 'ochocientos', 'novecientos'];

function menosDeMil(n) {
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  let texto = c ? CENTENAS[c] : '';
  if (resto) {
    const parte = resto < 30
      ? UNIDADES[resto]
      : DECENAS[Math.floor(resto / 10)] + (resto % 10 ? ' y ' + UNIDADES[resto % 10] : '');
    texto = texto ? `${texto} ${parte}` : parte;
  }
  return texto;
}

// "uno" pierde la o antes de un sustantivo: un mil, veintiún dólares, un millón
function apocopar(texto) {
  return texto.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un');
}

function enteroALetras(n) {
  if (n === 0) return 'cero';
  const millones = Math.floor(n / 1000000);
  const miles = Math.floor((n % 1000000) / 1000);
  const resto = n % 1000;
  const partes = [];
  if (millones) partes.push(millones === 1 ? 'un millón' : `${apocopar(enteroALetras(millones))} millones`);
  if (miles) partes.push(miles === 1 ? 'mil' : `${apocopar(menosDeMil(miles))} mil`);
  if (resto) partes.push(menosDeMil(resto));
  return partes.join(' ');
}

function montoEnLetras(monto) {
  const centavosTotales = Math.round(monto * 100);
  const entero = Math.floor(centavosTotales / 100);
  const centavos = String(centavosTotales % 100).padStart(2, '0');
  // Millones exactos llevan "de": un millón de dólares
  const moneda = entero === 1 ? 'dólar' : (entero >= 1000000 && entero % 1000000 === 0 ? 'de dólares' : 'dólares');
  return `${apocopar(enteroALetras(entero))} ${moneda} con ${centavos}/100`.toUpperCase();
}

(async function () {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const errorMsg = document.getElementById('error-msg');

  const mostrarError = (texto) => {
    errorMsg.textContent = texto;
    errorMsg.classList.remove('hidden');
  };

  if (!id) return mostrarError('Falta el número del gasto');

  const res = await fetch(`/api/gastos/${encodeURIComponent(id)}/comprobante`);
  const gasto = await res.json().catch(() => ({}));
  if (!res.ok) return mostrarError(gasto.error || 'No se pudo cargar el comprobante');

  document.title = `Comprobante de egreso ${gasto.numero}`;
  document.getElementById('numero-egreso').textContent = gasto.numero;

  // El servidor guarda la fecha en UTC; se muestra en hora de Ecuador
  const fechaStr = String(gasto.fecha).replace(' ', 'T');
  const fecha = new Date(fechaStr.endsWith('Z') ? fechaStr : fechaStr + 'Z');
  const [dia, mes, anio] = fecha.toLocaleDateString('es-EC', {
    timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: '2-digit',
  }).split('/');
  document.getElementById('fecha-dia').textContent = dia;
  document.getElementById('fecha-mes').textContent = mes;
  document.getElementById('fecha-anio').textContent = anio;
  document.getElementById('egreso-hora').textContent = fecha.toLocaleTimeString('es-EC', {
    timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false,
  });

  document.getElementById('egreso-concepto').textContent = gasto.descripcion;
  document.getElementById('egreso-registrado').textContent = gasto.registrado_por;
  document.getElementById('egreso-monto').textContent = `$${Number(gasto.monto).toFixed(2)}`;
  document.getElementById('egreso-letras').textContent = montoEnLetras(Number(gasto.monto));

  document.getElementById('proforma').classList.remove('hidden');
  document.getElementById('imprimir-btn').addEventListener('click', () => window.print());

  if (params.get('imprimir') === '1') {
    try { await document.fonts.ready; } catch (e) { /* si falla, se imprime igual */ }
    window.addEventListener('afterprint', () => window.close());
    window.print();
  }
})();
