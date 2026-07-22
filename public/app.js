const loginScreen = document.getElementById('login-screen');
const vendedorScreen = document.getElementById('vendedor-screen');
const adminScreen = document.getElementById('admin-screen');

let items = []; // { producto, cantidad, precio_unitario }
let editandoItems = []; // ítems en edición dentro del modal de editar venta
let editandoVentaId = null;
let rolActual = null;

// El servidor guarda y devuelve las fechas en UTC; esto las muestra en hora de Ecuador (UTC-5)
function formatFecha(fechaStr) {
  if (!fechaStr) return '';
  const d = new Date(fechaStr.replace(' ', 'T') + (fechaStr.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleString('es-EC', {
    timeZone: 'America/Guayaquil',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// --- Login ---

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const usuario = document.getElementById('login-usuario').value;
  const password = document.getElementById('login-password').value;

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, password }),
  });

  if (!res.ok) {
    const data = await res.json();
    document.getElementById('login-error').textContent = data.error;
    return;
  }

  const user = await res.json();
  mostrarPantalla(user.rol);
});

function mostrarPantalla(rol) {
  rolActual = rol;
  loginScreen.classList.add('hidden');
  vendedorScreen.classList.add('hidden');
  adminScreen.classList.add('hidden');

  // El formulario de Nota de venta es uno solo: se coloca en la pantalla del rol que entró
  const ventaForm = document.getElementById('venta-form-wrap');

  if (rol === 'admin' || rol === 'dueno') {
    adminScreen.classList.remove('hidden');
    document.querySelector('#admin-screen h1').textContent = rol === 'dueno' ? 'Panel del dueño' : 'Panel administrador';
    // Crear usuarios y asignar roles es exclusivo del dueño
    document.getElementById('crear-usuario-row').classList.toggle('hidden', rol !== 'dueno');
    document.getElementById('venta-slot-admin').appendChild(ventaForm);
    cargarEstadoCaja(); // muestra u oculta la Nota de venta según haya turno abierto
    cargarDashboard();
    cargarUsuarios();
    cargarGastos();
    cargarProductos();
  } else {
    vendedorScreen.classList.remove('hidden');
    document.getElementById('venta-slot-vendedor').appendChild(ventaForm);
    cargarEstadoCaja();
    cargarMisVentas();
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  items = [];
  loginScreen.classList.remove('hidden');
  vendedorScreen.classList.add('hidden');
  adminScreen.classList.add('hidden');
  document.getElementById('login-usuario').value = '';
  document.getElementById('login-password').value = '';
}

document.getElementById('logout-btn-v').addEventListener('click', logout);
document.getElementById('logout-btn-a').addEventListener('click', logout);

// --- Vendedor: estado de caja y proforma ---

async function cargarEstadoCaja() {
  const res = await fetch('/api/caja/estado');
  const data = await res.json();
  const cerradaMsg = document.getElementById('caja-cerrada-msg');
  const formWrap = document.getElementById('venta-form-wrap');
  if (data.turno) {
    cerradaMsg.classList.add('hidden');
    formWrap.classList.remove('hidden');
  } else {
    cerradaMsg.classList.remove('hidden');
    formWrap.classList.add('hidden');
  }
}

// --- Tipo de cliente ---

function resetTipoCliente() {
  document.getElementById('campos-cliente').classList.add('hidden');
  document.getElementById('btn-consumidor-final').classList.remove('activo');
  document.getElementById('btn-consumidor-datos').classList.remove('activo');
  document.getElementById('cliente-nombre').value = '';
  document.getElementById('cliente-direccion').value = '';
  document.getElementById('cliente-ruc').value = '';
  document.getElementById('cliente-telefono').value = '';
}

document.getElementById('btn-consumidor-final').addEventListener('click', () => {
  document.getElementById('campos-cliente').classList.add('hidden');
  document.getElementById('cliente-nombre').value = 'Consumidor final';
  document.getElementById('cliente-direccion').value = '';
  document.getElementById('cliente-ruc').value = '';
  document.getElementById('cliente-telefono').value = '';
  document.getElementById('btn-consumidor-final').classList.add('activo');
  document.getElementById('btn-consumidor-datos').classList.remove('activo');
});

document.getElementById('btn-consumidor-datos').addEventListener('click', () => {
  document.getElementById('campos-cliente').classList.remove('hidden');
  document.getElementById('cliente-nombre').value = '';
  document.getElementById('btn-consumidor-datos').classList.add('activo');
  document.getElementById('btn-consumidor-final').classList.remove('activo');
});

document.getElementById('agregar-item-btn').addEventListener('click', () => {
  const inputProducto = document.getElementById('item-producto');
  const producto = inputProducto.value.trim();
  const cantidad = parseFloat(document.getElementById('item-cantidad').value);
  const precio_unitario = parseFloat(document.getElementById('item-precio').value);

  if (!producto || !cantidad || cantidad <= 0 || isNaN(precio_unitario) || precio_unitario < 0) {
    document.getElementById('venta-msg').textContent = 'Completa producto, cantidad y precio válidos';
    document.getElementById('venta-msg').className = 'error';
    return;
  }

  const producto_id = inputProducto.dataset.productoId ? parseInt(inputProducto.dataset.productoId) : null;
  items.push({ producto, cantidad, precio_unitario, producto_id });
  inputProducto.value = '';
  inputProducto.dataset.productoId = '';
  document.getElementById('item-cantidad').value = '1';
  document.getElementById('item-precio').value = '';
  document.getElementById('venta-msg').textContent = '';
  renderItems();
});

// --- Modal catálogo ---

let productosDisponibles = [];

document.getElementById('buscar-catalogo-btn').addEventListener('click', async () => {
  const res = await fetch('/api/productos/disponibles');
  productosDisponibles = await res.json();
  document.getElementById('catalogo-buscar').value = '';
  renderCatalogoModal(productosDisponibles);
  document.getElementById('catalogo-modal').classList.remove('hidden');
  document.getElementById('catalogo-buscar').focus(); // listo para teclear el código de la etiqueta
});

document.getElementById('cerrar-catalogo-btn').addEventListener('click', () => {
  document.getElementById('catalogo-modal').classList.add('hidden');
});

document.getElementById('catalogo-buscar').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  const filtrados = productosDisponibles.filter((p) =>
    p.modelo.toLowerCase().includes(q) ||
    p.talla.toLowerCase().includes(q) ||
    p.color.toLowerCase().includes(q)
  );
  renderCatalogoModal(filtrados);
});

