// seguimientos.js — Seguimiento automático de cotizaciones de crédito hechas en CarteraNet.
// Flujo:
//  1. SINCRONIZAR: cada media hora lee los prospectos COTIZADOS de CarteraNet (pestaña Cotizar),
//     los marca como ⭐ Cliente potencial en el Centro de Chats y les crea un plan de seguimiento.
//  2. ENVIAR: una vez al día (10 am Colombia) manda la plantilla seguimiento_cotizacion a los que
//     tienen seguimiento vencido: primer toque a los 3 días de la cotización, luego cada 7 días,
//     máximo 3 intentos (más toques = riesgo de bloqueo del número por spam).
//  3. PARAR: si el cliente dice que ya no le interesa, el agente usa la herramienta
//     cliente_no_interesado y no se le vuelve a escribir. Si el cliente está conversando
//     activamente (escribió en los últimos 5 días), el toque se aplaza — no interrumpimos.
//  4. CRM: cada envío, conversión o descarte queda anotado como gestión en el CRM de CarteraNet
//     (tabla seguimientos_crm) y actualiza el estado del prospecto (DESEMBOLSADO / PERDIDO).
// Requiere: plantilla seguimiento_cotizacion aprobada en Meta (2 variables: nombre, moto/crédito)
// y la tabla seguimientos_cotizacion en la base del AGENTE (ver SQL).

import { createClient } from "@supabase/supabase-js";
import { enviarWhatsAppPlantilla } from "./whatsapp.js";

const agente =
  process.env.SUPABASE_URL && process.env.SUPABASE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;
const cartera =
  process.env.CARTERA_URL && process.env.CARTERA_SERVICE_KEY
    ? createClient(process.env.CARTERA_URL, process.env.CARTERA_SERVICE_KEY)
    : null;

if (!agente || !cartera)
  console.warn("[seguimientos] Faltan credenciales (agente o cartera): seguimiento de cotizaciones apagado.");

const HORA_ENVIO = 10; // 10 am Colombia
const DIAS_PRIMER_TOQUE = 3;
const DIAS_ENTRE_TOQUES = 7;
const MAX_INTENTOS = 3;
const DIAS_CONVERSACION_VIVA = 5; // si el cliente escribió hace menos de esto, no interrumpir

function horaColombia() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Bogota", hour: "numeric", hour12: false }).format(new Date()));
}
function fechaColombia(offsetDias = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date(Date.now() + offsetDias * 86400000));
}
function telWA(t) {
  const d = String(t || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("57")) return d;
  if (d.length === 10 && d.startsWith("3")) return "57" + d;
  return null;
}
function primerNombre(n) {
  return String(n || "").trim().split(/\s+/)[0] || "cliente";
}

