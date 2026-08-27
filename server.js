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
  const turno = await getTurnoAbierto();
  res.json({ turno });
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

app.post('/api/caja/cerrar', requireLogin, requireAdmin, async (req, res) => {
  const turno = await getTurnoAbierto();
  if (!turno) {
    return res.status(400).json({ error: 'No hay un turno de caja abierto' });
  }
  const r = await pool.query(
    `UPDATE turnos_caja SET estado = 'cerrado', fecha_cierre = NOW() WHERE id = $1 RETURNING *`,
    [turno.id]
  );
  res.json(r.rows[0]);
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

app.get('/api/caja/historial', requireLogin, requireAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT t.*, u.usuario AS abierto_por_usuario
    FROM turnos_caja t
    JOIN usuarios u ON u.id = t.abierto_por
    ORDER BY t.id DESC
  `);
  res.json(r.rows);
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

app.post('/api/ventas', requireLogin, async (req, res) => {
  const { cliente, cliente_direccion, cliente_ruc, cliente_telefono, cliente_email, items } = req.body;
  const metodoPago = req.body.metodo_pago === 'transferencia' ? 'transferencia' : 'efectivo';
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

  const turno = await getTurnoAbierto();
  if (!turno) {
    return res.status(400).json({ error: 'No hay caja abierta. Pide al administrador que abra el turno.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const total = items.reduce((acc, i) => acc + i.cantidad * i.precio_unitario, 0);

    const contador = await client.query("SELECT valor FROM configuracion WHERE clave = 'ultimo_numero_proforma'");
    const numeroProforma = parseInt(contador.rows[0].valor, 10) + 1;
    await client.query("UPDATE configuracion SET valor = $1 WHERE clave = 'ultimo_numero_proforma'", [String(numeroProforma)]);

    const ventaResult = await client.query(
      `INSERT INTO ventas (turno_id, usuario_id, cliente, cliente_direccion, cliente_ruc, cliente_telefono, cliente_email, total, numero_proforma, metodo_pago)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [turno.id, req.session.user.id, cliente || null, cliente_direccion || null, ruc || null, cliente_telefono || null, email || null, total, numeroProforma, metodoPago]
    );
    const ventaId = ventaResult.rows[0].id;

    for (const item of items) {
      await client.query(
        'INSERT INTO detalle_venta (venta_id, producto, cantidad, precio_unitario, precio_lista, producto_id) VALUES ($1, $2, $3, $4, $5, $6)',
        // Sin precio de lista se asume que se cobró el de siempre, o sea sin descuento
        [ventaId, item.producto, item.cantidad, item.precio_unitario, item.precio_lista ?? item.precio_unitario, item.producto_id || null]
      );
      if (item.producto_id) {
        const stockR = await client.query('SELECT stock FROM productos WHERE id = $1 FOR UPDATE', [item.producto_id]);
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
    res.status(201).json({ ventaId, total, numero_proforma: formatNumeroProforma(numeroProforma), metodo_pago: metodoPago });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Ventas recientes de todos los vendedores (cualquier vendedor puede reimprimir la proforma de un compañero)
app.get('/api/ventas/recientes', requireLogin, async (req, res) => {
  const r = await pool.query(`
    SELECT v.id, v.cliente, v.fecha, v.total, v.anulada, v.metodo_pago, u.usuario AS vendedor
    FROM ventas v
    JOIN usuarios u ON u.id = v.usuario_id
    WHERE v.eliminada = 0
    ORDER BY v.id DESC
    LIMIT 30
  `);
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
  venta.numero_proforma = formatNumeroProforma(venta.numero_proforma || venta.id);
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
  const turno = await getTurnoAbierto();
  const numVentasR = await pool.query('SELECT COUNT(*) AS c FROM ventas');

  // Lista blanca: solo estos valores llegan a la consulta
  const periodo = ['hoy', '7dias', 'mes', 'todo'].includes(req.query.periodo) ? req.query.periodo : 'hoy';
  const ventasR = await pool.query(`
    SELECT v.id, v.numero_proforma, v.cliente, v.cliente_direccion, v.cliente_ruc, v.cliente_telefono, v.cliente_email,
           v.fecha, v.total, v.metodo_pago, v.anulada, v.fecha_anulacion, v.motivo_anulacion,
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

  let totalTransferenciasTurno = 0;
  if (turno) {
    const r = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS t FROM ventas WHERE turno_id = $1 AND metodo_pago = 'transferencia' AND anulada = 0 AND eliminada = 0`,
      [turno.id]
    );
    totalTransferenciasTurno = r.rows[0].t;
  }

  res.json({ turno, totalTransferenciasTurno, numVentas: parseInt(numVentasR.rows[0].c, 10), periodo, ventas });
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Si la venta era en efectivo y no estaba anulada, su monto seguía contando en la caja: hay que restarlo.
    // Si ya estaba anulada, o era transferencia, la caja nunca tuvo ese monto (o ya se ajustó), no se vuelve a restar.
    if (!venta.anulada && venta.metodo_pago === 'efectivo') {
      await client.query('UPDATE turnos_caja SET monto_actual = monto_actual - $1 WHERE id = $2', [venta.total, venta.turno_id]);
    }
    // Restaurar stock solo si no estaba anulada (si estaba anulada, el stock ya se restauró al anular)
    if (!venta.anulada) {
      const detalleElim = await client.query('SELECT * FROM detalle_venta WHERE venta_id = $1 AND producto_id IS NOT NULL', [venta.id]);
      for (const d of detalleElim.rows) {
        await client.query('UPDATE productos SET stock = stock + $1 WHERE id = $2', [d.cantidad, d.producto_id]);
      }
    }
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

  const nuevoTotal = items.reduce((acc, i) => acc + i.cantidad * i.precio_unitario, 0);
  // El ajuste a la caja depende de cuánto aportaba ANTES (solo si era efectivo) vs cuánto aporta AHORA (solo si sigue siendo efectivo)
  const aportabaCajaAntes = venta.metodo_pago === 'efectivo' ? venta.total : 0;
  const aportaCajaAhora = nuevoMetodoPago === 'efectivo' ? nuevoTotal : 0;
  const diferencia = aportaCajaAhora - aportabaCajaAntes;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE ventas SET cliente = $1, cliente_direccion = $2, cliente_ruc = $3, cliente_telefono = $4, cliente_email = $5, total = $6, metodo_pago = $7 WHERE id = $8`,
      [cliente || null, cliente_direccion || null, ruc || null, cliente_telefono || null, email || null, nuevoTotal, nuevoMetodoPago, venta.id]
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

  // El código de barras son solo dígitos con ceros a la izquierda (000207)
  const esId = /^[0-9]{1,9}$/.test(codigo);
  const r = esId
    ? await pool.query('SELECT * FROM productos WHERE id = $1 AND eliminado = 0', [parseInt(codigo, 10)])
    : await pool.query('SELECT * FROM productos WHERE UPPER(sku) = $1 AND eliminado = 0', [codigo]);

  const p = r.rows[0];
  if (!p) {
    return res.status(404).json({ error: `Ningún producto tiene el código ${codigo}. ¿Es una etiqueta de otra tienda?` });
  }

  const nombre = `${p.modelo} T${p.talla} ${p.color}`;
  if (!p.activo) {
    return res.status(409).json({ error: `${nombre} está desactivado en el inventario. Avisa al administrador.` });
  }
  if (p.stock <= 0) {
    return res.status(409).json({ error: `${nombre} figura agotado en el sistema. Avisa al administrador para que corrija el stock.` });
  }

  res.json(p);
});

app.get('/api/productos/disponibles', requireLogin, async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM productos WHERE activo = 1 AND stock > 0 AND eliminado = 0 ORDER BY modelo, color, talla`
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
  const { modelo, talla, color, precio, stock } = req.body;
  if (!modelo?.trim() || !talla?.trim() || !color?.trim() || precio == null || precio < 0 || stock == null || stock < 0) {
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
    const r = await pool.query(
      'UPDATE productos SET stock = stock + $1, precio = $2, activo = 1 WHERE id = $3 RETURNING *',
      [Math.round(stock), precio, existente.rows[0].id]
    );
    return res.status(200).json({ ...r.rows[0], stock_sumado: Math.round(stock) });
  }

  const r = await pool.query(
    'INSERT INTO productos (modelo, talla, color, precio, stock) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [modelo.trim(), talla.trim(), color.trim(), precio, Math.round(stock)]
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
  const { modelo, talla, color, precio, stock } = req.body;
  if (!modelo?.trim() || !talla?.trim() || !color?.trim() || precio == null || precio < 0 || stock == null || stock < 0) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }

  const actual = await pool.query('SELECT stock FROM productos WHERE id = $1', [req.params.id]);
  if (actual.rowCount === 0) return res.status(404).json({ error: 'Producto no encontrado' });

  // Seguridad: reducir stock es exclusivo del dueño. El admin puede corregir datos y precio,
  // y subir stock, pero nunca bajarlo (esa es la vía típica para desviar mercadería).
  if (Math.round(stock) < actual.rows[0].stock && req.session.user.rol !== 'dueno') {
    return res.status(403).json({ error: 'Reducir el stock solo puede hacerlo el dueño' });
  }

  const r = await pool.query(
    // Si el stock se corrige hacia abajo, las etiquetas impresas no pueden quedar por encima
    'UPDATE productos SET modelo=$1, talla=$2, color=$3, precio=$4, stock=$5, etiquetas_impresas=LEAST(etiquetas_impresas, $5) WHERE id=$6 RETURNING *',
    [modelo.trim(), talla.trim(), color.trim(), precio, Math.round(stock), req.params.id]
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
