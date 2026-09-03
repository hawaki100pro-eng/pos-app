const loginScreen = document.getElementById('login-screen');
const vendedorScreen = document.getElementById('vendedor-screen');
const adminScreen = document.getElementById('admin-screen');
// El logo es uno solo y va dentro del marco: se muda a la pantalla que se esté mostrando
const logoHawaki = document.getElementById('logo-hawaki');

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
  mostrarPantalla(user);
});

// Saludo amigable con emoji aleatorio (solo para vendedores).
// Caras amigables para todos; las rositas solo si el nombre parece femenino.
const EMOJIS_CARAS = ['😊', '😄', '😁', '🤗', '😎', '🙂', '😃'];
const EMOJIS_ROSITAS = ['🌸', '🌺', '🌷', '🌹', '💐', '🌼', '🥰', '✨'];
// Heurística: termina en "a" o está en esta lista. Agregar aquí nombres femeninos que no terminen en "a".
const NOMBRES_FEMENINOS = ['jennifer', 'jessica', 'karen', 'katherine', 'nicole', 'lisbeth', 'estefania', 'belen', 'fernanda'];

function esNombreFemenino(usuario) {
  const n = usuario.toLowerCase().replace(/[0-9]+$/, ''); // ignora números finales (ej. jennifer1)
  return n.endsWith('a') || NOMBRES_FEMENINOS.includes(n);
}

function armarSaludo(usuario) {
  const nombre = usuario.charAt(0).toUpperCase() + usuario.slice(1);
  const pool = esNombreFemenino(usuario) ? EMOJIS_CARAS.concat(EMOJIS_ROSITAS) : EMOJIS_CARAS;
  const emoji = pool[Math.floor(Math.random() * pool.length)];
  return `¡Hola, ${nombre}! ${emoji}`;
}

