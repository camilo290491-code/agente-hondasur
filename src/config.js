// config.js — Datos del negocio. EDITA AQUÍ tus precios, horarios y promos.

export const NEGOCIO = {
  nombre: "HondaSur Motos y Repuestos",
  ubicacion: "Caldas, Antioquia",
  direccion: "Cra 50 #125 Sur-104, Caldas, Antioquia",
  contactoAsesor: "573156713630",
};

// ─────────────────────────────────────────────────────────────
// HORARIO DE ATENCIÓN — formato 24h (decimal para medias horas)
//   9 = 9:00am | 17 = 5:00pm | 17.5 = 5:30pm | 13 = 1:00pm | null = cerrado
//   Días: 0=domingo 1=lunes 2=martes 3=miércoles 4=jueves 5=viernes 6=sábado
// ─────────────────────────────────────────────────────────────
export const HORARIO = {
  0: null,                        // Domingo: cerrado
  1: { abre: 9, cierra: 17.5 },   // Lunes:     9:00am - 5:30pm
  2: { abre: 9, cierra: 17.5 },   // Martes:    9:00am - 5:30pm
  3: { abre: 9, cierra: 17.5 },   // Miércoles: 9:00am - 5:30pm
  4: { abre: 9, cierra: 17.5 },   // Jueves:    9:00am - 5:30pm
  5: { abre: 9, cierra: 17 },     // Viernes:   9:00am - 5:00pm
  6: { abre: 9, cierra: 13 },     // Sábado:    9:00am - 1:00pm
};
// NOTA: Los festivos colombianos NO se detectan automáticamente. En un festivo
// el agente creerá que está abierto según el día. Si quieres, agregamos la lista.

// ─────────────────────────────────────────────────────────────
// MODELOS Y PRECIOS
//   uso: "trabajo" | "ciudad" | "carretera" | "mixto"
//   promo: OPCIONAL. "" si no hay.
//   descuento: descuento del mes EN PESOS (número). 0 = sin descuento.
//              Ej: descuento: 500000 → el agente muestra $500.000 de ahorro.
// ─────────────────────────────────────────────────────────────
export const MODELOS = [
  { modelo: "XR190L 2,0",              precioLista:  13900000, papeles:   780000, total:  14680000, uso: "mixto",    promo: "", descuento: 0 },
  { modelo: "XR150 L 2,0",             precioLista:  10990000, papeles:   730000, total:  11720000, uso: "mixto",    promo: "", descuento: 0 },
  { modelo: "XR300L TORNADO",          precioLista:  30490000, papeles:  1372000, total:  31862000, uso: "mixto",    promo: "", descuento: 0 },
  { modelo: "CB300F",                  precioLista:  16800000, papeles:  1300000, total:  18100000, uso: "ciudad",   promo: "", descuento: 0 },
  { modelo: "CB100 2,0",               precioLista:   5700000, papeles:   510000, total:   6210000, uso: "trabajo",  promo: "", descuento: 0 },
  { modelo: "CB125F 2,0",              precioLista:   7090000, papeles:   600000, total:   7690000, uso: "trabajo",  promo: "", descuento: 0 },
  { modelo: "CB125F 2,0 DLX 2,0",      precioLista:   7250000, papeles:   600000, total:   7850000, uso: "trabajo",  promo: "", descuento: 0 },
  { modelo: "CB125F DLX 2,0 MAX",      precioLista:   7300000, papeles:   600000, total:   7900000, uso: "trabajo",  promo: "", descuento: 0 },
  { modelo: "XBLADE 160",              precioLista:  10290000, papeles:   760000, total:  11050000, uso: "ciudad",   promo: "", descuento: 200000 },
  { modelo: "CB190 2,0 2CH",           precioLista:  12790000, papeles:   760000, total:  13550000, uso: "mixto",    promo: "", descuento: 0 },
  { modelo: "NX190 2CH",               precioLista:  14690000, papeles:   800000, total:  15490000, uso: "mixto",    promo: "", descuento: 0 },
  { modelo: "DIO SRD 110",             precioLista:   7790000, papeles:   600000, total:   8390000, uso: "ciudad",   promo: "", descuento: 0 },
  { modelo: "DIO DLX",                 precioLista:   7940000, papeles:   600000, total:   8540000, uso: "ciudad",   promo: "", descuento: 0 },
  { modelo: "PCX160 ABS",              precioLista:  14800000, papeles:   850000, total:  15650000, uso: "ciudad",   promo: "", descuento: 0 },
  { modelo: "NAVI 2,0",                precioLista:   7290000, papeles:   600000, total:   7890000, uso: "ciudad",   promo: "", descuento: 0 },
  { modelo: "NAVI MIX 2,0",            precioLista:   7590000, papeles:   600000, total:   8190000, uso: "ciudad",   promo: "", descuento: 0 },
  { modelo: "NAVI ADVENTURE 2,0",      precioLista:   7640000, papeles:   600000, total:   8240000, uso: "ciudad",   promo: "", descuento: 0 },
  { modelo: "WAVE 110S CBS",           precioLista:   7790000, papeles:   600000, total:   8390000, uso: "ciudad",   promo: "", descuento: 0 },
];

