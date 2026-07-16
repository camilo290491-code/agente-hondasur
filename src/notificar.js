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

Nombre: [nombre del cliente, o "no dio" si no lo dijo]
Moto de interés: [modelo específico, o "no definido"]
Precio ya cotizado: [sí, el total / no]
Financiación: [preguntó / no preguntó]
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

  // En vivo, descomenta para que te llegue a TU WhatsApp:
  // await enviarWhatsApp(NOTIFICAR_A, resumen);
}
