// Nota de venta en blanco (nota-blanco.html). El botón "Hawaki" de la nota de
// venta la abre con ?imprimir=1: el cuadro de impresión sale solo y, al
// terminar, la pestaña se cierra y se vuelve al POS (igual que la nota impresa).

const FILAS_EN_BLANCO = 12;

const tbody = document.getElementById('items-tbody');
for (let i = 0; i < FILAS_EN_BLANCO; i++) {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td></td><td></td><td></td><td></td>';
  tbody.appendChild(tr);
}

document.getElementById('imprimir-btn').addEventListener('click', () => window.print());

(async function () {
  if (new URLSearchParams(window.location.search).get('imprimir') !== '1') return;
  // Se espera a las fuentes: si no, la hoja puede salir con los renglones corridos
  try { await document.fonts.ready; } catch (e) { /* si falla, se imprime igual */ }
  window.addEventListener('afterprint', () => window.close());
  window.print();
})();
