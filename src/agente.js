// agente.js — Núcleo: recibe un mensaje, responde con Claude, detecta handoff.
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./prompt.js";
import { getHistorial, guardarMensaje, marcarHumano, estaEnHumano } from "./memoria.js";
import { notificarLeadCaliente } from "./notificar.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Procesa un mensaje entrante de un cliente.
 * @param {string} telefono  número del cliente (id de conversación)
 * @param {string} texto     mensaje del cliente
 * @returns {Promise<{respuesta: string|null, handoff: boolean}>}
 */
export async function procesarMensaje(telefono, texto) {
  // Si la conversación ya está en manos del humano, el agente NO responde.
  if (await estaEnHumano(telefono)) {
    await guardarMensaje(telefono, "user", texto);
    return { respuesta: null, handoff: false };
  }

  await guardarMensaje(telefono, "user", texto);
  const historial = await getHistorial(telefono);

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: buildSystemPrompt(),
    messages: historial.map((m) => ({ role: m.rol, content: m.contenido })),
  });

  let respuesta = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Detección de handoff
  const handoff = respuesta.includes("[HANDOFF]");
  if (handoff) {
    respuesta = respuesta.replace(/\[HANDOFF\]/g, "").trim();
    await marcarHumano(telefono, true);
    // Incluye el historial completo + la última respuesta del agente para el resumen
    const historialCompleto = [...historial, { rol: "assistant", contenido: respuesta }];
    await notificarLeadCaliente(telefono, historialCompleto);
  }

  await guardarMensaje(telefono, "assistant", respuesta);
  return { respuesta, handoff };
}
