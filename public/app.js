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

  if (rol === 'admin' || rol === 'dueno') {
    adminScreen.classList.remove('hidden');
    document.querySelector('#admin-screen h1').textContent = rol === 'dueno' ? 'Panel del dueño' : 'Panel administrador';
    cargarDashboard();
    cargarUsuarios();
    cargarGastos();
  } else {
    vendedorScreen.classList.remove('hidden');
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

document.getElementById('agregar-item-btn').addEventListener('click', () => {
  const producto = document.getElementById('item-producto').value.trim();
  const cantidad = parseFloat(document.getElementById('item-cantidad').value);
  const precio_unitario = parseFloat(document.getElementById('item-precio').value);

  if (!producto || !cantidad || cantidad <= 0 || isNaN(precio_unitario) || precio_unitario < 0) {
    document.getElementById('venta-msg').textContent = 'Completa producto, cantidad y precio válidos';
    document.getElementById('venta-msg').className = 'error';
    return;
  }

  items.push({ producto, cantidad, precio_unitario });
  document.getElementById('item-producto').value = '';
  document.getElementById('item-cantidad').value = '1';
  document.getElementById('item-precio').value = '';
  document.getElementById('venta-msg').textContent = '';
  renderItems();
});

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
  document.getElementById('cliente-nombre').value = '';
  document.getElementById('cliente-direccion').value = '';
  document.getElementById('cliente-ruc').value = '';
  document.getElementById('cliente-telefono').value = '';
  document.querySelector('input[name="metodo-pago"][value="efectivo"]').checked = true;
  renderItems();
  cargarMisVentas();
  cargarEstadoCaja();
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

async function cargarDashboard() {
  const res = await fetch('/api/dashboard');
  const data = await res.json();

  const abiertaCard = document.getElementById('caja-abierta-card');
  const cerradaCard = document.getElementById('caja-cerrada-card');
  if (data.turno) {
    abiertaCard.classList.remove('hidden');
    cerradaCard.classList.add('hidden');
    document.getElementById('caja-inicial').textContent = data.turno.monto_inicial.toFixed(2);
    document.getElementById('caja-actual').textContent = data.turno.monto_actual.toFixed(2);
    document.getElementById('caja-transferencias').textContent = data.totalTransferenciasTurno.toFixed(2);
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

    tr.innerHTML = `<td>${v.numero_proforma}</td><td>${v.cliente || '-'}</td><td>${v.vendedor}</td><td>${formatFecha(v.fecha)}</td><td>${detalleTexto}</td><td>$${v.total.toFixed(2)}</td><td>${metodoTexto}</td><td>${estadoHtml}</td><td></td>`;

    const tdAccion = tr.lastElementChild;
    const linkImprimir = document.createElement('a');
    linkImprimir.href = `print.html?id=${v.id}`;
    linkImprimir.target = '_blank';
    linkImprimir.textContent = 'Imprimir';
    linkImprimir.className = 'imprimir-link';
    tdAccion.appendChild(linkImprimir);

    if (!v.anulada) {
      const btn = document.createElement('button');
      btn.textContent = 'Anular';
      btn.className = 'anular-btn';
      btn.addEventListener('click', () => anularVenta(v.id));
      tdAccion.appendChild(btn);
    }

    if (rolActual === 'dueno') {
      const btnEditar = document.createElement('button');
      btnEditar.textContent = 'Editar';
      btnEditar.addEventListener('click', () => abrirEditarVenta(v));
      tdAccion.appendChild(btnEditar);

      const btnEliminar = document.createElement('button');
      btnEliminar.textContent = 'Eliminar';
      btnEliminar.className = 'anular-btn';
      btnEliminar.addEventListener('click', () => eliminarVenta(v.id));
      tdAccion.appendChild(btnEliminar);
    }

    tbody.appendChild(tr);
  });
}

async function eliminarVenta(ventaId) {
  const motivo = window.prompt('Motivo de la eliminación (queda registrado, no se puede deshacer desde la interfaz):');
  if (motivo === null) return;
  if (!motivo.trim()) {
    alert('Debes indicar un motivo');
    return;
  }
  const res = await fetch(`/api/ventas/${ventaId}/eliminar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ motivo }),
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
});

// --- Gastos (descuentan de la caja) ---

async function cargarGastos() {
  const res = await fetch('/api/gastos');
  const gastos = await res.json();
  const tbody = document.querySelector('#gastos-tabla tbody');
  tbody.innerHTML = '';
  gastos.forEach((g) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${formatFecha(g.fecha)}</td><td>${g.descripcion}</td><td>$${g.monto.toFixed(2)}</td><td>${g.registrado_por}</td>`;
    tbody.appendChild(tr);
  });
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
      <td><button class="toggle-activo-btn" data-id="${u.id}" data-activo="${u.activo}">${u.activo ? 'Desactivar' : 'Activar'}</button></td>
    `;
    tr.querySelector('.toggle-activo-btn').addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      const activoActual = e.target.dataset.activo === '1';
      await fetch(`/api/usuarios/${id}/activo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activo: !activoActual }),
      });
      cargarUsuarios();
    });
    tbody.appendChild(tr);
  });
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

// --- Al cargar la página, verificar si ya hay sesión activa ---

(async function init() {
  const res = await fetch('/api/me');
  if (res.ok) {
    const user = await res.json();
    mostrarPantalla(user.rol);
  }
})();
