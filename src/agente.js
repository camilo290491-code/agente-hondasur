// agente.js — Núcleo: recibe un mensaje, responde con Claude, detecta handoff.
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./prompt.js";
import {
  getHistorial,
  guardarMensaje,
  marcarHumano,
  estaEnHumano,
  contarMensajesTrasHandoff,
  yaFuePasadoAntes,
} from "./memoria.js";
import { notificarLeadCaliente } from "./notificar.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Recordatorios mientras el cliente está en manos del asesor (dentro de las 12h).
const RECORDATORIOS = [
  "¡Gracias por escribir! 🙌 Ya un asesor tiene tus datos y te contactará muy pronto para ayudarte personalmente. Cualquier cosa, aquí sigo.",
  "En un momento te contacta el asesor que te asigné. 🏍️ Está terminando de organizar tu información para darte la mejor atención.",
  "Tranquilo, tu solicitud ya está en manos de nuestro equipo y no se ha perdido. Un asesor te escribe lo antes posible. ¡Gracias por la paciencia! 🙏",
];

/**
 * Prepara el historial para la API de Claude.
 * La API exige: alternancia de roles y que TERMINE con un mensaje del usuario.
 * Esta función:
 *  - Quita mensajes del asistente que queden al final
 *  - Fusiona mensajes consecutivos del mismo rol
 *  - Descarta mensajes vacíos
 */
function prepararHistorial(historial) {
  // 1. Quitar vacíos
  let msgs = historial.filter(
    (m) => m && m.contenido && String(m.contenido).trim() !== ""
  );

  // 2. Fusionar consecutivos del mismo rol (la API no los acepta separados)
  const fusionado = [];
  for (const m of msgs) {
    const ultimo = fusionado[fusionado.length - 1];
    if (ultimo && ultimo.rol === m.rol) {
      ultimo.contenido += "\n" + m.contenido;
    } else {
      fusionado.push({ rol: m.rol, contenido: m.contenido });
    }
  }

  // 3. La conversación debe EMPEZAR con el usuario
  while (fusionado.length && fusionado[0].rol !== "user") {
    fusionado.shift();
  }

  // 4. La conversación debe TERMINAR con el usuario
  while (fusionado.length && fusionado[fusionado.length - 1].rol !== "user") {
    fusionado.pop();
  }

  return fusionado;
}

export async function procesarMensaje(telefono, texto) {
  await guardarMensaje(telefono, "user", texto);

  // Si está en manos del asesor (dentro de 12h): recordatorio amable, no atiende normal.
  if (await estaEnHumano(telefono)) {
    const veces = await contarMensajesTrasHandoff(telefono);
    const idx = Math.min(veces, RECORDATORIOS.length - 1);
    const recordatorio = RECORDATORIOS[idx];
    await guardarMensaje(telefono, "assistant", recordatorio);
    return { respuesta: recordatorio, handoff: false };
  }

  const historial = await getHistorial(telefono);

  // ¿A este cliente ya se le pasó un lead antes? (para no duplicar el pase)
  const pasadoAntes = await yaFuePasadoAntes(telefono);

  // Sanear el historial para cumplir las reglas de la API
  let mensajesParaAPI = prepararHistorial(historial).map((m) => ({
    role: m.rol,
    content: m.contenido,
  }));

  // Red de seguridad: si el saneado dejó todo vacío, usar solo el mensaje actual
  if (mensajesParaAPI.length === 0) {
    mensajesParaAPI = [{ role: "user", content: texto }];
  }

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: buildSystemPrompt({ clienteYaPasado: pasadoAntes }),
    messages: mensajesParaAPI,
  });

  let respuesta = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const handoff = respuesta.includes("[HANDOFF]");
  if (handoff) {
    respuesta = respuesta.replace(/\[HANDOFF\]/g, "").trim();
    await marcarHumano(telefono, true);
    const historialCompleto = [...historial, { rol: "assistant", contenido: respuesta }];
    await notificarLeadCaliente(telefono, historialCompleto);
  }

  await guardarMensaje(telefono, "assistant", respuesta);
  return { respuesta, handoff };
}
