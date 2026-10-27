// cartera.js — Recordatorios de pago de CarteraNet por WhatsApp.
// Requiere en Railway: CARTERA_URL y CARTERA_SERVICE_KEY (la sb_secret_ de CarteraNet).
// Plantillas aprobadas en Meta: recordatorio_cuota (4 vars), cuota_vencida (3 vars), saldo_mora (2 vars).
//
// Cómo funciona:
//  1. El panel 📣 Recordatorios de CarteraNet pone filas en recordatorios_pago con estado SOLICITADO
//     (botón "Enviar ya"). Aquí se despachan cada minuto.
//  2. Si config.recordatorios_auto = 'SI', una vez al día (9 am Colombia) se hace el barrido:
//     se calculan los tres grupos con el MISMO modelo de mora del panel y se encolan los que falten.
//     Todo pasa por la misma cola, así el historial del panel siempre muestra la verdad.
//  Reglas duras: máximo un mensaje de cada plantilla por cliente por mes (mes_ref);
//  clientes con sin_recordatorios = true jamás reciben nada; sin teléfono válido no se envía.

import { createClient } from "@supabase/supabase-js";
import { enviarWhatsAppPlantilla } from "./whatsapp.js";

const CARTERA_URL = process.env.CARTERA_URL;
const CARTERA_KEY = process.env.CARTERA_SERVICE_KEY;

const cartera =
  CARTERA_URL && CARTERA_KEY ? createClient(CARTERA_URL, CARTERA_KEY) : null;

if (!cartera) {
  console.warn(
    "[cartera] Sin CARTERA_URL / CARTERA_SERVICE_KEY: recordatorios de cartera en modo apagado."
  );
}

const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const fmt = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("es-CO");

function horaColombia() {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Bogota", hour: "numeric", hour12: false }).format(new Date())
  );
}
function fechaColombia() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
}
// "Hoy" como objeto {y,m,d} en hora Colombia (m = 0-11)
function hoyCol() {
  const [y, m, d] = fechaColombia().split("-").map(Number);
  return { y, m: m - 1, d };
}

// Teléfono normalizado a formato WhatsApp (57XXXXXXXXXX) o null — igual que en el panel
function telWA(t) {
  const d = String(t || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("57")) return d;
  if (d.length === 10 && d.startsWith("3")) return "57" + d;
  return null;
}

// Cuota real del crédito — igual que getCuotaReal del panel
function cuotaDe(cr) {
  if (cr.cuota_fija && Number(cr.cuota_fija) > 0) return Number(cr.cuota_fija);
  const cap = Number(cr.capital), tasa = Number(cr.tasa_mv), plazo = Number(cr.plazo);
  if (!cap || !tasa || !plazo) return 0;
  const i = tasa / 100;
  return Math.round((cap * i) / (1 - Math.pow(1 + i, -plazo)));
}

// Mora "en vivo" del mes actual — MISMO modelo de asistencia de la pestaña Alertas/Recordatorios.
// El sistema registra pagos en forma desde MAYO 2026; antes fueron ajustes.
function moraViva(cr, pagos, hoy) {
  try {
    const INICIO_SISTEMA = "2026-05-01";
    const inicioRegistro = new Date(2026, 4, 1);
    const diaPago = cr.dia_pago || 1;
    const iniMesRef = new Date(hoy.y, hoy.m, 1);
    if (cr.fecha_desembolso && new Date(cr.fecha_desembolso + "T12:00:00") >= iniMesRef)
      return { mesesSin: 0, pagoEsteMes: false, nuevoDelMes: true };
    const pcs = pagos.filter(
      (p) => p.credito_id === cr.id && p.estado === "ACTIVO" && p.fecha_pago && p.fecha_pago >= INICIO_SISTEMA
    );
    if (pcs.length === 0) {
      let inicioConteo = inicioRegistro;
      if (cr.fecha_desembolso) {
        const fd = new Date(cr.fecha_desembolso + "T12:00:00");
        const mesSig = new Date(fd.getFullYear(), fd.getMonth() + 1, 1);
        if (mesSig > inicioConteo) inicioConteo = mesSig;
      }
      let m = (hoy.y - inicioConteo.getFullYear()) * 12 + (hoy.m - inicioConteo.getMonth()) + 1;
      if (hoy.d < diaPago) m -= 1;
      return { mesesSin: Math.max(0, Math.min(m, 12)), pagoEsteMes: false };
    }
    let u = null;
    pcs.forEach((p) => {
      const d = new Date(p.fecha_pago + "T12:00:00");
      if (!u || d > u) u = d;
    });
    const diff = (hoy.y - u.getFullYear()) * 12 + (hoy.m - u.getMonth());
    if (diff <= 0) return { mesesSin: 0, pagoEsteMes: true };
    let m = diff;
    if (hoy.d < diaPago) m = diff - 1;
    return { mesesSin: Math.max(0, Math.min(m, 12)), pagoEsteMes: false };
  } catch (e) {
    return { mesesSin: 0, pagoEsteMes: false };
  }
}

