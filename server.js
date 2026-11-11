const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const path = require('path');
const { pool, init } = require('./db');
const { skuUnico } = require('./sku');

const app = express();

app.use(express.json());
app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto-en-produccion',
  resave: false,
  saveUninitialized: false,
  // rolling: true renueva los 30 días en cada visita, así alguien que entra
  // seguido nunca ve caducar la sesión; solo se cierra sola si el dispositivo
  // pasa 30 días sin usarse.
  rolling: true,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 días
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- Middlewares de autenticación/autorización ---

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Debes iniciar sesión' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!['admin', 'dueno'].includes(req.session.user.rol)) {
    return res.status(403).json({ error: 'Solo el administrador puede hacer esto' });
  }
  next();
}

function requireDueño(req, res, next) {
  if (req.session.user.rol !== 'dueno') {
    return res.status(403).json({ error: 'Solo el dueño puede hacer esto' });
  }
  next();
}

// --- Avisos en tiempo real (Server-Sent Events) ---
// Cada navegador deja abierta una conexión a /api/eventos. Cuando un cambio
// (venta, anulación, caja, gasto, producto...) termina bien, el servidor manda
// un aviso cortito con el área que cambió y cada pantalla recarga solo eso.
// El aviso no lleva datos: cada uno vuelve a pedirlos con su propia sesión,
// así un vendedor nunca recibe nada que no podría ver.
// Si la conexión se cae, el navegador sigue con el refresco cada 20 s.

const conexionesEventos = new Set();

function avisarCambio(area) {
  const mensaje = `event: cambio\ndata: ${JSON.stringify({ area })}\n\n`;
  conexionesEventos.forEach((res) => res.write(mensaje));
}

app.get('/api/eventos', requireLogin, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // que ningún proxy retenga los avisos
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n'); // si se corta, reintentar a los 5 s
  conexionesEventos.add(res);
  req.on('close', () => conexionesEventos.delete(res));
});

// Latido: Railway corta las conexiones que pasan mucho rato sin tráfico
setInterval(() => {
  conexionesEventos.forEach((res) => res.write(': ping\n\n'));
}, 25 * 1000);

// Toda escritura en /api que termine bien dispara el aviso. Así no hay que
// acordarse de avisar en cada ruta nueva.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || ['/login', '/logout'].includes(req.path)) return next();
  // Se lee ahora: al terminar la respuesta, req.path ya vuelve a traer el /api
  const area = req.path.split('/')[1] || 'otro'; // ventas, caja, gastos, productos...
  res.on('finish', () => {
    if (res.statusCode < 400) avisarCambio(area);
  });
  next();
});

// --- Modo de caja ---
// 'cierre' (el de siempre): se abre, se vende y se cierra con cuadre.
// 'libre': la caja queda siempre abierta, nadie la cierra y nunca frena una
// venta. Lo elige solo el dueño; se guarda en configuracion.
// El cierre de caja está quitado POR AHORA (pedido del dueño): la caja funciona
// siempre como caja libre, sin botón de cerrar, sin historial de cierres ni
// selector de modo. El código sigue aquí: para volver a activarlo, poner true.
const CIERRE_DE_CAJA_ACTIVO = false;

async function getModoCaja() {
  if (!CIERRE_DE_CAJA_ACTIVO) return 'libre';
  const r = await pool.query("SELECT valor FROM configuracion WHERE clave = 'modo_caja'");
  return r.rows[0] && r.rows[0].valor === 'libre' ? 'libre' : 'cierre';
}

// Abre un turno con el sencillo que quedó en el último cierre (o $0) si no hay
// uno abierto. El candado evita que dos ventas simultáneas abran dos turnos.
async function asegurarTurnoLibre(usuarioId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(4242)');
    let turno = (await client.query(
      `SELECT * FROM turnos_caja WHERE estado = 'abierto' ORDER BY id DESC LIMIT 1`
    )).rows[0];
    if (!turno) {
      const ultimo = await client.query(
        `SELECT monto_queda FROM turnos_caja WHERE estado = 'cerrado' AND monto_queda IS NOT NULL ORDER BY id DESC LIMIT 1`
      );
      const inicial = ultimo.rows[0] ? Number(ultimo.rows[0].monto_queda) : 0;
      turno = (await client.query(
        `INSERT INTO turnos_caja (monto_inicial, monto_actual, abierto_por) VALUES ($1, $1, $2) RETURNING *`,
        [inicial, usuarioId]
      )).rows[0];
    }
    await client.query('COMMIT');
    return turno;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// El turno abierto; en caja libre, si no hay ninguno se abre solo (así el panel
// nunca muestra la caja cerrada ni pide abrirla)
async function turnoAbiertoOLibre(req) {
  const turno = await getTurnoAbierto();
  if (turno || (await getModoCaja()) !== 'libre') return turno;
  return asegurarTurnoLibre(req.session.user.id);
}

async function getTurnoAbierto() {
  const r = await pool.query(`SELECT * FROM turnos_caja WHERE estado = 'abierto' ORDER BY id DESC LIMIT 1`);
  return r.rows[0] || null;
}

// --- Auth ---

app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  const r = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [usuario]);
  const user = r.rows[0];

  if (!user || !user.activo || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  req.session.user = { id: user.id, usuario: user.usuario, rol: user.rol };
  res.json({ usuario: user.usuario, rol: user.rol });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.status(204).send());
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json(req.session.user);
});

// --- Caja: apertura, cierre y estado del turno ---

app.get('/api/caja/estado', requireLogin, async (req, res) => {
  const turno = await turnoAbiertoOLibre(req);
  // Con la caja cerrada, al admin y al dueño se les sugiere abrir con el sencillo
  // que se dejó en el último cierre
  let sugerido_inicial = null;
  if (!turno && ['admin', 'dueno'].includes(req.session.user.rol)) {
    const r = await pool.query(
      `SELECT monto_queda FROM turnos_caja WHERE estado = 'cerrado' AND monto_queda IS NOT NULL ORDER BY id DESC LIMIT 1`
    );
    if (r.rows[0]) sugerido_inicial = r.rows[0].monto_queda;
  }
  res.json({ turno, sugerido_inicial, modo_caja: await getModoCaja(), cierre_activo: CIERRE_DE_CAJA_ACTIVO });
});