// ── 0) Cotizador de la pestaña Atención al cliente ──────────────────────────
// Las cotizaciones hechas en la app de chats (tabla cotizaciones_chat) NO tocan
// CarteraNet: aquí mismo se les crea el plan de seguimiento por WhatsApp y se
// marcan como ⭐ Cliente potencial en el panel. La tasa también vive en la base
// del agente (cotizador_datos) y la administra el admin desde la propia app.
export async function bajarCotizacionesChat() {
  if (!agente) return;
  const { data: pend, error } = await agente.from("cotizaciones_chat").select("*").eq("sincronizada", false).limit(100);
  if (error) { console.error("[cotizador] error leyendo cotizaciones del chat:", error.message); return; }
  for (const c of pend || []) {
    const d = c.datos || {};
    const refId = "CHAT-" + c.id; // referencia interna; no existe en el CRM de CarteraNet
    const tel = telWA(c.telefono);
    const moto = d.tipo === "MOTO" && d.nombreMoto ? "la " + d.nombreMoto : "el crédito que cotizaste";

    if (tel) {
      // Plan de seguimiento: primer toque a los 3 días de la cotización
      const base = c.created_at ? new Date(c.created_at) : new Date();
      let proximo = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date(base.getTime() + DIAS_PRIMER_TOQUE * 86400000));
      if (proximo <= fechaColombia()) proximo = fechaColombia(1);
      const { error: e1 } = await agente.from("seguimientos_cotizacion").insert({
        prospecto_id: refId, telefono: tel, nombre: c.nombre || "", moto, intentos: 0, proximo, estado: "ACTIVO",
      });
      if (e1) { console.error("[cotizador] error creando seguimiento:", e1.message); continue; }

      // Marcarlo como ⭐ Cliente potencial (sin pisar una etapa ya avanzada)
      const { data: conv } = await agente.from("conversaciones").select("telefono, es_lead, lead_etapa").eq("telefono", tel).maybeSingle();
      if (!conv || !conv.es_lead) {
        await agente.from("conversaciones").upsert({
          telefono: tel, es_lead: true, lead_etapa: "Nuevo",
          nombre: c.nombre || null,
          lead_moto: d.tipo === "MOTO" ? (d.nombreMoto || null) : null,
          lead_resumen: (c.nombre || "Cliente") + " · cotización hecha en Atención al cliente · " + (d.tipo === "MOTO" ? (d.nombreMoto || "moto") : "crédito en efectivo"),
          lead_marcado_at: new Date().toISOString(),
        });
      }
    }
    await agente.from("cotizaciones_chat").update({ sincronizada: true, prospecto_id: refId }).eq("id", c.id);
    console.log("[cotizador] cotización de " + (c.nombre || c.telefono || "cliente") + (tel ? " entró a seguimiento." : " guardada (sin celular: sin seguimiento)."));
  }
}

// ── 1) Sincronizar cotizaciones nuevas de CarteraNet ─────────────────────────
let sincronizando = false;
export async function sincronizarCotizaciones() {
  if (!agente || !cartera || sincronizando) return;
  sincronizando = true;
  try {
    // Prospectos cotizados en CarteraNet (por páginas de 1000)
    let prospectos = [];
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await cartera.from("prospectos").select("id, nombre, telefono, estado, tipo_cotizacion, nombre_moto, created_at").range(desde, desde + 999);
      if (error) { console.error("[seguimientos] error leyendo prospectos:", error.message); return; }
      prospectos = prospectos.concat(data || []);
      if (!data || data.length < 1000) break;
    }
    // Los que ya tienen seguimiento
    let existentes = [];
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await agente.from("seguimientos_cotizacion").select("prospecto_id").range(desde, desde + 999);
      if (error) { console.error("[seguimientos] error leyendo seguimientos:", error.message); return; }
      existentes = existentes.concat(data || []);
      if (!data || data.length < 1000) break;
    }
    const ya = new Set(existentes.map((r) => r.prospecto_id));

    let nuevos = 0;
    for (const p of prospectos) {
      if (ya.has(p.id)) continue;
      const tel = telWA(p.telefono);
      if (!tel) continue; // sin teléfono no hay seguimiento
      const moto = p.tipo_cotizacion === "MOTO" && p.nombre_moto ? "la " + p.nombre_moto : "el crédito que cotizaste";

      // Primer toque: 3 días después de la cotización (si ya pasaron, mañana)
      const base = p.created_at ? new Date(p.created_at) : new Date();
      let proximo = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date(base.getTime() + DIAS_PRIMER_TOQUE * 86400000));
      if (proximo <= fechaColombia()) proximo = fechaColombia(1);

      const { error: e1 } = await agente.from("seguimientos_cotizacion").insert({
        prospecto_id: p.id, telefono: tel, nombre: p.nombre || "", moto, intentos: 0, proximo, estado: "ACTIVO",
      });
      if (e1) { console.error("[seguimientos] error insertando:", e1.message); continue; }

      // Marcarlo como ⭐ Cliente potencial en el Centro de Chats (sin pisar una etapa ya avanzada)
      const { data: conv } = await agente.from("conversaciones").select("telefono, es_lead, lead_etapa").eq("telefono", tel).maybeSingle();
      if (!conv || !conv.es_lead) {
        await agente.from("conversaciones").upsert({
          telefono: tel, es_lead: true, lead_etapa: "Nuevo",
          nombre: p.nombre || null,
          lead_moto: p.tipo_cotizacion === "MOTO" ? (p.nombre_moto || null) : null,
          lead_resumen: (p.nombre || "Cliente") + " · cotización de crédito hecha en el almacén (CarteraNet) · " + (p.tipo_cotizacion === "MOTO" ? (p.nombre_moto || "moto") : "crédito en efectivo"),
          lead_marcado_at: new Date().toISOString(),
        });
      }
      nuevos++;
    }
    if (nuevos) console.log(`[seguimientos] ${nuevos} cotizaciones nuevas entraron a seguimiento.`);
  } finally {
    sincronizando = false;
  }
}

