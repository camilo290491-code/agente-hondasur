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

// La disponibilidad real (carriles, duración por servicio, tope del 85%) la
// calcula la función central web_horarios_disponibles en la base de TallerNet —
// la misma que usa la página web, así ambos canales ofrecen exactamente lo mismo.

// Tarifa hora y holgura vigentes (tabla config de TallerNet)
async function configTaller() {
  const { data } = await taller.from("config")
    .select("tarifa_hora, holgura_min").eq("id", 1).maybeSingle();
  return {
    tarifa: Number(data?.tarifa_hora || 80000),
    holgura: Number(data?.holgura_min ?? 15),
  };
}

// Busca un servicio activo por su código (ej. TAL-041)
async function servicioPorCodigo(codigo) {
  const { data } = await taller.from("servicios")
    .select("id, codigo, nombre, horas, minutos_agenda, carril, paga")
    .eq("activo", true).eq("codigo", String(codigo || "").trim().toUpperCase())
    .maybeSingle();
  return data || null;
}

// ============================================================
// PARTE 1 — Herramientas de Claude para citas del taller
// ============================================================

export const HERRAMIENTAS_TALLER = [
  {
    name: "consultar_servicios_taller",
    description:
      "Consulta el menú del taller HondaSur: las 5 opciones principales, las revisiones por kilometraje, los servicios especiales y el tarifario completo con precios calculados a la tarifa vigente. Úsala cuando el cliente pregunte por servicios del taller, precios de mantenimiento, o quiera agendar una cita.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "consultar_disponibilidad_taller",
    description:
      "Consulta los horarios disponibles del taller para una fecha y un servicio específico (los cupos dependen del servicio: cada uno ocupa su propio tiempo y carril). Úsala SIEMPRE antes de proponer o confirmar una cita, con el código del servicio ya elegido.",
    input_schema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
        codigo_servicio: { type: "string", description: "Código del servicio, ej. TAL-041 (de consultar_servicios_taller)" },
      },
      required: ["fecha", "codigo_servicio"],
    },
  },
  {
    name: "agendar_cita_taller",
    description:
      "Agenda una cita en el taller HondaSur. Úsala SOLO cuando el cliente ya confirmó fecha, hora y servicio, y te dio su nombre, el modelo de la moto y el kilometraje actual. Después de agendar, confirma al cliente el número de cita, la fecha y la hora.",
    input_schema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "YYYY-MM-DD" },
        hora: { type: "string", description: "Hora en formato 24h, ej 09:30 (una de las disponibles)" },
        cliente: { type: "string", description: "Nombre del cliente" },
        codigo_servicio: { type: "string", description: "Código del servicio, ej. TAL-002" },
        modelo: { type: "string", description: "Modelo de la moto, ej. CB 125F, Dio, XR 150L" },
        kilometraje: { type: "number", description: "Kilometraje actual de la moto" },
        placa: { type: "string", description: "Placa de la moto (si la tiene a la mano)" },
      },
      required: ["fecha", "hora", "cliente", "codigo_servicio", "modelo", "kilometraje"],
    },
  },
  {
    name: "consultar_motos_disponibles",
    description:
      "Consulta el catálogo VIGENTE de motos de HondaSur: modelos disponibles con su precio actual, promociones del mes (precio rebajado o bonos), colores y características. Es la ÚNICA fuente válida de precios de motos. Úsala SIEMPRE que el cliente pregunte por una moto, un precio o una promoción.",
    input_schema: { type: "object", properties: {}, required: [] },
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
      const { tarifa } = await configTaller();
      const { data, error } = await taller
        .from("servicios")
        .select("codigo, nombre, horas, paga, web_especial")
        .eq("activo", true)
        .not("codigo", "is", null)
        .order("codigo");
      if (error) return { error: error.message };
      const visibles = (data || []).filter((s) => !String(s.paga || "").startsWith("Interno"));
      const precioDe = (s) =>
        s.paga === "FANALCA" ? 0 : Math.round(Number(s.horas || 0) * tarifa);
      const item = (s) => ({
        codigo: s.codigo,
        nombre: s.nombre,
        precio: precioDe(s),
        ...(s.paga === "FANALCA" ? { garantia: "SIN COSTO por garantía Honda" } : {}),
      });
      return {
        tarifa_hora: tarifa,
        menu_principal: [
          { opcion: "Cambio de aceite", codigo: "TAL-041" },
          { opcion: "Revisión por kilometraje", nota: "pregunta el kilometraje y elige la revisión de la lista" },
          { opcion: "Mantenimiento general", codigo: "TAL-013", nota: "NUNCA des precio cerrado: se cotiza según el estado de la moto y se aprueba por WhatsApp" },
          { opcion: "Reparación o falla", codigo: "TAL-051", nota: "se agenda el diagnóstico; la reparación se cotiza al revisar la moto, sin comprometer precio" },
          { opcion: "Servicios especiales", nota: "usa la lista de especiales" },
        ],
        revisiones_por_km: visibles.filter((s) => /^TAL-0(0[1-9]|1[01])$/.test(s.codigo)).map(item),
        especiales: visibles.filter((s) => s.web_especial).map(item),
        todos_los_servicios: visibles.map(item),
        nota:
          "Ofrece el menú de 5 opciones, no la lista completa. Las revisiones de 1.000, 3.000 y 6.000 km son SIN COSTO por garantía Honda; después van cada 3.000 km (9.000, 12.000… hasta 30.000; por encima el ciclo se repite: 33.000 usa la de 3.000).",
      };
    }

    if (nombre === "consultar_disponibilidad_taller") {
      const serv = await servicioPorCodigo(input.codigo_servicio);
      if (!serv) return { error: "No encuentro el servicio " + input.codigo_servicio + ". Consulta primero consultar_servicios_taller." };
      const { data, error } = await taller.rpc("web_horarios_disponibles", {
        p_fecha: input.fecha,
        p_servicio_id: serv.id,
      });
      if (error) return { error: error.message };
      if (!data?.abierto) {
        return {
          fecha: input.fecha,
          hay_espacio: false,
          nota: "Ese día el taller está cerrado o la fecha ya pasó. Horario: L-J 9:00am-5:30pm, V 9:00am-5:00pm, S 9:00am-1:00pm, domingos cerrado.",
        };
      }
      const horarios = data.horarios || [];
      if (!horarios.length) {
        return {
          fecha: input.fecha,
          servicio: serv.nombre,
          hay_espacio: false,
          nota: "Ese día ya está lleno para este servicio. Ofrece otra fecha cercana.",
        };
      }
      return {
        fecha: input.fecha,
        servicio: serv.nombre,
        hay_espacio: true,
        horarios_disponibles: horarios,
        nota: "Ofrécele al cliente 3 o 4 de estos horarios para que elija. No le menciones cuánto dura el servicio.",
      };
    }

    if (nombre === "agendar_cita_taller") {
      const serv = await servicioPorCodigo(input.codigo_servicio);
      if (!serv) return { error: "Servicio no válido: " + input.codigo_servicio };
      // Revalidar que la hora siga disponible (mismos cupos que la página web)
      const { data: disp } = await taller.rpc("web_horarios_disponibles", {
        p_fecha: input.fecha,
        p_servicio_id: serv.id,
      });
      const horarios = disp?.horarios || [];
      if (!disp?.abierto || !horarios.includes(input.hora)) {
        return {
          error: "Ese horario ya no está disponible.",
          horarios_disponibles: horarios,
          nota: "Ofrécele al cliente los horarios que sí están disponibles.",
        };
      }
      const { holgura } = await configTaller();
      const { data, error } = await taller
        .from("citas")
        .insert({
          fecha: input.fecha,
          hora_inicio: input.hora,
          cliente: input.cliente,
          telefono: telefonoWa || null,
          placa: (input.placa || "").toUpperCase() || null,
          servicio_id: serv.id,
          estado: "Agendada",
          origen: "whatsapp",
          modelo: input.modelo || null,
          kilometraje: Number.isFinite(Number(input.kilometraje)) ? Math.round(Number(input.kilometraje)) : null,
          duracion_min: Number(serv.minutos_agenda || 60) + holgura,
        })
        .select("id")
        .single();
      if (error) return { error: error.message };
      return {
        ok: true,
        cita_numero: data.id,
        detalle: `Cita #${data.id} (${serv.nombre}) agendada para el ${input.fecha} a las ${input.hora}.`,
      };
    }

    if (nombre === "consultar_motos_disponibles") {
      const { data, error } = await taller
        .from("motos_catalogo")
        .select("nombre, categoria, precio, precio_promo, promo_texto, colores, caracteristicas")
        .eq("activo", true)
        .order("orden");
      if (error) return { error: error.message };
      const motos = (data || []).map((m) => ({
        modelo: m.nombre,
        categoria: m.categoria || null,
        precio: m.precio ? Number(m.precio) : null,
        ...(m.precio_promo ? { precio_promocion: Number(m.precio_promo) } : {}),
        ...(m.promo_texto ? { promo: m.promo_texto } : {}),
        ...(m.colores ? { colores: m.colores } : {}),
        ...(m.caracteristicas
          ? { caracteristicas: String(m.caracteristicas).split("\n").filter(Boolean).slice(0, 4) }
          : {}),
      }));
      return {
        motos,
        nota:
          "Precios de contado con IVA, catálogo vigente. Si una moto tiene precio_promocion o promo, cotiza con la promoción y menciónala como oferta del mes (el precio normal es el de referencia). Si el modelo que pide el cliente no aparece aquí, dile que consultas disponibilidad con un asesor; no inventes precios.",
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

// Avisos de "moto lista": el botón en TallerNet marca el registro y aquí se envía por plantilla.
async function enviarAvisosMotoLista() {
  if (!taller) return;
  const { data } = await taller
    .from("registros")
    .select("id, placa, cliente, telefono")
    .eq("aviso_listo_solicitado", true)
    .is("aviso_listo_enviado_at", null)
    .not("telefono", "is", null)
    .limit(10);
  for (const r of data || []) {
    const tel = String(r.telefono).replace(/\D/g, "");
    const e = await enviarWhatsAppPlantilla(
      tel,
      process.env.TEMPLATE_MOTO_LISTA || "moto_lista",
      process.env.TEMPLATE_IDIOMA || "es_CO",
      [r.cliente || "cliente", r.placa],
      []
    );
    await taller
      .from("registros")
      .update(
        e.ok
          ? { aviso_listo_enviado_at: new Date().toISOString(), aviso_listo_solicitado: false }
          : { aviso_listo_solicitado: false }
      )
      .eq("id", r.id);
    console.log("[tallernet] aviso moto lista", r.placa, e.ok ? "enviado" : "FALLÓ (¿plantilla moto_lista aprobada?)");
  }
}

export function iniciarAvisosMotoLista() {
  if (!taller) return;
  enviarAvisosMotoLista();
  setInterval(enviarAvisosMotoLista, 60 * 1000);
  taller
    .channel("avisos-moto-lista")
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "registros" },
      (p) => { if (p.new?.aviso_listo_solicitado) enviarAvisosMotoLista(); })
    .subscribe((s) => console.log("[tallernet] realtime registros:", s));
  console.log("[tallernet] avisos de moto lista activos");
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