// El dueño cambia el modo de caja. Al pasar a libre, si la caja está cerrada se
// abre sola: en ese modo siempre hay una caja abierta.
app.post('/api/caja/modo', requireLogin, requireDueño, async (req, res) => {
  if (!CIERRE_DE_CAJA_ACTIVO) {
    return res.status(400).json({ error: 'El cierre de caja está desactivado por ahora: la caja queda siempre abierta.' });
  }
  const { modo } = req.body || {};
  if (!['libre', 'cierre'].includes(modo)) {
    return res.status(400).json({ error: 'El modo de caja debe ser "libre" o "cierre"' });
  }
  await pool.query(
    `INSERT INTO configuracion (clave, valor) VALUES ('modo_caja', $1)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [modo]
  );
  let turno = await getTurnoAbierto();
  if (modo === 'libre' && !turno) turno = await asegurarTurnoLibre(req.session.user.id);
  res.json({ modo, turno });
});

// --- Cuadre de caja ---
// Billetes y monedas que se cuentan al cerrar, en centavos para no arrastrar
// errores de decimales al sumar. El navegador usa la misma lista (app.js).
const DENOMINACIONES_CENTAVOS = [10000, 5000, 2000, 1000, 500, 100, 50, 25, 10, 5, 1];

const redondear2 = (n) => Math.round(n * 100) / 100;

// Lo que dice el sistema del turno abierto, para la ventana de cierre. El
// "debería haber" es el monto actual de la caja (el que ya se fue ajustando con
// cada venta, anulación y gasto); el desglose es para que se entienda de dónde sale.
app.get('/api/caja/resumen-cierre', requireLogin, requireAdmin, async (req, res) => {
  const turno = await getTurnoAbierto();
  if (!turno) return res.status(400).json({ error: 'No hay un turno de caja abierto' });
  const ventas = await pool.query(
    `SELECT metodo_pago, COUNT(*)::int AS cantidad, COALESCE(SUM(total), 0) AS total
     FROM ventas WHERE turno_id = $1 AND anulada = 0 AND eliminada = 0
     GROUP BY metodo_pago`,
    [turno.id]
  );
  const gastos = await pool.query(
    `SELECT COUNT(*)::int AS cantidad, COALESCE(SUM(monto), 0) AS total FROM gastos WHERE turno_id = $1`,
    [turno.id]
  );
  const porMetodo = (m) => {
    const fila = ventas.rows.find((v) => v.metodo_pago === m);
    return { cantidad: fila ? fila.cantidad : 0, total: fila ? redondear2(Number(fila.total)) : 0 };
  };
  const efectivo = porMetodo('efectivo');
  const transferencia = porMetodo('transferencia');
  const gasto = { cantidad: gastos.rows[0].cantidad, total: redondear2(Number(gastos.rows[0].total)) };
  const esperado = redondear2(turno.monto_actual);
  // Si se vació la caja a mitad de turno, el desglose no suma igual que el
  // monto actual: esa diferencia se muestra aparte como "ajustes"
  const ajustes = redondear2(esperado - (turno.monto_inicial + efectivo.total - gasto.total));
  res.json({
    turno_id: turno.id,
    fecha_apertura: turno.fecha_apertura,
    monto_inicial: redondear2(turno.monto_inicial),
    ventas_efectivo: efectivo,
    transferencias: transferencia,
    gastos: gasto,
    ajustes,
    esperado,
    denominaciones: DENOMINACIONES_CENTAVOS,
  });
});

app.post('/api/caja/abrir', requireLogin, requireAdmin, async (req, res) => {
  const { monto_inicial } = req.body;
  if (monto_inicial == null || monto_inicial < 0) {
    return res.status(400).json({ error: 'monto_inicial es obligatorio y debe ser >= 0' });
  }
  if (await getTurnoAbierto()) {
    return res.status(400).json({ error: 'Ya hay un turno de caja abierto' });
  }
  const r = await pool.query(
    `INSERT INTO turnos_caja (monto_inicial, monto_actual, abierto_por) VALUES ($1, $2, $3) RETURNING *`,
    [monto_inicial, monto_inicial, req.session.user.id]
  );
  res.status(201).json(r.rows[0]);
});

// Cerrar con cuadre: se cuenta billete por billete, se compara con lo que debía
// haber y queda guardado quién cerró, la diferencia (con motivo si es de $1 o
// más), cuánto se retiró y cuánto se dejó de sencillo.
app.post('/api/caja/cerrar', requireLogin, requireAdmin, async (req, res) => {
  const { conteo, motivo, monto_queda, transferencias_confirmadas } = req.body || {};

  if (!CIERRE_DE_CAJA_ACTIVO) {
    return res.status(400).json({ error: 'El cierre de caja está desactivado por ahora: la caja queda siempre abierta.' });
  }
  if ((await getModoCaja()) === 'libre') {
    return res.status(400).json({ error: 'La caja está en modo libre: el dueño debe pasarla a "Con cierre" para poder cerrarla.' });
  }

  // El conteo llega como { "2000": 10, "500": 9, ... } (centavos → cantidad)
  // Sin conteo solo llega desde una pestaña abierta antes de que existiera el
  // cuadre (cierra directo, sin la ventana de contar): se le dice que recargue
  if (!conteo || typeof conteo !== 'object') {
    return res.status(400).json({
      error: 'Esta pantalla tiene una versión vieja del POS. Recarga la página (Ctrl + F5) y vuelve a tocar "Cerrar caja" para contar el efectivo.',
    });
  }
  let contadoCentavos = 0;
  const conteoLimpio = {};
  for (const d of DENOMINACIONES_CENTAVOS) {
    const cantidad = conteo[d] == null || conteo[d] === '' ? 0 : Number(conteo[d]);
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      return res.status(400).json({ error: 'Las cantidades contadas deben ser números enteros, sin negativos' });
    }
    if (cantidad > 0) conteoLimpio[d] = cantidad;
    contadoCentavos += d * cantidad;
  }
  const contado = contadoCentavos / 100;
  const queda = monto_queda == null || monto_queda === '' ? 0 : redondear2(Number(monto_queda));
  if (!Number.isFinite(queda) || queda < 0 || queda > contado) {
    return res.status(400).json({ error: 'Lo que se deja de sencillo no puede ser negativo ni mayor a lo contado' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE: si justo entra una venta, espera a que termine; así el
    // "debería haber" no cambia entre que se lee y se guarda el cierre
    const t = await client.query(
      `SELECT * FROM turnos_caja WHERE estado = 'abierto' ORDER BY id DESC LIMIT 1 FOR UPDATE`
    );
    const turno = t.rows[0];
    if (!turno) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No hay un turno de caja abierto' });
    }
    const esperado = redondear2(turno.monto_actual);
    const diferencia = redondear2(contado - esperado);
    const motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';
    if (Math.abs(diferencia) >= 1 && !motivoLimpio) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La diferencia es de $1 o más: escribe el motivo antes de cerrar' });
    }
    const r = await client.query(
      `UPDATE turnos_caja SET estado = 'cerrado', fecha_cierre = NOW(),
         monto_esperado = $2, monto_contado = $3, diferencia = $4, motivo_diferencia = $5,
         conteo = $6, monto_retirado = $7, monto_queda = $8, cerrado_por = $9,
         transferencias_confirmadas = $10
       WHERE id = $1 RETURNING *`,
      [turno.id, esperado, contado, diferencia, motivoLimpio || null, JSON.stringify(conteoLimpio),
        redondear2(contado - queda), queda, req.session.user.id, !!transferencias_confirmadas]
    );
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/caja/vaciar', requireLogin, requireDueño, async (req, res) => {
  const turno = await getTurnoAbierto();
  if (!turno) {
    return res.status(400).json({ error: 'No hay un turno de caja abierto' });
  }
  const r = await pool.query(
    `UPDATE turnos_caja SET monto_inicial = 0, monto_actual = 0 WHERE id = $1 RETURNING *`,
    [turno.id]
  );
  res.json(r.rows[0]);
});

// Historial de cierres: los últimos 60 turnos cerrados, con su cuadre
app.get('/api/caja/historial', requireLogin, requireAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT t.*, u.usuario AS abierto_por_usuario, c.usuario AS cerrado_por_usuario
    FROM turnos_caja t
    JOIN usuarios u ON u.id = t.abierto_por
    LEFT JOIN usuarios c ON c.id = t.cerrado_por
    -- Solo cierres con conteo: los de antes del cuadre y los borrados no se listan
    WHERE t.estado = 'cerrado' AND t.monto_contado IS NOT NULL
    ORDER BY t.id DESC
    LIMIT 60
  `);
  res.json(r.rows);
});

// --- Días libres ---
// Cada vendedor pide su día de descanso en un calendario; el admin o el dueño lo
// acepta o lo rechaza. Reglas:
//   - Viernes, sábado y domingo no se puede (son los días fuertes de venta).
//   - Hay que pedirlo con antelación: al menos DIAS_ANTELACION día(s) antes.
//   - Un solo día libre por semana (de lunes a domingo) por vendedor.
// Las fechas viajan como texto 'AAAA-MM-DD' y "hoy" es el día de Ecuador.
const DIAS_ANTELACION = 1;
const textoAntelacion = () => (DIAS_ANTELACION === 1 ? '1 día' : `${DIAS_ANTELACION} días`);
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const hoyEcuador = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

function sumarDias(fechaIso, dias) {
  const d = new Date(`${fechaIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// 0 = domingo ... 6 = sábado; null si el texto no es una fecha real (2026-02-31)
function diaDeSemana(fechaIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fechaIso))) return null;
  const d = new Date(`${fechaIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== fechaIso) return null;
  return d.getUTCDay();
}

const lunesDeLaSemana = (fechaIso) => sumarDias(fechaIso, -((diaDeSemana(fechaIso) + 6) % 7));

const fechaLarga = (fechaIso) => `${DIAS_SEMANA[diaDeSemana(fechaIso)]} ${fechaIso.slice(8)}/${fechaIso.slice(5, 7)}`;

const DIA_LIBRE_COLUMNAS = `d.id, d.usuario_id, u.usuario, to_char(d.fecha, 'YYYY-MM-DD') AS fecha, d.estado`;

// El calendario de un mes. Todos ven los días pedidos y aprobados de todos (para
// no chocar); los rechazados solo los ve su dueño y el admin.
app.get('/api/dias-libres', requireLogin, async (req, res) => {
  const hoy = hoyEcuador();
  const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.mes)) ? req.query.mes : hoy.slice(0, 7);
  const desde = `${mes}-01`;
  const hasta = sumarDias(desde, 32).slice(0, 7) + '-01';
  const esVendedor = req.session.user.rol === 'vendedor';

  const dias = await pool.query(
    `SELECT ${DIA_LIBRE_COLUMNAS} FROM dias_libres d JOIN usuarios u ON u.id = d.usuario_id
     WHERE d.fecha >= $1 AND d.fecha < $2 ${esVendedor ? "AND (d.estado <> 'rechazado' OR d.usuario_id = $3)" : ''}
     ORDER BY d.fecha, u.usuario`,
    esVendedor ? [desde, hasta, req.session.user.id] : [desde, hasta]
  );
  // La lista de vendedores fija el color de cada uno en el calendario
  const vendedores = await pool.query(`SELECT usuario FROM usuarios WHERE rol = 'vendedor' AND activo = 1 ORDER BY usuario`);
  // Lista de abajo: al vendedor, sus pedidos de hoy en adelante; al admin, todo
  // lo pendiente y lo aprobado que viene (ahí acepta, rechaza o quita)
  const lista = await pool.query(
    `SELECT ${DIA_LIBRE_COLUMNAS} FROM dias_libres d JOIN usuarios u ON u.id = d.usuario_id
     WHERE d.fecha >= $1 AND ${esVendedor ? 'd.usuario_id = $2' : "d.estado IN ('pendiente', 'aprobado')"}
     ORDER BY d.fecha, u.usuario`,
    esVendedor ? [hoy, req.session.user.id] : [hoy]
  );

  res.json({
    mes,
    hoy,
    primera_fecha: sumarDias(hoy, DIAS_ANTELACION),
    antelacion: DIAS_ANTELACION,
    vendedores: vendedores.rows.map((v) => v.usuario),
    dias: dias.rows,
    lista: lista.rows,
  });
});

