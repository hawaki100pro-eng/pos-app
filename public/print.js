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

  const fecha = new Date(venta.fecha.replace(' ', 'T'));
  document.getElementById('fecha-dia').textContent = String(fecha.getDate()).padStart(2, '0');
  document.getElementById('fecha-mes').textContent = String(fecha.getMonth() + 1).padStart(2, '0');
  document.getElementById('fecha-anio').textContent = String(fecha.getFullYear()).slice(-2);

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

  const subtotalItems = venta.detalle.reduce((acc, item) => acc + item.cantidad * item.precio_unitario, 0);
  document.getElementById('subtotal-valor').textContent = `$${subtotalItems.toFixed(2)}`;

  if (venta.descuento_pct > 0) {
    document.getElementById('descuento-label-print').textContent = `DESCUENTO ${venta.descuento_pct}%`;
    document.getElementById('descuento-valor-print').textContent = `-$${(subtotalItems - venta.total).toFixed(2)}`;
    document.getElementById('total-valor-print').textContent = `$${venta.total.toFixed(2)}`;
    document.getElementById('descuento-row-print').classList.remove('hidden');
    document.getElementById('total-row-print').classList.remove('hidden');
  }

  if (venta.anulada) {
    const aviso = document.createElement('p');
    aviso.style.color = '#dc2626';
    aviso.style.fontWeight = 'bold';
    aviso.style.textAlign = 'center';
    aviso.textContent = `ANULADA el ${venta.fecha_anulacion} — ${venta.motivo_anulacion}`;
    proforma.parentElement.insertBefore(aviso, proforma);
  }

  proforma.classList.remove('hidden');

  document.getElementById('imprimir-btn').addEventListener('click', () => window.print());
})();
