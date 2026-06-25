# POS - Punto de venta con proforma libre y caja por turnos

## Stack
- Backend: Node.js + Express
- Base de datos: SQLite (`better-sqlite3`), archivo `pos.db`
- Autenticación: sesiones con cookie (`express-session`) + contraseñas con `bcryptjs`
- Frontend: HTML/CSS/JS plano en `public/`

## Cómo correrlo
```
cd pos-app
node server.js
```
Servidor en `http://localhost:3001`, escucha en `0.0.0.0` (accesible desde otros dispositivos en la misma red local con la IP de la PC, ej. `http://192.168.1.7:3001`).

## Usuarios de prueba
| Usuario | Password | Rol |
|---|---|---|
| admin | admin123 | admin |
| vendedor1 | venta123 | vendedor |

## Modelo de datos
- `usuarios`: id, usuario, password_hash, rol (admin/vendedor), activo
- `turnos_caja`: id, monto_inicial, monto_actual, abierto_por, fecha_apertura, fecha_cierre, estado (abierto/cerrado)
- `ventas`: id, turno_id, usuario_id, cliente, fecha, total
- `detalle_venta`: id, venta_id, producto (texto libre), cantidad, precio_unitario

## Lógica clave
- **Caja por turnos**: el admin abre la caja con un monto inicial (`POST /api/caja/abrir`). Mientras esté abierta, cada venta suma su total a `monto_actual` dentro de una transacción (`db.transaction`). El admin la cierra con `POST /api/caja/cerrar`.
- **Proforma libre**: el vendedor no elige de un catálogo fijo — escribe el nombre del producto, cantidad y precio a cobrar a mano (como una nota de venta). El total se calcula en el servidor, nunca confiando en el del cliente.
- Si no hay caja abierta, `POST /api/ventas` rechaza la venta — el vendedor ve un aviso para que el admin abra turno.
- Cada venta recibe un número de proforma visible (`PRF-000001`, derivado del id) que se muestra al vendedor y en el historial del admin.
- Roles: `requireLogin` y `requireAdmin` son middlewares que protegen rutas. El admin puede crear vendedores nuevos y activar/desactivar usuarios desde el panel.

## Pendiente / próximos pasos
- Reportes por fecha o por vendedor
- Exportar/imprimir la proforma como recibo
- Historial visual de turnos de caja cerrados (el endpoint `GET /api/caja/historial` ya existe, falta UI)

## Notas
- Hay un proyecto hermano más simple en `../todo-app` (to-do list) que se usó para enseñar los mismos conceptos base (CRUD, API REST, SQLite) antes de construir este POS.
