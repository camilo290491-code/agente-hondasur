// ============================================================
// tallernet.js — Módulo de integración TallerNet para el agente
// Agregar al proyecto Node.js del agente WhatsApp (Railway)
//
// VARIABLES DE ENTORNO NUEVAS (Railway → tu servicio → Variables):
//   TALLERNET_URL         = https://zeywthfzrfxdenwqvboe.supabase.co
//   TALLERNET_SERVICE_KEY = la llave "secret" (sb_secret_...) del proyecto
//                           TallerNet (Settings → API). Solo vive en Railway.
// Reutiliza las que ya tienes del agente:
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID
// ============================================================

const { createClient } = require("@supabase/supabase-js");

const taller = createClient(
  process.env.TALLERNET_URL,
  process.env.TALLERNET_SERVICE_KEY
);

const WA_URL = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
const WA_HEADERS = {
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  "Content-Type": "application/json",
};

const cop = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("es-CO");

// ============================================================
// PARTE 1 — CITAS: herramientas para Claude (tool use)
// Agregar estos objetos al array `tools` que ya le pasas a la API
// ============================================================

const HERRAMIENTAS_TALLER = [
  {
    name: "consultar_servicios_taller",
    description:
      "Consulta el tarifario oficial del taller HondaSur: servicios de mantenimiento y reparación de motos con precio de mano de obra y tiempo estimado. Úsala cuando el cliente pregunte por servicios de taller, precios de mantenimiento o quiera agendar una cita.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "consultar_disponibilidad_taller",
    description:
      "Consulta cuántas horas de agenda quedan libres en el taller para una fecha. Úsala antes de proponer o confirmar una cita.",
    input_schema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
      },
      required: ["fecha"],
    },
  },
  {
    name: "agendar_cita_taller",
    description:
      "Agenda una cita en el taller. Úsala SOLO cuando el cliente ya confirmó fecha, hora y servicio, y te dio su nombre y la placa de la moto.",
    input_schema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "YYYY-MM-DD" },
        hora: { type: "string", description: "HH:MM en formato 24h, ej 09:30" },
        cliente: { type: "string" },
        telefono: { type: "string", description: "Número de WhatsApp del cliente" },
        placa: { type: "string" },
        servicio_id: { type: "number", description: "id del servicio del tarifario" },
      },
      required: ["fecha", "hora", "cliente", "telefono", "servicio_id"],
    },
  },
];

// Capacidad diaria del taller en horas (2 mecánicos x 8h, con margen para imprevistos)
const HORAS_AGENDABLES_DIA = 13;

async function ejecutarHerramientaTaller(nombre, input) {
  if (nombre === "consultar_servicios_taller") {
    const { data, error } = await taller
      .from("servicios")
      .select("id,nombre,categoria,tiempo_est_horas,precio_mano_obra")
      .eq("activo", true)
      .order("nombre");
    if (error) return { error: error.message };
    return { servicios: data };
  }

  if (nombre === "consultar_disponibilidad_taller") {
    const { data, error } = await taller
      .from("citas")
      .select("servicio_id, servicios(tiempo_est_horas)")
      .eq("fecha", input.fecha)
      .neq("estado", "Cancelada");
    if (error) return { error: error.message };
    const ocupadas = (data || []).reduce(
      (a, c) => a + Number(c.servicios?.tiempo_est_horas || 1), 0);
    const libres = Math.max(0, HORAS_AGENDABLES_DIA - ocupadas);
    return {
      fecha: input.fecha,
      horas_ocupadas: ocupadas,
      horas_libres: libres,
      hay_espacio: libres > 0,
    };
  }

  if (nombre === "agendar_cita_taller") {
    const { data, error } = await taller
      .from("citas")
      .insert({
        fecha: input.fecha,
        hora_inicio: input.hora,
        cliente: input.cliente,
        telefono: input.telefono,
        placa: (input.placa || "").toUpperCase(),
        servicio_id: input.servicio_id,
        estado: "Agendada",
      })
      .select("id")
      .single();
    if (error) return { error: error.message };
    return {
      ok: true,
      cita_numero: data.id,
      mensaje_confirmacion:
        `Cita #${data.id} agendada para el ${input.fecha} a las ${input.hora}.`,
    };
  }

  return { error: "herramienta desconocida" };
}

// ============================================================
// PARTE 2 — APROBACIONES: envío con botones y registro de respuesta
// ============================================================