function mostrarPantalla(user) {
  const rol = user.rol;
  rolActual = rol;
  loginScreen.classList.add('hidden');
  vendedorScreen.classList.add('hidden');
  adminScreen.classList.add('hidden');

  // El formulario de Nota de venta es uno solo: se coloca en la pantalla del rol que entró
  const ventaForm = document.getElementById('venta-form-wrap');

  if (rol === 'admin' || rol === 'dueno') {
    adminScreen.classList.remove('hidden');
    adminScreen.prepend(logoHawaki);
    document.querySelector('#admin-screen h1').textContent = rol === 'dueno' ? 'Panel del dueño' : 'Panel administrador';
    // La sección de Vendedores (usuarios) completa es exclusiva del dueño
    document.getElementById('seccion-usuarios').classList.toggle('hidden', rol !== 'dueno');
    document.getElementById('venta-slot-admin').appendChild(ventaForm);
    cargarEstadoCaja(); // muestra u oculta la Nota de venta según haya turno abierto
    cargarDashboard();
    if (rol === 'dueno') cargarUsuarios();
    cargarGastos();
    cargarProductos();
    iniciarRefrescoAuto(); // las ventas de los vendedores aparecen solas
  } else {
    vendedorScreen.classList.remove('hidden');
    vendedorScreen.prepend(logoHawaki);
    document.getElementById('saludo-vendedor').textContent = armarSaludo(user.usuario);
    document.getElementById('venta-slot-vendedor').appendChild(ventaForm);
    cargarEstadoCaja();
    cargarMisVentas();
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  detenerRefrescoAuto();
  items = [];
  loginScreen.classList.remove('hidden');
  loginScreen.prepend(logoHawaki);
  vendedorScreen.classList.add('hidden');
  adminScreen.classList.add('hidden');
  document.getElementById('login-usuario').value = '';
  document.getElementById('login-password').value = '';
}

document.getElementById('logout-btn-v').addEventListener('click', logout);
document.getElementById('logout-btn-a').addEventListener('click', logout);

// --- Modo noche ---
// El tema ya se aplicó en el <head> para que no parpadee; aquí solo se maneja el botón.
// La preferencia se recuerda en este dispositivo, igual que la de ocultar el dinero.

let temaNoche = document.documentElement.dataset.tema === 'noche';

function aplicarTema() {
  document.documentElement.dataset.tema = temaNoche ? 'noche' : 'dia';
  // El botón anuncia lo que va a activar, no el estado en el que está
  document.getElementById('tema-texto').textContent = temaNoche ? 'Modo día' : 'Modo noche';
  document.getElementById('tema-btn').setAttribute('aria-pressed', temaNoche ? 'true' : 'false');
}

document.getElementById('tema-btn').addEventListener('click', () => {
  temaNoche = !temaNoche;
  localStorage.setItem('tema', temaNoche ? 'noche' : 'dia');
  aplicarTema();
});

aplicarTema();

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

// --- Revisión de los datos del cliente ---
// El RUC/cédula y el correo son opcionales, pero si se escribe algo tiene que
// estar bien. Cada revisor devuelve '' cuando el dato está bien, o el aviso que
// se le muestra a la vendedora. Las mismas reglas viven en server.js: si se
// cambia una aquí, hay que cambiarla allá.

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function avisoEmail(valor) {
  if (valor === '') return '';
  return RE_EMAIL.test(valor) ? '' : 'El correo no tiene un formato válido (ejemplo: nombre@dominio.com)';
}

// Cédula: 10 dígitos. RUC: 13. Cualquier otro largo, o algo que no sean números,
// es un error. El aviso dice cuántos números escribió y cuántos debería haber,
// para que la diferencia se vea sola sin tener que contarlos en la pantalla.
function avisoCedulaRuc(valor) {
  if (valor === '') return '';
  if (!/^[0-9]+$/.test(valor)) return 'El RUC o cédula solo lleva números, sin letras ni guiones';
  if (valor.length === 10 || valor.length === 13) return '';
  const cuantos = valor.length === 1 ? 'Escribiste 1 número' : `Escribiste ${valor.length} números`;
  return `${cuantos}. Deben ser 10 (cédula) o 13 (RUC).`;
}

// Los campos que se revisan, con el revisor que le toca a cada uno. El id lleva
// delante 'editar-' cuando es el modal de edición del dueño.
const CAMPOS_REVISADOS = [
  ['cliente-ruc', avisoCedulaRuc],
  ['cliente-email', avisoEmail],
];

// Escribe el aviso debajo del campo y lo pinta de rojo. Devuelve el aviso.
function revisarCampo(id, revisor) {
  const input = document.getElementById(id);
  const texto = revisor(input.value.trim());
  document.getElementById(`${id}-aviso`).textContent = texto;
  input.classList.toggle('campo-invalido', texto !== '');
  return texto;
}

// Revisa todos los campos de un formulario y devuelve el primer aviso, o ''.
function revisarDatosCliente(prefijo) {
  let primero = '';
  for (const [id, revisor] of CAMPOS_REVISADOS) {
    const texto = revisarCampo(prefijo + id, revisor);
    if (texto && !primero) primero = texto;
  }
  return primero;
}

function limpiarAvisosCliente(prefijo) {
  for (const [id] of CAMPOS_REVISADOS) {
    document.getElementById(`${prefijo}${id}-aviso`).textContent = '';
    document.getElementById(prefijo + id).classList.remove('campo-invalido');
  }
}

// Se revisa al salir del campo, no en cada tecla: si no, avisaría desde el
// primer dígito, cuando el dato todavía no puede estar completo. Ya marcado en
// rojo, sí se revisa al escribir, para que el aviso se quite al corregir.
function vigilarCampo(id, revisor) {
  const input = document.getElementById(id);
  input.addEventListener('blur', () => revisarCampo(id, revisor));
  input.addEventListener('input', () => {
    if (input.classList.contains('campo-invalido')) revisarCampo(id, revisor);
  });
}

for (const prefijo of ['', 'editar-']) {
  for (const [id, revisor] of CAMPOS_REVISADOS) {
    vigilarCampo(prefijo + id, revisor);
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
  document.getElementById('cliente-email').value = '';
  limpiarAvisosCliente('');
}

document.getElementById('btn-consumidor-final').addEventListener('click', () => {
  document.getElementById('campos-cliente').classList.add('hidden');
  document.getElementById('cliente-nombre').value = 'Consumidor final';
  document.getElementById('cliente-direccion').value = '';
  document.getElementById('cliente-ruc').value = '';
  document.getElementById('cliente-telefono').value = '';
  document.getElementById('cliente-email').value = '';
  limpiarAvisosCliente('');
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
  // Si el producto se escribió a mano no hay precio de catálogo: se toma el
  // cobrado, o sea que esa línea no lleva descuento
  const precio_lista = inputProducto.dataset.precioLista
    ? parseFloat(inputProducto.dataset.precioLista)
    : precio_unitario;
  items.push({ producto, cantidad, precio_unitario, precio_lista, producto_id });
  inputProducto.value = '';
  inputProducto.dataset.productoId = '';
  inputProducto.dataset.precioLista = '';
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

// Minúsculas y sin tildes, para que "cafe" encuentre "Café"
function normalizarTexto(t) {
  return String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Búsqueda por palabras: cada palabra escrita debe aparecer en algún campo del producto.
// Así "chunky negro", "CHUNKY 37" o "a-001 38" encuentran lo esperado.
document.getElementById('catalogo-buscar').addEventListener('input', (e) => {
  const palabras = normalizarTexto(e.target.value).split(/\s+/).filter(Boolean);
  const filtrados = productosDisponibles.filter((p) => {
    const texto = normalizarTexto(`${p.modelo} ${p.talla} ${p.color}`);
    return palabras.every((palabra) => texto.includes(palabra));
  });
  renderCatalogoModal(filtrados);
});

function renderCatalogoModal(productos) {
  const lista = document.getElementById('catalogo-lista');
  lista.innerHTML = '';
  if (productos.length === 0) {
    lista.innerHTML = '<p style="text-align:center;color:#888;">Sin resultados</p>';
    return;
  }
  // Tarjetas táctiles: se toca en cualquier parte de la tarjeta para seleccionar (pensado para móvil)
  productos.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'catalogo-item';
    card.innerHTML = `
      <div class="catalogo-item-modelo">${p.modelo}</div>
      <div class="catalogo-item-detalle">${p.controla_stock
        ? `<strong>Talla ${p.talla}</strong> · ${p.color} · $${p.precio.toFixed(2)} · Stock: ${p.stock}`
        : `$${p.precio.toFixed(2)} · sin control de stock`}</div>
    `;
    card.addEventListener('click', () => {
      const inputProducto = document.getElementById('item-producto');
      inputProducto.value = nombreProducto(p);
      inputProducto.dataset.productoId = p.id;
      // Se guarda el precio del catálogo aparte: si la vendedora lo baja antes de
      // agregar, la diferencia se cuenta como descuento
      inputProducto.dataset.precioLista = p.precio;
      document.getElementById('item-precio').value = p.precio;
      document.getElementById('item-cantidad').value = 1;
      document.getElementById('catalogo-modal').classList.add('hidden');
      document.getElementById('item-cantidad').focus();
    });
    lista.appendChild(card);
  });
}

/* ==========================================================================
   Escaneo de etiquetas

   Dos formas de leer, un solo camino: la pistola Bluetooth y la cámara llaman
   las dos a escanear(), así nunca pueden comportarse distinto.
   ========================================================================== */

// Pitido corto hecho por el navegador, sin archivos de sonido que descargar.
// Sirve para no tener que mirar la pantalla en cada par: el tono agudo es
// "entró", el grave es "algo pasó, mira".
let contextoAudio = null;

function pitido(bien) {
  try {
    contextoAudio = contextoAudio || new (window.AudioContext || window.webkitAudioContext)();
    if (contextoAudio.state === 'suspended') contextoAudio.resume();
    const ahora = contextoAudio.currentTime;
    const tonos = bien ? [[880, 0, 0.09]] : [[240, 0, 0.16], [190, 0.2, 0.24]];
    for (const [hz, desde, hasta] of tonos) {
      const osc = contextoAudio.createOscillator();
      const vol = contextoAudio.createGain();
      osc.type = 'square';
      osc.frequency.value = hz;
      // La rampa evita el chasquido que se oye si el tono corta de golpe
      vol.gain.setValueAtTime(0.0001, ahora + desde);
      vol.gain.exponentialRampToValueAtTime(0.18, ahora + desde + 0.01);
      vol.gain.exponentialRampToValueAtTime(0.0001, ahora + hasta);
      osc.connect(vol);
      vol.connect(contextoAudio.destination);
      osc.start(ahora + desde);
      osc.stop(ahora + hasta + 0.02);
    }
  } catch (e) {
    // Si el navegador no deja sonar, el aviso en pantalla igual se ve
  }
}

function mensajeVenta(texto, esError) {
  const msg = document.getElementById('venta-msg');
  msg.textContent = texto;
  msg.className = esError ? 'error' : '';
}

// Cómo se nombra un producto en la línea de una venta. Una sandalia lleva talla
// y color ("Cabuya Alta T38 Yute"); una categoría suelta no tiene ninguno de los
// dos y se queda solo con su nombre ("Zapatilla de dama").
// El servidor tiene la misma función: si se cambia una, cambiar la otra.
function nombreProducto(p) {
  const talla = String(p.talla || '').trim();
  const color = String(p.color || '').trim();
  return [p.modelo, talla && `T${talla}`, color].filter(Boolean).join(' ');
}

let escaneando = false;
let resaltado = null;            // id del producto recién escaneado
let temporizadorResaltado = null;

async function escanear(codigo) {
  if (escaneando) return;          // no encimar dos lecturas
  escaneando = true;
  try {
    let res, data;
    try {
      res = await fetch(`/api/productos/codigo/${encodeURIComponent(codigo)}`);
      data = await res.json();
    } catch (e) {
      pitido(false);
      return mensajeVenta('Sin conexión con el servidor. Revisa el internet.', true);
    }

    if (!res.ok) {
      pitido(false);
      return mensajeVenta(data.error || 'No se pudo leer el código', true);
    }

    // Si ya está en la lista, sube la cantidad en vez de repetir la línea
    const nombre = data.nombre || nombreProducto(data);
    const yaEsta = items.find((i) => i.producto_id === data.id);
    if (yaEsta) {
      // Una categoría suelta no tiene tope: se puede vender la que sea
      if (data.controla_stock && yaEsta.cantidad + 1 > data.stock) {
        pitido(false);
        return mensajeVenta(`Solo quedan ${data.stock} de ${nombre} en el sistema.`, true);
      }
      yaEsta.cantidad++;
    } else {
      items.push({
        producto: nombre,
        cantidad: 1,
        precio_unitario: Number(data.precio),
        precio_lista: Number(data.precio),   // el del catálogo, para calcular el descuento
        producto_id: data.id,
      });
    }

    // La línea recién escaneada se resalta un momento: si salió la talla
    // equivocada, se ve al toque y no al final de la venta.
    resaltado = data.id;
    clearTimeout(temporizadorResaltado);
    temporizadorResaltado = setTimeout(() => { resaltado = null; renderItems(); }, 2500);

    renderItems();
    pitido(true);
    const cuantos = yaEsta ? ` (x${yaEsta.cantidad})` : '';
    mensajeVenta(`${nombre} · $${Number(data.precio).toFixed(2)}${cuantos}`, false);
  } finally {
    escaneando = false;
  }
}

/* --- Pistola Bluetooth -----------------------------------------------------
   Se comporta como un teclado: manda el código tecla por tecla y termina en
   Enter, pero mucho más rápido de lo que teclea una persona. Por eso se mide el
   tiempo entre teclas. Así la vendedora escanea sin tener que tocar nada antes.

   Funciona aunque el cursor esté dentro de un campo: si no, bastaba con haber
   tocado "Producto" o "Nombre del cliente" para que el código se escribiera ahí
   y la venta no registrara nada. Lo que distingue a la pistola de la vendedora
   es SOLO la velocidad, así que se recuerda el campo y su contenido al empezar
   la ráfaga y se restaura al confirmarse que fue un escaneo.
   -------------------------------------------------------------------------- */
const MS_ENTRE_TECLAS = 50;
let bufferLector = '';
let ultimaTecla = 0;
let campoAlEmpezar = null;   // campo enfocado cuando arrancó la ráfaga
let valorAlEmpezar = '';     // y lo que tenía escrito, para dejarlo igual

function campoEditable() {
  const el = document.activeElement;
  return el && ['INPUT', 'TEXTAREA'].includes(el.tagName) ? el : null;
}

document.addEventListener('keydown', (e) => {
  if (document.getElementById('venta-form-wrap').classList.contains('hidden')) return;

  const ahora = Date.now();
  const seguidas = ahora - ultimaTecla <= MS_ENTRE_TECLAS;
  ultimaTecla = ahora;

  if (e.key === 'Enter') {
    const codigo = seguidas ? bufferLector.trim() : '';
    bufferLector = '';
    if (codigo.length >= 4) {
      e.preventDefault();
      // El código alcanzó a escribirse en un campo: se borra y queda como estaba
      if (campoAlEmpezar) {
        campoAlEmpezar.value = valorAlEmpezar;
        campoAlEmpezar = null;
      }
      escanear(codigo);
    }
    return;
  }

  if (e.key.length !== 1) return;  // Shift, flechas y demás no son parte del código
  if (!seguidas) {
    // Arranca una ráfaga nueva. En keydown la tecla todavía no se insertó,
    // así que este es el contenido previo del campo.
    campoAlEmpezar = campoEditable();
    valorAlEmpezar = campoAlEmpezar ? campoAlEmpezar.value : '';
  }
  bufferLector = seguidas ? bufferLector + e.key : e.key;
});

/* --- Cámara del celular ----------------------------------------------------
   Usa el lector que Chrome ya trae (BarcodeDetector): no hay que descargar
   ninguna librería y funciona sin internet. Si el celular no lo tiene, el botón
   lo dice en vez de quedarse mudo.
   -------------------------------------------------------------------------- */
let flujoCamara = null;
let temporizadorCamara = null;
let ultimaLectura = '';   // para exigir dos fotogramas seguidos con el mismo código

// El recuadro de puntería, pasado a coordenadas del fotograma. El video se
// muestra con object-fit: cover, o sea recortado y escalado, así que hay que
// deshacer esa transformación para saber qué parte de la imagen es la que la
// vendedora ve dentro del recuadro.
function regionDeMira(video, mira) {
  const rv = video.getBoundingClientRect();
  const rm = mira.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const escala = Math.max(rv.width / vw, rv.height / vh);
  const desplazadoX = (rv.width - vw * escala) / 2;
  const desplazadoY = (rv.height - vh * escala) / 2;

  const x = Math.round((rm.left - rv.left - desplazadoX) / escala);
  const y = Math.round((rm.top - rv.top - desplazadoY) / escala);
  const w = Math.round(rm.width / escala);
  const h = Math.round(rm.height / escala);

  // Recortado a los límites del fotograma, por si el recuadro se sale
  const x0 = Math.max(0, Math.min(x, vw - 1));
  const y0 = Math.max(0, Math.min(y, vh - 1));
  return { x: x0, y: y0, w: Math.min(w, vw - x0), h: Math.min(h, vh - y0) };
}

function cerrarCamara() {
  clearInterval(temporizadorCamara);
  temporizadorCamara = null;
  ultimaLectura = '';
  if (flujoCamara) {
    flujoCamara.getTracks().forEach((t) => t.stop());  // apaga la luz de la cámara
    flujoCamara = null;
  }
  document.getElementById('camara-video').srcObject = null;
  document.getElementById('camara-modal').classList.add('hidden');
}

async function abrirCamara() {
  if (!('BarcodeDetector' in window)) {
    return mensajeVenta('Este navegador no puede leer códigos con la cámara. Usa la pistola, o el botón MAGICA para buscar a mano.', true);
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return mensajeVenta('No se puede abrir la cámara desde aquí. La página tiene que estar en https.', true);
  }

  const modal = document.getElementById('camara-modal');
  const video = document.getElementById('camara-video');
  const aviso = document.getElementById('camara-msg');
  const mira = document.querySelector('.camara-mira');
  aviso.textContent = 'Encuadra UNA sola etiqueta dentro del recuadro';
  ultimaLectura = '';
  modal.classList.remove('hidden');

  try {
    // Se pide resolución alta a propósito. Como solo se analiza el recuadro de
    // puntería, con la resolución por defecto (640x480) ese recorte queda en
    // unos 170 px de ancho: el código de barras tiene 121 barras, o sea 1,4
    // píxeles por barra, y a un lector le hacen falta 2 o 3. Con 1920 el mismo
    // recorte pasa de 500 px y las barras se distinguen.
    //
    // El enfoque continuo va en "advanced", que el navegador aplica solo si
    // puede: como restricción normal, un celular que no lo soporte fallaría al
    // abrir la cámara en vez de abrirla sin enfoque.
    flujoCamara = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',            // la cámara de atrás
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        advanced: [{ focusMode: 'continuous' }],
      },
    });
  } catch (e) {
    // Si el celular no puede dar esa resolución, se abre con lo que tenga:
    // vale más una cámara de menos calidad que ninguna cámara.
    try {
      flujoCamara = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (e2) {
      cerrarCamara();
      const negada = e2.name === 'NotAllowedError' || e.name === 'NotAllowedError';
      return mensajeVenta(negada
        ? 'No diste permiso para usar la cámara. Actívalo en el candado de la barra de direcciones.'
        : 'No se pudo abrir la cámara: ' + e2.message, true);
    }
  }

  video.srcObject = flujoCamara;
  await video.play();

  // Si aun así el recorte queda muy chico, el código de barras no se va a poder
  // leer y conviene decirlo en vez de dejar a la vendedora apuntando en vano.
  const regionInicial = regionDeMira(video, mira);
  if (regionInicial && regionInicial.w < 320) {
    aviso.textContent = 'Cámara de baja resolución: si no lee, acércate más o usa el QR';
  }

  const detector = new BarcodeDetector({ formats: ['qr_code', 'code_128'] });
  const lienzo = document.createElement('canvas');
  const pincel = lienzo.getContext('2d', { willReadFrequently: true });

  temporizadorCamara = setInterval(async () => {
    try {
      // 1) Se mira SOLO lo que está dentro del recuadro. Las etiquetas vienen en
      //    tira, pegadas una a otra: si se analizara el fotograma entero, la de
      //    al lado podría colarse y venderse una talla equivocada.
      const region = regionDeMira(video, mira);
      if (!region || region.w < 10 || region.h < 10) return;
      lienzo.width = region.w;
      lienzo.height = region.h;
      pincel.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);

      const encontrados = await detector.detect(lienzo);
      if (!encontrados.length) { ultimaLectura = ''; return; }

      // 2) Si aun así entró más de un código, gana el que esté más al centro del
      //    recuadro, que es el que la vendedora está apuntando.
      const cx = region.w / 2;
      const cy = region.h / 2;
      const distancia = (c) => {
        const b = c.boundingBox;
        return Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy);
      };
      const elegido = encontrados.reduce((a, b) => (distancia(b) < distancia(a) ? b : a));
      const codigo = (elegido.rawValue || '').trim();
      if (!codigo) return;

      // 3) Se exige leer lo mismo dos veces seguidas. Una lectura suelta puede
      //    ser un reflejo o un movimiento; dos iguales, no.
      if (codigo !== ultimaLectura) {
        ultimaLectura = codigo;
        aviso.textContent = 'Leyendo… no muevas';
        return;
      }

      cerrarCamara();
      escanear(codigo);
    } catch (e) {
      // Un fotograma que no se pudo analizar no es un error: sigue el siguiente
    }
  }, 200);
}