function renderCatalogoModal(productos) {
  const tbody = document.querySelector('#catalogo-tabla tbody');
  tbody.innerHTML = '';
  if (productos.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;">Sin resultados</td></tr>';
    return;
  }
  productos.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.modelo}</td>
      <td>${p.talla}</td>
      <td>${p.color}</td>
      <td>$${p.precio.toFixed(2)}</td>
      <td>${p.stock}</td>
      <td></td>
    `;
    const btn = document.createElement('button');
    btn.textContent = 'Seleccionar';
    btn.className = 'accion-btn editar-btn';
    btn.addEventListener('click', () => {
      const inputProducto = document.getElementById('item-producto');
      inputProducto.value = `${p.modelo} T${p.talla} ${p.color}`;
      inputProducto.dataset.productoId = p.id;
      document.getElementById('item-precio').value = p.precio;
      document.getElementById('item-cantidad').value = 1;
      document.getElementById('catalogo-modal').classList.add('hidden');
      document.getElementById('item-cantidad').focus();
    });
    tr.lastElementChild.appendChild(btn);
    tbody.appendChild(tr);
  });
}

function renderItems() {
  const cont = document.getElementById('items-lista');
  cont.innerHTML = '';
  let total = 0;
  items.forEach((item, idx) => {
    const subtotal = item.cantidad * item.precio_unitario;
    total += subtotal;
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <span>${item.producto} x${item.cantidad} — $${subtotal.toFixed(2)}</span>
      <button data-idx="${idx}" class="quitar-item-btn">Quitar</button>
    `;
    row.querySelector('.quitar-item-btn').addEventListener('click', () => {
      items.splice(idx, 1);
      renderItems();
    });
    cont.appendChild(row);
  });
  document.getElementById('carrito-total').textContent = total.toFixed(2);
}