// Promoción general del mes (aplica a todos). "" si no hay.
export const PROMO_GENERAL = "";

// ─────────────────────────────────────────────────────────────
// CAMPAÑA DEL MES (volantes con código de bono en accesorios)
//
// Cuando el cliente MENCIONA la campaña/volante y pide su código, el agente:
//   1. Le pide datos (nombre + cédula) y en qué moto está interesado
//   2. Le da el CODIGO del bono
//   3. Le recuerda seguir a HondaSur en Instagram para hacerlo efectivo
//   4. Guarda los datos y avisa al asesor para seguimiento
//
// Para activar/desactivar cada mes, edita estos valores:
// ─────────────────────────────────────────────────────────────
export const CAMPANA = {
  activa: true,                          // true = campaña en curso; false = apagada
  codigo: "ACCEAGOSTO2026",            // el código fijo del mes
  bonoValor: 300000,                           // monto del bono en pesos (ej: 100000)
  instagram: "@honda_sur_motos",            // usuario de Instagram a seguir
  nombreCampana: "campaña de agosto",     // cómo la llama el agente
};

// Número del asesor para recibir avisos de leads calientes.
export const NOTIFICAR_A = process.env.WHATSAPP_ASESOR || "573156713630";

// ═════════════════════════════════════════════════════════════
// LÓGICA DE HORARIO — no necesitas tocar nada de aquí para abajo
// ═════════════════════════════════════════════════════════════

const DIAS = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];

function formatoHora(h) {
  const horas = Math.floor(h);
  const mins = Math.round((h - horas) * 60);
  const ampm = horas >= 12 ? "pm" : "am";
  let h12 = horas % 12;
  if (h12 === 0) h12 = 12;
  return mins === 0 ? `${h12}:00${ampm}` : `${h12}:${String(mins).padStart(2,"0")}${ampm}`;
}

function ahoraColombia(date = new Date()) {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc - 5 * 3600000);
}

export function enHorario(date = new Date()) {
  const col = ahoraColombia(date);
  const franja = HORARIO[col.getDay()];
  if (!franja) return false;
  const horaActual = col.getHours() + col.getMinutes() / 60;
  return horaActual >= franja.abre && horaActual < franja.cierra;
}

export function horarioTexto() {
  const grupos = [];
  for (let d = 1; d <= 6; d++) {
    const f = HORARIO[d];
    if (!f) continue;
    const clave = `${f.abre}-${f.cierra}`;
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.clave === clave && ultimo.fin === d - 1) {
      ultimo.fin = d;
    } else {
      grupos.push({ clave, inicio: d, fin: d, f });
    }
  }
  const partes = grupos.map((g) => {
    const rango = g.inicio === g.fin ? DIAS[g.inicio] : `${DIAS[g.inicio]} a ${DIAS[g.fin]}`;
    return `${rango} de ${formatoHora(g.f.abre)} a ${formatoHora(g.f.cierra)}`;
  });
  const cerrados = [0,1,2,3,4,5,6].filter((d) => !HORARIO[d]);
  let txt = partes.join("; ");
  if (cerrados.length) txt += `. Cerrado ${cerrados.map((d) => DIAS[d]).join(" y ")}`;
  return txt;
}

export function proximaApertura(date = new Date()) {
  const col = ahoraColombia(date);
  const hoy = col.getDay();
  const horaActual = col.getHours() + col.getMinutes() / 60;
  const franjaHoy = HORARIO[hoy];
  if (franjaHoy && horaActual < franjaHoy.abre) {
    return `hoy a las ${formatoHora(franjaHoy.abre)}`;
  }
  for (let i = 1; i <= 7; i++) {
    const d = (hoy + i) % 7;
    const f = HORARIO[d];
    if (f) {
      const cuando = i === 1 ? "mañana" : `el ${DIAS[d]}`;
      return `${cuando} a las ${formatoHora(f.abre)}`;
    }
  }
  return "en nuestro próximo horario de atención";
}
