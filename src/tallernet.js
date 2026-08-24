// tallernet.js — Integración del agente con TallerNet (citas + aprobaciones).
// Requiere en Railway: TALLERNET_URL y TALLERNET_SERVICE_KEY (la sb_secret_ de TallerNet).
import { createClient } from "@supabase/supabase-js";
import { enviarWhatsApp, enviarWhatsAppBotones, enviarWhatsAppPlantilla } from "./whatsapp.js";

const TALLERNET_URL = process.env.TALLERNET_URL;
const TALLERNET_KEY = process.env.TALLERNET_SERVICE_KEY;

const taller =
  TALLERNET_URL && TALLERNET_KEY ? createClient(TALLERNET_URL, TALLERNET_KEY) : null;

if (!taller) {
  console.warn(
    "[tallernet] Sin TALLERNET_URL / TALLERNET_SERVICE_KEY: funciones de taller en modo apagado."
  );
}

const cop = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("es-CO");

// Capacidad diaria agendable del taller (2 mecánicos x 8h con margen para imprevistos)
const HORAS_AGENDABLES_DIA = 13;

// ============================================================
// PARTE 1 — Herramientas de Claude para citas del taller
// ============================================================

export const HERRAMIENTAS_TALLER = [
  {
    name: "consultar_servicios_taller",
    description:
      "Consulta el tarifario oficial del taller HondaSur: servicios de mantenimiento y reparación de motos con su precio de mano de obra y tiempo estimado. Úsala cuando el cliente pregunte por servicios de taller, precios de mantenimiento, o quiera agendar una cita.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "consultar_disponibilidad_taller",
    description:
      "Consulta cuántas horas de agenda quedan libres en el taller para una fecha específica. Úsala SIEMPRE antes de proponer o confirmar una cita.",
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
      "Agenda una cita en el taller HondaSur. Úsala SOLO cuando el cliente ya confirmó fecha, hora y servicio, y te dio su nombre y la placa de la moto. Después de agendar, confirma al cliente el número de cita, la fecha y la hora.",
    input_schema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "YYYY-MM-DD" },
        hora: { type: "string", description: "Hora en formato 24h, ej 09:30" },
        cliente: { type: "string", description: "Nombre del cliente" },
        placa: { type: "string", description: "Placa de la moto" },
        servicio_id: {
          type: "number",
          description: "id del servicio elegido, obtenido de consultar_servicios_taller",
        },
      },
      required: ["fecha", "hora", "cliente", "servicio_id"],
    },
  },
  {
    name: "cancelar_cita_taller",
    description:
      "Cancela una cita existente del taller. Úsala cuando el cliente pida cancelar o reprogramar: primero cancela la cita anterior con su número y luego, si aplica, agenda la nueva con agendar_cita_taller.",
    input_schema: {
      type: "object",
      properties: {
        cita_numero: { type: "number", description: "Número de la cita a cancelar" },
      },
      required: ["cita_numero"],
    },
  },
];