document.getElementById('confirmar-venta-btn').addEventListener('click', async () => {
  const msg = document.getElementById('venta-msg');
  if (items.length === 0) {
    msg.textContent = 'Agrega al menos un producto';
    msg.className = 'error';
    return;
  }

  const cliente = document.getElementById('cliente-nombre').value.trim();
  const cliente_direccion = document.getElementById('cliente-direccion').value.trim();
  const cliente_ruc = document.getElementById('cliente-ruc').value.trim();
  const cliente_telefono = document.getElementById('cliente-telefono').value.trim();
  const metodo_pago = document.querySelector('input[name="metodo-pago"]:checked').value;
  const res = await fetch('/api/ventas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliente, cliente_direccion, cliente_ruc, cliente_telefono, items, metodo_pago }),
  });
  const data = await res.json();

  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }

  msg.textContent = `Venta ${data.numero_proforma} registrada por $${data.total.toFixed(2)} (${data.metodo_pago})`;
  msg.className = '';

  const imprimirLink = document.getElementById('imprimir-link');
  imprimirLink.href = `print.html?id=${data.ventaId}`;
  imprimirLink.classList.remove('hidden');

  items = [];
  resetTipoCliente();
  document.querySelector('input[name="metodo-pago"][value="efectivo"]').checked = true;
  renderItems();
  cargarMisVentas();
  cargarEstadoCaja();
  // Si vendió el admin o el dueño, refrescar su dashboard (montos de caja e historial)
  if (rolActual === 'admin' || rolActual === 'dueno') {
    cargarDashboard();
    cargarProductos();
  }
});

async function cargarMisVentas() {
  const res = await fetch('/api/ventas/recientes');
  const ventas = await res.json();
  const tbody = document.querySelector('#mis-ventas-tabla tbody');
  tbody.innerHTML = '';
  ventas.forEach((v) => {
    const tr = document.createElement('tr');
    const totalTexto = v.anulada ? `<s>$${v.total.toFixed(2)}</s> (anulada)` : `$${v.total.toFixed(2)}`;
    const metodoTexto = v.metodo_pago === 'transferencia' ? '<span class="badge-transferencia">Transferencia</span>' : 'Efectivo';
    tr.innerHTML = `<td>${v.id}</td><td>${v.cliente || '-'}</td><td>${v.vendedor}</td><td>${formatFecha(v.fecha)}</td><td>${totalTexto}</td><td>${metodoTexto}</td><td><a href="print.html?id=${v.id}" target="_blank">Imprimir</a></td>`;
    tbody.appendChild(tr);
  });
}

// --- Admin: dashboard, caja, usuarios ---

// Ocultar/mostrar el dinero de la caja (la preferencia se recuerda en este dispositivo)
let dineroOculto = localStorage.getItem('dineroOculto') === '1';

function aplicarVisibilidadDinero() {
  ['caja-inicial', 'caja-actual', 'caja-transferencias'].forEach((id) => {
    const el = document.getElementById(id);
    if (el.dataset.valor == null) return;
    el.textContent = dineroOculto ? '••••' : el.dataset.valor;
  });
  document.getElementById('toggle-dinero-btn').textContent = dineroOculto ? '👁 Mostrar' : '🙈 Ocultar';
}

document.getElementById('toggle-dinero-btn').addEventListener('click', () => {
  dineroOculto = !dineroOculto;
  localStorage.setItem('dineroOculto', dineroOculto ? '1' : '0');
  aplicarVisibilidadDinero();
});

