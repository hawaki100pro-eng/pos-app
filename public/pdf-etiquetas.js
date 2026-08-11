/* ============================================================================
   PDF de etiquetas de 40 x 20 mm, en vectores y sin librerías.

   POR QUÉ EXISTE
   Chrome en Android ignora la regla @page{size}. Al imprimir desde el celular,
   todas las hojas salen del tamaño de papel que eligió Android (A4), con la
   etiqueta chiquita en una esquina; después la app de la impresora encoge esa
   hoja entera para meterla en la etiqueta y todo queda ilegible. Aquí cada hoja
   del PDF mide exactamente 40 x 20 mm, así que la app la imprime a tamaño
   completo sin tener que escalar nada.

   POR QUÉ EN VECTORES
   Se dibuja con rectángulos y texto, no con una imagen, para que salga nítido
   en cualquier impresora, sea de 203 o de 300 dpi, sin tener que saber cuál es.

   El texto usa Helvetica y Courier, que toda impresora y todo lector de PDF ya
   traen: así no hay que incrustar tipografías y el archivo pesa unos pocos KB.
   ============================================================================ */

const PT_MM = 72 / 25.4;          // 1 mm en puntos PDF
const ET_ANCHO = 40;              // mm
const ET_ALTO = 20;               // mm
const ET_MARGEN = 1;              // mm

// --- Medición de texto ---------------------------------------------------
// Se mide con el canvas del navegador usando Arial, que tiene exactamente los
// mismos anchos que la Helvetica del PDF. Sirve para recortar lo que no cabe.
const lienzoMedida = document.createElement('canvas').getContext('2d');

function anchoTextoPt(texto, tamPt, negrita) {
  lienzoMedida.font = `${negrita ? 'bold ' : ''}100px Arial, Helvetica, sans-serif`;
  return lienzoMedida.measureText(texto).width * tamPt / 100;
}

// Recorta con puntos suspensivos lo que no entre en el ancho disponible.
function recortarTexto(texto, maxPt, tamPt, negrita) {
  if (anchoTextoPt(texto, tamPt, negrita) <= maxPt) return texto;
  let corto = texto;
  while (corto.length > 1 && anchoTextoPt(corto + '…', tamPt, negrita) > maxPt) {
    corto = corto.slice(0, -1);
  }
  return corto + '…';
}

// --- Texto dentro del PDF ------------------------------------------------
// Las cadenas van en WinAnsi (Latin-1), que cubre las tildes y la ñ. Lo que no
// entre en esa tabla se cambia por su letra sin tilde o por un signo de pregunta.
function aLatin1(texto) {
  return String(texto)
    .normalize('NFC')
    .replace(/…/g, '\x85')
    .split('')
    .map((c) => (c.charCodeAt(0) <= 0xff || c === '\x85'
      ? c
      : (c.normalize('NFD').replace(/[̀-ͯ]/g, '') || '?')))
    .map((c) => (c.charCodeAt(0) <= 0xff ? c : '?'))
    .join('');
}

function escaparPDF(texto) {
  return aLatin1(texto).replace(/[\\()]/g, (c) => '\\' + c);
}

/* --------------------------------------------------------------------------
   Dibujo de una etiqueta.

   El PDF mide desde abajo a la izquierda; la etiqueta se piensa desde arriba a
   la izquierda, como en la pantalla. Estas dos ayudas hacen la conversión para
   no tener que darle vuelta a cada número a mano.
   -------------------------------------------------------------------------- */
const px = (mm) => (mm * PT_MM).toFixed(3);
const py = (mm) => ((ET_ALTO - mm) * PT_MM).toFixed(3);

function rect(xMM, yMM, anchoMM, altoMM) {
  return `${px(xMM)} ${py(yMM + altoMM)} ${(anchoMM * PT_MM).toFixed(3)} ${(altoMM * PT_MM).toFixed(3)} re f\n`;
}

// yMM es la línea base del texto, medida desde arriba.
function texto(xMM, yMM, tamPt, fuente, contenido) {
  return `BT /${fuente} ${tamPt} Tf ${px(xMM)} ${py(yMM)} Td (${escaparPDF(contenido)}) Tj ET\n`;
}