// telefonoWa: el número de WhatsApp del cliente (lo inyecta agente.js automáticamente)
export async function ejecutarHerramientaTaller(nombre, input, telefonoWa) {
  if (!taller) return { error: "TallerNet no está configurado en el servidor." };

  try {
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
        .select("hora_inicio, servicio_id, servicios(tiempo_est_horas)")
        .eq("fecha", input.fecha)
        .neq("estado", "Cancelada");
      if (error) return { error: error.message };
      const ocupadas = (data || []).reduce(
        (a, c) => a + Number(c.servicios?.tiempo_est_horas || 1),
        0
      );
      const libres = Math.max(0, HORAS_AGENDABLES_DIA - ocupadas);

      // Horarios sugeridos: jornada 8:00–17:00, propone inicios cada 30 min
      // donde quepa al menos 1 hora sin chocar con citas ya agendadas.
      const aMin = (h) => {
        const [hh, mm] = String(h).split(":").map(Number);
        return hh * 60 + (mm || 0);
      };
      const ocupados = (data || [])
        .filter((c) => c.hora_inicio)
        .map((c) => {
          const ini = aMin(c.hora_inicio);
          const dur = Number(c.servicios?.tiempo_est_horas || 1) * 60;
          return [ini, ini + dur];
        });
      const sugeridos = [];
      for (let t = 8 * 60; t <= 16 * 60 && sugeridos.length < 8; t += 30) {
        const fin = t + 60;
        const choca = ocupados.some(([a, b]) => t < b && fin > a);
        if (!choca) {
          sugeridos.push(
            String(Math.floor(t / 60)).padStart(2, "0") + ":" +
            String(t % 60).padStart(2, "0")
          );
        }
      }
      return {
        fecha: input.fecha,
        horas_ocupadas: ocupadas,
        horas_libres: libres,
        hay_espacio: libres > 0 && sugeridos.length > 0,
        horarios_disponibles: sugeridos,
        nota: "Ofrécele al cliente 3 o 4 de estos horarios para que elija.",
      };
    }

    if (nombre === "agendar_cita_taller") {
      const { data, error } = await taller
        .from("citas")
        .insert({
          fecha: input.fecha,
          hora_inicio: input.hora,
          cliente: input.cliente,
          telefono: telefonoWa || null,
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
        detalle: `Cita #${data.id} agendada para el ${input.fecha} a las ${input.hora}.`,
      };
    }

    if (nombre === "cancelar_cita_taller") {
      const { error } = await taller
        .from("citas")
        .update({ estado: "Cancelada" })
        .eq("id", input.cita_numero);
      if (error) return { error: error.message };
      return { ok: true, detalle: "Cita #" + input.cita_numero + " cancelada." };
    }

    return { error: "herramienta desconocida: " + nombre };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ============================================================
// PARTE 2 — Aprobaciones de presupuesto por WhatsApp
// ============================================================

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

  let envio = await enviarWhatsAppBotones(ap.telefono, cuerpo, [
    { id: `APR_${ap.id}`, titulo: "✅ Aprobar" },
    { id: `RECH_${ap.id}`, titulo: "❌ Rechazar" },
  ]);
  let ok = envio.ok, msgId = envio.id;
  let via = "botones";

  // Si el envío directo falla de inmediato, se intenta con la PLANTILLA aprobada
  // por Meta. OJO: el fallo por ventana de 24h NO llega aquí sino después, como
  // "status failed" al webhook — eso lo maneja manejarEstadoWhatsApp más abajo.
  if (!ok) {
    const resumen = (
      `Mano de obra ${cop(ap.mano_obra)}` +
      ((ap.items || []).length
        ? ` | Repuestos: ` +
          ap.items.map((it) => `${it.nombre} x${it.cant} ${cop(it.cant * it.precio)}`).join(", ")
        : "") +
      ` | Total ${cop(ap.total)}`
    ).replace(/\s+/g, " ").slice(0, 900); // las plantillas no aceptan saltos de línea

    const e2 = await enviarWhatsAppPlantilla(
      ap.telefono,
      process.env.TEMPLATE_APROBACION || "aprobacion_taller",
      process.env.TEMPLATE_IDIOMA || "es_CO",
      [resumen],
      [`APR_${ap.id}`, `RECH_${ap.id}`]
    );
    ok = e2.ok; msgId = e2.id;
    via = "plantilla";
  }

  await taller
    .from("aprobaciones")
    .update(
      ok
        ? { estado: "ENVIADA", enviada_at: new Date().toISOString(),
            wa_message_id: msgId, error_detalle: "via=" + via }
        : { estado: "ERROR", error_detalle: "Falló el envío directo y por plantilla (¿plantilla aprobada en Meta?)" }
    )
    .eq("id", ap.id);
  console.log("[tallernet] aprobación", ap.id, ok ? "enviada vía " + via : "ERROR");
}

// Llamar UNA VEZ al arrancar el servidor.
export function iniciarEscuchaAprobaciones() {
  if (!taller) return;

  taller
    .channel("aprobaciones-nuevas")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "aprobaciones" },
      (payload) => {
        if (payload.new?.estado === "POR ENVIAR") enviarAprobacion(payload.new);
      }
    )
    .subscribe((status) => console.log("[tallernet] realtime aprobaciones:", status));

  // Red de seguridad: cada 2 minutos revisa si quedó alguna sin enviar
  setInterval(async () => {
    const { data } = await taller
      .from("aprobaciones")
      .select("*")
      .eq("estado", "POR ENVIAR")
      .limit(5);
    for (const ap of data || []) await enviarAprobacion(ap);
  }, 120000);
  console.log("[tallernet] escucha de aprobaciones activa");
}

