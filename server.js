const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const path = require('path');
const { pool, init } = require('./db');

const app = express();

app.use(express.json());
app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto-en-produccion',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 horas
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

app.delete('/api/gastos/:id', requireLogin, requireAdmin, async (req, res) => {
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
// Body: { cliente, cliente_direccion, cliente_ruc, cliente_telefono, items: [{ producto, cantidad, precio_unitario }] }

function formatNumeroProforma(numero) {
  return String(numero).padStart(7, '0');
}

app.post('/api/ventas', requireLogin, async (req, res) => {
  const { cliente, cliente_direccion, cliente_ruc, cliente_telefono, items } = req.body;
  const metodoPago = req.body.metodo_pago === 'transferencia' ? 'transferencia' : 'efectivo';
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Debes incluir al menos un producto' });
  }
  for (const item of items) {
    if (!item.producto || !item.cantidad || item.cantidad <= 0 || item.precio_unitario == null || item.precio_unitario < 0) {
      return res.status(400).json({ error: 'Cada ítem necesita producto, cantidad > 0 y precio_unitario >= 0' });
    }
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
      `INSERT INTO ventas (turno_id, usuario_id, cliente, cliente_direccion, cliente_ruc, cliente_telefono, total, numero_proforma, metodo_pago)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [turno.id, req.session.user.id, cliente || null, cliente_direccion || null, cliente_ruc || null, cliente_telefono || null, total, numeroProforma, metodoPago]
    );
    const ventaId = ventaResult.rows[0].id;

    for (const item of items) {
      await client.query(
        'INSERT INTO detalle_venta (venta_id, producto, cantidad, precio_unitario, producto_id) VALUES ($1, $2, $3, $4, $5)',
        [ventaId, item.producto, item.cantidad, item.precio_unitario, item.producto_id || null]
      );
      if (item.producto_id) {
        const stockR = await client.query('SELECT stock FROM productos WHERE id = $1 FOR UPDATE', [item.producto_id]);
        if (!stockR.rows[0] || stockR.rows[0].stock < item.cantidad) {
          throw new Error(`Stock insuficiente para "${item.producto}"`);
        }
        await client.query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [item.cantidad, item.producto_id]);
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
  const detalle = await pool.query('SELECT producto, cantidad, precio_unitario FROM detalle_venta WHERE venta_id = $1', [venta.id]);
  venta.detalle = detalle.rows;
  res.json(venta);
});

// --- Dashboard del admin ---

app.get('/api/dashboard', requireLogin, requireAdmin, async (req, res) => {
  const turno = await getTurnoAbierto();
  const numVentasR = await pool.query('SELECT COUNT(*) AS c FROM ventas');
  const ventasR = await pool.query(`
    SELECT v.id, v.numero_proforma, v.cliente, v.cliente_direccion, v.cliente_ruc, v.cliente_telefono,
           v.fecha, v.total, v.metodo_pago, v.anulada, v.fecha_anulacion, v.motivo_anulacion,
           u.usuario AS vendedor, au.usuario AS anulada_por_usuario
    FROM ventas v
    JOIN usuarios u ON u.id = v.usuario_id
    LEFT JOIN usuarios au ON au.id = v.anulada_por
    WHERE v.eliminada = 0
    ORDER BY v.id DESC
    LIMIT 100
  `);

  const ventas = ventasR.rows;
  for (const v of ventas) {
    v.numero_proforma = formatNumeroProforma(v.numero_proforma || v.id);
    const detalle = await pool.query('SELECT producto, cantidad, precio_unitario FROM detalle_venta WHERE venta_id = $1', [v.id]);
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

  res.json({ turno, totalTransferenciasTurno, numVentas: parseInt(numVentasR.rows[0].c, 10), ventas });
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

// --- Eliminación lógica de ventas (solo dueño): oculta del historial pero se conserva en la base de datos ---

app.post('/api/ventas/:id/eliminar', requireLogin, requireDueño, async (req, res) => {
  // El motivo es opcional: si no se indica, se registra uno genérico para conservar el rastro de auditoría
  const motivo = ((req.body && req.body.motivo) || '').trim() || 'Eliminada por el dueño';

  const ventaR = await pool.query('SELECT * FROM ventas WHERE id = $1', [req.params.id]);
  const venta = ventaR.rows[0];
  if (!venta) {
    return res.status(404).json({ error: 'Venta no encontrada' });
  }
  if (venta.eliminada) {
    return res.status(400).json({ error: 'Esta venta ya fue eliminada' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE ventas SET eliminada = 1, fecha_eliminacion = NOW(), motivo_eliminacion = $1, eliminada_por = $2 WHERE id = $3`,
      [motivo.trim(), req.session.user.id, venta.id]
    );
    // Si la venta era en efectivo y no estaba anulada, su monto seguía contando en la caja: hay que restarlo al eliminarla.
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
  const { cliente, cliente_direccion, cliente_ruc, cliente_telefono, items } = req.body;
  const nuevoMetodoPago = req.body.metodo_pago === 'transferencia' ? 'transferencia' : 'efectivo';
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Debes incluir al menos un producto' });
  }
  for (const item of items) {
    if (!item.producto || !item.cantidad || item.cantidad <= 0 || item.precio_unitario == null || item.precio_unitario < 0) {
      return res.status(400).json({ error: 'Cada ítem necesita producto, cantidad > 0 y precio_unitario >= 0' });
    }
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
      `UPDATE ventas SET cliente = $1, cliente_direccion = $2, cliente_ruc = $3, cliente_telefono = $4, total = $5, metodo_pago = $6 WHERE id = $7`,
      [cliente || null, cliente_direccion || null, cliente_ruc || null, cliente_telefono || null, nuevoTotal, nuevoMetodoPago, venta.id]
    );

    await client.query('DELETE FROM detalle_venta WHERE venta_id = $1', [venta.id]);
    for (const item of items) {
      await client.query(
        'INSERT INTO detalle_venta (venta_id, producto, cantidad, precio_unitario) VALUES ($1, $2, $3, $4)',
        [venta.id, item.producto, item.cantidad, item.precio_unitario]
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

app.get('/api/usuarios', requireLogin, requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT id, usuario, rol, activo FROM usuarios ORDER BY id');
  res.json(r.rows);
});

app.post('/api/usuarios', requireLogin, requireAdmin, async (req, res) => {
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

app.post('/api/usuarios/:id/activo', requireLogin, requireAdmin, async (req, res) => {
  const { activo } = req.body;
  await pool.query('UPDATE usuarios SET activo = $1 WHERE id = $2', [activo ? 1 : 0, req.params.id]);
  const r = await pool.query('SELECT id, usuario, rol, activo FROM usuarios WHERE id = $1', [req.params.id]);
  res.json(r.rows[0]);
});

// --- Catálogo / Inventario ---

// Catálogo disponible para vendedores (activo y con stock)
app.get('/api/productos/disponibles', requireLogin, async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM productos WHERE activo = 1 AND stock > 0 ORDER BY modelo, color, talla`
  );
  res.json(r.rows);
});

app.get('/api/productos', requireLogin, requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM productos ORDER BY modelo, color, talla');
  res.json(r.rows);
});

app.post('/api/productos', requireLogin, requireAdmin, async (req, res) => {
  const { modelo, talla, color, precio, stock } = req.body;
  if (!modelo?.trim() || !talla?.trim() || !color?.trim() || precio == null || precio < 0 || stock == null || stock < 0) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }
  const r = await pool.query(
    'INSERT INTO productos (modelo, talla, color, precio, stock) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [modelo.trim(), talla.trim(), color.trim(), precio, Math.round(stock)]
  );
  res.status(201).json(r.rows[0]);
});

app.put('/api/productos/:id', requireLogin, requireAdmin, async (req, res) => {
  const { modelo, talla, color, precio, stock } = req.body;
  if (!modelo?.trim() || !talla?.trim() || !color?.trim() || precio == null || precio < 0 || stock == null || stock < 0) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }
  const r = await pool.query(
    'UPDATE productos SET modelo=$1, talla=$2, color=$3, precio=$4, stock=$5 WHERE id=$6 RETURNING *',
    [modelo.trim(), talla.trim(), color.trim(), precio, Math.round(stock), req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(r.rows[0]);
});

app.post('/api/productos/:id/activo', requireLogin, requireAdmin, async (req, res) => {
  const { activo } = req.body;
  await pool.query('UPDATE productos SET activo=$1 WHERE id=$2', [activo ? 1 : 0, req.params.id]);
  const r = await pool.query('SELECT * FROM productos WHERE id=$1', [req.params.id]);
  res.json(r.rows[0]);
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