async function cargarDashboard() {
  const res = await fetch('/api/dashboard');
  const data = await res.json();

  const abiertaCard = document.getElementById('caja-abierta-card');
  const cerradaCard = document.getElementById('caja-cerrada-card');
  if (data.turno) {
    abiertaCard.classList.remove('hidden');
    cerradaCard.classList.add('hidden');
    document.getElementById('caja-inicial').dataset.valor = data.turno.monto_inicial.toFixed(2);
    document.getElementById('caja-actual').dataset.valor = data.turno.monto_actual.toFixed(2);
    document.getElementById('caja-transferencias').dataset.valor = data.totalTransferenciasTurno.toFixed(2);
    aplicarVisibilidadDinero();
    document.getElementById('vaciar-caja-btn').classList.toggle('hidden', rolActual !== 'dueno');
  } else {
    abiertaCard.classList.add('hidden');
    cerradaCard.classList.remove('hidden');
  }

  const tbody = document.querySelector('#ventas-tabla tbody');
  tbody.innerHTML = '';
  data.ventas.forEach((v) => {
    const detalleTexto = v.detalle
      .map((d) => `${d.producto} x${d.cantidad}`)
      .join(', ');
    const tr = document.createElement('tr');
    if (v.anulada) tr.className = 'venta-anulada';

    const estadoHtml = v.anulada
      ? `<span class="badge-anulada">ANULADA</span><div class="nota-anulacion">${formatFecha(v.fecha_anulacion)} por ${v.anulada_por_usuario}: "${v.motivo_anulacion}"</div>`
      : 'Activa';

    const metodoTexto = v.metodo_pago === 'transferencia' ? '<span class="badge-transferencia">Transferencia</span>' : 'Efectivo';

    // Punto verde: venta hecha "con datos" (nombre real del cliente o RUC/dirección/teléfono), a diferencia del consumidor final
    const conDatos = (v.cliente && v.cliente.trim() && v.cliente.trim().toLowerCase() !== 'consumidor final')
      || v.cliente_ruc || v.cliente_direccion || v.cliente_telefono;
    const clienteHtml = `${conDatos ? '<span class="dot-cliente-datos"></span>' : ''}${v.cliente || '-'}`;

    tr.innerHTML = `<td>${v.numero_proforma}</td><td>${clienteHtml}</td><td>${v.vendedor}</td><td>${formatFecha(v.fecha)}</td><td>${detalleTexto}</td><td>$${v.total.toFixed(2)}</td><td>${metodoTexto}</td><td>${estadoHtml}</td><td></td>`;

    const tdAccion = tr.lastElementChild;
    const acciones = document.createElement('div');
    acciones.className = 'acciones-venta';
    tdAccion.appendChild(acciones);

    const linkImprimir = document.createElement('a');
    linkImprimir.href = `print.html?id=${v.id}`;
    linkImprimir.target = '_blank';
    linkImprimir.innerHTML = '🖨 Imprimir';
    linkImprimir.className = 'accion-btn imprimir-link';
    acciones.appendChild(linkImprimir);

    if (!v.anulada) {
      const btn = document.createElement('button');
      btn.innerHTML = '⊘ Anular';
      btn.className = 'accion-btn anular-btn';
      btn.addEventListener('click', () => anularVenta(v.id));
      acciones.appendChild(btn);
    }

    if (rolActual === 'dueno') {
      const btnEditar = document.createElement('button');
      btnEditar.innerHTML = '✎ Editar';
      btnEditar.className = 'accion-btn editar-btn';
      btnEditar.addEventListener('click', () => abrirEditarVenta(v));
      acciones.appendChild(btnEditar);

      const btnEliminar = document.createElement('button');
      btnEliminar.innerHTML = '🗑 Eliminar';
      btnEliminar.className = 'accion-btn anular-btn';
      btnEliminar.addEventListener('click', () => eliminarVenta(v.id));
      acciones.appendChild(btnEliminar);
    }

    tbody.appendChild(tr);
  });
}

async function eliminarVenta(ventaId) {
  if (!confirm('¿Eliminar esta venta PERMANENTEMENTE? Se borra de la base de datos y no se puede recuperar.')) return;
  const res = await fetch(`/api/ventas/${ventaId}/eliminar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const data = await res.json();
    alert(data.error);
    return;
  }
  cargarDashboard();
}

// --- Edición de venta (solo dueño) ---

function abrirEditarVenta(venta) {
  editandoVentaId = venta.id;
  editandoItems = venta.detalle.map((d) => ({ ...d }));
  document.getElementById('editar-cliente-nombre').value = venta.cliente || '';
  document.getElementById('editar-cliente-direccion').value = venta.cliente_direccion || '';
  document.getElementById('editar-cliente-ruc').value = venta.cliente_ruc || '';
  document.getElementById('editar-cliente-telefono').value = venta.cliente_telefono || '';
  document.querySelector(`input[name="editar-metodo-pago"][value="${venta.metodo_pago || 'efectivo'}"]`).checked = true;
  document.getElementById('editar-msg').textContent = '';
  renderEditarItems();
  document.getElementById('editar-venta-modal').classList.remove('hidden');
}

document.getElementById('cerrar-editar-btn').addEventListener('click', () => {
  document.getElementById('editar-venta-modal').classList.add('hidden');
});

document.getElementById('editar-agregar-item-btn').addEventListener('click', () => {
  const producto = document.getElementById('editar-item-producto').value.trim();
  const cantidad = parseFloat(document.getElementById('editar-item-cantidad').value);
  const precio_unitario = parseFloat(document.getElementById('editar-item-precio').value);

  if (!producto || !cantidad || cantidad <= 0 || isNaN(precio_unitario) || precio_unitario < 0) {
    document.getElementById('editar-msg').textContent = 'Completa producto, cantidad y precio válidos';
    document.getElementById('editar-msg').className = 'error';
    return;
  }

  editandoItems.push({ producto, cantidad, precio_unitario });
  document.getElementById('editar-item-producto').value = '';
  document.getElementById('editar-item-cantidad').value = '1';
  document.getElementById('editar-item-precio').value = '';
  document.getElementById('editar-msg').textContent = '';
  renderEditarItems();
});

function renderEditarItems() {
  const cont = document.getElementById('editar-items-lista');
  cont.innerHTML = '';
  let total = 0;
  editandoItems.forEach((item, idx) => {
    const subtotal = item.cantidad * item.precio_unitario;
    total += subtotal;
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <span>${item.producto} x${item.cantidad} — $${subtotal.toFixed(2)}</span>
      <button data-idx="${idx}" class="quitar-item-btn">Quitar</button>
    `;
    row.querySelector('.quitar-item-btn').addEventListener('click', () => {
      editandoItems.splice(idx, 1);
      renderEditarItems();
    });
    cont.appendChild(row);
  });
  document.getElementById('editar-total').textContent = total.toFixed(2);
}