// Días que faltan para el próximo vencimiento (día de pago, ajustado a meses cortos)
function diasHastaVencimiento(cr, hoy) {
  const ultimoDia = new Date(hoy.y, hoy.m + 1, 0).getDate();
  const dp = Math.min(cr.dia_pago || 1, ultimoDia);
  const hoy0 = new Date(hoy.y, hoy.m, hoy.d);
  let venc = new Date(hoy.y, hoy.m, dp);
  if (venc < hoy0) {
    const ultimoSig = new Date(hoy.y, hoy.m + 2, 0).getDate();
    venc = new Date(hoy.y, hoy.m + 1, Math.min(cr.dia_pago || 1, ultimoSig));
  }
  return { dias: Math.round((venc - hoy0) / 86400000), venc };
}

function nombreDe(cr) {
  return String(cr.cliente || "").trim().split(/\s+/)[0] || "cliente";
}

// Variables de cada plantilla — deben coincidir con los textos aprobados en Meta
function variablesDe(cr, plantilla, mesesSin, hoy) {
  const mesAct = MESES[hoy.m];
  const mesVenc = MESES[(hoy.m + 11) % 12];
  if (plantilla === "recordatorio_cuota") {
    const { venc } = diasHastaVencimiento(cr, hoy);
    return [nombreDe(cr), MESES[venc.getMonth()], fmt(cuotaDe(cr)), venc.getDate() + " de " + MESES[venc.getMonth()]];
  }
  if (plantilla === "cuota_vencida")
    return [nombreDe(cr), hoy.d < (cr.dia_pago || 1) ? mesVenc : mesAct, fmt(cuotaDe(cr))];
  return [nombreDe(cr), mesesSin + (mesesSin === 1 ? " cuota" : " cuotas")];
}

// ============================================================
// 1) DESPACHO de la cola (filas SOLICITADO → WhatsApp → ENVIADO/ERROR)
// ============================================================
let despachando = false;
async function despacharCola() {
  if (!cartera || despachando) return;
  despachando = true;
  try {
    const { data, error } = await cartera
      .from("recordatorios_pago")
      .select("*")
      .eq("estado", "SOLICITADO")
      .order("created_at", { ascending: true })
      .limit(25);
    if (error) { console.error("[cartera] error leyendo cola:", error.message); return; }
    for (const r of data || []) {
      const idioma = process.env.TEMPLATE_IDIOMA || "es_CO";
      const params = (r.variables || []).map(String);
      let e = await enviarWhatsAppPlantilla(r.telefono, r.plantilla, idioma, params, []);
      if (!e.ok) e = await enviarWhatsAppPlantilla(r.telefono, r.plantilla, idioma === "es" ? "es_CO" : "es", params, []);
      await cartera
        .from("recordatorios_pago")
        .update(
          e.ok
            ? { estado: "ENVIADO", enviado_at: new Date().toISOString() }
            : { estado: "ERROR", error_detalle: String(e.error || "Falló el envío (¿plantilla aprobada en Meta?)").slice(0, 400) }
        )
        .eq("id", r.id);
      console.log("[cartera] recordatorio", r.plantilla, "→", r.cliente, e.ok ? "enviado" : "FALLÓ");
      await new Promise((ok) => setTimeout(ok, 1200)); // pausa suave entre envíos
    }
  } finally {
    despachando = false;
  }
}

