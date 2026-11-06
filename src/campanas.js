// campanas.js — Campañas promocionales por WhatsApp (plantillas de marketing de Meta)
// dirigidas a los clientes de CarteraNet, disparadas desde el botón 📣 Campañas
// de Honda Sur Central (solo administrador).
//
// Flujo:
//  1. La app llama POST /campanas con el token del admin:
//       previsualizar → cuántos clientes recibirían la campaña (y por qué se excluyen otros)
//       crear         → guarda la campaña y encola un envío por cliente (estado PENDIENTE)
//       listar        → historial con contadores
//       detener       → cancela lo que falte por enviar
//       vigente       → marca/desmarca la campaña como vigente para que el agente la explique
//  2. despacharCampanas() corre cada 20 s y envía los PENDIENTE de a pocos (1,3 s entre
//     mensajes) usando la plantilla aprobada en Meta. Deja constancia en `mensajes` para que
//     el envío aparezca en el chat del cliente.
//  3. campanaVigente() se inyecta en el prompt del agente: así sabe explicar el bono.
//
// Reglas duras: nunca se envía a clientes con sin_recordatorios, en proceso jurídico
// (dificil_recaudo), sin celular válido, ni a quien pidió no recibir promociones
// (tabla no_promociones). Un mismo celular recibe la campaña una sola vez.

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

const ADMIN_CORREOS = ["camilo290491@gmail.com"];

// Plantillas que la app puede usar. El texto_vista es lo que se guarda en el chat
// (debe coincidir con el cuerpo aprobado en Meta). Las variables van en orden.
export const PLANTILLAS_CAMPANA = {
  bono_accesorios: {
    variables: ["nombre", "valor", "fecha_fin"],
    texto: (v) =>
      `Hola ${v.nombre} 👋 En HondaSur queremos darte las gracias por haber comprado tu moto con nosotros 🏍 ` +
      `Por eso te regalamos un bono de ${v.valor} para redimir en accesorios originales en nuestro almacén de Caldas. ` +
      `Es válido hasta el ${v.fecha_fin}: solo pasa con tu cédula y lo haces efectivo. ¡Te esperamos! 🙌`,
  },
};

const fmtCOP = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("es-CO");
const primerNombre = (n) => String(n || "").trim().split(/\s+/)[0] || "cliente";
function telWA(t) {
  const d = String(t || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("57")) return d;
  if (d.length === 10 && d.startsWith("3")) return "57" + d;
  return null;
}

async function esAdmin(token) {
  const URL_SB = process.env.SUPABASE_URL, LLAVE = process.env.SUPABASE_KEY;
  if (!URL_SB || !LLAVE || !token) return null;
  const r = await fetch(URL_SB + "/auth/v1/user", { headers: { apikey: LLAVE, Authorization: "Bearer " + token } });
  const u = r.ok ? await r.json() : null;
  const correo = String(u?.email || "").toLowerCase();
  return ADMIN_CORREOS.includes(correo) ? correo : null;
}

// ── Destinatarios según el segmento ─────────────────────────────────────────
//  activos : créditos con estado ACTIVO (clientes que hoy pagan su moto)
//  todos   : cualquier crédito registrado (incluye los ya cancelados)
async function destinatarios(segmento) {
  if (!cartera) throw new Error("El servidor no tiene acceso a CarteraNet.");
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await cartera
      .from("creditos")
      .select("id, cliente, telefono, estado, sin_recordatorios, dificil_recaudo, articulo")
      .order("id", { ascending: true })
      .range(desde, desde + 999);
    if (error) throw new Error("CarteraNet: " + error.message);
    filas.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const { data: vetados } = await agente.from("no_promociones").select("telefono");
  const sinPromos = new Set((vetados || []).map((v) => v.telefono));

  const motivos = { otro_estado: 0, sin_celular: 0, sin_recordatorios: 0, juridico: 0, no_promociones: 0, repetidos: 0 };
  const vistos = new Set();
  const lista = [];
  for (const cr of filas) {
    if (segmento === "activos" && String(cr.estado || "").toUpperCase() !== "ACTIVO") { motivos.otro_estado++; continue; }
    const tel = telWA(cr.telefono);
    if (!tel) { motivos.sin_celular++; continue; }
    if (cr.sin_recordatorios === true || cr.sin_recordatorios === "true") { motivos.sin_recordatorios++; continue; }
    if (cr.dificil_recaudo === true || cr.dificil_recaudo === "true") { motivos.juridico++; continue; }
    if (sinPromos.has(tel)) { motivos.no_promociones++; continue; }
    if (vistos.has(tel)) { motivos.repetidos++; continue; }
    vistos.add(tel);
    lista.push({ telefono: tel, nombre: String(cr.cliente || "").trim(), articulo: cr.articulo || "" });
  }
  return { lista, motivos, total_base: filas.length };
}

