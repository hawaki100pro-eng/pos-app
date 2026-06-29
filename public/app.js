const loginScreen = document.getElementById('login-screen');
const vendedorScreen = document.getElementById('vendedor-screen');
const adminScreen = document.getElementById('admin-screen');

let items = []; // { producto, cantidad, precio_unitario }
let editandoItems = []; // ítems en edición dentro del modal de editar venta
let editandoVentaId = null;
let editandoDescuentoPct = 0;
let rolActual = null;
let descuentoPct = 0;
let catalogoCache = [];
let catalogoSeleccionado = null;

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
    cargarCatalogoAdmin();
  } else {
    vendedorScreen.classList.remove('hidden');
    cargarEstadoCaja();
    cargarMisVentas();
    cargarCatalogoVendedor();
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  items = [];
  descuentoPct = 0;
  catalogoSeleccionado = null;
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

// --- Tabs: proforma libre vs pedido grande ---

document.getElementById('tab-libre-btn').addEventListener('click', () => {
  document.getElementById('tab-libre-btn').classList.add('tab-activo');
  document.getElementById('tab-catalogo-btn').classList.remove('tab-activo');
  document.getElementById('panel-libre').classList.remove('hidden');
  document.getElementById('panel-catalogo').classList.add('hidden');
});

document.getElementById('tab-catalogo-btn').addEventListener('click', () => {
  document.getElementById('tab-catalogo-btn').classList.add('tab-activo');
  document.getElementById('tab-libre-btn').classList.remove('tab-activo');
  document.getElementById('panel-catalogo').classList.remove('hidden');
  document.getElementById('panel-libre').classList.add('hidden');
});

// --- Pedido grande: búsqueda en catálogo, colores y cantidades ---

async function cargarCatalogoVendedor() {
  const res = await fetch('/api/catalogo');
  catalogoCache = await res.json();
}

document.getElementById('cat-buscar').addEventListener('input', () => {
  const q = document.getElementById('cat-buscar').value.trim().toUpperCase().replace(/\s/g, '');
  const lista = document.getElementById('cat-sug-list');
  document.getElementById('cat-msg').textContent = '';
  catalogoSeleccionado = null;
  ocultarColoresCatalogo();

  if (!q) { lista.classList.remove('vis'); return; }

  const res = catalogoCache.filter((p) =>
    p.codigo.toUpperCase().replace(/\s/g, '').includes(q) ||
    p.descripcion.toUpperCase().replace(/\s/g, '').includes(q)
  );
  if (!res.length) { lista.classList.remove('vis'); return; }

  lista.innerHTML = res.map((p) => `
    <div class="sug-item ${p.agotado ? 'agotado' : ''}" data-codigo="${p.codigo}">
      <span class="sug-cod">${p.codigo}</span>
      <span class="sug-col">${p.colores.join(' · ')}</span>
      <span class="sug-prec">${p.agotado ? 'AGOTADO ' : ''}$${p.precio.toFixed(2)}</span>
    </div>`).join('');
  lista.classList.add('vis');
  lista.querySelectorAll('.sug-item').forEach((el) => {
    el.addEventListener('click', () => elegirCatalogo(el.dataset.codigo));
  });
});

function elegirCatalogo(codigo) {
  const p = catalogoCache.find((x) => x.codigo === codigo);
  if (!p) return;
  catalogoSeleccionado = p;
  document.getElementById('cat-buscar').value = p.codigo;
  document.getElementById('cat-sug-list').classList.remove('vis');
  mostrarColoresCatalogo(p.colores);
}

function mostrarColoresCatalogo(colores) {
  const panel = document.getElementById('cat-colores-panel');
  const wrap = document.getElementById('cat-chips-wrap');
  wrap.innerHTML = colores.map((c, i) => `
    <div class="chip-wrap">
      <div class="chip" id="cat-chip-${i}" data-color="${c}">${c}</div>
      <input class="chip-cant" id="cat-cant-${i}" type="number" value="1" min="0.5" step="0.5">
    </div>
  `).join('');
  wrap.querySelectorAll('.chip').forEach((chip, i) => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('sel');
      const cant = document.getElementById(`cat-cant-${i}`);
      cant.classList.toggle('vis', chip.classList.contains('sel'));
      if (chip.classList.contains('sel')) {
        cant.focus();
        agregarDesdeCatalogo();
      }
    });
  });
  panel.classList.remove('hidden');
}