document.getElementById('escanear-btn').addEventListener('click', abrirCamara);
document.getElementById('cerrar-camara-btn').addEventListener('click', cerrarCamara);

// Lo que se rebajó en una línea: cuánto en dólares y cuánto en porcentaje.
// Si no hay precio de catálogo, o se cobró igual o más, no hay descuento.
function descuentoDe(item) {
  const lista = Number(item.precio_lista ?? item.precio_unitario);
  const cobrado = Number(item.precio_unitario);
  if (!(lista > cobrado)) return null;
  return {
    lista,
    dolares: (lista - cobrado) * item.cantidad,
    porcentaje: ((lista - cobrado) / lista) * 100,
  };
}

function renderItems() {
  const cont = document.getElementById('items-lista');
  cont.innerHTML = '';
  let total = 0;
  items.forEach((item, idx) => {
    const subtotal = item.cantidad * item.precio_unitario;
    total += subtotal;
    const dcto = descuentoDe(item);

    const row = document.createElement('div');
    row.className = 'item-row' + (item.producto_id && item.producto_id === resaltado ? ' item-escaneado' : '');
    row.innerHTML = `
      <div class="item-datos">
        <span class="item-nombre">${item.producto} x${item.cantidad} — $${subtotal.toFixed(2)}</span>
        ${dcto ? `<span class="item-descuento">antes $${dcto.lista.toFixed(2)} · rebaja $${dcto.dolares.toFixed(2)} (${dcto.porcentaje.toFixed(1)}%)</span>` : ''}
      </div>
      <label class="item-precio-campo">
        <span>$</span>
        <input type="number" min="0" step="0.01" value="${item.precio_unitario.toFixed(2)}"
               aria-label="Precio de ${item.producto}">
      </label>
      <button class="quitar-item-btn">Quitar</button>
    `;

    // Se actualiza al salir del campo, no en cada tecla: si no, al escribir "3"
    // para llegar a 30 la línea se recalcularía con un precio de 3
    const campoPrecio = row.querySelector('.item-precio-campo input');
    campoPrecio.addEventListener('change', () => {
      const nuevo = parseFloat(campoPrecio.value);
      if (isNaN(nuevo) || nuevo < 0) {
        campoPrecio.value = item.precio_unitario.toFixed(2);
        return;
      }
      item.precio_unitario = nuevo;
      renderItems();
    });

    row.querySelector('.quitar-item-btn').addEventListener('click', () => {
      items.splice(idx, 1);
      renderItems();
    });
    cont.appendChild(row);
  });

  // Resumen del descuento de toda la venta, para que la vendedora vea lo que
  // está regalando antes de confirmar
  const rebaja = items.reduce((a, i) => a + (descuentoDe(i)?.dolares || 0), 0);
  const resumen = document.getElementById('descuento-resumen');
  if (rebaja > 0.004) {
    const sinRebaja = total + rebaja;
    resumen.textContent = `Descuento: $${rebaja.toFixed(2)} (${((rebaja / sinRebaja) * 100).toFixed(1)}%) · antes $${sinRebaja.toFixed(2)}`;
  } else {
    resumen.textContent = '';
  }

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
  const cliente_email = document.getElementById('cliente-email').value.trim();
  const problema = revisarDatosCliente('');
  if (problema) {
    msg.textContent = problema;
    msg.className = 'error';
    return;
  }
  const metodo_pago = document.querySelector('input[name="metodo-pago"]:checked').value;

  // La pestaña de impresión se abre AQUÍ, todavía dentro del clic, y recién
  // después se le pone la dirección. Si se abriera al terminar el fetch, el
  // navegador ya no la vería como respuesta a un clic y la bloquearía por
  // emergente. Queda en blanco el instante que tarda el servidor en responder.
  let ventanaImpresion = null;
  try { ventanaImpresion = window.open('', '_blank'); } catch (e) { /* bloqueada: queda el enlace */ }

  const res = await fetch('/api/ventas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliente, cliente_direccion, cliente_ruc, cliente_telefono, cliente_email, items, metodo_pago }),
  });
  const data = await res.json();

  if (!res.ok) {
    if (ventanaImpresion) ventanaImpresion.close();  // la venta no se hizo: no hay nada que imprimir
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }

  msg.textContent = `Venta ${data.numero_proforma} registrada por $${data.total.toFixed(2)} (${data.metodo_pago})`;
  msg.className = '';

  // El enlace se deja visible igual, por si el navegador bloqueó la pestaña
  const direccionImpresion = `print.html?id=${data.ventaId}`;
  const imprimirLink = document.getElementById('imprimir-link');
  imprimirLink.href = direccionImpresion;
  imprimirLink.classList.remove('hidden');

  if (ventanaImpresion) ventanaImpresion.location = `${direccionImpresion}&imprimir=1`;

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
  // Solo se cambia el texto: el dibujo lo elige el CSS con la clase (ver .btn-dinero)
  document.getElementById('toggle-dinero-texto').textContent = dineroOculto ? 'Mostrar' : 'Ocultar';
  document.getElementById('toggle-dinero-btn').classList.toggle('dinero-oculto', dineroOculto);
  // Al ocultar, la tarjeta entera se colapsa a una barra delgada (ver .compacta en style.css)
  document.getElementById('caja-abierta-card').classList.toggle('compacta', dineroOculto);
}