// ============================================================
// 2) BARRIDO automático diario (si config.recordatorios_auto = 'SI')
// ============================================================
const HORA_BARRIDO = 9; // 9 am Colombia
let ultimoBarrido = ""; // fecha Colombia del último barrido hecho

async function barridoDiario() {
  if (!cartera) return;
  const hoyStr = fechaColombia();
  if (ultimoBarrido === hoyStr) return;
  if (horaColombia() < HORA_BARRIDO) return;
  ultimoBarrido = hoyStr; // aunque falle algo abajo, no reintenta en bucle hasta mañana

  // Configuración del panel
  const { data: cf } = await cartera.from("config").select("*").in("clave", ["recordatorios_auto", "recordatorio_dias_antes"]);
  const auto = (cf || []).find((r) => r.clave === "recordatorios_auto")?.valor === "SI";
  const diasAntes = Number((cf || []).find((r) => r.clave === "recordatorio_dias_antes")?.valor) || 3;
  if (!auto) { console.log("[cartera] barrido: envío automático apagado."); return; }

  const hoy = hoyCol();
  const mesRef = hoy.y + "-" + String(hoy.m + 1).padStart(2, "0");

  const { data: creditos, error: e1 } = await cartera.from("creditos").select("*").eq("estado", "ACTIVO");
  if (e1) { console.error("[cartera] barrido: error leyendo créditos:", e1.message); return; }
  const { data: pagos, error: e2 } = await cartera.from("pagos").select("credito_id, estado, fecha_pago").gte("fecha_pago", "2026-05-01");
  if (e2) { console.error("[cartera] barrido: error leyendo pagos:", e2.message); return; }
  const { data: yaEnviados } = await cartera
    .from("recordatorios_pago")
    .select("credito_id, plantilla, estado")
    .eq("mes_ref", mesRef)
    .neq("estado", "ERROR");
  const ya = new Set((yaEnviados || []).map((r) => r.credito_id + "|" + r.plantilla));

  let encolados = 0;
  for (const cr of creditos || []) {
    if (cr.sin_recordatorios === true || cr.sin_recordatorios === "true") continue;
    const tel = telWA(cr.telefono);
    if (!tel) continue;

    const { mesesSin, pagoEsteMes, nuevoDelMes } = moraViva(cr, pagos || [], hoy);
    let plantilla = null, tipo = null;
    if (mesesSin >= 2) { plantilla = "saldo_mora"; tipo = "MORA"; }
    else if (mesesSin === 1) { plantilla = "cuota_vencida"; tipo = "VENCIDO"; }
    else if (!pagoEsteMes && !nuevoDelMes && diasHastaVencimiento(cr, hoy).dias <= diasAntes) {
      plantilla = "recordatorio_cuota"; tipo = "PROXIMO";
    }
    if (!plantilla) continue;
    if (ya.has(String(cr.id) + "|" + plantilla)) continue; // ya tiene el suyo este mes

    const { error } = await cartera.from("recordatorios_pago").insert({
      credito_id: String(cr.id),
      cliente: cr.cliente,
      telefono: tel,
      tipo,
      plantilla,
      variables: variablesDe(cr, plantilla, mesesSin, hoy),
      mes_ref: mesRef,
      estado: "SOLICITADO",
      solicitado_por: "auto",
    });
    if (!error) encolados++;
  }
  console.log(`[cartera] barrido ${hoyStr}: ${encolados} recordatorios encolados.`);
}

export function iniciarRecordatoriosCartera() {
  if (!cartera) return;
  despacharCola(); // al arrancar, despacha lo que haya quedado en cola
  setInterval(despacharCola, 60 * 1000);       // "Enviar ya" sale en máximo 1 minuto
  setInterval(barridoDiario, 15 * 60 * 1000);  // barrido automático: revisa cada 15 min desde las 9 am
  console.log("[cartera] recordatorios de pago iniciados.");
}