document.getElementById('guardar-edicion-btn').addEventListener('click', async () => {
  const msg = document.getElementById('editar-msg');
  if (editandoItems.length === 0) {
    msg.textContent = 'Agrega al menos un producto';
    msg.className = 'error';
    return;
  }

  const cliente = document.getElementById('editar-cliente-nombre').value.trim();
  const cliente_direccion = document.getElementById('editar-cliente-direccion').value.trim();
  const cliente_ruc = document.getElementById('editar-cliente-ruc').value.trim();
  const cliente_telefono = document.getElementById('editar-cliente-telefono').value.trim();
  const metodo_pago = document.querySelector('input[name="editar-metodo-pago"]:checked').value;

  const res = await fetch(`/api/ventas/${editandoVentaId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliente, cliente_direccion, cliente_ruc, cliente_telefono, items: editandoItems, metodo_pago }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }

  document.getElementById('editar-venta-modal').classList.add('hidden');
  cargarDashboard();
});

async function anularVenta(ventaId) {
  const motivo = window.prompt('Motivo de la anulación (ej: venta duplicada por error):');
  if (motivo === null) return;
  if (!motivo.trim()) {
    alert('Debes indicar un motivo');
    return;
  }
  const res = await fetch(`/api/ventas/${ventaId}/anular`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ motivo }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error);
    return;
  }
  cargarDashboard();
}

document.getElementById('abrir-caja-btn').addEventListener('click', async () => {
  const msg = document.getElementById('caja-msg');
  const monto_inicial = parseFloat(document.getElementById('monto-inicial-input').value);
  if (isNaN(monto_inicial) || monto_inicial < 0) {
    msg.textContent = 'Ingresa un monto inicial válido';
    msg.className = 'error';
    return;
  }
  const res = await fetch('/api/caja/abrir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ monto_inicial }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }
  msg.textContent = 'Caja abierta';
  msg.className = '';
  document.getElementById('monto-inicial-input').value = '';
  cargarDashboard();
  cargarEstadoCaja(); // al abrir caja aparece la Nota de venta del admin
});

document.getElementById('vaciar-caja-btn').addEventListener('click', async () => {
  if (!confirm('¿Seguro? Esto pone el monto inicial y actual en $0.00. La caja sigue abierta.')) return;
  const msg = document.getElementById('caja-msg');
  const res = await fetch('/api/caja/vaciar', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }
  msg.textContent = 'Caja vaciada. Todos los montos en $0.00.';
  msg.className = '';
  cargarDashboard();
});

document.getElementById('cerrar-caja-btn').addEventListener('click', async () => {
  const msg = document.getElementById('caja-msg');
  const res = await fetch('/api/caja/cerrar', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }
  msg.textContent = `Caja cerrada con $${data.monto_actual.toFixed(2)}`;
  msg.className = '';
  cargarDashboard();
  cargarEstadoCaja(); // al cerrar caja se oculta la Nota de venta del admin
});

// --- Gastos (descuentan de la caja) ---

async function cargarGastos() {
  const res = await fetch('/api/gastos');
  const gastos = await res.json();
  const tbody = document.querySelector('#gastos-tabla tbody');
  tbody.innerHTML = '';
  gastos.forEach((g) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${formatFecha(g.fecha)}</td><td>${g.descripcion}</td><td>$${g.monto.toFixed(2)}</td><td>${g.registrado_por}</td><td></td>`;

    const tdAccion = tr.lastElementChild;
    const acciones = document.createElement('div');
    acciones.className = 'acciones-venta';

    const btnEditar = document.createElement('button');
    btnEditar.textContent = '✎ Editar';
    btnEditar.className = 'accion-btn editar-btn';
    btnEditar.addEventListener('click', () => editarGasto(g));
    acciones.appendChild(btnEditar);

    // Borrar un gasto es permanente: solo el dueño ve el botón
    if (rolActual === 'dueno') {
      const btnEliminar = document.createElement('button');
      btnEliminar.textContent = '🗑 Eliminar';
      btnEliminar.className = 'accion-btn anular-btn';
      btnEliminar.addEventListener('click', () => eliminarGasto(g));
      acciones.appendChild(btnEliminar);
    }

    tdAccion.appendChild(acciones);
    tbody.appendChild(tr);
  });
}