document.getElementById('toggle-dinero-btn').addEventListener('click', () => {
  dineroOculto = !dineroOculto;
  localStorage.setItem('dineroOculto', dineroOculto ? '1' : '0');
  aplicarVisibilidadDinero();
});

// El historial de ventas es largo, así que arranca plegado. La preferencia se recuerda
// en este dispositivo, igual que la de ocultar el dinero de la caja.
let historialOculto = localStorage.getItem('historialOculto') !== '0';

function aplicarVisibilidadHistorial() {
  document.getElementById('historial-wrap').classList.toggle('hidden', historialOculto);
  document.getElementById('toggle-historial-btn').textContent = historialOculto ? '👁 Mostrar' : 'Ocultar';
}

document.getElementById('toggle-historial-btn').addEventListener('click', () => {
  historialOculto = !historialOculto;
  localStorage.setItem('historialOculto', historialOculto ? '1' : '0');
  aplicarVisibilidadHistorial();
});

aplicarVisibilidadHistorial();

// El filtro de periodo solo cambia lo que se muestra: ninguna venta se borra
document.getElementById('filtro-periodo').addEventListener('change', () => cargarDashboard());

// --- Refresco automático del panel (para ver las ventas de los vendedores sin recargar) ---

let refrescoAutoId = null;
const REFRESCO_SEGUNDOS = 20;