// ── Manejador HTTP (lo monta server.js en POST /campanas) ───────────────────
export async function manejarCampanas(req, res) {
  try {
    if (!agente) return res.json({ ok: false, error: "Servidor sin base de datos." });
    const { accion, token } = req.body || {};
    const admin = await esAdmin(token);
    if (!admin) return res.json({ ok: false, error: "Solo el administrador puede manejar campañas." });

    if (accion === "previsualizar") {
      const { segmento } = req.body;
      const d = await destinatarios(segmento || "activos");
      return res.json({ ok: true, total: d.lista.length, muestra: d.lista.slice(0, 6).map((x) => x.nombre || x.telefono), excluidos: d.motivos, total_base: d.total_base });
    }

    if (accion === "crear") {
      const { nombre, plantilla, segmento, valor, fecha_fin, condiciones } = req.body;
      const def = PLANTILLAS_CAMPANA[plantilla];
      if (!def) return res.json({ ok: false, error: "Plantilla desconocida." });
      if (!(Number(valor) > 0)) return res.json({ ok: false, error: "Escribe el valor del bono." });
      if (!fecha_fin) return res.json({ ok: false, error: "Escribe hasta cuándo es válido." });
      const d = await destinatarios(segmento || "activos");
      if (!d.lista.length) return res.json({ ok: false, error: "No hay destinatarios para ese segmento." });
      const params = { valor: fmtCOP(valor), fecha_fin: String(fecha_fin).trim() };
      const { data: cam, error } = await agente
        .from("campanas")
        .insert({
          nombre: String(nombre || "Campaña").trim().slice(0, 80),
          plantilla, segmento: segmento || "activos", params,
          condiciones: String(condiciones || "").slice(0, 1200),
          estado: "ENVIANDO", vigente: true, creado_por: admin,
          total: d.lista.length, enviados: 0, errores: 0,
        })
        .select("id")
        .single();
      if (error) return res.json({ ok: false, error: "No se pudo crear la campaña: " + error.message });
      // Encolar de a 500 para no pasarse del tamaño de petición
      for (let i = 0; i < d.lista.length; i += 500) {
        const trozo = d.lista.slice(i, i + 500).map((x) => ({ campana_id: cam.id, telefono: x.telefono, nombre: x.nombre, estado: "PENDIENTE" }));
        const { error: e2 } = await agente.from("campanas_envios").insert(trozo);
        if (e2) return res.json({ ok: false, error: "No se pudo encolar: " + e2.message });
      }
      return res.json({ ok: true, id: cam.id, total: d.lista.length, mensaje: `Campaña creada: ${d.lista.length} clientes en cola. El envío arranca en menos de un minuto.` });
    }

    if (accion === "listar") {
      const { data } = await agente.from("campanas").select("*").order("id", { ascending: false }).limit(20);
      return res.json({ ok: true, campanas: data || [] });
    }

    if (accion === "detener") {
      const { id } = req.body;
      await agente.from("campanas_envios").update({ estado: "OMITIDO", error: "detenida por el administrador" }).eq("campana_id", id).eq("estado", "PENDIENTE");
      await agente.from("campanas").update({ estado: "DETENIDA" }).eq("id", id);
      return res.json({ ok: true, mensaje: "Campaña detenida: no se enviará nada más." });
    }

    if (accion === "vigente") {
      const { id, vigente } = req.body;
      await agente.from("campanas").update({ vigente: !!vigente }).eq("id", id);
      cacheVigente = { hasta: 0, texto: "" };
      return res.json({ ok: true, mensaje: vigente ? "El agente volverá a explicar esta promoción." : "El agente dejará de ofrecer esta promoción." });
    }

    if (accion === "probar") {
      // Envía la plantilla SOLO al celular indicado (para que el admin vea cómo llega)
      const { telefono, plantilla, valor, fecha_fin } = req.body;
      const def = PLANTILLAS_CAMPANA[plantilla]; const tel = telWA(telefono);
      if (!def || !tel) return res.json({ ok: false, error: "Revisa la plantilla y el celular." });
      const v = { nombre: "Camilo", valor: fmtCOP(valor), fecha_fin: String(fecha_fin || "").trim() };
      const e = await enviarPlantillaCampana(tel, plantilla, v);
      return res.json({ ok: e.ok, mensaje: e.ok ? "Prueba enviada a " + tel : "Meta rechazó el envío. ¿La plantilla ya está aprobada con ese nombre e idioma?", detalle: e.error || null });
    }

    return res.json({ ok: false, error: "Acción no válida." });
  } catch (e) {
    res.json({ ok: false, error: "Error del servidor: " + e.message });
  }
}

async function enviarPlantillaCampana(tel, plantilla, v) {
  const def = PLANTILLAS_CAMPANA[plantilla];
  const params = def.variables.map((k) => v[k]);
  const idioma = process.env.TEMPLATE_IDIOMA || "es_CO";
  let e = await enviarWhatsAppPlantilla(tel, plantilla, idioma, params, []);
  if (!e.ok) e = await enviarWhatsAppPlantilla(tel, plantilla, idioma === "es" ? "es_CO" : "es", params, []);
  return e;
}