function contenidoEtiqueta(p, sku, codigoBarras) {
  const izq = ET_MARGEN;
  const der = ET_ANCHO - ET_MARGEN;
  const anchoUtil = der - izq;
  let s = '0 g\n'; // todo en negro

  // --- QR: cuadrado de 10 mm arriba a la izquierda ---
  const m = qrMatrix(sku, 'M');
  const n = m.length;
  const zonaMuda = 4;
  const modulos = n + 2 * zonaMuda;
  const lado = 10 / modulos; // mm por módulo
  for (let r = 0; r < n; r++) {
    // Los módulos negros seguidos se juntan en un solo rectángulo: el archivo
    // queda a la mitad de tamaño y el resultado impreso es idéntico.
    let c = 0;
    while (c < n) {
      if (!m[r][c]) { c++; continue; }
      let fin = c;
      while (fin + 1 < n && m[r][fin + 1]) fin++;
      s += rect(
        izq + (c + zonaMuda) * lado,
        ET_MARGEN + (r + zonaMuda) * lado,
        (fin - c + 1) * lado,
        lado
      );
      c = fin + 1;
    }
  }

  // --- Datos, a la derecha del QR ---
  const datosX = izq + 10 + 1.5;
  const datosAncho = (der - datosX) * PT_MM; // en puntos, para medir el texto
  s += texto(datosX, 3.79, 5.4, 'F1', recortarTexto(p.modelo, datosAncho, 5.4, true));
  s += texto(datosX, 6.11, 4.8, 'F2', recortarTexto(`T${p.talla} · ${p.color}`, datosAncho, 4.8, false));
  s += texto(datosX, 8.99, 7, 'F1', `$${Number(p.precio).toFixed(2)}`);

  // --- Código de barras, a todo lo ancho ---
  const { total, barras } = code128Modulos(codigoBarras);
  const porModulo = anchoUtil / total;
  for (const b of barras) {
    s += rect(izq + b.x * porModulo, 11.4, b.w * porModulo, 6);
  }

  // --- Pie: SKU a la izquierda, número del código a la derecha ---
  // En Courier todas las letras miden lo mismo (0.6 em), así que el ancho se
  // calcula contando caracteres, sin tener que medirlo.
  const anchoNumero = codigoBarras.length * 4.2 * 0.6;
  const skuMax = anchoUtil * PT_MM - anchoNumero - PT_MM; // 1 mm de separación
  s += texto(izq, 18.7, 4.2, 'F3', recortarTexto(sku, skuMax, 4.2, false));
  s += texto(der - anchoNumero / PT_MM, 18.7, 4.2, 'F3', codigoBarras);

  return s;
}

/* --------------------------------------------------------------------------
   Armado del archivo PDF.

   Se escribe a mano porque es poco: un catálogo, la lista de hojas, tres
   tipografías y, por cada etiqueta, una hoja y su dibujo. La tabla xref del
   final necesita en qué byte empieza cada objeto, por eso se va midiendo el
   texto conforme se arma.
   -------------------------------------------------------------------------- */
function armarPDF(contenidos) {
  const objetos = [];
  const agregar = (cuerpo) => { objetos.push(cuerpo); return objetos.length; };

  const catalogo = agregar(null);   // se rellena al final, cuando ya hay hojas
  const hojas = agregar(null);
  const f1 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const f2 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f3 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');

  const medio = `[0 0 ${(ET_ANCHO * PT_MM).toFixed(3)} ${(ET_ALTO * PT_MM).toFixed(3)}]`;
  const recursos = `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >>`;
  const idsHojas = [];

  for (const contenido of contenidos) {
    const idHoja = agregar(null);
    const idFlujo = agregar(`<< /Length ${contenido.length} >>\nstream\n${contenido}endstream`);
    objetos[idHoja - 1] = `<< /Type /Page /Parent ${hojas} 0 R /MediaBox ${medio} /Resources ${recursos} /Contents ${idFlujo} 0 R >>`;
    idsHojas.push(idHoja);
  }

  objetos[catalogo - 1] = `<< /Type /Catalog /Pages ${hojas} 0 R >>`;
  objetos[hojas - 1] = `<< /Type /Pages /Kids [${idsHojas.map((i) => `${i} 0 R`).join(' ')}] /Count ${idsHojas.length} >>`;

  let salida = '%PDF-1.4\n';
  const posiciones = [];
  objetos.forEach((cuerpo, i) => {
    posiciones.push(salida.length);
    salida += `${i + 1} 0 obj\n${cuerpo}\nendobj\n`;
  });

  const inicioXref = salida.length;
  salida += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const pos of posiciones) {
    salida += `${String(pos).padStart(10, '0')} 00000 n \n`;
  }
  salida += `trailer\n<< /Size ${objetos.length + 1} /Root ${catalogo} 0 R >>\n`;
  salida += `startxref\n${inicioXref}\n%%EOF\n`;

  // Cada carácter es un byte porque todo el contenido va en Latin-1: por eso
  // las posiciones medidas con .length coinciden con los bytes reales.
  const bytes = new Uint8Array(salida.length);
  for (let i = 0; i < salida.length; i++) bytes[i] = salida.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: 'application/pdf' });
}

// etiquetas: [{ producto, sku, codigoBarras }], una por hoja del PDF.
function pdfEtiquetas(etiquetas) {
  return armarPDF(etiquetas.map((e) => contenidoEtiqueta(e.producto, e.sku, e.codigoBarras)));
}