// No refresca si el usuario está escribiendo, si hay un modal abierto o si la pestaña
// está en segundo plano: así nunca interrumpe una tarea a medias.
function puedeRefrescar() {
  const activo = document.activeElement;
  // Los <select> no bloquean: no se pierde nada al re-renderizar (ej. el filtro de periodo)
  if (activo && ['INPUT', 'TEXTAREA'].includes(activo.tagName)) return false;
  if (!document.getElementById('catalogo-modal').classList.contains('hidden')) return false;
  if (!document.getElementById('editar-venta-modal').classList.contains('hidden')) return false;
  if (document.hidden) return false;
  return true;
}

function iniciarRefrescoAuto() {
  detenerRefrescoAuto();
  refrescoAutoId = setInterval(() => {
    if (!puedeRefrescar()) return;
    cargarDashboard();
    cargarGastos();
    cargarProductos();
    cargarEstadoCaja();
  }, REFRESCO_SEGUNDOS * 1000);
}

function detenerRefrescoAuto() {
  if (refrescoAutoId) clearInterval(refrescoAutoId);
  refrescoAutoId = null;
}

async function cargarDashboard() {
  const periodo = document.getElementById('filtro-periodo').value;
  const res = await fetch(`/api/dashboard?periodo=${periodo}`);
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

  // Aviso de cuántas ventas se están viendo (las demás no se borraron, solo están filtradas)
  const info = document.getElementById('filtro-periodo-info');
  info.textContent = data.ventas.length === 0
    ? `Sin ventas en este periodo (hay ${data.numVentas} en total)`
    : `${data.ventas.length} venta(s) · ${data.numVentas} en total`;

  data.ventas.forEach((v) => {
    const detalleTexto = v.detalle
      .map((d) => `${d.producto} x${d.cantidad}`)
      .join(', ');
    const tr = document.createElement('tr');
    tr.className = v.anulada ? 'fila-venta venta-anulada' : 'fila-venta';

    const estadoHtml = v.anulada
      ? `<span class="badge-anulada">ANULADA</span><div class="nota-anulacion">${formatFecha(v.fecha_anulacion)} por ${v.anulada_por_usuario}: "${v.motivo_anulacion}"</div>`
      : 'Activa';

    const metodoTexto = v.metodo_pago === 'transferencia' ? '<span class="badge-transferencia">Transferencia</span>' : 'Efectivo';

    // Punto verde: venta hecha "con datos" (nombre real del cliente o RUC/dirección/teléfono/correo), a diferencia del consumidor final
    const conDatos = (v.cliente && v.cliente.trim() && v.cliente.trim().toLowerCase() !== 'consumidor final')
      || v.cliente_ruc || v.cliente_direccion || v.cliente_telefono || v.cliente_email;
    const clienteHtml = `${conDatos ? '<span class="dot-cliente-datos"></span>' : ''}${v.cliente || '-'}`;

    // Cada celda lleva su clase para que en celular el CSS reordene la fila como tarjeta
    // (ver "Historial de ventas en celular" en style.css)
    tr.innerHTML = `<td class="celda-proforma">${v.numero_proforma}</td><td class="celda-cliente">${clienteHtml}</td><td class="celda-vendedor">${v.vendedor}</td><td class="celda-fecha">${formatFecha(v.fecha)}</td><td class="celda-productos">${detalleTexto}</td><td class="celda-total">$${v.total.toFixed(2)}</td><td class="celda-metodo">${metodoTexto}</td><td class="celda-estado">${estadoHtml}</td><td class="celda-acciones"></td>`;

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
  document.getElementById('editar-cliente-email').value = venta.cliente_email || '';
  limpiarAvisosCliente('editar-');
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
    const dcto = descuentoDe(item);
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <div class="item-datos">
        <span class="item-nombre">${item.producto} x${item.cantidad} — $${subtotal.toFixed(2)}</span>
        ${dcto ? `<span class="item-descuento">antes $${dcto.lista.toFixed(2)} · rebaja $${dcto.dolares.toFixed(2)} (${dcto.porcentaje.toFixed(1)}%)</span>` : ''}
      </div>
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
  const cliente_email = document.getElementById('editar-cliente-email').value.trim();
  const problema = revisarDatosCliente('editar-');
  if (problema) {
    msg.textContent = problema;
    msg.className = 'error';
    return;
  }
  const metodo_pago = document.querySelector('input[name="editar-metodo-pago"]:checked').value;

  const res = await fetch(`/api/ventas/${editandoVentaId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliente, cliente_direccion, cliente_ruc, cliente_telefono, cliente_email, items: editandoItems, metodo_pago }),
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

      const btnClave = document.createElement('button');
      btnClave.textContent = '🔑 Clave';
      btnClave.className = 'accion-btn';
      btnClave.style.background = '#0369a1';
      btnClave.style.color = '#fff';
      btnClave.addEventListener('click', () => cambiarClaveUsuario(u));
      acciones.appendChild(btnClave);

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

async function cambiarClaveUsuario(u) {
  const password = window.prompt(`Nueva contraseña para "${u.usuario}" (mínimo 4 caracteres):`);
  if (password === null) return;
  if (password.length < 4) {
    alert('La contraseña debe tener al menos 4 caracteres');
    return;
  }
  const res = await fetch(`/api/usuarios/${u.id}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) { const d = await res.json(); alert(d.error); return; }
  alert(`Contraseña de "${u.usuario}" actualizada. Anótala en un lugar seguro: no se puede volver a ver, solo asignar otra nueva.`);
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

let productosInventario = [];
const familiasAbiertas = new Set(); // familias expandidas (Cabuya Alta, Chunky, ...)
const gruposAbiertos = new Set(); // modelos expandidos en la vista agrupada de escritorio
const coloresAbiertos = new Set(); // colores expandidos, con clave `modelo||color`

// Los modelos se nombran "{Familia} #{código}" (Cabuya Alta #00-04), así que la
// familia sale de partir por el #. Con eso el nombre deja de repetirse en cada
// fila: se escribe una vez arriba y dentro solo va el código.
// Si un modelo no lleva #, el nombre completo hace de familia y no se pierde.
function partirModelo(modelo) {
  const nombre = String(modelo ?? '');
  const i = nombre.indexOf('#');
  if (i <= 0) return { familia: nombre.trim(), codigo: '' };
  return { familia: nombre.slice(0, i).trim(), codigo: nombre.slice(i).trim() };
}

async function cargarProductos() {
  const res = await fetch('/api/productos');
  if (!res.ok) return;
  productosInventario = await res.json();
  renderInventario();
}

/* --- Buscador del inventario ---------------------------------------------
   Con varios modelos y decenas de variantes, bajar con el dedo hasta la talla
   que se quiere editar se vuelve lento. Esto filtra mientras se escribe.
   -------------------------------------------------------------------------- */
const buscadorInv = document.getElementById('buscar-inventario');
const infoBusqueda = document.getElementById('busqueda-info');
const btnLimpiarBusqueda = document.getElementById('limpiar-busqueda');

// Sin tildes y en minúsculas, para que "animal print" encuentre "Animal Print"
// y "ortopedica" encuentre "Ortopédica".
function sinTildes(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Cada palabra tiene que aparecer en algún dato del producto, en cualquier orden:
// así "chunky 38" llega directo a la talla 38 de ese modelo.
function coincide(p, palabras) {
  const donde = sinTildes(
    `${p.modelo} ${p.color} ${p.talla} t${p.talla} ${p.sku || ''} ${String(p.id).padStart(6, '0')}`
  );
  return palabras.every((w) => donde.includes(w));
}

function renderInventario() {
  const tbody = document.querySelector('#productos-tabla tbody');
  tbody.innerHTML = '';

  const busqueda = sinTildes(buscadorInv.value).trim();
  const palabras = busqueda ? busqueda.split(/\s+/) : [];
  const filtrando = palabras.length > 0;
  const productosVisibles = filtrando
    ? productosInventario.filter((p) => coincide(p, palabras))
    : productosInventario;

  btnLimpiarBusqueda.classList.toggle('hidden', !filtrando);
  if (!filtrando) {
    infoBusqueda.textContent = '';
  } else if (productosVisibles.length === 0) {
    infoBusqueda.textContent = `Sin resultados para «${buscadorInv.value.trim()}»`;
  } else {
    const modelos = new Set(productosVisibles.map((p) => p.modelo)).size;
    infoBusqueda.textContent = `${productosVisibles.length} variante(s) en ${modelos} modelo(s)`;
  }

  // Tres niveles, igual en escritorio y celular: familia > modelo > color > tallas.
  // La familia va arriba para que "Cabuya Alta" no se repita en cada fila: dentro
  // de ella los modelos se muestran solo por su código (#00-04).
  // (En celular el CSS convierte cada talla en una tarjeta para que nada quede cortado.)
  const familias = new Map();
  productosVisibles.forEach((p) => {
    const { familia } = partirModelo(p.modelo);
    if (!familias.has(familia)) familias.set(familia, new Map());
    const porModelo = familias.get(familia);
    if (!porModelo.has(p.modelo)) porModelo.set(p.modelo, new Map());
    const porColor = porModelo.get(p.modelo);
    if (!porColor.has(p.color)) porColor.set(p.color, []);
    porColor.get(p.color).push(p);
  });

  const sumaStock = (items) => items.reduce((acc, p) => acc + p.stock, 0);

  familias.forEach((porModelo, familia) => {
  // Buscando, todo se abre solo: si no, habría que ir tocando familia por familia
  // para ver qué coincidió. Al limpiar vuelve el estado manual.
  const familiaAbierta = filtrando || familiasAbiertas.has(familia);
  const todosFamilia = [];
  porModelo.forEach((porColor) => porColor.forEach((items) => todosFamilia.push(...items)));
  const trFamilia = document.createElement('tr');
  trFamilia.className = 'grupo-familia';
  trFamilia.innerHTML = `<td colspan="6">${familiaAbierta ? '▾' : '▸'} ${familia} <span class="grupo-info">${porModelo.size} modelo(s) · ${todosFamilia.length} variante(s) · stock total: ${sumaStock(todosFamilia)}</span></td>`;
  trFamilia.addEventListener('click', () => {
    if (familiaAbierta) familiasAbiertas.delete(familia);
    else familiasAbiertas.add(familia);
    renderInventario();
  });
  trFamilia.firstElementChild.appendChild(botonRenombrarFamilia(todosFamilia, familia));
  tbody.appendChild(trFamilia);
  if (!familiaAbierta) return;

  porModelo.forEach((porColor, modelo) => {
    const abierto = filtrando || gruposAbiertos.has(modelo);
    const todos = [].concat(...porColor.values());
    // Dentro de la familia basta el código; si el modelo no lleva #, va entero
    const etiquetaModelo = partirModelo(modelo).codigo || modelo;
    const trGrupo = document.createElement('tr');
    trGrupo.className = 'grupo-modelo';
    trGrupo.innerHTML = `<td colspan="6">${abierto ? '▾' : '▸'} ${etiquetaModelo} <span class="grupo-info">${porColor.size} color(es) · ${todos.length} variante(s) · stock total: ${sumaStock(todos)}</span></td>`;
    trGrupo.addEventListener('click', () => {
      if (abierto) gruposAbiertos.delete(modelo);
      else gruposAbiertos.add(modelo);
      renderInventario();
    });
    // Van con float:right, así que el orden de aquí sale invertido en pantalla:
    // [Eliminar] [Editar código] [Etiquetas]. Eliminar queda lejos de Etiquetas,
    // que es el que más se toca.
    trGrupo.firstElementChild.appendChild(botonEtiquetas(todos, 'Etiquetas del modelo'));
    trGrupo.firstElementChild.appendChild(botonRenombrarModelo(todos, modelo));
    trGrupo.firstElementChild.appendChild(botonEliminarModelo(todos, modelo));
    tbody.appendChild(trGrupo);
    if (!abierto) return;

    porColor.forEach((items, color) => {
      const clave = `${modelo}||${color}`;
      const colorAbierto = filtrando || coloresAbiertos.has(clave);
      const tallas = items
        .slice()
        .sort((a, b) => String(a.talla).localeCompare(String(b.talla), 'es', { numeric: true }));
      const trColor = document.createElement('tr');
      trColor.className = 'grupo-color';
      trColor.innerHTML = `<td colspan="6">${colorAbierto ? '▾' : '▸'} ${color} <span class="grupo-info">${tallas.length} talla(s) · stock: ${sumaStock(tallas)}</span></td>`;
      trColor.addEventListener('click', () => {
        if (colorAbierto) coloresAbiertos.delete(clave);
        else coloresAbiertos.add(clave);
        renderInventario();
      });
      trColor.firstElementChild.appendChild(botonEtiquetas(tallas, 'Etiquetas de este color'));
      tbody.appendChild(trColor);
      if (colorAbierto) tallas.forEach((p) => tbody.appendChild(crearFilaProducto(p)));
    });
  });
  });
}

// Al marcar "categoría suelta" se apagan los campos que no aplican: es más claro
// que dejarlos escribibles y luego ignorarlos.
const chkSinStock = document.getElementById('prod-sin-stock');

function aplicarModoCategoria() {
  const suelta = chkSinStock.checked;
  for (const id of ['prod-talla', 'prod-color', 'prod-stock']) {
    const campo = document.getElementById(id);
    campo.disabled = suelta;
    if (suelta) campo.value = '';
  }
  document.getElementById('prod-modelo').placeholder = suelta
    ? 'Nombre (ej: Zapatilla de dama)'
    : 'Modelo (ej: Sandalia Roma)';
}

chkSinStock.addEventListener('change', aplicarModoCategoria);
aplicarModoCategoria();

// La hoja con los códigos de las categorías, para imprimir y dejar en la caja
document.getElementById('tarjeta-btn').addEventListener('click', () => {
  window.open('tarjeta.html', '_blank');
});

buscadorInv.addEventListener('input', renderInventario);
btnLimpiarBusqueda.addEventListener('click', () => {
  buscadorInv.value = '';
  renderInventario();
  buscadorInv.focus();
});

async function marcarSinEtiquetar(p) {
  const nombre = `${p.modelo} T${p.talla} ${p.color}`;
  if (!confirm(`¿Marcar "${nombre}" como no etiquetado?\n\nSus ${p.stock} par(es) volverán a aparecer como pendientes de imprimir.`)) return;
  const res = await fetch(`/api/productos/${p.id}/etiquetas-pendientes`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'No se pudo marcar como no etiquetado');
    return;
  }
  cargarProductos();
}

// Abre la hoja de etiquetas en pestaña nueva, para no perder de vista el inventario.
// Los productos eliminados no se etiquetan.
function abrirEtiquetas(items) {
  const ids = items.filter((p) => !p.eliminado).map((p) => p.id);
  if (ids.length === 0) return;
  window.open(`etiquetas.html?ids=${ids.join(',')}`, '_blank');
}

const ICONO_ETIQUETA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 1.4.6l6.4 6.4a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';

function botonEtiquetas(items, texto) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-etiqueta';
  btn.innerHTML = ICONO_ETIQUETA + texto;
  btn.title = 'Imprimir etiquetas con código de barras y QR';
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // si no, el clic también plegaría el grupo
    abrirEtiquetas(items);
  });
  return btn;
}

