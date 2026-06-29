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

    CREATE TABLE IF NOT EXISTS catalogo (
      id SERIAL PRIMARY KEY,
      codigo TEXT NOT NULL UNIQUE,
      descripcion TEXT NOT NULL,
      precio REAL NOT NULL,
      colores TEXT[] NOT NULL DEFAULT '{}',
      agotado INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Migración: agrega el rol 'dueno' (admin + permisos extra de editar/eliminar ventas)
  // Orden importante: primero se quita la restricción vieja (en su propia transacción,
  // que queda confirmada de inmediato), luego se normalizan filas que hayan quedado con
  // 'dueño' (con tilde, de un intento previo) y solo al final se agrega la restricción nueva.
  // Si se hiciera en otro orden, el UPDATE podría violar la restricción vieja todavía vigente.
  await pool.query(`ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check`);
  await pool.query(`UPDATE usuarios SET rol = 'dueno' WHERE rol = 'dueño'`);
  await pool.query(`ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK (rol IN ('admin', 'vendedor', 'dueno'))`);

  // Migración: columnas de borrado lógico en ventas (no se borra físicamente, queda oculta pero conservada)
  await pool.query(`
    ALTER TABLE ventas ADD COLUMN IF NOT EXISTS eliminada INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ventas ADD COLUMN IF NOT EXISTS fecha_eliminacion TIMESTAMP;
    ALTER TABLE ventas ADD COLUMN IF NOT EXISTS motivo_eliminacion TEXT;
    ALTER TABLE ventas ADD COLUMN IF NOT EXISTS eliminada_por INTEGER REFERENCES usuarios(id);
  `);

  // Migración: descuento porcentual aplicado a la venta (usado por "Pedido grande")
  await pool.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS descuento_pct REAL NOT NULL DEFAULT 0`);

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
    await pool.query('INSERT INTO usuarios (usuario, password_hash, rol) VALUES ($1, $2, $3)', ['dueno1', hash, 'dueno']);
    console.log('Usuario creado -> usuario: dueno1 / password: dueno123 (rol: dueño)');
  }

  const catalogoCount = await pool.query('SELECT COUNT(*) AS c FROM catalogo');
  if (parseInt(catalogoCount.rows[0].c, 10) === 0) {
    const insertCat = pool.query.bind(pool, 'INSERT INTO catalogo (codigo, descripcion, precio, colores, agotado) VALUES ($1, $2, $3, $4, $5)');
    for (const p of CATALOGO_INICIAL) {
      await insertCat([p.codigo, p.desc, p.precio, p.colores, p.agotado ? 1 : 0]);
    }
    console.log(`Catálogo precargado con ${CATALOGO_INICIAL.length} modelos`);
  }
}

const CATALOGO_INICIAL = [
  { codigo:"1021",    desc:"DOC. 1021",      precio:39, colores:["P.Rosa","Lila","Negro","Verde"] },
  { codigo:"1025M",   desc:"DOC. 1025 M",    precio:38, colores:["Menta","Lila","Rosa","Fucsia"] },
  { codigo:"856Y2",   desc:"DOC. 856Y2",     precio:33, colores:["Rosa","Lila","Negro","Fucsia"] },
  { codigo:"885M9",   desc:"DOC. 885 M9",    precio:42, colores:["Lila","Rosa","Turqueza","Fucsia"], agotado:true },
  { codigo:"885M7",   desc:"DOC. 885 M7",    precio:42, colores:["Lila","Rosa","Turqueza","Fucsia"], agotado:true },
  { codigo:"1003",    desc:"DOC. 1003",      precio:42, colores:["Morado","P.Rosa","Fucsia","Rosa","Turqueza"] },
  { codigo:"1016",    desc:"DOC. 1016",      precio:40, colores:["Lila","Rosa","Negro","Kaki","Azul Electrico","Azul Oscuro","Beige"] },
  { codigo:"1002Y",   desc:"DOC. 1002 Y",    precio:39, colores:["Fucsia","Lila","Turqueza","Rosa","P.Rosa"] },
  { codigo:"916M",    desc:"DOC. 916 M",     precio:38, colores:["Rosa","Lila","Fucsia","Turqueza"], agotado:true },
  { codigo:"1022",    desc:"DOC. 1022",      precio:42, colores:["Rosa","Lila"], agotado:true },
  { codigo:"10222",   desc:"DOC. 1022 2",    precio:42, colores:["Lila","Kaki"], agotado:true },
  { codigo:"10226",   desc:"DOC. 1022 6",    precio:39, colores:["Negro","Plomo","Azul Oscuro","Azul Electrico"] },
  { codigo:"1025",    desc:"DOC. 1025",      precio:38, colores:["Azul Oscuro","Negro","Beige","Azul Electrico"] },
  { codigo:"916H",    desc:"DOC. 916 H",     precio:38, colores:["Negro","Rojo","Azul","Azul Electrico"], agotado:true },
  { codigo:"885C3",   desc:"DOC. 885 C3",    precio:42, colores:["Azul Electrico","Negro","Plomo","Rojo Negro"], agotado:true },
  { codigo:"890B5",   desc:"DOC. 890 B5",    precio:38, colores:["Negro","Azul","Azul Electrico","Plomo","Rojo"] },
  { codigo:"1002B",   desc:"DOC. 1002 B",    precio:39, colores:["Rojo","Negro","Azul Electrico","Azul Oscuro"] },
  { codigo:"1003B",   desc:"DOC. 1003 B",    precio:42, colores:["Rojo","Negro","Azul Electrico","Azul Oscuro"] },
  { codigo:"856W6",   desc:"DOC. 856 W6",    precio:38, colores:["Rojo","Negro","Azul Electrico","Azul Oscuro"] },
  { codigo:"1022-1",  desc:"DOC. 1022 1",    precio:42, colores:["Celeste","Rosa"], agotado:true },
  { codigo:"1030Y",   desc:"DOC. 1030 Y",    precio:38, colores:["Fucsia","Rosado","Menta","Celeste"] },
  { codigo:"10223",   desc:"DOC. 1022 3",    precio:42, colores:["Kaki","Rosa"], agotado:true },
  { codigo:"915B6",   desc:"DOC. 915 B6",    precio:40, colores:["Lila","Beige","Menta","Turquesa","Rosa"] },
  { codigo:"1003S",   desc:"DOC. 1003 S",    precio:43, colores:["Coral","Menta","Lila","Rosa"] },
  { codigo:"915B",    desc:"DOC. 915 B",     precio:40, colores:["Lila","Beige","Amarillo","Rosa","Menta"] },
  { codigo:"915B1",   desc:"DOC. 915 B1",    precio:40, colores:["Lila","Beige","Menta","Verde","Rosa"] },
  { codigo:"912-1",   desc:"DOC. 912-1",     precio:42, colores:["Rosa","Lila","Turqueza","P.Rosa","Fucsia","Morado"] },
  { codigo:"915B2",   desc:"DOC. 915 B2",    precio:40, colores:["Lila","Rosa","Beige","Turqueza"] },
  { codigo:"1017S",   desc:"DOC. 1017 S",    precio:39, colores:["Lila/Morado","Blanco/Fucsia","Turqueza","Fucsia"] },
  { codigo:"1002S",   desc:"DOC. 1002 S",    precio:42, colores:["Lila","Rosa","P.Rosa","Fucsia","Turqueza"] },
  { codigo:"1010Y",   desc:"DOC. 1010 Y",    precio:37, colores:["Lila","Rosa","Fucsia","Verde Limon","Menta"], agotado:true },
  { codigo:"1010Y1",  desc:"DOC. 1010 Y1",   precio:40, colores:["Lila","Rosa","Fucsia","Celeste"], agotado:true },
  { codigo:"1018",    desc:"DOC. 1018",      precio:36, colores:["Blanco","Rosa","Azul","Lila"], agotado:true },
  { codigo:"890S",    desc:"DOC. 890 S",     precio:40, colores:["Rosa","Fucsia","Lila","Menta"] },
  { codigo:"1005",    desc:"DOC. 1005",      precio:40, colores:["Rosa","Lila","Turqueza","Fucsia"], agotado:true },
  { codigo:"915B3",   desc:"DOC. 915 B3",    precio:39, colores:["Lila","Fucsia","Rosa","Verde"] },
  { codigo:"1002C",   desc:"DOC. 1002 C",    precio:42, colores:["Negro","Rojo","Azul Electrico","Azul Oscuro"] },
  { codigo:"919-1",   desc:"DOC. 919-1",     precio:58, colores:["Azul","Negro","Verde","Plomo"], agotado:true },
  { codigo:"1010B1",  desc:"DOC. 1010 B1",   precio:40, colores:["Negro","Verde","Plomo","Azul","Azul Electrico"], agotado:true },
  { codigo:"856D7",   desc:"DOC. 856 D7",    precio:42, colores:["Negro","Azul Oscuro","Azul Electrico","Rojo"] },
  { codigo:"912B",    desc:"DOC. 912 B",     precio:42, colores:["Rojo","Verde","Azul Oscuro","Azul Electrico","Negro"] },
  { codigo:"915B5",   desc:"DOC. 915 B5",    precio:40, colores:["Negro","Azul","Azul Oscuro","Blanco"] },
  { codigo:"915B-1",  desc:"DOC. 915 B1",    precio:40, colores:["Beige","Verde","Lila","Rosa","Menta"] },
  { codigo:"890C",    desc:"DOC. 890 C",     precio:40, colores:["Negro","Azul Oscuro","Azul Electrico","Rojo"] },
  { codigo:"885P2",   desc:"DOC. 885 P2",    precio:43, colores:["Negro","Rojo","Plomo","Azul","Azul Electrico"], agotado:true },
  { codigo:"1017B",   desc:"DOC. 1017 B",    precio:39, colores:["Azul Oscuro","Azul Electrico","Negro","Negro/Blanco"] },
  { codigo:"1030B",   desc:"DOC. 1030 B",    precio:38, colores:["Plomo","Azul Electrico","Azul Oscuro","Negro"] },
  { codigo:"919S1",   desc:"DOC. 919 S1",    precio:59, colores:["Lila","Rosa","Turqueza","Fucsia"], agotado:true },
  { codigo:"1027S",   desc:"DOC. 1027 S",    precio:40, colores:["Negro","Cafe","Lila","Rosa"] },
  { codigo:"1030S",   desc:"DOC. 1030 S",    precio:40, colores:["Fucsia","Rosa","Lila","Menta"] },
  { codigo:"1017S-2", desc:"DOC. 1017 S",    precio:40, colores:["Negro","Blanco","Rosa","Lila"] },
  { codigo:"915D2",   desc:"DOC. 915 D2",    precio:42, colores:["Turqueza","Rosa","Beige","Blanco","Lila"] },
  { codigo:"10232",   desc:"DOC. 1023 2",    precio:43, colores:["Morado","Kaki","Rosa"], agotado:true },
  { codigo:"915D6",   desc:"DOC. 915 D6",    precio:42, colores:["Lila","Beige","Menta","Turquesa","Rosa"] },
  { codigo:"10233",   desc:"DOC. 1023 3",    precio:43, colores:["Celeste","Rosa"], agotado:true },
  { codigo:"10231",   desc:"DOC. 1023 1",    precio:43, colores:["Lila","Rosa"], agotado:true },
  { codigo:"1023",    desc:"DOC. 1023",      precio:43, colores:["Lila","Rosa"], agotado:true },
  { codigo:"1002",    desc:"DOC. 1002",      precio:43, colores:["Lila","Rosa","Fucsia","P.Rosa"] },
  { codigo:"856K",    desc:"DOC. 856 K",     precio:35, colores:["Fucsia","Negro","Rosa","Lila"] },
  { codigo:"915D",    desc:"DOC. 915 D",     precio:42, colores:["Amarillo","Verde","Lila","Rosa","Beige"] },
  { codigo:"915D1",   desc:"DOC. 915 D1",    precio:42, colores:["Rosa","Lila","Turqueza","Beige","Verde"] },
  { codigo:"1007",    desc:"DOC. 1007",      precio:40, colores:["Negro","Fucsia","Rosa","Turqueza","Verde","Lila"], agotado:true },
  { codigo:"1018S",   desc:"DOC. 1018 S",    precio:38, colores:["Azul","Rosa","Blanco","Lila"], agotado:true },
  { codigo:"1027C",   desc:"DOC. 1027 C",    precio:40, colores:["Negro","Kaki","Azul Oscuro","Azul Electrico"] },
  { codigo:"915D5",   desc:"DOC. 915 D5",    precio:42, colores:["Negro","Beige","Azul","Azul Oscuro"] },
  { codigo:"10236",   desc:"DOC. 1023 6",    precio:43, colores:["Negro","Plomo","Azul Oscuro","Azul Electrico"] },
  { codigo:"1010C1",  desc:"DOC. 1010 C1",   precio:42, colores:["Negro","Verde","Plomo","Azul Marino","Azul Electrico"], agotado:true },
  { codigo:"1010C",   desc:"DOC. 1010 C",    precio:38, colores:["Negro","Azul","Azul Electrico","Plomo"], agotado:true },
  { codigo:"1030C",   desc:"DOC. 1030 C",    precio:40, colores:["Plomo","Negro","Azul Electrico","Azul Oscuro"] },
  { codigo:"1028M",   desc:"DOC. 1028 M",    precio:47, colores:["Rosa","Fucsia","Lila","Negro"] },
  { codigo:"V132",    desc:"DOC. V 132",     precio:48, colores:["Negro","Beige","Rosa","Kaki"] },
  { codigo:"E136",    desc:"DOC. E 136",     precio:46, colores:["Negro","Beige","Kaki"] },
  { codigo:"E888",    desc:"DOC. E 888",     precio:48, colores:["Negro","Beige","Rosa","Rosa/Lila"], agotado:true },
  { codigo:"V131M",   desc:"DOC. V 131 M",   precio:46, colores:["Fucsia","Negro","Rosa","Lila","Celeste"] },
  { codigo:"V139",    desc:"DOC. V 139",     precio:47, colores:["Negro","Beige","Rosa","Lila","Blanco"] },
  { codigo:"1027M",   desc:"DOC. 1027 M",    precio:42, colores:["Lila","Rosa","Cafe","Negro"] },
  { codigo:"V138",    desc:"DOC. V 138",     precio:46, colores:["Negro","Beige","Rosa","Lila"] },
  { codigo:"V137",    desc:"DOC. V 137",     precio:40, colores:["Cafe Oscuro","Cafe Claro","Beige Oscuro","Beige Claro"] },
  { codigo:"V137M",   desc:"DOC. V 137 M",   precio:40, colores:["Negro","Rosa","Beige","Celeste"] },
  { codigo:"915M9",   desc:"DOC. 915 M9",    precio:46, colores:["Blanco","Fucsia","P.Rosa","Beige","Rosa"] },
  { codigo:"1019",    desc:"DOC. 1019",      precio:50, colores:["Negro","Beige","Rosa","Rosa/Lila"] },
  { codigo:"612M1",   desc:"DOC. 612 M1",    precio:46, colores:["Fucsia","Rosa","Menta","Lila","Negro","Blanca"] },
  { codigo:"1002M",   desc:"DOC. 1002 M",    precio:45, colores:["Turqueza","Lila","Negro","P.Rosa","Rosa"] },
  { codigo:"V129",    desc:"DOC. V 129",     precio:45, colores:["Negro","P.Rosa","Lila","Beige"] },
  { codigo:"851M",    desc:"DOC. 851 M",     precio:40, colores:["Blanca","Negra"] },
  { codigo:"V127",    desc:"DOC. V 127",     precio:32, colores:["Beige","P.Rosa","Negro"] },
  { codigo:"V130",    desc:"DOC. V 130",     precio:42, colores:["Rosa","Beige","Lila","Negro"], agotado:true },
  { codigo:"1008",    desc:"DOC. 1008",      precio:45, colores:["Rosa","Menta","Lila","Negra"], agotado:true },
  { codigo:"V128",    desc:"DOC. V 128",     precio:42, colores:["Beige","Verde","Lila","Negra"], agotado:true },
  { codigo:"V126",    desc:"DOC. V 126",     precio:46, colores:["P.Rosa","Verde","Negro","Lila"], agotado:true },
  { codigo:"1013",    desc:"DOC. 1013",      precio:45, colores:["Beige","Lila","Negro","Rosa","P.Rosa"] },
  { codigo:"915",     desc:"DOC. 915",       precio:40, colores:["Negro","Beige","Verde","Kaki"] },
  { codigo:"915M6",   desc:"DOC. 915 M6",    precio:46, colores:["Turquesa","Rosa","Negro","Blanco","Lila"] },
  { codigo:"915M2",   desc:"DOC. 915 M2",    precio:46, colores:["Beige","Lila","Turquesa","Rosa","Verde"] },
  { codigo:"915M3",   desc:"DOC. 915 M3",    precio:46, colores:["Amarillo","Rosa","Lila","Beige","Verde"] },
  { codigo:"612M",    desc:"DOC. 612 M",     precio:40, colores:["Negro","P.Rosa","Rosa","Lila"], agotado:true },
  { codigo:"912M",    desc:"DOC. 912 M",     precio:43, colores:["Negro","Fucsia","P.Rosa","Turqueza","Rosa","Verde"], agotado:true },
  { codigo:"915M7",   desc:"DOC. 915 M7",    precio:46, colores:["Negra","Lila","Blanca","Rosa"], agotado:true },
  { codigo:"915M1",   desc:"DOC. 915 M1",    precio:46, colores:["Cafe","Rosa","Verde Neon","Lila"], agotado:true },
  { codigo:"1015M",   desc:"DOC. 1015 M",    precio:40, colores:["Negro","P.Rosa","Beige"], agotado:true },
  { codigo:"1028",    desc:"DOC. 1028",      precio:48, colores:["Verde","Azul","Negro"] },
  { codigo:"915C2",   desc:"DOC. 915 C2",    precio:46, colores:["Negra","Ploma","Azul"] },
  { codigo:"915C3",   desc:"DOC. 915 C3",    precio:46, colores:["Negra","Ploma","Azul"] },
  { codigo:"905",     desc:"DOC. 905",       precio:46, colores:["Verde","Plomo","Azul","Negro"], agotado:true },
  { codigo:"890H",    desc:"DOC. 890 H",     precio:46, colores:["Azul","Plomo","Negro"] },
  { codigo:"131H",    desc:"DOC. 131 H",     precio:46, colores:["Beige","Azul","Negro","Plomo"] },
  { codigo:"1027H",   desc:"DOC. 1027 H",    precio:42, colores:["Kaki","Negro","Plomo","Azul"] },
  { codigo:"1028H",   desc:"DOC. 1028 H",    precio:48, colores:["Plomo","Azul","Kaki","Negro"] },
  { codigo:"915H6",   desc:"DOC. 915 H6",    precio:48, colores:["Plomo","Negro","Blanco","Azul"] },
  { codigo:"856N8",   desc:"DOC. 856 N8",    precio:49, colores:["Plomo","Negro","Blanco","Azul"] },
  { codigo:"915H2",   desc:"DOC. 915 H2",    precio:48, colores:["Plomo","Negro","Blanco","Azul","Beige"] },
  { codigo:"V1032",   desc:"DOC. V 1032",    precio:45, colores:["Negro","Negro/Blanco","Blanco/Negro","Beige","Azul"] },
  { codigo:"V133",    desc:"DOC. V 133",     precio:40, colores:["Kaki","Negro","Plomo","Azul"] },
  { codigo:"610",     desc:"DOC. 610",       precio:46, colores:["Negro","Plomo","Azul","Verde"] },
  { codigo:"915H1",   desc:"DOC. 915 H1",    precio:48, colores:["Plomo","Negro","Blanco","Azul"] },
  { codigo:"1020",    desc:"DOC. 1020",      precio:53, colores:["Plomo","Negro","Blanco","Azul"] },
  { codigo:"915H",    desc:"DOC. 915 H",     precio:46, colores:["Negro","Kaki","Beige","Verde"] },
  { codigo:"852H",    desc:"DOC. 852 H",     precio:39, colores:["Negra","Blanca"] },
  { codigo:"915H9",   desc:"DOC. 915 H9",    precio:48, colores:["Negro","Verde","Kaki","Beige"] },
  { codigo:"1006",    desc:"DOC. 1006",      precio:46, colores:["Plomo","Negro","Verde","Azul"] },
  { codigo:"851H",    desc:"DOC. 851 H",     precio:40, colores:["Blanca","Negra"] },
  { codigo:"872",     desc:"DOC. 872",       precio:48, colores:["Negro","Azul","Plomo"] },
  { codigo:"V131",    desc:"DOC. V 131",     precio:48, colores:["Plomo","Beige","Azul","Negro"] },
  { codigo:"1033",    desc:"DOC. 1033",      precio:43, colores:["Plomo","Azul","Negro","Kaki","Beige"] },
  { codigo:"915H8",   desc:"DOC. 915 H8",    precio:48, colores:["Beige","Amarillo","Verde"] },
  { codigo:"852M",    desc:"DOC. 852 M",     precio:38, colores:["Negro","Blanco"] },
];

module.exports = { pool, init };