async function editarGasto(g) {
  const nuevaDesc = window.prompt('Descripción:', g.descripcion);
  if (nuevaDesc === null) return;
  const nuevoMontoStr = window.prompt('Monto:', g.monto);
  if (nuevoMontoStr === null) return;
  const nuevoMonto = parseFloat(nuevoMontoStr);
  if (!nuevaDesc.trim() || isNaN(nuevoMonto) || nuevoMonto <= 0) {
    alert('Descripción y monto válido son obligatorios');
    return;
  }
  const res = await fetch(`/api/gastos/${g.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ descripcion: nuevaDesc.trim(), monto: nuevoMonto }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  cargarGastos();
  cargarDashboard();
}

async function eliminarGasto(g) {
  if (!confirm(`¿Eliminar gasto "${g.descripcion}" de $${g.monto.toFixed(2)}? El monto vuelve a la caja.`)) return;
  const res = await fetch(`/api/gastos/${g.id}`, { method: 'DELETE' });
  if (!res.ok) { const d = await res.json(); alert(d.error); return; }
  cargarGastos();
  cargarDashboard();
}

document.getElementById('registrar-gasto-btn').addEventListener('click', async () => {
  const msg = document.getElementById('gasto-msg');
  const descripcion = document.getElementById('gasto-descripcion').value.trim();
  const monto = parseFloat(document.getElementById('gasto-monto').value);

  if (!descripcion || isNaN(monto) || monto <= 0) {
    msg.textContent = 'Completa descripción y un monto válido';
    msg.className = 'error';
    return;
  }

  const res = await fetch('/api/gastos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ descripcion, monto }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }

  msg.textContent = `Gasto de $${data.monto.toFixed(2)} registrado`;
  msg.className = '';
  document.getElementById('gasto-descripcion').value = '';
  document.getElementById('gasto-monto').value = '';
  cargarGastos();
  cargarDashboard();
});

async function cargarUsuarios() {
  const res = await fetch('/api/usuarios');
  const usuarios = await res.json();
  const tbody = document.querySelector('#usuarios-tabla tbody');
  tbody.innerHTML = '';
  usuarios.forEach((u) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${u.usuario}</td>
      <td>${u.rol}</td>
      <td>${u.activo ? 'Sí' : 'No'}</td>
      <td></td>
    `;

    const acciones = document.createElement('div');
    acciones.className = 'acciones-venta';

    const btnToggle = document.createElement('button');
    btnToggle.textContent = u.activo ? 'Desactivar' : 'Activar';
    btnToggle.className = 'toggle-activo-btn';
    btnToggle.addEventListener('click', async () => {
      await fetch(`/api/usuarios/${u.id}/activo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activo: !u.activo }),
      });
      cargarUsuarios();
    });
    acciones.appendChild(btnToggle);

    // Renombrar/cambiar rol y eliminar usuarios: exclusivo del dueño
    if (rolActual === 'dueno') {
      const btnRenombrar = document.createElement('button');
      btnRenombrar.textContent = '✎ Renombrar';
      btnRenombrar.className = 'accion-btn editar-btn';
      btnRenombrar.addEventListener('click', () => renombrarUsuario(u));
      acciones.appendChild(btnRenombrar);

      const btnEliminar = document.createElement('button');
      btnEliminar.textContent = '🗑 Eliminar';
      btnEliminar.className = 'accion-btn anular-btn';
      btnEliminar.addEventListener('click', () => eliminarUsuario(u));
      acciones.appendChild(btnEliminar);
    }

    tr.lastElementChild.appendChild(acciones);
    tbody.appendChild(tr);
  });
}

async function renombrarUsuario(u) {
  const nuevoNombre = window.prompt('Nuevo nombre de usuario:', u.usuario);
  if (nuevoNombre === null) return;
  if (!nuevoNombre.trim()) { alert('El nombre no puede estar vacío'); return; }
  const nuevoRol = window.prompt('Rol (vendedor / admin / dueno):', u.rol);
  if (nuevoRol === null) return;
  if (!['vendedor', 'admin', 'dueno'].includes(nuevoRol.trim().toLowerCase())) {
    alert('Rol inválido. Debe ser: vendedor, admin o dueno');
    return;
  }
  const res = await fetch(`/api/usuarios/${u.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: nuevoNombre.trim(), rol: nuevoRol.trim().toLowerCase() }),
  });
  if (!res.ok) { const d = await res.json(); alert(d.error); return; }
  cargarUsuarios();
}

async function eliminarUsuario(u) {
  if (!confirm(`¿Eliminar al usuario "${u.usuario}" PERMANENTEMENTE? No se puede recuperar.`)) return;
  const res = await fetch(`/api/usuarios/${u.id}`, { method: 'DELETE' });
  if (!res.ok) { const d = await res.json(); alert(d.error); return; }
  cargarUsuarios();
}

document.getElementById('crear-usuario-btn').addEventListener('click', async () => {
  const msg = document.getElementById('usuario-msg');
  const usuario = document.getElementById('nuevo-usuario').value.trim();
  const password = document.getElementById('nuevo-password').value;
  const rol = document.getElementById('nuevo-rol').value;

  if (!usuario || !password) {
    msg.textContent = 'Usuario y contraseña son obligatorios';
    msg.className = 'error';
    return;
  }

  const res = await fetch('/api/usuarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, password, rol }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }
  msg.textContent = `Usuario "${data.usuario}" creado`;
  msg.className = '';
  document.getElementById('nuevo-usuario').value = '';
  document.getElementById('nuevo-password').value = '';
  cargarUsuarios();
});

// --- Catálogo / Inventario ---

async function cargarProductos() {
  const res = await fetch('/api/productos');
  if (!res.ok) return;
  const productos = await res.json();
  const tbody = document.querySelector('#productos-tabla tbody');
  tbody.innerHTML = '';
  productos.forEach((p) => {
    const tr = document.createElement('tr');
    if (!p.activo || p.eliminado) tr.style.opacity = '0.5';
    const stockRojo = p.stock === 2;
    const stockAzul = p.stock === 1;
    const stockColor = stockRojo ? 'color:#dc2626;font-weight:bold' : stockAzul ? 'color:#0369a1;font-weight:bold' : '';
    // Solo el dueño recibe productos eliminados del servidor: se muestran con el motivo que escribió el admin
    const notaEliminado = p.eliminado
      ? `<div class="nota-anulacion">Eliminado ${formatFecha(p.fecha_eliminacion)} por ${p.eliminado_por_usuario || 'admin'}: "${p.motivo_eliminacion}"</div>`
      : '';
    tr.innerHTML = `
      <td>${p.modelo}${notaEliminado}</td>
      <td>${p.talla}</td>
      <td>${p.color}</td>
      <td>$${p.precio.toFixed(2)}</td>
      <td style="${stockColor}">${p.stock}${stockRojo || stockAzul ? ' ⚠' : ''}</td>
      <td></td>
    `;

    const acciones = document.createElement('div');
    acciones.className = 'acciones-venta';

    if (p.eliminado) {
      const badge = document.createElement('span');
      badge.className = 'badge-anulada';
      badge.textContent = 'ELIMINADO';
      acciones.appendChild(badge);

      // El dueño puede purgar definitivamente lo que el admin marcó como eliminado
      const btnPurga = document.createElement('button');
      btnPurga.textContent = '🗑 Eliminar definitivo';
      btnPurga.className = 'accion-btn';
      btnPurga.style.background = '#a855f7';
      btnPurga.style.color = '#fff';
      btnPurga.addEventListener('click', () => eliminarProductoDefinitivo(p));
      acciones.appendChild(btnPurga);
    } else {
      const btnEditar = document.createElement('button');
      btnEditar.textContent = '✎ Editar';
      btnEditar.className = 'accion-btn editar-btn';
      btnEditar.addEventListener('click', () => editarProducto(p));
      acciones.appendChild(btnEditar);

      const btnToggle = document.createElement('button');
      btnToggle.textContent = p.activo ? 'Desactivar' : 'Activar';
      btnToggle.className = 'accion-btn';
      btnToggle.style.background = p.activo ? '#dc2626' : '#16a34a';
      btnToggle.style.color = '#fff';
      btnToggle.addEventListener('click', () => toggleProducto(p));
      acciones.appendChild(btnToggle);

      // Dueño: elimina definitivamente. Admin: solo marca como eliminado (con motivo que el dueño verá).
      const btnEliminar = document.createElement('button');
      btnEliminar.textContent = '🗑 Eliminar';
      btnEliminar.className = 'accion-btn';
      btnEliminar.style.background = '#a855f7';
      btnEliminar.style.color = '#fff';
      btnEliminar.addEventListener('click', () => (rolActual === 'dueno' ? eliminarProductoDefinitivo(p) : eliminarProducto(p)));
      acciones.appendChild(btnEliminar);
    }

    tr.lastElementChild.appendChild(acciones);
    tbody.appendChild(tr);
  });
}

async function eliminarProductoDefinitivo(p) {
  if (!confirm(`¿Eliminar "${p.modelo} T${p.talla} ${p.color}" PERMANENTEMENTE? Se borra de la base de datos y no se puede recuperar.`)) return;
  const res = await fetch(`/api/productos/${p.id}`, { method: 'DELETE' });
  if (!res.ok) { const d = await res.json(); alert(d.error); return; }
  cargarProductos();
}

async function eliminarProducto(p) {
  const motivo = window.prompt(`¿Por qué eliminas "${p.modelo} T${p.talla} ${p.color}"? (el dueño verá este motivo)`);
  if (motivo === null) return;
  if (!motivo.trim()) {
    alert('Debes escribir el motivo');
    return;
  }
  const res = await fetch(`/api/productos/${p.id}/eliminar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ motivo }),
  });
  if (!res.ok) { const d = await res.json(); alert(d.error); return; }
  cargarProductos();
}

async function editarProducto(p) {
  const modelo = window.prompt('Modelo:', p.modelo);
  if (modelo === null) return;
  const talla = window.prompt('Talla:', p.talla);
  if (talla === null) return;
  const color = window.prompt('Color:', p.color);
  if (color === null) return;
  const precioStr = window.prompt('Precio:', p.precio);
  if (precioStr === null) return;
  const stockStr = window.prompt('Stock actual:', p.stock);
  if (stockStr === null) return;

  const precio = parseFloat(precioStr);
  const stock = parseInt(stockStr, 10);
  if (!modelo.trim() || !talla.trim() || !color.trim() || isNaN(precio) || precio < 0 || isNaN(stock) || stock < 0) {
    alert('Datos inválidos');
    return;
  }

  const res = await fetch(`/api/productos/${p.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelo: modelo.trim(), talla: talla.trim(), color: color.trim(), precio, stock }),
  });
  if (!res.ok) { const d = await res.json(); alert(d.error); return; }
  cargarProductos();
}