const ICONO_PAPELERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

const ICONO_LAPIZ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

// Botón para cambiar el nombre de una familia entera (Chunky, Cabuya Alta...).
// Cada modelo conserva su código: solo cambia la parte de adelante.
function botonRenombrarFamilia(items, familia) {
  const modelos = new Set(items.map((p) => p.modelo)).size;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-editar-modelo';
  btn.innerHTML = ICONO_LAPIZ + 'Editar nombre';
  btn.title = `Cambiar el nombre de la familia ${familia} en sus ${modelos} modelo(s)`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // si no, el clic también plegaría la familia
    renombrarFamiliaCompleta(items, familia);
  });
  return btn;
}

async function renombrarFamiliaCompleta(items, familia) {
  const modelos = new Set(items.map((p) => p.modelo)).size;
  const nueva = window.prompt(
    `Nuevo nombre para la familia (se aplica a sus ${modelos} modelo(s) y ${items.length} variante(s)).\n\n` +
    `Cada modelo conserva su código: "${familia} #A-01" pasaría a "NUEVO #A-01".\n` +
    `Las etiquetas ya pegadas siguen sirviendo: su código no cambia.`,
    familia
  );
  if (nueva === null) return;
  const limpio = nueva.trim();
  if (!limpio) return alert('El nombre no puede quedar vacío');
  if (limpio === familia) return;

  // Unir dos familias suele ser justo lo que se busca (Chunky PB dentro de
  // Chunky), pero conviene decirlo antes de hacerlo.
  const yaExiste = productosInventario.some(
    (p) => partirModelo(p.modelo).familia.toLowerCase() === limpio.toLowerCase()
  );
  if (yaExiste && !confirm(`Ya existe la familia "${limpio}".\nSi continúas, "${familia}" pasará a formar parte de ella.\n\n¿Continuar?`)) {
    return;
  }

  // Cada producto lleva el nombre nuevo con SU código; los que no tienen código
  // se quedan solo con el nombre de la familia.
  const cambios = items.map((p) => {
    const { codigo } = partirModelo(p.modelo);
    return { id: p.id, modelo: codigo ? `${limpio} ${codigo}` : limpio };
  });

  const res = await fetch('/api/productos/renombrar-varios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cambios }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  // Se deja abierta la familia nueva para ver el resultado sin volver a buscarla
  familiasAbiertas.delete(familia);
  familiasAbiertas.add(limpio);
  alert(`Listo: ${data.actualizados} variante(s) ahora están en "${limpio}".`);
  cargarProductos();
}

// Botón para corregir el código del modelo en todas sus tallas de una vez.
function botonRenombrarModelo(items, modelo) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-editar-modelo';
  btn.innerHTML = ICONO_LAPIZ + 'Editar código';
  btn.title = `Cambiar el nombre de ${modelo} en sus ${items.length} variante(s)`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // si no, el clic también plegaría el grupo
    renombrarModeloCompleto(items, modelo);
  });
  return btn;
}

