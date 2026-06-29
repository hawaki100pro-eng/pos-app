(async function () {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const errorMsg = document.getElementById('error-msg');
  const proforma = document.getElementById('proforma');

  if (!id) {
    errorMsg.textContent = 'Falta el id de la venta';
    errorMsg.classList.remove('hidden');
    return;
  }

  const res = await fetch(`/api/ventas/${id}`);
  if (!res.ok) {
    const data = await res.json();
    errorMsg.textContent = data.error || 'No se pudo cargar la proforma';
    errorMsg.classList.remove('hidden');
    return;
  }
  const venta = await res.json();

  document.getElementById('numero-proforma').textContent = venta.numero_proforma;

  // El servidor guarda la fecha en UTC; se muestra convertida a hora de Ecuador (UTC-5)
  const fechaStr = venta.fecha.replace(' ', 'T');
  const fechaUTC = new Date(fechaStr.endsWith('Z') ? fechaStr : fechaStr + 'Z');
  const partesFecha = fechaUTC.toLocaleString('es-EC', {
    timeZone: 'America/Guayaquil',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).split('/');
  document.getElementById('fecha-dia').textContent = partesFecha[0];
  document.getElementById('fecha-mes').textContent = partesFecha[1];
  document.getElementById('fecha-anio').textContent = partesFecha[2];

  document.getElementById('cliente-nombre').textContent = venta.cliente || '';
  document.getElementById('cliente-direccion').textContent = venta.cliente_direccion || '';
  document.getElementById('cliente-ruc').textContent = venta.cliente_ruc || '';
  document.getElementById('cliente-telefono').textContent = venta.cliente_telefono || '';

  const tbody = document.getElementById('items-tbody');
  venta.detalle.forEach((item) => {
    const tr = document.createElement('tr');
    const subtotal = item.cantidad * item.precio_unitario;
    tr.innerHTML = `
      <td>${item.cantidad}</td>
      <td>${item.producto}</td>
      <td>$${item.precio_unitario.toFixed(2)}</td>
      <td>$${subtotal.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  });
  // Filas vacías para que la tabla mantenga la altura de la plantilla impresa
  for (let i = venta.detalle.length; i < 8; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>&nbsp;</td><td></td><td></td><td></td>';
    tbody.appendChild(tr);
  }

  document.getElementById('subtotal-valor').textContent = `$${venta.total.toFixed(2)}`;
  const metodoEl = document.getElementById('metodo-pago-valor');
  if (metodoEl) {
    metodoEl.textContent = venta.metodo_pago === 'transferencia' ? 'TRANSFERENCIA' : 'EFECTIVO';
  }

  if (venta.anulada) {
    const aviso = document.createElement('p');
    aviso.style.color = '#dc2626';
    aviso.style.fontWeight = 'bold';
    aviso.style.textAlign = 'center';
    const fa = venta.fecha_anulacion.replace(' ', 'T');
    const faUTC = new Date(fa.endsWith('Z') ? fa : fa + 'Z');
    const faLocal = faUTC.toLocaleString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    aviso.textContent = `ANULADA el ${faLocal} — ${venta.motivo_anulacion}`;
    proforma.parentElement.insertBefore(aviso, proforma);
  }

  proforma.classList.remove('hidden');

  document.getElementById('imprimir-btn').addEventListener('click', () => window.print());
})();