async function toggleProducto(p) {
  const res = await fetch(`/api/productos/${p.id}/activo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activo: !p.activo }),
  });
  if (!res.ok) { const d = await res.json(); alert(d.error); return; }
  cargarProductos();
}

document.getElementById('crear-producto-btn').addEventListener('click', async () => {
  const msg = document.getElementById('producto-msg');
  const modelo = document.getElementById('prod-modelo').value.trim();
  const talla = document.getElementById('prod-talla').value.trim();
  const color = document.getElementById('prod-color').value.trim();
  const precio = parseFloat(document.getElementById('prod-precio').value);
  const stock = parseInt(document.getElementById('prod-stock').value, 10);

  if (!modelo || !talla || !color || isNaN(precio) || precio < 0 || isNaN(stock) || stock < 0) {
    msg.textContent = 'Completa todos los campos con valores válidos';
    msg.className = 'error';
    return;
  }

  const res = await fetch('/api/productos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelo, talla, color, precio, stock }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }

  msg.textContent = `Producto "${data.modelo} T${data.talla} ${data.color}" agregado con stock ${data.stock}`;
  msg.className = '';
  document.getElementById('prod-modelo').value = '';
  document.getElementById('prod-talla').value = '';
  document.getElementById('prod-color').value = '';
  document.getElementById('prod-precio').value = '';
  document.getElementById('prod-stock').value = '';
  cargarProductos();
});

// --- Al cargar la página, verificar si ya hay sesión activa ---

(async function init() {
  const res = await fetch('/api/me');
  if (res.ok) {
    const user = await res.json();
    mostrarPantalla(user.rol);
  }
})();