async function renombrarModeloCompleto(items, modelo) {
  const nuevo = window.prompt(
    `Nuevo nombre para el modelo (se aplica a sus ${items.length} variante(s)).\n\n` +
    `Las etiquetas ya pegadas siguen sirviendo: su código no cambia.`,
    modelo
  );
  if (nuevo === null) return;
  const limpio = nuevo.trim();
  if (!limpio) return alert('El nombre no puede quedar vacío');
  if (limpio === modelo) return;

  // Si ya hay otro modelo con ese nombre, los dos pasarían a ser uno solo.
  // A veces es justo lo que se busca (unir un código escrito de dos formas),
  // así que se avisa en vez de impedirlo.
  const yaExiste = productosInventario.some(
    (p) => p.modelo !== modelo && p.modelo.toLowerCase() === limpio.toLowerCase()
  );
  if (yaExiste && !confirm(`Ya existe un modelo llamado "${limpio}".\nSi continúas, los dos quedarán unidos en uno solo.\n\n¿Continuar?`)) {
    return;
  }

  const res = await fetch('/api/productos/renombrar-modelo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: items.map((p) => p.id), modelo: limpio }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  // El grupo abierto estaba guardado con el nombre viejo: se pasa al nuevo
  if (gruposAbiertos.delete(modelo)) gruposAbiertos.add(limpio);
  familiasAbiertas.add(partirModelo(limpio).familia);
  alert(`Listo: ${data.actualizados} variante(s) ahora son "${limpio}".`);
  cargarProductos();
}

// Botón para borrar el modelo completo, sin ir talla por talla.
function botonEliminarModelo(items, nombre) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-eliminar-modelo';
  btn.innerHTML = ICONO_PAPELERA + 'Eliminar modelo';
  btn.title = `Eliminar las ${items.length} variante(s) de ${nombre}`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // si no, el clic también plegaría el grupo
    eliminarModeloCompleto(items, nombre);
  });
  return btn;
}