// El vendedor pide un día libre: queda pendiente hasta que el admin lo resuelva
app.post('/api/dias-libres', requireLogin, async (req, res) => {
  if (req.session.user.rol !== 'vendedor') {
    return res.status(403).json({ error: 'El día libre lo pide cada ayudante desde su usuario' });
  }
  const fecha = String((req.body || {}).fecha || '');
  const dia = diaDeSemana(fecha);
  if (dia === null) return res.status(400).json({ error: 'Fecha inválida' });
  if ([5, 6, 0].includes(dia)) {
    return res.status(400).json({ error: 'Viernes, sábado y domingo no se pueden pedir como día libre' });
  }
  const primera = sumarDias(hoyEcuador(), DIAS_ANTELACION);
  if (fecha < primera) {
    return res.status(400).json({
      error: `El día libre se pide con al menos ${textoAntelacion()} de antelación: lo más pronto es el ${fechaLarga(primera)}`,
    });
  }

  // Lo que ese vendedor ya pidió en esa semana (de lunes a domingo)
  const lunes = lunesDeLaSemana(fecha);
  const semana = await pool.query(
    `SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, estado FROM dias_libres
     WHERE usuario_id = $1 AND fecha >= $2 AND fecha < $3`,
    [req.session.user.id, lunes, sumarDias(lunes, 7)]
  );
  const mismoDia = semana.rows.find((d) => d.fecha === fecha);
  if (mismoDia) {
    return res.status(400).json({
      error: mismoDia.estado === 'rechazado' ? 'Ese día ya te lo rechazaron: elige otro' : 'Ya pediste ese día',
    });
  }
  const otro = semana.rows.find((d) => d.estado !== 'rechazado');
  if (otro) {
    return res.status(400).json({
      error: `Ya tienes un día libre esa semana (${fechaLarga(otro.fecha)}). Cancélalo primero si quieres cambiarlo.`,
    });
  }

  try {
    const r = await pool.query(
      `INSERT INTO dias_libres (usuario_id, fecha) VALUES ($1, $2)
       RETURNING id, to_char(fecha, 'YYYY-MM-DD') AS fecha, estado`,
      [req.session.user.id, fecha]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    // Dos toques seguidos al mismo día: el segundo choca con la regla de la tabla
    res.status(400).json({ error: 'Ya pediste ese día' });
  }
});

// El admin o el dueño acepta o rechaza (también puede quitar uno ya aceptado)
app.post('/api/dias-libres/:id/resolver', requireLogin, requireAdmin, async (req, res) => {
  const estado = (req.body || {}).estado;
  if (!['aprobado', 'rechazado'].includes(estado)) {
    return res.status(400).json({ error: 'El estado debe ser "aprobado" o "rechazado"' });
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Pedido inválido' });
  const r = await pool.query(
    `UPDATE dias_libres SET estado = $1, resuelto_por = $2, resuelto_en = NOW() WHERE id = $3
     RETURNING id, to_char(fecha, 'YYYY-MM-DD') AS fecha, estado`,
    [estado, req.session.user.id, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Ese pedido ya no existe' });
  res.json(r.rows[0]);
});

// El vendedor cancela un pedido suyo (pendiente o aprobado) mientras no haya pasado
app.delete('/api/dias-libres/:id', requireLogin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Pedido inválido' });
  const r = await pool.query(
    `SELECT usuario_id, to_char(fecha, 'YYYY-MM-DD') AS fecha, estado FROM dias_libres WHERE id = $1`,
    [id]
  );
  const pedido = r.rows[0];
  if (!pedido) return res.status(404).json({ error: 'Ese pedido ya no existe' });
  if (req.session.user.rol === 'vendedor') {
    if (pedido.usuario_id !== req.session.user.id) {
      return res.status(403).json({ error: 'Ese día libre es de otro ayudante' });
    }
    if (pedido.estado === 'rechazado' || pedido.fecha <= hoyEcuador()) {
      return res.status(400).json({ error: 'Ese día ya no se puede cancelar' });
    }
  }
  await pool.query('DELETE FROM dias_libres WHERE id = $1', [id]);
  res.status(204).send();
});

// --- Gastos: descuentan directamente de la caja del turno abierto (solo admin/dueño) ---

app.post('/api/gastos', requireLogin, requireAdmin, async (req, res) => {
  const { descripcion, monto } = req.body;
  if (!descripcion || !descripcion.trim() || monto == null || monto <= 0) {
    return res.status(400).json({ error: 'descripcion y monto (mayor a 0) son obligatorios' });
  }

  const turno = await getTurnoAbierto();
  if (!turno) {
    return res.status(400).json({ error: 'No hay caja abierta. Abre un turno antes de registrar un gasto.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'INSERT INTO gastos (turno_id, usuario_id, descripcion, monto) VALUES ($1, $2, $3, $4) RETURNING *',
      [turno.id, req.session.user.id, descripcion.trim(), monto]
    );
    await client.query('UPDATE turnos_caja SET monto_actual = monto_actual - $1 WHERE id = $2', [monto, turno.id]);
    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/gastos/:id', requireLogin, requireAdmin, async (req, res) => {
  const { descripcion, monto } = req.body;
  if (!descripcion || !descripcion.trim() || monto == null || monto <= 0) {
    return res.status(400).json({ error: 'descripcion y monto (mayor a 0) son obligatorios' });
  }

  const gastoR = await pool.query('SELECT * FROM gastos WHERE id = $1', [req.params.id]);
  const gasto = gastoR.rows[0];
  if (!gasto) return res.status(404).json({ error: 'Gasto no encontrado' });

  const diferencia = monto - gasto.monto; // si el monto sube, la caja baja más; si baja, la caja sube

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'UPDATE gastos SET descripcion = $1, monto = $2 WHERE id = $3 RETURNING *',
      [descripcion.trim(), monto, gasto.id]
    );
    await client.query('UPDATE turnos_caja SET monto_actual = monto_actual - $1 WHERE id = $2', [diferencia, gasto.turno_id]);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Borrar un gasto es una eliminación permanente: solo el dueño puede hacerlo
app.delete('/api/gastos/:id', requireLogin, requireDueño, async (req, res) => {
  const gastoR = await pool.query('SELECT * FROM gastos WHERE id = $1', [req.params.id]);
  const gasto = gastoR.rows[0];
  if (!gasto) return res.status(404).json({ error: 'Gasto no encontrado' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM gastos WHERE id = $1', [gasto.id]);
    await client.query('UPDATE turnos_caja SET monto_actual = monto_actual + $1 WHERE id = $2', [gasto.monto, gasto.turno_id]);
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Gastos del turno abierto actual (o, si no hay turno abierto, los últimos registrados)
// Comprobante de egreso de un gasto: el documento interno que respalda cada
// salida de efectivo. Lleva su propia numeración (CE- + el número del gasto),
// aparte de las notas de venta, que son de la serie del SRI y no se tocan.
app.get('/api/gastos/:id/comprobante', requireLogin, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Número de gasto inválido' });
  const r = await pool.query(
    'SELECT g.*, u.usuario AS registrado_por FROM gastos g JOIN usuarios u ON u.id = g.usuario_id WHERE g.id = $1',
    [id]
  );
  const gasto = r.rows[0];
  if (!gasto) return res.status(404).json({ error: 'Gasto no encontrado' });
  res.json({ ...gasto, numero: 'CE-' + String(gasto.id).padStart(6, '0') });
});

app.get('/api/gastos', requireLogin, requireAdmin, async (req, res) => {
  const turno = await getTurnoAbierto();
  const r = turno
    ? await pool.query(
        `SELECT g.*, u.usuario AS registrado_por FROM gastos g JOIN usuarios u ON u.id = g.usuario_id WHERE g.turno_id = $1 ORDER BY g.id DESC`,
        [turno.id]
      )
    : await pool.query(
        `SELECT g.*, u.usuario AS registrado_por FROM gastos g JOIN usuarios u ON u.id = g.usuario_id ORDER BY g.id DESC LIMIT 50`
      );
  res.json(r.rows);
});

// --- Ventas (proforma libre) ---
// Body: { cliente, cliente_direccion, cliente_ruc, cliente_telefono, cliente_email, items: [{ producto, cantidad, precio_unitario }] }

function formatNumeroProforma(numero) {
  return String(numero).padStart(7, '0');
}

// El RUC/cédula y el correo del cliente son opcionales, pero si viene algo tiene
// que estar bien. Se revisan también aquí y no solo en el navegador: el
// formulario se puede saltar. Las mismas reglas viven en public/app.js
// (avisoCedulaRuc y avisoEmail): si se cambia una allá, cambiarla aquí.
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Bancos de la empresa donde los clientes transfieren. La clave es lo que se
// guarda en ventas.banco; app.js tiene la misma lista con los colores de cada
// banco. Para agregar uno, se suma aquí y allá.
const BANCOS = {
  guayaquil: 'Banco Guayaquil',
  pichincha: 'Banco Pichincha',
  pacifico: 'Banco del Pacífico',
  bolivariano: 'Banco Bolivariano',
  // Para cuando el cliente transfirió a un banco que no es ninguno de los de arriba
  otros: 'Otros bancos',
};

// La clave del banco si es uno de los de la empresa; si no, null
function bancoValido(valor) {
  return typeof valor === 'string' && Object.hasOwn(BANCOS, valor) ? valor : null;
}

function limpiarTexto(valor) {
  return (valor == null ? '' : String(valor)).trim();
}

function avisoEmail(valor) {
  if (valor === '') return '';
  return RE_EMAIL.test(valor) ? '' : 'El correo no tiene un formato válido (ejemplo: nombre@dominio.com)';
}

// Cédula: 10 dígitos. RUC: 13. Cualquier otro largo, o algo que no sean números, falla.
function avisoCedulaRuc(valor) {
  if (valor === '') return '';
  if (!/^[0-9]+$/.test(valor)) return 'El RUC o cédula solo lleva números, sin letras ni guiones';
  if (valor.length === 10 || valor.length === 13) return '';
  const cuantos = valor.length === 1 ? 'Escribiste 1 número' : `Escribiste ${valor.length} números`;
  return `${cuantos}. Deben ser 10 (cédula) o 13 (RUC).`;
}

// Descuento al total de la nota: sin descuento (0) o de 5% a 16%, de uno en uno.
// Devuelve null si el valor no es uno de esos.
const DESCUENTO_MIN = 5;
const DESCUENTO_MAX = 16;
function descuentoValido(valor) {
  if (valor == null || valor === '' || Number(valor) === 0) return 0;
  const n = Number(valor);
  return Number.isInteger(n) && n >= DESCUENTO_MIN && n <= DESCUENTO_MAX ? n : null;
}
// Lo que se cobra: la suma de las líneas menos el descuento, redondeado al centavo
function totalConDescuento(items, pct) {
  const suma = items.reduce((acc, i) => acc + i.cantidad * i.precio_unitario, 0);
  return Math.round(suma * (100 - pct)) / 100;
}

app.post('/api/ventas', requireLogin, async (req, res) => {
  const { cliente, cliente_direccion, cliente_ruc, cliente_telefono, cliente_email, items } = req.body;
  const metodoPago = req.body.metodo_pago === 'transferencia' ? 'transferencia' : 'efectivo';
  // Una transferencia tiene que decir a qué banco entró; el efectivo no lleva banco
  const banco = metodoPago === 'transferencia' ? bancoValido(req.body.banco) : null;
  if (metodoPago === 'transferencia' && !banco) {
    return res.status(400).json({ error: 'Elige a qué banco se hizo la transferencia' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Debes incluir al menos un producto' });
  }
  for (const item of items) {
    if (!item.producto || !item.cantidad || item.cantidad <= 0 || item.precio_unitario == null || item.precio_unitario < 0) {
      return res.status(400).json({ error: 'Cada ítem necesita producto, cantidad > 0 y precio_unitario >= 0' });
    }
  }
  const ruc = limpiarTexto(cliente_ruc);
  const email = limpiarTexto(cliente_email);
  const problema = avisoCedulaRuc(ruc) || avisoEmail(email);
  if (problema) {
    return res.status(400).json({ error: problema });
  }
  const descuentoPct = descuentoValido(req.body.descuento_pct);
  if (descuentoPct === null) {
    return res.status(400).json({ error: `El descuento al total va de ${DESCUENTO_MIN}% a ${DESCUENTO_MAX}%` });
  }

  let turno = await getTurnoAbierto();
  // En caja libre la caja nunca frena una venta: si no hay turno, se abre solo
  if (!turno && (await getModoCaja()) === 'libre') {
    turno = await asegurarTurnoLibre(req.session.user.id);
  }
  if (!turno) {
    return res.status(400).json({ error: 'No hay caja abierta. Pide al administrador que abra el turno.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const total = totalConDescuento(items, descuentoPct);

    const contador = await client.query("SELECT valor FROM configuracion WHERE clave = 'ultimo_numero_proforma'");
    const numeroProforma = parseInt(contador.rows[0].valor, 10) + 1;
    await client.query("UPDATE configuracion SET valor = $1 WHERE clave = 'ultimo_numero_proforma'", [String(numeroProforma)]);

    const ventaResult = await client.query(
      `INSERT INTO ventas (turno_id, usuario_id, cliente, cliente_direccion, cliente_ruc, cliente_telefono, cliente_email, total, numero_proforma, metodo_pago, banco, descuento_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [turno.id, req.session.user.id, cliente || null, cliente_direccion || null, ruc || null, cliente_telefono || null, email || null, total, numeroProforma, metodoPago, banco, descuentoPct]
    );
    const ventaId = ventaResult.rows[0].id;

    for (const item of items) {
      await client.query(
        'INSERT INTO detalle_venta (venta_id, producto, cantidad, precio_unitario, precio_lista, producto_id) VALUES ($1, $2, $3, $4, $5, $6)',
        // Sin precio de lista se asume que se cobró el de siempre, o sea sin descuento
        [ventaId, item.producto, item.cantidad, item.precio_unitario, item.precio_lista ?? item.precio_unitario, item.producto_id || null]
      );
      if (item.producto_id) {
        const stockR = await client.query(
          'SELECT stock, controla_stock, por_docena FROM productos WHERE id = $1 FOR UPDATE',
          [item.producto_id]
        );
        // Lo que se vende por docena va de media docena (0.5) hasta 6 docenas, de
        // media en media: 0.5, 1, 1.5... 6
        if (stockR.rows[0] && stockR.rows[0].por_docena) {
          const docenas = Number(item.cantidad);
          if (!Number.isInteger(docenas * 2) || docenas < 0.5 || docenas > MAX_DOCENAS) {
            throw new Error(`"${item.producto}" se vende de media docena hasta ${MAX_DOCENAS} docenas (0.5, 1, 1.5... ${MAX_DOCENAS})`);
          }
        }
        // Las categorías sueltas (zapatillas, ofertas) no llevan stock: se venden
        // siempre y no descuentan nada. Solo aportan su nombre y su precio.
        if (stockR.rows[0] && !stockR.rows[0].controla_stock) continue;
        if (!stockR.rows[0] || stockR.rows[0].stock < item.cantidad) {
          throw new Error(`Stock insuficiente para "${item.producto}"`);
        }
        // La etiqueta se va pegada al zapato, así que al vender baja también la
        // cuenta de impresas. Si no, al reponer ese par el sistema lo daría por
        // etiquetado y saldría a la venta sin etiqueta.
        await client.query(
          'UPDATE productos SET stock = stock - $1, etiquetas_impresas = LEAST(etiquetas_impresas, stock - $1) WHERE id = $2',
          [item.cantidad, item.producto_id]
        );
      }
    }

    // Las transferencias no entran a la caja física: solo el efectivo suma a monto_actual
    if (metodoPago === 'efectivo') {
      await client.query('UPDATE turnos_caja SET monto_actual = monto_actual + $1 WHERE id = $2', [total, turno.id]);
    }

    await client.query('COMMIT');
    res.status(201).json({ ventaId, total, descuento_pct: descuentoPct, numero_proforma: formatNumeroProforma(numeroProforma), metodo_pago: metodoPago, banco });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Ventas recientes de todos los vendedores (cualquier vendedor puede reimprimir la proforma de un compañero)
app.get('/api/ventas/recientes', requireLogin, async (req, res) => {
  // Un vendedor solo ve lo que vendió él. El admin y el dueño siguen viendo todo,
  // que para eso tienen el panel.
  const soloMias = req.session.user.rol === 'vendedor';
  const r = await pool.query(`
    SELECT v.id, v.cliente, v.fecha, v.total, v.anulada, v.metodo_pago, v.banco, u.usuario AS vendedor
    FROM ventas v
    JOIN usuarios u ON u.id = v.usuario_id
    WHERE v.eliminada = 0 ${soloMias ? 'AND v.usuario_id = $1' : ''}
    ORDER BY v.id DESC
    LIMIT 30
  `, soloMias ? [req.session.user.id] : []);
  // Lo que lleva cada venta, para el resumen de la campanita (una sola consulta
  // para las 30, en vez de una por venta)
  const ids = r.rows.map((v) => v.id);
  const detalle = ids.length
    ? await pool.query(
      'SELECT venta_id, producto, cantidad, precio_unitario FROM detalle_venta WHERE venta_id = ANY($1) ORDER BY id',
      [ids]
    )
    : { rows: [] };
  r.rows.forEach((v) => {
    v.detalle = detalle.rows
      .filter((d) => d.venta_id === v.id)
      .map(({ producto, cantidad, precio_unitario }) => ({ producto, cantidad, precio_unitario }));
  });
  res.json(r.rows);
});

// Detalle completo de una venta, para la vista de impresión de la proforma.
app.get('/api/ventas/:id', requireLogin, async (req, res) => {
  const r = await pool.query(
    `SELECT v.*, u.usuario AS vendedor FROM ventas v JOIN usuarios u ON u.id = v.usuario_id WHERE v.id = $1`,
    [req.params.id]
  );
  const venta = r.rows[0];
  if (!venta) {
    return res.status(404).json({ error: 'Venta no encontrada' });
  }
  // Sin esto, esconder las ventas ajenas del listado sería solo apariencia: con
  // cambiar el número en la dirección se abriría la nota de un compañero.
  if (req.session.user.rol === 'vendedor' && venta.usuario_id !== req.session.user.id) {
    return res.status(403).json({ error: 'Esa venta es de otro vendedor. Pídesela al administrador.' });
  }
  venta.numero_proforma = formatNumeroProforma(venta.numero_proforma || venta.id);
  // Nombre completo del banco para el comprobante ("Banco Pichincha")
  venta.banco_nombre = BANCOS[venta.banco] || null;
  const detalle = await pool.query('SELECT producto, cantidad, precio_unitario, precio_lista FROM detalle_venta WHERE venta_id = $1', [venta.id]);
  venta.detalle = detalle.rows;
  res.json(venta);
});

// --- Dashboard del admin ---

// Filtro de periodo del historial. Las fechas se guardan en UTC, así que se convierten
// a hora de Ecuador antes de comparar: "hoy" es el día real del local, no el día UTC.
const FECHA_LOCAL = `(v.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Guayaquil')`;
const HOY_LOCAL = `date_trunc('day', NOW() AT TIME ZONE 'America/Guayaquil')`;
const FILTROS_PERIODO = {
  hoy: `AND ${FECHA_LOCAL} >= ${HOY_LOCAL}`,
  '7dias': `AND ${FECHA_LOCAL} >= ${HOY_LOCAL} - INTERVAL '6 days'`,
  mes: `AND ${FECHA_LOCAL} >= date_trunc('month', NOW() AT TIME ZONE 'America/Guayaquil')`,
  todo: '',
};

app.get('/api/dashboard', requireLogin, requireAdmin, async (req, res) => {
  const turno = await turnoAbiertoOLibre(req);
  const numVentasR = await pool.query('SELECT COUNT(*) AS c FROM ventas');

  // Lista blanca: solo estos valores llegan a la consulta
  const periodo = ['hoy', '7dias', 'mes', 'todo'].includes(req.query.periodo) ? req.query.periodo : 'hoy';
  const ventasR = await pool.query(`
    SELECT v.id, v.numero_proforma, v.cliente, v.cliente_direccion, v.cliente_ruc, v.cliente_telefono, v.cliente_email,
           v.fecha, v.total, v.metodo_pago, v.banco, v.anulada, v.fecha_anulacion, v.motivo_anulacion,
           u.usuario AS vendedor, au.usuario AS anulada_por_usuario
    FROM ventas v
    JOIN usuarios u ON u.id = v.usuario_id
    LEFT JOIN usuarios au ON au.id = v.anulada_por
    WHERE v.eliminada = 0
    ${FILTROS_PERIODO[periodo]}
    ORDER BY v.id DESC
    LIMIT 100
  `);

  const ventas = ventasR.rows;
  for (const v of ventas) {
    v.numero_proforma = formatNumeroProforma(v.numero_proforma || v.id);
    const detalle = await pool.query('SELECT producto, cantidad, precio_unitario, precio_lista FROM detalle_venta WHERE venta_id = $1', [v.id]);
    v.detalle = detalle.rows;
  }

  // Transferencias de HOY (día de Ecuador), no del turno: en caja libre el turno
  // no se cierra nunca y el número crecería sin parar. Vaciar la caja no las toca
  // porque ese dinero está en el banco, no en el cajón.
  const transferenciasR = await pool.query(`
    SELECT COALESCE(SUM(v.total), 0) AS t FROM ventas v
    WHERE v.metodo_pago = 'transferencia' AND v.anulada = 0 AND v.eliminada = 0
    ${FILTROS_PERIODO.hoy}
  `);
  const totalTransferenciasHoy = Number(transferenciasR.rows[0].t);
  // Lo mismo separado por banco, para comparar con la app de cada uno. Las
  // transferencias de antes de que se pidiera el banco salen como "sin_banco".
  const porBancoR = await pool.query(`
    SELECT COALESCE(v.banco, 'sin_banco') AS banco, COUNT(*)::int AS cantidad, COALESCE(SUM(v.total), 0) AS total
    FROM ventas v
    WHERE v.metodo_pago = 'transferencia' AND v.anulada = 0 AND v.eliminada = 0
    ${FILTROS_PERIODO.hoy}
    GROUP BY COALESCE(v.banco, 'sin_banco')
  `);
  const transferenciasPorBanco = porBancoR.rows.map((r) => ({
    banco: r.banco, cantidad: r.cantidad, total: Number(r.total),
  }));

  res.json({
    turno,
    totalTransferenciasHoy,
    transferenciasPorBanco,
    // Mismo valor con el nombre de antes, para las pestañas abiertas antes de esta versión
    totalTransferenciasTurno: totalTransferenciasHoy,
    numVentas: parseInt(numVentasR.rows[0].c, 10),
    periodo,
    ventas,
  });
});

// --- Anulación de ventas (no se borran, queda nota con fecha y motivo) ---

app.post('/api/ventas/:id/anular', requireLogin, requireAdmin, async (req, res) => {
  const { motivo } = req.body;
  if (!motivo || !motivo.trim()) {
    return res.status(400).json({ error: 'Debes indicar el motivo de la anulación' });
  }

  const ventaR = await pool.query('SELECT * FROM ventas WHERE id = $1', [req.params.id]);
  const venta = ventaR.rows[0];
  if (!venta) {
    return res.status(404).json({ error: 'Venta no encontrada' });
  }
  if (venta.anulada) {
    return res.status(400).json({ error: 'Esta venta ya está anulada' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE ventas SET anulada = 1, fecha_anulacion = NOW(), motivo_anulacion = $1, anulada_por = $2 WHERE id = $3`,
      [motivo.trim(), req.session.user.id, venta.id]
    );
    if (venta.metodo_pago === 'efectivo') {
      await client.query('UPDATE turnos_caja SET monto_actual = monto_actual - $1 WHERE id = $2', [venta.total, venta.turno_id]);
    }
    // Restaurar stock de ítems del catálogo
    const detalleAnular = await client.query('SELECT * FROM detalle_venta WHERE venta_id = $1 AND producto_id IS NOT NULL', [venta.id]);
    for (const d of detalleAnular.rows) {
      await client.query('UPDATE productos SET stock = stock + $1 WHERE id = $2', [d.cantidad, d.producto_id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }

  const actualizada = await pool.query('SELECT * FROM ventas WHERE id = $1', [venta.id]);
  res.json(actualizada.rows[0]);
});

// --- Eliminación definitiva de ventas (solo dueño): se borra por completo de la base de datos ---

app.post('/api/ventas/:id/eliminar', requireLogin, requireDueño, async (req, res) => {
  const ventaR = await pool.query('SELECT * FROM ventas WHERE id = $1', [req.params.id]);
  const venta = ventaR.rows[0];
  if (!venta) {
    return res.status(404).json({ error: 'Venta no encontrada' });
  }

  // Eliminar solo borra el registro: NO devuelve el stock ni toca la caja (así lo
  // pidió el dueño, para que el inventario no se desordene). Para una venta real
  // que se devuelve está Anular, que sí regresa los productos y deja el registro.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM detalle_venta WHERE venta_id = $1', [venta.id]);
    await client.query('DELETE FROM ventas WHERE id = $1', [venta.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }

  res.status(204).send();
});

// --- Edición de ventas (solo dueño): reemplaza cliente e ítems, recalcula total y ajusta la caja por la diferencia ---

app.put('/api/ventas/:id', requireLogin, requireDueño, async (req, res) => {
  const { cliente, cliente_direccion, cliente_ruc, cliente_telefono, cliente_email, items } = req.body;
  const nuevoMetodoPago = req.body.metodo_pago === 'transferencia' ? 'transferencia' : 'efectivo';
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Debes incluir al menos un producto' });
  }
  for (const item of items) {
    if (!item.producto || !item.cantidad || item.cantidad <= 0 || item.precio_unitario == null || item.precio_unitario < 0) {
      return res.status(400).json({ error: 'Cada ítem necesita producto, cantidad > 0 y precio_unitario >= 0' });
    }
  }
  const ruc = limpiarTexto(cliente_ruc);
  const email = limpiarTexto(cliente_email);
  const problema = avisoCedulaRuc(ruc) || avisoEmail(email);
  if (problema) {
    return res.status(400).json({ error: problema });
  }

  const ventaR = await pool.query('SELECT * FROM ventas WHERE id = $1', [req.params.id]);
  const venta = ventaR.rows[0];
  if (!venta) {
    return res.status(404).json({ error: 'Venta no encontrada' });
  }
  if (venta.anulada || venta.eliminada) {
    return res.status(400).json({ error: 'No se puede editar una venta anulada o eliminada' });
  }

  // Banco de la transferencia: si se eligió uno tiene que ser de la lista. Si no
  // se mandó, se conserva el que tenía, para poder corregir otros datos de una
  // transferencia antigua que se registró antes de que se pidiera el banco.
  let nuevoBanco = null;
  if (nuevoMetodoPago === 'transferencia') {
    if (req.body.banco) {
      nuevoBanco = bancoValido(req.body.banco);
      if (!nuevoBanco) return res.status(400).json({ error: 'Ese banco no está en la lista de la empresa' });
    } else if (venta.metodo_pago === 'transferencia') {
      nuevoBanco = venta.banco;
    } else {
      // Pasa de efectivo a transferencia: ahí sí hay que decir el banco
      return res.status(400).json({ error: 'Elige a qué banco se hizo la transferencia' });
    }
  }

  // El descuento al total se conserva si la edición no lo cambia
  const nuevoDescuento = req.body.descuento_pct === undefined ? (venta.descuento_pct || 0) : descuentoValido(req.body.descuento_pct);
  if (nuevoDescuento === null) {
    return res.status(400).json({ error: `El descuento al total va de ${DESCUENTO_MIN}% a ${DESCUENTO_MAX}%` });
  }
  const nuevoTotal = totalConDescuento(items, nuevoDescuento);
  // El ajuste a la caja depende de cuánto aportaba ANTES (solo si era efectivo) vs cuánto aporta AHORA (solo si sigue siendo efectivo)
  const aportabaCajaAntes = venta.metodo_pago === 'efectivo' ? venta.total : 0;
  const aportaCajaAhora = nuevoMetodoPago === 'efectivo' ? nuevoTotal : 0;
  const diferencia = aportaCajaAhora - aportabaCajaAntes;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE ventas SET cliente = $1, cliente_direccion = $2, cliente_ruc = $3, cliente_telefono = $4, cliente_email = $5, total = $6, metodo_pago = $7, banco = $8, descuento_pct = $9 WHERE id = $10`,
      [cliente || null, cliente_direccion || null, ruc || null, cliente_telefono || null, email || null, nuevoTotal, nuevoMetodoPago, nuevoBanco, nuevoDescuento, venta.id]
    );

    await client.query('DELETE FROM detalle_venta WHERE venta_id = $1', [venta.id]);
    for (const item of items) {
      await client.query(
        'INSERT INTO detalle_venta (venta_id, producto, cantidad, precio_unitario, precio_lista) VALUES ($1, $2, $3, $4, $5)',
        [venta.id, item.producto, item.cantidad, item.precio_unitario, item.precio_lista ?? item.precio_unitario]
      );
    }

    if (diferencia !== 0) {
      await client.query('UPDATE turnos_caja SET monto_actual = monto_actual + $1 WHERE id = $2', [diferencia, venta.turno_id]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }

  const actualizada = await pool.query('SELECT * FROM ventas WHERE id = $1', [venta.id]);
  res.json(actualizada.rows[0]);
});

// --- Gestión de usuarios (vendedores) por el admin ---

// Toda la gestión de usuarios es exclusiva del dueño
app.get('/api/usuarios', requireLogin, requireDueño, async (req, res) => {
  const r = await pool.query('SELECT id, usuario, rol, activo FROM usuarios ORDER BY id');
  res.json(r.rows);
});

// Solo el dueño puede crear usuarios y asignar roles
app.post('/api/usuarios', requireLogin, requireDueño, async (req, res) => {
  const { usuario, password, rol } = req.body;
  if (!usuario || !password || !['admin', 'vendedor', 'dueno'].includes(rol)) {
    return res.status(400).json({ error: 'usuario, password y rol (admin/vendedor/dueño) son obligatorios' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = await pool.query(
      'INSERT INTO usuarios (usuario, password_hash, rol) VALUES ($1, $2, $3) RETURNING id, usuario, rol, activo',
      [usuario, hash, rol]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(400).json({ error: `Ya existe el usuario "${usuario}"` });
  }
});

// Renombrar usuario y/o cambiar su rol (solo dueño)
app.put('/api/usuarios/:id', requireLogin, requireDueño, async (req, res) => {
  const { usuario, rol } = req.body;
  if (!usuario || !usuario.trim() || !['admin', 'vendedor', 'dueno'].includes(rol)) {
    return res.status(400).json({ error: 'usuario y rol (admin/vendedor/dueño) son obligatorios' });
  }
  const id = parseInt(req.params.id, 10);
  // Evita que el dueño se quite a sí mismo el rol y quede sin acceso a estas funciones
  if (id === req.session.user.id && rol !== 'dueno') {
    return res.status(400).json({ error: 'No puedes cambiar tu propio rol' });
  }
  try {
    const r = await pool.query(
      'UPDATE usuarios SET usuario = $1, rol = $2 WHERE id = $3 RETURNING id, usuario, rol, activo',
      [usuario.trim(), rol, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(400).json({ error: `Ya existe el usuario "${usuario.trim()}"` });
  }
});

// Cambiar la contraseña de un usuario (solo dueño). Las contraseñas nunca se guardan
// en texto plano (solo su hash bcrypt), por eso no existe forma de "verlas": solo de asignar una nueva.
app.post('/api/usuarios/:id/password', requireLogin, requireDueño, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const r = await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2 RETURNING id, usuario', [hash, req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ ok: true, usuario: r.rows[0].usuario });
});

// Eliminar usuario definitivamente (solo dueño). Si el usuario tiene movimientos registrados
// (ventas, turnos, gastos), la base de datos lo protege y se sugiere desactivarlo.
app.delete('/api/usuarios/:id', requireLogin, requireDueño, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.user.id) {
    return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
  }
  try {
    const r = await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.status(204).send();
  } catch (err) {
    res.status(400).json({
      error: 'Este usuario tiene ventas, turnos o gastos registrados: borrarlo dañaría el historial. Desactívalo en su lugar.',
    });
  }
});

app.post('/api/usuarios/:id/activo', requireLogin, requireDueño, async (req, res) => {
  const { activo } = req.body;
  await pool.query('UPDATE usuarios SET activo = $1 WHERE id = $2', [activo ? 1 : 0, req.params.id]);
  const r = await pool.query('SELECT id, usuario, rol, activo FROM usuarios WHERE id = $1', [req.params.id]);
  res.json(r.rows[0]);
});

// --- Catálogo / Inventario ---

// Catálogo disponible para vendedores (activo y con stock)
// Cómo se nombra un producto en la línea de una venta. Una sandalia lleva talla
// y color ("Cabuya Alta T38 Yute"); una categoría suelta no tiene ninguno de los
// dos y se queda solo con su nombre ("Zapatilla de dama").
// Los colores de una categoría suelta, limpios: llegan como lista o como texto
// separado por comas; se quitan los vacíos y los repetidos (sin importar
// mayúsculas o tildes) y se guardan como "Rosa, Menta, Lila". Vacío = null.
const MAX_COLORES = 20;
// Lo máximo que se vende de un código por docena en una sola línea de la nota
const MAX_DOCENAS = 6;
function limpiarColores(valor) {
  const lista = Array.isArray(valor) ? valor : String(valor ?? '').split(',');
  const vistos = new Set();
  const limpios = [];
  for (const c of lista) {
    const color = String(c ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const clave = color.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!color || vistos.has(clave)) continue;
    vistos.add(clave);
    limpios.push(color);
  }
  return limpios.length ? limpios.slice(0, MAX_COLORES).join(', ') : null;
}

function nombreProducto(p) {
  const talla = String(p.talla || '').trim();
  const color = String(p.color || '').trim();
  return [p.modelo, talla && `T${talla}`, color].filter(Boolean).join(' ');
}

// --- Etiquetas ya impresas ---
// Lo pendiente de etiquetar es stock - etiquetas_impresas. Al ingresar mercadería
// el stock sube y las impresas no, así que lo pendiente pasa a ser exactamente lo
// que acaba de entrar, sin tener que registrar nada más.

// Se confirma después de imprimir, no al descargar el PDF: descargar no es
// imprimir, y el rollo se puede trabar.
app.post('/api/etiquetas/impresas', requireLogin, requireAdmin, async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No se indicó qué etiquetas se imprimieron' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const cantidad = Math.round(Number(item.cantidad));
      if (!Number.isInteger(item.id) || !Number.isFinite(cantidad) || cantidad <= 0) continue;
      // Nunca por encima del stock: no se puede haber etiquetado más pares de los que hay
      await client.query(
        'UPDATE productos SET etiquetas_impresas = LEAST(stock, etiquetas_impresas + $1) WHERE id = $2',
        [cantidad, item.id]
      );
    }
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Para el modelo viejo que nunca se etiquetó, o el rollo que se trabó a la mitad:
// vuelve a dejar toda esa talla como pendiente.
app.post('/api/productos/:id/etiquetas-pendientes', requireLogin, requireAdmin, async (req, res) => {
  const r = await pool.query(
    'UPDATE productos SET etiquetas_impresas = 0 WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(r.rows[0]);
});

// Búsqueda por el código de la etiqueta, para vender escaneando.
// La etiqueta lleva dos códigos del mismo producto: el de barras tiene el id en
// 6 dígitos y el QR tiene el SKU. Se aceptan los dos, así da igual cuál alcance
// a leer el lector.
//
// Se consulta la base en cada escaneo en vez de una copia en el celular: el
// stock y el precio tienen que ser los de este momento, porque otra vendedora
// pudo haber vendido el último par hace un segundo.
app.get('/api/productos/codigo/:codigo', requireLogin, async (req, res) => {
  const codigo = String(req.params.codigo || '').trim().toUpperCase();
  if (!codigo) return res.status(400).json({ error: 'Código vacío' });

  // El código de barras son solo dígitos con ceros a la izquierda (000207). Pero
  // hay códigos de etiqueta que también son solo números (los del catálogo por
  // docena: "1016", "915"), así que primero gana el código de la etiqueta y, si
  // ninguno coincide, se toma como código de barras.
  // Después de la etiqueta va el código del catálogo tal como se escribe ("1021",
  // "1002 Y", sin importar espacios): la etiqueta de un código por docena lleva
  // además su rango ("1021-1823"), pero en el mostrador se dice "la 1021".
  const esId = /^[0-9]{1,9}$/.test(codigo);
  const sinEspacios = codigo.replace(/\s+/g, '');
  const r = await pool.query(
    `SELECT *, CASE WHEN UPPER(sku) = $1 THEN 0
                    WHEN controla_stock = 0 AND REPLACE(UPPER(modelo), ' ', '') = $3 THEN 1
                    ELSE 2 END AS prioridad
     FROM productos
     WHERE eliminado = 0
       AND (UPPER(sku) = $1 OR id = $2 OR (controla_stock = 0 AND REPLACE(UPPER(modelo), ' ', '') = $3))
     ORDER BY prioridad, activo DESC, id`,
    [codigo, esId ? parseInt(codigo, 10) : -1, sinEspacios]
  );

  // Un código del catálogo que viene en dos rangos (1017 S en 24-29 y 30-35):
  // si solo uno está a la venta se toma ese; si no, hay que decir cuál
  const delCatalogo = r.rows.filter((x) => x.prioridad === 1);
  if (r.rows[0] && r.rows[0].prioridad === 1 && delCatalogo.length > 1
      && delCatalogo.filter((x) => x.activo).length !== 1) {
    const rangos = delCatalogo.map((x) => x.talla || 'sin rango').join(', ');
    return res.status(409).json({
      error: `${delCatalogo[0].modelo} viene en varias tallas (${rangos}). Elígelo con el buscador.`,
    });
  }

  const p = r.rows[0];
  if (p) delete p.prioridad;
  if (!p) {
    return res.status(404).json({ error: `Ningún producto tiene el código ${codigo}. ¿Es una etiqueta de otra tienda?` });
  }

  const nombre = nombreProducto(p);
  if (!p.activo) {
    return res.status(409).json({ error: `${nombre} está desactivado en el inventario. Avisa al administrador.` });
  }
  // Una categoría suelta no tiene stock que revisar: se vende siempre
  if (p.controla_stock && p.stock <= 0) {
    return res.status(409).json({ error: `${nombre} figura agotado en el sistema. Avisa al administrador para que corrija el stock.` });
  }

  // El nombre lo arma el servidor y no el navegador, así los dos escriben igual
  // la línea de la venta, con talla y color o sin ellos.
  res.json({ ...p, nombre });
});

app.get('/api/productos/disponibles', requireLogin, async (req, res) => {
  const r = await pool.query(
    // Las categorías sueltas no tienen stock que mirar: se ofrecen siempre
    `SELECT * FROM productos
     WHERE activo = 1 AND eliminado = 0 AND (stock > 0 OR controla_stock = 0)
     ORDER BY modelo, color, talla`
  );
  res.json(r.rows);
});

// El admin no ve los productos eliminados; el dueño los ve todos, con el motivo y quién los eliminó
app.get('/api/productos', requireLogin, requireAdmin, async (req, res) => {
  const r = req.session.user.rol === 'dueno'
    ? await pool.query(`
        SELECT p.*, u.usuario AS eliminado_por_usuario
        FROM productos p
        LEFT JOIN usuarios u ON u.id = p.eliminado_por
        ORDER BY p.modelo, p.color, p.talla`)
    : await pool.query('SELECT * FROM productos WHERE eliminado = 0 ORDER BY modelo, color, talla');
  res.json(r.rows);
});

app.post('/api/productos', requireLogin, requireAdmin, async (req, res) => {
  const { modelo, precio } = req.body;
  // Una categoría suelta no tiene talla, ni color, ni stock: es un solo producto
  // con su precio. Por eso esos campos solo se exigen cuando sí lleva control.
  const controlaStock = req.body.controla_stock === false || req.body.controla_stock === 0 ? 0 : 1;
  // Solo una categoría suelta puede venderse por docena (ver db.js)
  const porDocena = !controlaStock && req.body.por_docena ? 1 : 0;
  // Una categoría suelta no tiene talla; la que se vende por docena sí lleva su
  // rango ("24-29"): el mismo código viene en varios rangos con distinto precio
  const talla = controlaStock ? req.body.talla : (porDocena ? String(req.body.talla ?? '').trim() : '');
  const color = controlaStock ? req.body.color : '';
  const stock = controlaStock ? req.body.stock : 0;
  // Solo una categoría suelta lleva lista de colores; una talla tiene su color
  const colores = controlaStock ? null : limpiarColores(req.body.colores);

  if (!modelo?.trim() || precio == null || precio < 0) {
    return res.status(400).json({ error: 'El nombre y el precio son obligatorios' });
  }
  if (controlaStock && (!talla?.trim() || !color?.trim() || stock == null || stock < 0)) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }

  // Si el producto ya existe (mismo modelo+talla+color), el stock nuevo SE SUMA al existente
  // (llegada de mercadería). También se actualiza el precio al recién escrito y se reactiva si estaba inactivo.
  const existente = await pool.query(
    `SELECT * FROM productos
     WHERE LOWER(modelo) = LOWER($1) AND LOWER(talla) = LOWER($2) AND LOWER(color) = LOWER($3) AND eliminado = 0
     LIMIT 1`,
    [modelo.trim(), talla.trim(), color.trim()]
  );
  if (existente.rows[0]) {
    // Una categoría suelta que se vuelve a cargar con colores los actualiza; sin
    // colores, se quedan los que tenía
    const r = await pool.query(
      'UPDATE productos SET stock = stock + $1, precio = $2, activo = 1, colores = COALESCE($3, colores), por_docena = $4 WHERE id = $5 RETURNING *',
      [Math.round(stock), precio, colores, porDocena, existente.rows[0].id]
    );
    return res.status(200).json({ ...r.rows[0], stock_sumado: Math.round(stock) });
  }

  const r = await pool.query(
    'INSERT INTO productos (modelo, talla, color, precio, stock, controla_stock, colores, por_docena) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
    [modelo.trim(), talla.trim(), color.trim(), precio, Math.round(stock), controlaStock, colores, porDocena]
  );

  // El código de la etiqueta se pone en un segundo paso, y aparte: si fallara,
  // el producto igual queda creado. Una etiqueta se puede arreglar después;
  // perder el alta de mercadería, no. Una vez puesto ya no cambia, porque la
  // etiqueta impresa tiene que seguir sirviendo aunque se corrija el color.
  try {
    const sku = await skuUnico(pool, { modelo: modelo.trim(), color: color.trim(), talla: talla.trim() });
    const conSku = await pool.query('UPDATE productos SET sku = $1 WHERE id = $2 RETURNING *', [sku, r.rows[0].id]);
    return res.status(201).json(conSku.rows[0]);
  } catch (err) {
    console.error('No se pudo asignar el código de etiqueta al producto nuevo:', err.message);
    return res.status(201).json(r.rows[0]);
  }
});

app.put('/api/productos/:id', requireLogin, requireAdmin, async (req, res) => {
  const { modelo, precio } = req.body;

  const actual = await pool.query('SELECT stock, controla_stock, colores, por_docena, talla FROM productos WHERE id = $1', [req.params.id]);
  if (actual.rowCount === 0) return res.status(404).json({ error: 'Producto no encontrado' });

  // Si no viene en el cuerpo se conserva lo que ya tenía: así una edición que no
  // toca el tema no convierte por accidente una talla en categoría suelta.
  const controlaStock = req.body.controla_stock == null
    ? actual.rows[0].controla_stock
    : (req.body.controla_stock === false || req.body.controla_stock === 0 ? 0 : 1);
  // La venta por docena: sin dato en el cuerpo, queda como estaba
  const porDocena = controlaStock
    ? 0
    : (req.body.por_docena === undefined ? actual.rows[0].por_docena : (req.body.por_docena ? 1 : 0));
  // La talla: la del par; en un código por docena, su rango (se conserva si no viene)
  const talla = controlaStock
    ? req.body.talla
    : (porDocena ? String(req.body.talla ?? actual.rows[0].talla ?? '').trim() : '');
  const color = controlaStock ? req.body.color : '';
  const stock = controlaStock ? req.body.stock : 0;
  // Colores de la categoría suelta; si no vienen en el cuerpo se conservan
  const colores = controlaStock
    ? null
    : (req.body.colores === undefined ? actual.rows[0].colores : limpiarColores(req.body.colores));

  if (!modelo?.trim() || precio == null || precio < 0) {
    return res.status(400).json({ error: 'El nombre y el precio son obligatorios' });
  }
  if (controlaStock && (!talla?.trim() || !color?.trim() || stock == null || stock < 0)) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }

  // Seguridad: reducir stock es exclusivo del dueño. El admin puede corregir datos y precio,
  // y subir stock, pero nunca bajarlo (esa es la vía típica para desviar mercadería).
  // Pasar una talla a categoría suelta pone el stock en 0, así que también se controla.
  if (Math.round(stock) < actual.rows[0].stock && req.session.user.rol !== 'dueno') {
    return res.status(403).json({ error: 'Reducir el stock solo puede hacerlo el dueño' });
  }

  const r = await pool.query(
    // Si el stock se corrige hacia abajo, las etiquetas impresas no pueden quedar por encima
    `UPDATE productos SET modelo=$1, talla=$2, color=$3, precio=$4, stock=$5,
       etiquetas_impresas=LEAST(etiquetas_impresas, $5), controla_stock=$6, colores=$7, por_docena=$8
     WHERE id=$9 RETURNING *`,
    [modelo.trim(), talla.trim(), color.trim(), precio, Math.round(stock), controlaStock, colores, porDocena, req.params.id]
  );
  res.json(r.rows[0]);
});

app.post('/api/productos/:id/activo', requireLogin, requireAdmin, async (req, res) => {
  const { activo } = req.body;
  await pool.query('UPDATE productos SET activo=$1 WHERE id=$2', [activo ? 1 : 0, req.params.id]);
  const r = await pool.query('SELECT * FROM productos WHERE id=$1', [req.params.id]);
  res.json(r.rows[0]);
});

// Eliminación definitiva de productos (solo dueño): se borra por completo de la base de datos.
// Las ventas históricas no se rompen: conservan el nombre del producto en texto, solo se desvincula la referencia.
app.delete('/api/productos/:id', requireLogin, requireDueño, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE detalle_venta SET producto_id = NULL WHERE producto_id = $1', [req.params.id]);
    const r = await client.query('DELETE FROM productos WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    if (r.rowCount === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Eliminación lógica de productos: el admin corrige errores ocultándolos de su panel,
// pero el producto se conserva y el dueño lo sigue viendo junto con el motivo escrito.
app.post('/api/productos/:id/eliminar', requireLogin, requireAdmin, async (req, res) => {
  const { motivo } = req.body;
  if (!motivo || !motivo.trim()) {
    return res.status(400).json({ error: 'Debes escribir el motivo de la eliminación (el dueño lo verá)' });
  }
  const r = await pool.query(
    `UPDATE productos SET eliminado = 1, motivo_eliminacion = $1, fecha_eliminacion = NOW(), eliminado_por = $2
     WHERE id = $3 AND eliminado = 0 RETURNING *`,
    [motivo.trim(), req.session.user.id, req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Producto no encontrado o ya eliminado' });
  res.status(204).send();
});

// Renombrar varios productos a nombres distintos en una sola sentencia. Lo usa
// el cambio de nombre de una familia entera: cada modelo conserva su código
// (#APR-03) y solo cambia la parte de la familia, así que cada fila recibe un
// nombre diferente. El cliente manda los pares ya armados.
app.post('/api/productos/renombrar-varios', requireLogin, requireAdmin, async (req, res) => {
  const cambios = Array.isArray(req.body.cambios) ? req.body.cambios : [];
  const limpios = [];
  for (const c of cambios) {
    const id = parseInt(c && c.id, 10);
    const modelo = String((c && c.modelo) || '').trim();
    if (Number.isInteger(id) && modelo) limpios.push({ id, modelo });
  }
  if (limpios.length === 0) {
    return res.status(400).json({ error: 'No se indicó qué renombrar' });
  }

  const valores = [];
  const parametros = [];
  for (const c of limpios) {
    parametros.push(c.id, c.modelo);
    valores.push(`($${parametros.length - 1}::int, $${parametros.length}::text)`);
  }

  const r = await pool.query(
    `UPDATE productos SET modelo = nuevos.modelo
     FROM (VALUES ${valores.join(', ')}) AS nuevos(id, modelo)
     WHERE productos.id = nuevos.id`,
    parametros
  );
  res.json({ actualizados: r.rowCount });
});

// Renombrar un modelo entero de una vez (todas sus tallas y colores), para
// corregir un código mal escrito sin editar variante por variante.
//
// El SKU NO se toca a propósito, igual que al editar un producto suelto: la
// etiqueta ya está pegada en el zapato y su código tiene que seguir sirviendo
// después de corregir el nombre. El código de barras tampoco cambia, porque
// lleva el id, que es fijo.
app.post('/api/productos/renombrar-modelo', requireLogin, requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? req.body.ids.map((n) => parseInt(n, 10)).filter(Number.isInteger)
    : [];
  const modelo = String(req.body.modelo || '').trim();
  if (ids.length === 0) {
    return res.status(400).json({ error: 'No se indicó qué renombrar' });
  }
  if (!modelo) {
    return res.status(400).json({ error: 'El nombre del modelo no puede quedar vacío' });
  }

  const r = await pool.query('UPDATE productos SET modelo = $1 WHERE id = ANY($2::int[])', [modelo, ids]);
  res.json({ actualizados: r.rowCount, modelo });
});

// Eliminar un modelo entero de una vez (todas sus tallas y colores), en vez de
// ir talla por talla. Sigue la misma regla que el borrado individual: el dueño
// elimina de verdad y el admin solo marca con un motivo que el dueño verá.
// Los ids van en el cuerpo y no en la dirección: los modelos llevan "#" en el
// nombre, que en una URL se interpreta como otra cosa.
app.post('/api/productos/eliminar-varios', requireLogin, requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? req.body.ids.map((n) => parseInt(n, 10)).filter(Number.isInteger)
    : [];
  if (ids.length === 0) {
    return res.status(400).json({ error: 'No se indicó qué eliminar' });
  }

  if (req.session.user.rol !== 'dueno') {
    const motivo = String(req.body.motivo || '').trim();
    if (!motivo) {
      return res.status(400).json({ error: 'Debes escribir el motivo de la eliminación (el dueño lo verá)' });
    }
    const r = await pool.query(
      `UPDATE productos SET eliminado = 1, motivo_eliminacion = $1, fecha_eliminacion = NOW(), eliminado_por = $2
       WHERE id = ANY($3::int[]) AND eliminado = 0`,
      [motivo, req.session.user.id, ids]
    );
    return res.json({ eliminados: r.rowCount });
  }

  // Dueño: borrado definitivo. Las ventas históricas no se rompen porque
  // conservan el nombre del producto en texto; solo se suelta la referencia.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE detalle_venta SET producto_id = NULL WHERE producto_id = ANY($1::int[])', [ids]);
    const r = await client.query('DELETE FROM productos WHERE id = ANY($1::int[])', [ids]);
    await client.query('COMMIT');
    res.json({ eliminados: r.rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3001;

init()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`POS corriendo en puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Error al inicializar la base de datos:', err);
    process.exit(1);
  });