// ============================================================
// PARTE 3 — Recordatorios de cita (día anterior, ~5 pm Colombia)
// Requiere plantilla aprobada en Meta: "recordatorio_cita" con 4 variables.
// ============================================================

const HORA_RECORDATORIO = 17; // 5 pm hora Colombia

function fechaColombia(offsetDias = 0) {
  const d = new Date(Date.now() + offsetDias * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(d);
}
function horaColombia() {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Bogota",
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
}

async function enviarRecordatoriosPendientes() {
  if (!taller) return;
  if (horaColombia() < HORA_RECORDATORIO) return; // solo desde las 5 pm

  const manana = fechaColombia(1);
  const { data, error } = await taller
    .from("citas")
    .select("id, cliente, telefono, fecha, hora_inicio, servicios(nombre)")
    .eq("fecha", manana)
    .eq("estado", "Agendada")
    .is("recordatorio_enviado_at", null)
    .not("telefono", "is", null);
  if (error) {
    console.error("[tallernet] error consultando recordatorios:", error.message);
    return;
  }
  for (const c of data || []) await enviarRecordatorioCita(c);
}

async function enviarRecordatorioCita(c) {
  const hora = c.hora_inicio ? String(c.hora_inicio).slice(0, 5) : "la hora acordada";
  const params = [c.cliente || "cliente", c.fecha, hora, c.servicios?.nombre || "tu servicio"];
  const plantilla = process.env.TEMPLATE_RECORDATORIO || "recordatorio_cita";
  const idioma = process.env.TEMPLATE_IDIOMA || "es_CO";

  // Con botones Confirmar/Reprogramar; si la plantilla aún no los tiene, reintenta sin botones.
  let e = await enviarWhatsAppPlantilla(c.telefono, plantilla, idioma, params,
    [`CONF_${c.id}`, `REPRO_${c.id}`]);
  if (!e.ok) e = await enviarWhatsAppPlantilla(c.telefono, plantilla, idioma, params, []);

  await taller
    .from("citas")
    .update(
      e.ok
        ? { recordatorio_enviado_at: new Date().toISOString(), recordatorio_solicitado: false }
        : { recordatorio_solicitado: false }
    )
    .eq("id", c.id);
  console.log("[tallernet] recordatorio cita #" + c.id, e.ok ? "enviado" : "FALLÓ");
}

// Recordatorios manuales: el botón "Enviar ya" de TallerNet marca la cita y aquí se envía al instante.
async function enviarRecordatoriosManuales() {
  if (!taller) return;
  const { data } = await taller
    .from("citas")
    .select("id, cliente, telefono, fecha, hora_inicio, servicios(nombre)")
    .eq("recordatorio_solicitado", true)
    .not("telefono", "is", null)
    .limit(10);
  for (const c of data || []) await enviarRecordatorioCita(c);
}

// Llamar UNA VEZ al arrancar: revisa cada 30 minutos.
export function iniciarRecordatoriosCitas() {
  if (!taller) return;
  enviarRecordatoriosPendientes();
  enviarRecordatoriosManuales();
  setInterval(enviarRecordatoriosPendientes, 30 * 60 * 1000);
  setInterval(enviarRecordatoriosManuales, 60 * 1000);
  taller
    .channel("recordatorios-manuales")
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "citas" },
      (payload) => { if (payload.new?.recordatorio_solicitado) enviarRecordatoriosManuales(); })
    .subscribe((s) => console.log("[tallernet] realtime citas:", s));
  console.log("[tallernet] recordatorios de citas activos (envío desde las " + HORA_RECORDATORIO + ":00 Colombia)");
}