async function eliminarModeloCompleto(items, nombre) {
  const cuantas = items.length;
  const pares = items.reduce((acc, p) => acc + p.stock, 0);
  const cuerpo = { ids: items.map((p) => p.id) };

  if (rolActual === 'dueno') {
    // Se pide escribir el nombre: son varias tallas de una sola vez y no hay vuelta atrás
    const confirmacion = window.prompt(
      `Vas a eliminar PERMANENTEMENTE ${nombre}: ${cuantas} variante(s) y ${pares} par(es) de stock.\n` +
      `Esto no se puede deshacer.\n\nEscribe ELIMINAR para confirmar:`
    );
    if (confirmacion === null) return;
    if (confirmacion.trim().toUpperCase() !== 'ELIMINAR') {
      return alert('No se eliminó nada.');
    }
  } else {
    const motivo = window.prompt(
      `¿Por qué eliminas ${nombre} completo (${cuantas} variante(s))? El dueño verá este motivo:`
    );
    if (motivo === null) return;
    if (!motivo.trim()) return alert('Debes escribir el motivo');
    cuerpo.motivo = motivo;
  }

  const res = await fetch('/api/productos/eliminar-varios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  alert(`${nombre}: ${data.eliminados} variante(s) eliminada(s).`);
  cargarProductos();
}

function crearFilaProducto(p) {
    const tr = document.createElement('tr');
    tr.className = 'fila-producto';
    if (!p.activo || p.eliminado) tr.style.opacity = '0.5';
    // Una categoría suelta no lleva stock: no hay nada que avisar ni que agotar
    const suelta = !p.controla_stock;
    const stockRojo = !suelta && p.stock === 2;
    const stockAzul = !suelta && p.stock === 1;
    // El color va por clase, no escrito aquí, para que el modo noche pueda aclararlo
    const stockClase = stockRojo ? ' stock-bajo' : stockAzul ? ' stock-critico' : '';
    // Solo el dueño recibe productos eliminados del servidor: se muestran con el motivo que escribió el admin
    const notaEliminado = p.eliminado
      ? `<div class="nota-anulacion">Eliminado ${formatFecha(p.fecha_eliminacion)} por ${p.eliminado_por_usuario || 'admin'}: "${p.motivo_eliminacion}"</div>`
      : '';
    // En celular el CSS oculta modelo y color (ya se leen en las cabeceras del grupo) y deja
    // talla, precio y stock en una sola línea, por eso cada celda lleva su clase.
    tr.innerHTML = `
      <td class="celda-modelo"><span class="celda-modelo-texto">${p.modelo}</span>${notaEliminado}</td>
      <td class="celda-talla">${suelta ? '—' : p.talla}</td>
      <td class="celda-color">${suelta ? '—' : p.color}</td>
      <td class="celda-precio">$${p.precio.toFixed(2)}</td>
      <td class="celda-stock${stockClase}">${suelta ? '—' : p.stock}${stockRojo || stockAzul ? ' ⚠' : ''}</td>
      <td class="celda-acciones"></td>
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
      // El botón dice cuántas FALTAN, no cuántos pares hay: al reponer mercadería
      // solo salen los pares nuevos, sin reimprimir todo el modelo.
      //
      // Una categoría suelta no se etiqueta par por par, pero igual puede
      // imprimirse: son las tarjetas de bolsillo que lleva cada vendedora para
      // escanear el precio sin ir hasta la hoja de la caja. Ahí no hay
      // pendientes que contar, se elige cuántas copias en la vista de etiquetas.
      const pendientes = suelta ? 0 : Math.max(0, p.stock - (p.etiquetas_impresas || 0));
      const btnEtiqueta = botonEtiquetas(
        [p],
        !suelta && pendientes > 0 ? `${pendientes} pendiente${pendientes === 1 ? '' : 's'}` : 'Etiquetas'
      );
      btnEtiqueta.classList.add('accion-btn');
      if (!suelta && pendientes > 0) btnEtiqueta.classList.add('con-pendientes');
      acciones.appendChild(btnEtiqueta);

      // Salida para el modelo viejo que nunca se etiquetó, o el rollo que se
      // trabó: vuelve a dejar toda la talla como pendiente.
      if (!suelta && pendientes === 0 && p.stock > 0) {
        const btnSinEtiquetar = document.createElement('button');
        btnSinEtiquetar.textContent = '↺ Sin etiquetar';
        btnSinEtiquetar.className = 'accion-btn';
        btnSinEtiquetar.title = 'Marca esta talla como no etiquetada, para volver a imprimir sus etiquetas';
        btnSinEtiquetar.addEventListener('click', () => marcarSinEtiquetar(p));
        acciones.appendChild(btnSinEtiquetar);
      }

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
    return tr;
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
  // Una categoría suelta no tiene talla, color ni stock: no se preguntan
  const suelta = !p.controla_stock;

  const modelo = window.prompt(suelta ? 'Nombre:' : 'Modelo:', p.modelo);
  if (modelo === null) return;

  let talla = p.talla, color = p.color, stock = p.stock;
  if (!suelta) {
    talla = window.prompt('Talla:', p.talla);
    if (talla === null) return;
    color = window.prompt('Color:', p.color);
    if (color === null) return;
  }

  const precioStr = window.prompt('Precio:', p.precio);
  if (precioStr === null) return;

  if (!suelta) {
    const stockStr = window.prompt('Stock actual:', p.stock);
    if (stockStr === null) return;
    stock = parseInt(stockStr, 10);
  }

  const precio = parseFloat(precioStr);
  if (!modelo.trim() || isNaN(precio) || precio < 0) {
    alert('Datos inválidos');
    return;
  }
  if (!suelta && (!talla.trim() || !color.trim() || isNaN(stock) || stock < 0)) {
    alert('Datos inválidos');
    return;
  }

  // Reducir stock es exclusivo del dueño (el servidor también lo valida)
  if (!suelta && stock < p.stock && rolActual !== 'dueno') {
    alert(`No puedes reducir el stock (actual: ${p.stock}). Solo el dueño puede bajarlo.`);
    return;
  }

  const res = await fetch(`/api/productos/${p.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modelo: modelo.trim(),
      talla: String(talla).trim(),
      color: String(color).trim(),
      precio,
      stock,
      controla_stock: p.controla_stock ? true : false,
    }),
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
  const controla_stock = !document.getElementById('prod-sin-stock').checked;

  if (!modelo || isNaN(precio) || precio < 0) {
    msg.textContent = 'Escribe al menos el nombre y el precio';
    msg.className = 'error';
    return;
  }
  if (controla_stock && (!talla || !color || isNaN(stock) || stock < 0)) {
    msg.textContent = 'Completa todos los campos con valores válidos';
    msg.className = 'error';
    return;
  }

  const res = await fetch('/api/productos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelo, talla, color, precio, stock, controla_stock }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error;
    msg.className = 'error';
    return;
  }

  const nombre = nombreProducto(data);
  if (!controla_stock) {
    msg.textContent = `Categoría "${nombre}" lista a $${Number(data.precio).toFixed(2)}. Imprime la tarjeta para poder escanearla.`;
  } else {
    msg.textContent = data.stock_sumado
      ? `Ya existía "${nombre}": se sumaron ${data.stock_sumado} al stock (ahora tiene ${data.stock})`
      : `Producto "${nombre}" agregado con stock ${data.stock}`;
  }
  msg.className = '';
  // Se conservan modelo, color, precio y stock para cargar la siguiente talla rápido:
  // solo se selecciona la talla, listo para escribir la nueva (35 → 36 → 37...)
  const tallaInput = document.getElementById('prod-talla');
  if (controla_stock) {
    tallaInput.focus();
    tallaInput.select();
  } else {
    document.getElementById('prod-modelo').value = '';
    document.getElementById('prod-precio').value = '';
    document.getElementById('prod-modelo').focus();
  }
  cargarProductos();
});

// --- Al cargar la página, verificar si ya hay sesión activa ---

(async function init() {
  const res = await fetch('/api/me');
  if (res.ok) {
    const user = await res.json();
    mostrarPantalla(user);
  }
})();