// Anota la gestión en el CRM de CarteraNet (tabla seguimientos_crm, mismo formato de la app)
// y opcionalmente actualiza el estado del prospecto (CONTACTADO/DESEMBOLSADO/PERDIDO...).
async function anotarCRM(prospectoId, nota, nuevoEstado) {
  if (!cartera || !prospectoId) return;
  if (String(prospectoId).startsWith("CHAT-")) return; // cotización del chat: no está en el CRM de CarteraNet
  try {
    await cartera.from("seguimientos_crm").insert({
      id: "SEG-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
      prospecto_id: prospectoId,
      tipo: "WHATSAPP",
      fecha: fechaColombia(),
      nota,
      registrado_por: "Agente HondaSur",
      created_at: new Date().toISOString(),
    });
    if (nuevoEstado) await cartera.from("prospectos").update({ estado: nuevoEstado }).eq("id", prospectoId);
  } catch (e) {
    console.error("[seguimientos] no se pudo anotar en el CRM:", e?.message);
  }
}

// ── 2) Enviar los seguimientos vencidos (una vez al día) ─────────────────────
let ultimoEnvio = "";
export async function enviarSeguimientos() {
  if (!agente || !cartera) return;
  const hoyStr = fechaColombia();
  if (ultimoEnvio === hoyStr) return;
  if (horaColombia() < HORA_ENVIO) return;
  ultimoEnvio = hoyStr;

  const { data: due, error } = await agente
    .from("seguimientos_cotizacion").select("*")
    .eq("estado", "ACTIVO").lte("proximo", hoyStr).limit(100);
  if (error) { console.error("[seguimientos] error leyendo vencidos:", error.message); return; }

  for (const s of due || []) {
    // ¿El cliente ya dijo que no, o Gloria lo descartó?
    const { data: conv } = await agente.from("conversaciones").select("lead_etapa, control_humano").eq("telefono", s.telefono).maybeSingle();
    if (conv && conv.lead_etapa === "Descartado") {
      await agente.from("seguimientos_cotizacion").update({ estado: "DETENIDO" }).eq("id", s.id);
      continue;
    }
    // ¿Ya es cliente de cartera? (compró: misión cumplida)
    const { data: cred } = await cartera.from("creditos").select("id").eq("estado", "ACTIVO").ilike("telefono", "%" + s.telefono.slice(-10)).limit(1);
    if (cred && cred.length) {
      await agente.from("seguimientos_cotizacion").update({ estado: "CONVERTIDO" }).eq("id", s.id);
      await anotarCRM(s.prospecto_id, "🎉 El cliente compró: se detectó crédito activo en la cartera. Seguimiento cerrado.", "DESEMBOLSADO");
      continue;
    }
    // ¿Está conversando activamente? No interrumpir: aplazar sin gastar intento.
    const { data: ult } = await agente.from("mensajes").select("created_at").eq("telefono", s.telefono).eq("rol", "user").order("created_at", { ascending: false }).limit(1);
    if (ult && ult[0] && (Date.now() - new Date(ult[0].created_at).getTime()) < DIAS_CONVERSACION_VIVA * 86400000) {
      await agente.from("seguimientos_cotizacion").update({ proximo: fechaColombia(DIAS_ENTRE_TOQUES) }).eq("id", s.id);
      continue;
    }

    const nombre = primerNombre(s.nombre);
    const idioma = process.env.TEMPLATE_IDIOMA || "es_CO";
    let e = await enviarWhatsAppPlantilla(s.telefono, "seguimiento_cotizacion", idioma, [nombre, s.moto], []);
    if (!e.ok) e = await enviarWhatsAppPlantilla(s.telefono, "seguimiento_cotizacion", idioma === "es" ? "es_CO" : "es", [nombre, s.moto], []);

    if (e.ok) {
      const intentos = (s.intentos || 0) + 1;
      await agente.from("seguimientos_cotizacion").update({
        intentos, proximo: fechaColombia(DIAS_ENTRE_TOQUES),
        estado: intentos >= MAX_INTENTOS ? "AGOTADO" : "ACTIVO",
      }).eq("id", s.id);
      await anotarCRM(s.prospecto_id,
        "Seguimiento automático " + intentos + " de " + MAX_INTENTOS + " enviado por WhatsApp: ¿sigue interesado en " + s.moto + "?" +
        (intentos >= MAX_INTENTOS ? " ÚLTIMO toque: si no responde, queda en manos del equipo." : ""));
      // Dejar constancia en el chat, para que el equipo lo vea en el Centro de Chats
      await agente.from("mensajes").insert({
        telefono: s.telefono, rol: "assistant",
        contenido: "Hola " + nombre + ", te saluda HondaSur 👋 Hace unos días te cotizamos " + s.moto + " y queremos saber si sigues interesado. Respóndenos por aquí y con gusto resolvemos tus dudas o te ayudamos a dar el paso 🏍 Si prefieres que no te escribamos más sobre esto, solo dínoslo.",
      });
      console.log("[seguimientos] toque", intentos, "→", s.nombre, "(" + s.telefono + ")");
    } else {
      console.error("[seguimientos] FALLÓ el envío a", s.telefono, "(¿plantilla seguimiento_cotizacion aprobada?)");
    }
    await new Promise((ok) => setTimeout(ok, 1200));
  }
}

