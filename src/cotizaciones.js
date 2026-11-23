// cotizaciones.js — Envío de cotizaciones al celular del cliente desde el cotizador
// de Honda Sur Central (Atención al cliente). La app deja una fila en
// `cotizaciones_envios` y aquí se despacha con la plantilla de Meta que corresponda:
//   cotizacion_contado  → nombre, moto, precio de contado, papeles, total
//   cotizacion_credito  → nombre, moto, total, cuota inicial, plazo, cuota mensual aprox.
// Nunca se envía la tasa de interés. El mensaje queda registrado en el chat del cliente.

import { createClient } from "@supabase/supabase-js";
import { enviarWhatsAppPlantilla } from "./whatsapp.js";

const agente =
  process.env.SUPABASE_URL && process.env.SUPABASE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;

export const PLANTILLAS_COTIZACION = {
  contado: {
    plantilla: "cotizacion_contado",
    variables: ["nombre", "moto", "precio", "papeles", "total"],
    texto: (v) =>
      `Hola ${v.nombre} 👋 Esta es tu cotización de HondaSur para la ${v.moto} 🏍\n` +
      `Precio de contado: ${v.precio}\nPapeles (matrícula y SOAT): ${v.papeles}\nTotal: ${v.total}\n` +
      `Precios sujetos a cambio sin previo aviso. Te esperamos en Cra. 50 #125 Sur-104, Caldas. ¿Tienes alguna duda? Respóndenos por aquí 🙌`,
  },
  credito: {
    plantilla: "cotizacion_credito",
    variables: ["nombre", "moto", "total", "inicial", "plazo", "cuota"],
    texto: (v) =>
      `Hola ${v.nombre} 👋 Esta es tu cotización de HondaSur para la ${v.moto} 🏍\n` +
      `Valor total con papeles: ${v.total}\nCuota inicial: ${v.inicial}\nPlazo: ${v.plazo} meses\nCuota mensual aproximada: ${v.cuota}\n` +
      `Valores aproximados, sujetos a estudio de crédito. Te esperamos en Cra. 50 #125 Sur-104, Caldas. ¿Tienes alguna duda? Respóndenos por aquí 🙌`,
  },
};

let despachando = false;
export async function despacharCotizaciones() {
  if (!agente || despachando) return;
  despachando = true;
  try {
    const { data: pend } = await agente
      .from("cotizaciones_envios").select("*").eq("estado", "PENDIENTE").order("id", { ascending: true }).limit(10);
    if (!pend || !pend.length) return;
    const idioma = process.env.TEMPLATE_IDIOMA || "es_CO";
    for (const env of pend) {
      const def = PLANTILLAS_COTIZACION[env.tipo];
      const v = env.params || {};
      if (!def) {
        await agente.from("cotizaciones_envios").update({ estado: "ERROR", error: "tipo desconocido" }).eq("id", env.id);
        continue;
      }
      const params = def.variables.map((k) => String(v[k] ?? ""));
      let e = await enviarWhatsAppPlantilla(env.telefono, def.plantilla, idioma, params, []);
      if (!e.ok) e = await enviarWhatsAppPlantilla(env.telefono, def.plantilla, idioma === "es" ? "es_CO" : "es", params, []);
      if (e.ok) {
        await agente.from("cotizaciones_envios").update({ estado: "ENVIADO", enviado_el: new Date().toISOString() }).eq("id", env.id);
        await agente.from("mensajes").insert({ telefono: env.telefono, rol: "assistant", contenido: def.texto(v) });
        console.log("[cotización] enviada a", env.telefono, env.tipo);
      } else {
        await agente.from("cotizaciones_envios").update({ estado: "ERROR", error: "Meta rechazó el envío (¿plantilla aprobada?)" }).eq("id", env.id);
        console.error("[cotización] falló", env.telefono, env.tipo);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  } catch (e) {
    console.error("[cotización] error:", e.message);
  } finally {
    despachando = false;
  }
}

export function iniciarEnvioCotizaciones() {
  if (!agente) return;
  setInterval(despacharCotizaciones, 30 * 1000);
  console.log("[cotización] envío de cotizaciones por WhatsApp activo");
}
