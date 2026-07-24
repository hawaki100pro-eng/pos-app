// Respaldo completo de la base de datos del POS a un archivo JSON local.
//
// Uso:
//   1) Copia la variable DATABASE_PUBLIC_URL desde Railway (servicio Postgres → Variables)
//   2) Pégala en un archivo .env en esta carpeta, así:  DATABASE_URL=postgresql://...
//      (el archivo .env está en .gitignore: nunca se sube a GitHub)
//   3) Ejecuta:  node backup.js
//
// Genera: respaldo-pos-AAAA-MM-DD-HHMM.json en esta misma carpeta.

const fs = require('fs');
const path = require('path');

// Carga DATABASE_URL desde .env si no está en el entorno (sin dependencias extra)
if (!process.env.DATABASE_URL) {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const linea of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = linea.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/);
      if (m) process.env.DATABASE_URL = m[1].trim();
    }
  }
}

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL. Crea un archivo .env con: DATABASE_URL=postgresql://...');
  process.exit(1);
}

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const TABLAS = ['usuarios', 'turnos_caja', 'ventas', 'detalle_venta', 'gastos', 'productos', 'configuracion'];

(async () => {
  const respaldo = { generado: new Date().toISOString(), tablas: {} };
  let totalFilas = 0;

  for (const tabla of TABLAS) {
    const r = await pool.query(`SELECT * FROM ${tabla} ORDER BY 1`);
    respaldo.tablas[tabla] = r.rows;
    totalFilas += r.rowCount;
    console.log(`  ${tabla}: ${r.rowCount} filas`);
  }

  const ahora = new Date();
  const sello = ahora.toISOString().slice(0, 10) + '-' + String(ahora.getHours()).padStart(2, '0') + String(ahora.getMinutes()).padStart(2, '0');
  const archivo = path.join(__dirname, `respaldo-pos-${sello}.json`);
  fs.writeFileSync(archivo, JSON.stringify(respaldo, null, 2), 'utf8');

  console.log(`\nRespaldo completo: ${totalFilas} filas guardadas en ${archivo}`);
  await pool.end();
})().catch((err) => {
  console.error('Error al respaldar:', err.message);
  process.exit(1);
});