// ── Despacho de la cola ─────────────────────────────────────────────────────
let despachando = false;
export async function despacharCampanas() {
  if (!agente || despachando) return;
  despachando = true;
  try {
    const { data: cams } = await agente.from("campanas").select("*").eq("estado", "ENVIANDO").order("id", { ascending: true }).limit(1);
    const cam = cams && cams[0];
    if (!cam) return;
    const def = PLANTILLAS_CAMPANA[cam.plantilla];
    const { data: pend } = await agente.from("campanas_envios").select("*").eq("campana_id", cam.id).eq("estado", "PENDIENTE").order("id", { ascending: true }).limit(15);
    if (!pend || !pend.length) {
      await agente.from("campanas").update({ estado: "TERMINADA", terminada_el: new Date().toISOString() }).eq("id", cam.id);
      console.log("[campañas] terminada:", cam.nombre);
      return;
    }
    let ok = 0, mal = 0;
    for (const env of pend) {
      const v = { nombre: primerNombre(env.nombre), ...(cam.params || {}) };
      const e = def ? await enviarPlantillaCampana(env.telefono, cam.plantilla, v) : { ok: false, error: "plantilla desconocida" };
      if (e.ok) {
        ok++;
        await agente.from("campanas_envios").update({ estado: "ENVIADO", enviado_el: new Date().toISOString() }).eq("id", env.id);
        await agente.from("mensajes").insert({ telefono: env.telefono, rol: "assistant", contenido: def.texto(v) });
      } else {
        mal++;
        await agente.from("campanas_envios").update({ estado: "ERROR", error: String(e.error || "falló el envío").slice(0, 200) }).eq("id", env.id);
      }
      await new Promise((r) => setTimeout(r, 1300));
    }
    await agente.from("campanas").update({ enviados: (cam.enviados || 0) + ok, errores: (cam.errores || 0) + mal }).eq("id", cam.id);
    console.log(`[campañas] ${cam.nombre}: +${ok} enviados, +${mal} errores`);
  } catch (e) {
    console.error("[campañas] error despachando:", e.message);
  } finally {
    despachando = false;
  }
}

// ── Lo que el agente debe saber de la promoción vigente ─────────────────────
let cacheVigente = { hasta: 0, texto: "" };
export async function campanaVigente() {
  if (!agente) return "";
  if (Date.now() < cacheVigente.hasta) return cacheVigente.texto;
  let texto = "";
  try {
    const { data } = await agente.from("campanas").select("nombre, plantilla, params, condiciones, created_at").eq("vigente", true).order("id", { ascending: false }).limit(1);
    const c = data && data[0];
    if (c) {
      const p = c.params || {};
      texto =
        `\n\nPROMOCIÓN VIGENTE PARA CLIENTES (campaña "${c.nombre}"): a los clientes que compraron su moto con nosotros les enviamos por WhatsApp un bono de ${p.valor || ""} ` +
        `para redimir en accesorios originales en el almacén, válido hasta el ${p.fecha_fin || ""}. ` +
        `Si un cliente responde a ese mensaje o pregunta por el bono: agradécele, confírmale que el bono es suyo y que se redime en el almacén (Cra. 50 #125 Sur-104, Caldas) presentando su cédula; ` +
        `no se cambia por dinero ni se descuenta de cuotas del crédito. Si quiere saber qué accesorios hay, invítalo a pasar y verlos o dile que un asesor le cuenta por este chat. ` +
        (c.condiciones ? `Condiciones adicionales definidas por el almacén: ${c.condiciones} ` : "") +
        `Si pregunta si el bono aplica para comprar OTRA moto o para alguien más, dile que eso lo confirma el equipo en el almacén. ` +
        `Si el cliente dice que no quiere recibir más promociones o mensajes de este tipo, usa la herramienta no_mas_promociones y despídete con amabilidad.`;
    }
  } catch (e) { /* sin promoción */ }
  cacheVigente = { hasta: Date.now() + 60 * 1000, texto };
  return texto;
}

// ── Herramienta del agente: el cliente no quiere promociones ────────────────
export const HERRAMIENTA_NO_PROMOS = {
  name: "no_mas_promociones",
  description:
    "Úsala cuando el cliente diga que NO quiere recibir promociones, publicidad, bonos ni mensajes de este tipo (por ejemplo responde 'no más promociones', 'no me envíen publicidad', 'quítenme de la lista'). Lo saca de todas las campañas futuras. Después de usarla, confírmale en una frase que no le volveremos a enviar promociones y que el chat sigue abierto para lo que necesite.",
  input_schema: { type: "object", properties: {}, required: [] },
};
export async function marcarNoPromociones(telefono) {
  if (!agente) return { ok: false };
  const tel = telWA(telefono) || String(telefono).replace(/\D/g, "");
  await agente.from("no_promociones").upsert({ telefono: tel, motivo: "lo pidió por WhatsApp", created_at: new Date().toISOString() });
  await agente.from("campanas_envios").update({ estado: "OMITIDO", error: "cliente pidió no recibir promociones" }).eq("telefono", tel).eq("estado", "PENDIENTE");
  return { ok: true, mensaje: "Listo: este cliente no recibirá más campañas promocionales." };
}

export function iniciarCampanas() {
  if (!agente) return;
  setInterval(despacharCampanas, 20 * 1000);
  console.log("[campañas] despacho de campañas activo");
}
