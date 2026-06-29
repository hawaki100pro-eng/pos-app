const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      usuario TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL CHECK(rol IN ('admin', 'vendedor')),
      activo INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS turnos_caja (
      id SERIAL PRIMARY KEY,
      monto_inicial REAL NOT NULL,
      monto_actual REAL NOT NULL,
      abierto_por INTEGER NOT NULL REFERENCES usuarios(id),
      fecha_apertura TIMESTAMP NOT NULL DEFAULT NOW(),
      fecha_cierre TIMESTAMP,
      estado TEXT NOT NULL CHECK(estado IN ('abierto', 'cerrado')) DEFAULT 'abierto'
    );

    CREATE TABLE IF NOT EXISTS ventas (
      id SERIAL PRIMARY KEY,
      turno_id INTEGER NOT NULL REFERENCES turnos_caja(id),
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      cliente TEXT,
      cliente_direccion TEXT,
      cliente_ruc TEXT,
      cliente_telefono TEXT,
      fecha TIMESTAMP NOT NULL DEFAULT NOW(),
      total REAL NOT NULL,
      numero_proforma INTEGER,
      anulada INTEGER NOT NULL DEFAULT 0,
      fecha_anulacion TIMESTAMP,
      motivo_anulacion TEXT,
      anulada_por INTEGER REFERENCES usuarios(id)
    );

    CREATE TABLE IF NOT EXISTS detalle_venta (
      id SERIAL PRIMARY KEY,
      venta_id INTEGER NOT NULL REFERENCES ventas(id),
      producto TEXT NOT NULL,
      cantidad REAL NOT NULL,
      precio_unitario REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS configuracion (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );
  `);

  // Migración: agrega el rol 'dueño' (admin + permisos extra de editar/eliminar ventas)
  await pool.query(`
    ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK (rol IN ('admin', 'vendedor', 'dueño'));
  `);

  // Migración: columnas de borrado lógico en ventas (no se borra físicamente, queda oculta pero conservada)
  await pool.query(`
    ALTER TABLE ventas ADD COLUMN IF NOT EXISTS eliminada INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ventas ADD COLUMN IF NOT EXISTS fecha_eliminacion TIMESTAMP;
    ALTER TABLE ventas ADD COLUMN IF NOT EXISTS motivo_eliminacion TEXT;
    ALTER TABLE ventas ADD COLUMN IF NOT EXISTS eliminada_por INTEGER REFERENCES usuarios(id);
  `);

  const contador = await pool.query("SELECT clave FROM configuracion WHERE clave = 'ultimo_numero_proforma'");
  if (contador.rowCount === 0) {
    await pool.query("INSERT INTO configuracion (clave, valor) VALUES ('ultimo_numero_proforma', '7567')");
    console.log('Contador de proformas inicializado en 7567 (próxima proforma: 0007568)');
  }

  const admin = await pool.query('SELECT id FROM usuarios WHERE usuario = $1', ['admin']);
  if (admin.rowCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query('INSERT INTO usuarios (usuario, password_hash, rol) VALUES ($1, $2, $3)', ['admin', hash, 'admin']);
    console.log('Usuario creado -> usuario: admin / password: admin123 (rol: admin)');
  }

  const vendedor = await pool.query('SELECT id FROM usuarios WHERE usuario = $1', ['vendedor1']);
  if (vendedor.rowCount === 0) {
    const hash = bcrypt.hashSync('venta123', 10);
    await pool.query('INSERT INTO usuarios (usuario, password_hash, rol) VALUES ($1, $2, $3)', ['vendedor1', hash, 'vendedor']);
    console.log('Usuario creado -> usuario: vendedor1 / password: venta123 (rol: vendedor)');
  }

  const dueno = await pool.query('SELECT id FROM usuarios WHERE usuario = $1', ['dueno1']);
  if (dueno.rowCount === 0) {
    const hash = bcrypt.hashSync('dueno123', 10);
    await pool.query('INSERT INTO usuarios (usuario, password_hash, rol) VALUES ($1, $2, $3)', ['dueno1', hash, 'dueño']);
    console.log('Usuario creado -> usuario: dueno1 / password: dueno123 (rol: dueño)');
  }
}

module.exports = { pool, init };