// Formatea y envía la aprobación por WhatsApp con botones interactivos.
// NOTA 24 HORAS: los mensajes con botones solo llegan si el cliente escribió
// al número en las últimas 24 h. Como el cliente casi siempre acaba de dejar
// la moto (o chateó con el agente), normalmente aplica. Si el envío falla por
// ventana cerrada, crea una plantilla "utility" en el WhatsApp Manager y
// reemplaza este payload por un envío de plantilla.
async function enviarAprobacion(ap) {
  const lineas = (ap.items || [])
    .map((it) => `• ${it.nombre} x${it.cant}: ${cop(it.cant * it.precio)}`)
    .join("\n");
  const cuerpo =
    `*HondaSur Taller* — Presupuesto para tu moto:\n\n` +
    `Mano de obra: ${cop(ap.mano_obra)}\n` +
    (lineas ? `Repuestos:\n${lineas}\n` : "") +
    `\n*Total: ${cop(ap.total)}*\n\n` +
    `¿Autorizas la reparación?`;

  const payload = {
    messaging_product: "whatsapp",
    to: ap.telefono.replace(/\D/g, ""),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: cuerpo },
      action: {
        buttons: [
          { type: "reply", reply: { id: `APR_${ap.id}`, title: "✅ Aprobar" } },
          { type: "reply", reply: { id: `RECH_${ap.id}`, title: "❌ Rechazar" } },
        ],
      },
    },
  };

  const resp = await fetch(WA_URL, {
    method: "POST",
    headers: WA_HEADERS,
    body: JSON.stringify(payload),
  });
  const json = await resp.json();

  if (!resp.ok) {
    await taller.from("aprobaciones").update({
      estado: "ERROR",
      error_detalle: JSON.stringify(json).slice(0, 500),
    }).eq("id", ap.id);
    console.error("[tallernet] error enviando aprobación", ap.id, json);
    return;
  }
  await taller.from("aprobaciones").update({
    estado: "ENVIADA",
    wa_message_id: json.messages?.[0]?.id || null,
    enviada_at: new Date().toISOString(),
  }).eq("id", ap.id);
  console.log("[tallernet] aprobación enviada", ap.id);
}

// Escucha en tiempo real las aprobaciones nuevas creadas desde TallerNet.
// Llamar UNA VEZ al arrancar el agente (junto a tu app.listen).
function iniciarEscuchaAprobaciones() {
  taller
    .channel("aprobaciones-nuevas")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "aprobaciones" },
      (payload) => {
        if (payload.new?.estado === "POR ENVIAR") enviarAprobacion(payload.new);
      }
    )
    .subscribe((status) => console.log("[tallernet] realtime:", status));

  // Red de seguridad: cada 2 min revisa si quedó alguna sin enviar
  setInterval(async () => {
    const { data } = await taller
      .from("aprobaciones").select("*").eq("estado", "POR ENVIAR").limit(5);
    for (const ap of data || []) await enviarAprobacion(ap);
  }, 120000);
}

// Procesa la respuesta del cliente (botón tocado).
// LLAMAR desde tu webhook existente, ANTES de pasarle el mensaje a Claude.
// Devuelve true si el mensaje era una respuesta de aprobación (ya manejada).
async function procesarRespuestaAprobacion(message) {
  const btnId = message?.interactive?.button_reply?.id;
  if (!btnId || !/^(APR|RECH)_\d+$/.test(btnId)) return false;

  const aprobado = btnId.startsWith("APR_");
  const id = parseInt(btnId.split("_")[1]);

  const { data: ap } = await taller
    .from("aprobaciones").select("*").eq("id", id).single();
  if (!ap) return false;

  await taller.from("aprobaciones").update({
    estado: aprobado ? "APROBADA" : "RECHAZADA",
    respondida_at: new Date().toISOString(),
  }).eq("id", id);

  if (ap.registro_id) {
    await taller.from("registros").update({
      aprobacion: aprobado ? "Aprobada" : "Rechazada",
    }).eq("id", ap.registro_id);
  }

  // Confirmación al cliente
  await fetch(WA_URL, {
    method: "POST",
    headers: WA_HEADERS,
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: message.from,
      type: "text",
      text: {
        body: aprobado
          ? "¡Listo! Reparación autorizada ✅. Te avisamos cuando tu moto esté lista."
          : "Entendido, no realizaremos la reparación ❌. Puedes pasar a recoger tu moto o escribirnos si cambias de opinión.",
      },
    }),
  });
  console.log("[tallernet] aprobación", id, aprobado ? "APROBADA" : "RECHAZADA");
  return true;
}

module.exports = {
  HERRAMIENTAS_TALLER,
  ejecutarHerramientaTaller,
  iniciarEscuchaAprobaciones,
  procesarRespuestaAprobacion,
};
