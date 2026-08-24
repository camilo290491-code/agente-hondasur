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
// NUEVO — herramientas del taller (citas y tarifario de TallerNet)
import { HERRAMIENTAS_TALLER, ejecutarHerramientaTaller } from "./tallernet.js";

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

  // NUEVO — Fecha y hora actuales de Colombia, para que el agente sepa "hoy", "mañana", etc.
  const ahoraCol = new Date().toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const fechaISO = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());

  const parametrosBase = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system:
      buildSystemPrompt({ clienteYaPasado: pasadoAntes }) +
      `\n\nFECHA Y HORA ACTUAL (Colombia): ${ahoraCol}. En formato YYYY-MM-DD, hoy es ${fechaISO}. ` +
      `Usa esta fecha para interpretar "hoy", "mañana", "el viernes", etc. al agendar citas. ` +
      `Al proponer una cita, consulta primero la disponibilidad y ofrécele al cliente los horarios disponibles que devuelve la herramienta. ` +
      `REGLA DEL TALLER: HondaSur atiende ÚNICAMENTE motos marca Honda. Antes de agendar, confirma la marca de la moto; ` +
      `si es de otra marca, informa con amabilidad que el taller solo atiende Honda y NO agendes la cita. ` +
      `REPROGRAMACIONES: si el cliente pide cambiar una cita existente (el número de cita suele aparecer en la conversación), ` +
      `primero cancélala con cancelar_cita_taller y luego agenda la nueva con la disponibilidad.`,
    tools: HERRAMIENTAS_TALLER, // Claude puede consultar tarifario, disponibilidad y agendar
  };

  let msg = await anthropic.messages.create({
    ...parametrosBase,
    messages: mensajesParaAPI,
  });

  // NUEVO — Ciclo de herramientas: si Claude pide usar una herramienta,
  // se ejecuta, se le devuelve el resultado, y se le pide la respuesta final.
  let vueltas = 0;
  while (msg.stop_reason === "tool_use" && vueltas < 5) {
    const usosDeHerramienta = msg.content.filter((b) => b.type === "tool_use");

    // El turno del asistente (con sus llamadas) entra al historial de la API
    mensajesParaAPI.push({ role: "assistant", content: msg.content });

    // Ejecutar cada herramienta y devolver los resultados
    const resultados = [];
    for (const uso of usosDeHerramienta) {
      const salida = await ejecutarHerramientaTaller(uso.name, uso.input, telefono);
      console.log("[herramienta]", uso.name, JSON.stringify(salida).slice(0, 200));
      resultados.push({
        type: "tool_result",
        tool_use_id: uso.id,
        content: JSON.stringify(salida),
      });
    }
    mensajesParaAPI.push({ role: "user", content: resultados });

    msg = await anthropic.messages.create({
      ...parametrosBase,
      messages: mensajesParaAPI,
    });
    vueltas++;
  }

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