// ── 3) Herramienta del agente: el cliente dice que ya no le interesa ─────────
export const HERRAMIENTA_NO_INTERESADO = {
  name: "cliente_no_interesado",
  description:
    "Úsala cuando el cliente diga claramente que YA NO está interesado en la moto o el crédito que cotizó, o que no quiere que le escribamos más sobre eso. Detiene los mensajes de seguimiento y lo marca como descartado en el panel. Después de usarla, despídete con amabilidad dejando la puerta abierta ('cuando quieras retomarlo, aquí estamos').",
  input_schema: { type: "object", properties: {}, required: [] },
};

export async function marcarNoInteresado(telefono) {
  if (!agente) return { ok: false };
  const tel = telWA(telefono) || telefono;
  const { data: segs } = await agente.from("seguimientos_cotizacion").select("prospecto_id").eq("telefono", tel);
  await agente.from("seguimientos_cotizacion").update({ estado: "DETENIDO" }).eq("telefono", tel).eq("estado", "ACTIVO");
  await agente.from("conversaciones").upsert({ telefono: tel, lead_etapa: "Descartado" });
  for (const s of segs || []) {
    await anotarCRM(s.prospecto_id, "El cliente respondió por WhatsApp que YA NO está interesado. Seguimiento detenido.", "PERDIDO");
  }
  return { ok: true, mensaje: "Seguimiento detenido: no se le volverá a escribir sobre la cotización. Despídete con amabilidad." };
}

export function iniciarSeguimientosCotizacion() {
  if (!agente || !cartera) return;
  const ciclo = async () => {
    await bajarCotizacionesChat();    // cotizaciones del chat entran a seguimiento
    await sincronizarCotizaciones();  // y las de CarteraNet, como siempre
  };
  ciclo();
  setInterval(ciclo, 5 * 60 * 1000);           // ciclo completo cada 5 min
  setInterval(enviarSeguimientos, 15 * 60 * 1000); // envía a las 10 am (revisa cada 15 min)
  console.log("[seguimientos] seguimiento de cotizaciones iniciado.");
}
