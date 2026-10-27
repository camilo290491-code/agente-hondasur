// clasificar.js — Clasifica cada conversación en VENTAS / TALLER / CARTERA.
// La etiqueta vive en conversaciones.categoria (base del agente) y el Centro
// de Chats la usa para separar las bandejas.
//
// Reglas (en orden de prioridad):
//  1. CARTERA: el teléfono pertenece a un cliente con crédito ACTIVO en CarteraNet.
//  2. TALLER:  el teléfono tiene citas o servicios registrados en TallerNet.
//  3. (si no aplica ninguna, se deja en blanco y el panel la muestra como Ventas
//     según el contenido de la conversación, como hasta ahora)
//
// El equipo puede corregir la etiqueta a mano desde el Centro de Chats; una
// etiqueta puesta a mano lleva categoria_manual=true y aquí NUNCA se pisa.

import { createClient } from "@supabase/supabase-js";

const agente =
  process.env.SUPABASE_URL && process.env.SUPABASE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;
const cartera =
  process.env.CARTERA_URL && process.env.CARTERA_SERVICE_KEY
    ? createClient(process.env.CARTERA_URL, process.env.CARTERA_SERVICE_KEY)
    : null;
const taller =
  process.env.TALLERNET_URL && process.env.TALLERNET_SERVICE_KEY
    ? createClient(process.env.TALLERNET_URL, process.env.TALLERNET_SERVICE_KEY)
    : null;

if (!agente) console.warn("[clasificar] Sin SUPABASE_URL / SUPABASE_KEY: clasificación apagada.");

// Un teléfono puede venir como 573001234567, 3001234567 o con espacios.
// Devuelve las variantes a comparar.
async function paginado(cli, tabla, columnas, aplicarFiltro) {
  let out = [];
  for (let desde = 0; ; desde += 1000) {
    let q = cli.from(tabla).select(columnas).range(desde, desde + 999);
    if (aplicarFiltro) q = aplicarFiltro(q);
    const { data, error } = await q;
    if (error) { console.error("[clasificar] " + tabla + ":", error.message); break; }
    out = out.concat(data || []);
    if (!data || data.length < 1000) break;
  }
  return out;
}

function variantes(t) {
  const d = String(t || "").replace(/\D/g, "");
  const v = new Set();
  if (d) v.add(d);
  if (d.length === 12 && d.startsWith("57")) v.add(d.slice(2));
  if (d.length === 10 && d.startsWith("3")) v.add("57" + d);
  return [...v];
}

let clasificando = false;
export async function clasificarConversaciones() {
  if (!agente || clasificando) return;
  clasificando = true;
  try {
    // Conversaciones sin etiqueta o sin nombre
    const { data: convs, error } = await agente
      .from("conversaciones")
      .select("telefono, categoria, categoria_manual, nombre")
      .or("categoria.is.null,nombre.is.null")
      .limit(300);
    if (error) { console.error("[clasificar] error leyendo conversaciones:", error.message); return; }
    const pendientes = (convs || []).filter(
      (c) => !c.categoria_manual && c.telefono && !String(c.telefono).startsWith("ig:")
    );
    if (!pendientes.length) return;

    // Teléfonos (y nombres) de clientes de CARTERA (créditos activos)
    let telsCartera = new Set();
    const nombres = {}; // tel normalizado -> nombre
    const anotar = (tel, nom) => { if (nom) variantes(tel).forEach((t) => { if (!nombres[t]) nombres[t] = String(nom).trim(); }); };
    if (cartera) {
      const data = await paginado(cartera, "creditos", "telefono, cliente", (q) => q.eq("estado", "ACTIVO"));
      data.forEach((r) => { variantes(r.telefono).forEach((t) => telsCartera.add(t)); anotar(r.telefono, r.cliente); });
    }
    // Teléfonos (y nombres) con historia en el TALLER (citas o servicios)
    let telsTaller = new Set();
    if (taller) {
      const [c1, c2] = await Promise.all([
        paginado(taller, "citas", "telefono, cliente", (q) => q.not("telefono", "is", null)),
        paginado(taller, "registros", "telefono, cliente", (q) => q.not("telefono", "is", null)),
      ]);
      [...c1, ...c2].forEach((r) => { variantes(r.telefono).forEach((t) => telsTaller.add(t)); anotar(r.telefono, r.cliente); });
    }

    let n = 0;
    for (const c of pendientes) {
      const vs = variantes(c.telefono);
      let cat = null;
      if (vs.some((t) => telsCartera.has(t))) cat = "cartera";
      else if (vs.some((t) => telsTaller.has(t))) cat = "taller";
      const nom = vs.map((t) => nombres[t]).find(Boolean) || null;
      const cambios = {};
      if (cat && !c.categoria) cambios.categoria = cat;
      if (nom && !c.nombre) cambios.nombre = nom;
      if (!Object.keys(cambios).length) continue;
      const { error: e2 } = await agente
        .from("conversaciones")
        .update(cambios)
        .eq("telefono", c.telefono);
      if (!e2) n++;
    }
    if (n) console.log(`[clasificar] ${n} conversaciones etiquetadas o con nombre puesto.`);
  } finally {
    clasificando = false;
  }
}

export function iniciarClasificacion() {
  if (!agente) return;
  clasificarConversaciones(); // una pasada al arrancar
  setInterval(clasificarConversaciones, 5 * 60 * 1000); // y cada 5 minutos
  console.log("[clasificar] clasificación de chats iniciada.");
}
