// notificar.js — Avisa al asesor (tú) cuando hay un lead caliente.
// Genera un resumen LIMPIO y estructurado usando Claude, en vez de pegar
// mensajes crudos del cliente.

import Anthropic from "@anthropic-ai/sdk";
import { NOTIFICAR_A } from "./config.js";
import { enviarWhatsApp } from "./whatsapp.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Pide a Claude que extraiga los datos clave de la conversación y arme
 * un resumen corto y claro para el asesor.
 */
async function generarResumen(historial) {
  const conversacion = historial
    .map((m) => `${m.rol === "user" ? "Cliente" : "Agente"}: ${m.contenido}`)
    .join("\n");

  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: `Eres un asistente que resume conversaciones de venta de motos para
pasarle el lead a un asesor humano. Lee la conversación y extrae SOLO los datos
clave. Responde EXACTAMENTE en este formato, sin nada más:

Nombre: [nombre del cliente, o "no dio"]
Cédula: [número de cédula si lo dio, o "no dio"]
Moto de interés: [modelo específico, o "no definido"]
Precio ya cotizado: [sí, el total / no]
Financiación: [preguntó / no preguntó]
Código de campaña: [si se le dio un código de descuento, ponlo; si no, "no aplica"]
Intención: [qué quiere hacer: visitar el local, que lo llamen, cuándo, etc.]

Sé breve. No inventes datos que no estén en la conversación. Ignora saludos,
preguntas de horario o ubicación y cualquier cosa que no sirva para la venta.`,
      messages: [
        {
          role: "user",
          content: `Resume este lead:\n\n${conversacion}`,
        },
      ],
    });

    return msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (err) {
    console.error("Error generando resumen:", err.message);
    return "(No se pudo generar el resumen automático. Revisa la conversación.)";
  }
}

export async function notificarLeadCaliente(telefonoCliente, historial) {
  const datos = await generarResumen(historial);

  const resumen =
    `🔥 LEAD CALIENTE — HondaSur\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${datos}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📱 WhatsApp: ${telefonoCliente}\n` +
    `🕐 ${new Date().toLocaleString("es-CO")}\n` +
    `👉 Escríbele tú para cerrar.`;

  console.log("\n========== NOTIFICACIÓN AL ASESOR ==========");
  console.log(resumen);
  console.log("============================================\n");

  // Enviar el aviso a TU WhatsApp personal
  try {
    await enviarWhatsApp(NOTIFICAR_A, resumen);
  } catch (err) {
    console.error("No se pudo enviar el aviso al asesor:", err.message);
  }
}

// Aviso a las asesoras cuando el agente perfila un caso de GARANTÍA.
export async function notificarGarantia(telefonoCliente, info = {}) {
  const comproAqui = info.compro_en_hondasur === true || info.compro_en_hondasur === "true";
  const texto =
    `🛠 GARANTÍA — HondaSur\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Compró la moto aquí: ${comproAqui ? "SÍ ✅" : "NO ⚠️"}\n` +
    `Cliente: ${info.nombre || "no dio"}\n` +
    `Moto: ${info.modelo || "no dijo"}\n` +
    `Falla: ${info.falla || "no detalló"}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📱 WhatsApp: ${telefonoCliente}\n` +
    `🕐 ${new Date().toLocaleString("es-CO")}\n` +
    `👉 El bot quedó en silencio en este chat: atiéndelo desde Honda Sur Central.`;
  console.log("\n========== AVISO DE GARANTÍA ==========\n" + texto + "\n=======================================\n");
  try { await enviarWhatsApp(NOTIFICAR_A, texto); }
  catch (err) { console.error("No se pudo enviar el aviso de garantía:", err.message); }
}