function ocultarColoresCatalogo() {
  document.getElementById('cat-colores-panel').classList.add('hidden');
  document.getElementById('cat-chips-wrap').innerHTML = '';
}

function agregarDesdeCatalogo() {
  if (!catalogoSeleccionado) return;
  const chipsSeleccionados = document.querySelectorAll('#cat-chips-wrap .chip.sel');
  chipsSeleccionados.forEach((chip) => {
    const idx = chip.id.replace('cat-chip-', '');
    const cantidad = parseFloat(document.getElementById(`cat-cant-${idx}`).value) || 1;
    const color = chip.dataset.color;
    const producto = `${catalogoSeleccionado.descripcion} (${color})`;
    const existente = items.find((it) => it.producto === producto);
    if (existente) {
      existente.cantidad = cantidad;
    } else {
      items.push({ producto, cantidad, precio_unitario: catalogoSeleccionado.precio });
    }
  });
  renderItems();
}

document.getElementById('cat-chips-wrap').addEventListener('input', (e) => {
  if (e.target.classList.contains('chip-cant')) agregarDesdeCatalogo();
});

document.getElementById('descuento-slider').addEventListener('input', (e) => {
  descuentoPct = parseInt(e.target.value, 10);
  document.getElementById('descuento-pct-label').textContent = `${descuentoPct}%`;
  renderItems();
});

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
  let subtotal = 0;
  items.forEach((item, idx) => {
    const itemSubtotal = item.cantidad * item.precio_unitario;
    subtotal += itemSubtotal;
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <span>${item.producto} x${item.cantidad} — $${itemSubtotal.toFixed(2)}</span>
      <button data-idx="${idx}" class="quitar-item-btn">Quitar</button>
    `;
    row.querySelector('.quitar-item-btn').addEventListener('click', () => {
      items.splice(idx, 1);
      renderItems();
    });
    cont.appendChild(row);
  });
  const total = subtotal * (1 - descuentoPct / 100);
  document.getElementById('carrito-subtotal').textContent = subtotal.toFixed(2);
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
  const res = await fetch('/api/ventas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliente, cliente_direccion, cliente_ruc, cliente_telefono, items, descuento_pct: descuentoPct }),
  });
  const data = await res.json();

  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }

  msg.textContent = `Venta ${data.numero_proforma} registrada por $${data.total.toFixed(2)}`;
  msg.className = '';

  const imprimirLink = document.getElementById('imprimir-link');
  imprimirLink.href = `print.html?id=${data.ventaId}`;
  imprimirLink.classList.remove('hidden');

  items = [];
  descuentoPct = 0;
  catalogoSeleccionado = null;
  document.getElementById('cliente-nombre').value = '';
  document.getElementById('cliente-direccion').value = '';
  document.getElementById('cliente-ruc').value = '';
  document.getElementById('cliente-telefono').value = '';
  document.getElementById('cat-buscar').value = '';
  document.getElementById('descuento-slider').value = 0;
  document.getElementById('descuento-pct-label').textContent = '0%';
  ocultarColoresCatalogo();
  renderItems();
  cargarMisVentas();
  cargarCatalogoVendedor();
});

async function cargarMisVentas() {
  const res = await fetch('/api/ventas/recientes');
  const ventas = await res.json();
  const tbody = document.querySelector('#mis-ventas-tabla tbody');
  tbody.innerHTML = '';
  ventas.forEach((v) => {
    const tr = document.createElement('tr');
    const totalTexto = v.anulada ? `<s>$${v.total.toFixed(2)}</s> (anulada)` : `$${v.total.toFixed(2)}`;
    tr.innerHTML = `<td>${v.id}</td><td>${v.cliente || '-'}</td><td>${v.vendedor}</td><td>${v.fecha}</td><td>${totalTexto}</td><td><a href="print.html?id=${v.id}" target="_blank">Imprimir</a></td>`;
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
      ? `<span class="badge-anulada">ANULADA</span><div class="nota-anulacion">${v.fecha_anulacion} por ${v.anulada_por_usuario}: "${v.motivo_anulacion}"</div>`
      : 'Activa';

    const totalTexto = v.descuento_pct > 0
      ? `$${v.total.toFixed(2)} <small>(desc. ${v.descuento_pct}%)</small>`
      : `$${v.total.toFixed(2)}`;

    tr.innerHTML = `<td>${v.numero_proforma}</td><td>${v.cliente || '-'}</td><td>${v.vendedor}</td><td>${v.fecha}</td><td>${detalleTexto}</td><td>${totalTexto}</td><td>${estadoHtml}</td><td></td>`;

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
  editandoDescuentoPct = venta.descuento_pct || 0;
  editandoItems = venta.detalle.map((d) => ({ ...d }));
  document.getElementById('editar-cliente-nombre').value = venta.cliente || '';
  document.getElementById('editar-cliente-direccion').value = venta.cliente_direccion || '';
  document.getElementById('editar-cliente-ruc').value = venta.cliente_ruc || '';
  document.getElementById('editar-cliente-telefono').value = venta.cliente_telefono || '';
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

  const res = await fetch(`/api/ventas/${editandoVentaId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliente, cliente_direccion, cliente_ruc, cliente_telefono, items: editandoItems, descuento_pct: editandoDescuentoPct }),
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

// --- Admin/dueño: gestión del catálogo de productos ---

async function cargarCatalogoAdmin() {
  const res = await fetch('/api/catalogo');
  const productos = await res.json();
  const tbody = document.querySelector('#catalogo-tabla tbody');
  tbody.innerHTML = '';
  productos.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.codigo}</td>
      <td>${p.descripcion}</td>
      <td>$${p.precio.toFixed(2)}</td>
      <td>${p.colores.join(', ')}</td>
      <td>${p.agotado ? 'Agotado' : 'Disponible'}</td>
      <td></td>
    `;
    const tdAccion = tr.lastElementChild;

    const btnAgotado = document.createElement('button');
    btnAgotado.textContent = p.agotado ? 'Marcar disponible' : 'Marcar agotado';
    btnAgotado.addEventListener('click', async () => {
      await fetch(`/api/catalogo/${p.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ descripcion: p.descripcion, precio: p.precio, colores: p.colores, agotado: !p.agotado }),
      });
      cargarCatalogoAdmin();
    });
    tdAccion.appendChild(btnAgotado);

    const btnEliminar = document.createElement('button');
    btnEliminar.textContent = 'Eliminar';
    btnEliminar.className = 'anular-btn';
    btnEliminar.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar "${p.codigo}" del catálogo?`)) return;
      await fetch(`/api/catalogo/${p.id}`, { method: 'DELETE' });
      cargarCatalogoAdmin();
    });
    tdAccion.appendChild(btnEliminar);

    tbody.appendChild(tr);
  });
}

document.getElementById('cat-crear-btn').addEventListener('click', async () => {
  const msg = document.getElementById('catalogo-msg');
  const codigo = document.getElementById('cat-nuevo-codigo').value.trim();
  const descripcion = document.getElementById('cat-nuevo-desc').value.trim();
  const precio = parseFloat(document.getElementById('cat-nuevo-precio').value);
  const colores = document.getElementById('cat-nuevo-colores').value.split(',').map((c) => c.trim()).filter(Boolean);
  const agotado = document.getElementById('cat-nuevo-agotado').checked;

  if (!codigo || !descripcion || isNaN(precio) || colores.length === 0) {
    msg.textContent = 'Completa código, descripción, precio y al menos un color';
    msg.className = 'error';
    return;
  }

  const res = await fetch('/api/catalogo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo, descripcion, precio, colores, agotado }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }

  msg.textContent = `Producto "${data.codigo}" agregado`;
  msg.className = '';
  document.getElementById('cat-nuevo-codigo').value = '';
  document.getElementById('cat-nuevo-desc').value = '';
  document.getElementById('cat-nuevo-precio').value = '';
  document.getElementById('cat-nuevo-colores').value = '';
  document.getElementById('cat-nuevo-agotado').checked = false;
  cargarCatalogoAdmin();
});

// --- Al cargar la página, verificar si ya hay sesión activa ---

(async function init() {
  const res = await fetch('/api/me');
  if (res.ok) {
    const user = await res.json();
    mostrarPantalla(user.rol);
  }
})();

document.addEventListener('click', (e) => {
  if (!e.target.closest('.sug-wrap')) {
    const lista = document.getElementById('cat-sug-list');
    if (lista) lista.classList.remove('vis');
  }
});