// Maneja los avisos de estado de WhatsApp. Si un envío de aprobación FALLÓ
// (típico: cliente fuera de la ventana de 24h), reenvía por PLANTILLA.
export async function manejarEstadoWhatsApp(status) {
  if (!taller) return;
  if (status?.status !== "failed" || !status?.id) return;

  const { data: ap } = await taller
    .from("aprobaciones")
    .select("*")
    .eq("wa_message_id", status.id)
    .maybeSingle();
  if (!ap || ap.estado !== "ENVIADA") return;

  // Si ya fue por plantilla y aun así falló, es error definitivo.
  if ((ap.error_detalle || "").includes("via=plantilla")) {
    await taller.from("aprobaciones").update({
      estado: "ERROR",
      error_detalle: "La plantilla tampoco se entregó: " +
        JSON.stringify(status.errors || []).slice(0, 400),
    }).eq("id", ap.id);
    console.error("[tallernet] aprobación", ap.id, "falló también por plantilla");
    return;
  }

  console.log("[tallernet] entrega directa falló para aprobación", ap.id, "→ reenviando por plantilla");
  const resumen = (
    `Mano de obra ${cop(ap.mano_obra)}` +
    ((ap.items || []).length
      ? ` | Repuestos: ` +
        ap.items.map((it) => `${it.nombre} x${it.cant} ${cop(it.cant * it.precio)}`).join(", ")
      : "") +
    ` | Total ${cop(ap.total)}`
  ).replace(/\s+/g, " ").slice(0, 900);

  const e2 = await enviarWhatsAppPlantilla(
    ap.telefono,
    process.env.TEMPLATE_APROBACION || "aprobacion_taller",
    process.env.TEMPLATE_IDIOMA || "es_CO",
    [resumen],
    [`APR_${ap.id}`, `RECH_${ap.id}`]
  );
  await taller.from("aprobaciones").update(
    e2.ok
      ? { wa_message_id: e2.id, error_detalle: "via=plantilla", enviada_at: new Date().toISOString() }
      : { estado: "ERROR", error_detalle: "Reenvío por plantilla falló (¿nombre/idioma de la plantilla?)" }
  ).eq("id", ap.id);
  console.log("[tallernet] aprobación", ap.id, e2.ok ? "reenviada vía plantilla" : "ERROR en plantilla");
}

// Procesa Confirmar/Reprogramar del recordatorio de cita. Devuelve true si era eso.
export async function procesarConfirmacionCita(mensaje) {
  if (!taller) return false;
  const btnId =
    mensaje?.interactive?.button_reply?.id || mensaje?.button?.payload;
  if (!btnId || !/^(CONF|REPRO)_\d+$/.test(btnId)) return false;

  const confirma = btnId.startsWith("CONF_");
  const id = parseInt(btnId.split("_")[1]);
  const { data: cita } = await taller.from("citas").select("*").eq("id", id).maybeSingle();
  if (!cita) return false;

  if (confirma) {
    await taller.from("citas").update({ confirmada_at: new Date().toISOString() }).eq("id", id);
    await enviarWhatsApp(mensaje.from,
      "✅ ¡Gracias! Tu cita #" + id + " quedó confirmada para el " + cita.fecha +
      (cita.hora_inicio ? " a las " + String(cita.hora_inicio).slice(0,5) : "") + ". Te esperamos.");
  } else {
    await enviarWhatsApp(mensaje.from,
      "Claro, con gusto reprogramamos tu cita #" + id + " del " + cita.fecha +
      ". Cuéntame qué día y hora te sirven mejor y te muestro la disponibilidad.");
  }
  console.log("[tallernet] cita", id, confirma ? "CONFIRMADA" : "pidió reprogramar");
  return true;
}

// Procesa el toque de un botón de aprobación. Devuelve true si el mensaje era eso.
export async function procesarRespuestaAprobacion(mensaje) {
  if (!taller) return false;
  const btnId =
    mensaje?.interactive?.button_reply?.id || mensaje?.button?.payload;
  if (!btnId || !/^(APR|RECH)_\d+$/.test(btnId)) return false;

  const aprobado = btnId.startsWith("APR_");
  const id = parseInt(btnId.split("_")[1]);

  const { data: ap } = await taller.from("aprobaciones").select("*").eq("id", id).single();
  if (!ap) return false;

  await taller
    .from("aprobaciones")
    .update({
      estado: aprobado ? "APROBADA" : "RECHAZADA",
      respondida_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (ap.registro_id) {
    await taller
      .from("registros")
      .update({ aprobacion: aprobado ? "Aprobada" : "Rechazada" })
      .eq("id", ap.registro_id);
  }

  await enviarWhatsApp(
    mensaje.from,
    aprobado
      ? "¡Listo! Reparación autorizada ✅. Te avisamos cuando tu moto esté lista."
      : "Entendido, no realizaremos la reparación ❌. Puedes pasar a recoger tu moto o escribirnos si cambias de opinión."
  );
  console.log("[tallernet] aprobación", id, aprobado ? "APROBADA" : "RECHAZADA");
  return true;
}
