// memoria.js — Guarda historial y estado de handoff.
// Usa Supabase si hay credenciales; si no, usa memoria local (para simulación).

import { createClient } from "@supabase/supabase-js";

const USAR_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
const supabase = USAR_SUPABASE
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;

// Cuántas horas se calla el agente tras pasar un lead al asesor.
// Pasado ese tiempo, si el cliente escribe de nuevo, el bot retoma.
const HORAS_HANDOFF = 12;

// Fallback en memoria (se pierde al reiniciar; solo para pruebas locales)
const local = new Map(); // telefono -> { mensajes: [], humano: bool, desde: Date }

function getLocal(telefono) {
  if (!local.has(telefono)) local.set(telefono, { mensajes: [], humano: false, desde: null });
  return local.get(telefono);
}

export async function guardarMensaje(telefono, rol, contenido) {
  if (USAR_SUPABASE) {
    await supabase.from("mensajes").insert({ telefono, rol, contenido });
    return;
  }
  getLocal(telefono).mensajes.push({ rol, contenido });
}

export async function getHistorial(telefono, limite = 20) {
  if (USAR_SUPABASE) {
    // Traemos los MÁS RECIENTES (descending) y luego los invertimos,
    // porque la API necesita orden cronológico (viejo → nuevo).
    const { data } = await supabase
      .from("mensajes")
      .select("rol, contenido, created_at")
      .eq("telefono", telefono)
      .order("created_at", { ascending: false })
      .limit(limite);
    if (!data) return [];
    return data
      .slice()
      .reverse()
      .map((m) => ({ rol: m.rol, contenido: m.contenido }));
  }
  return getLocal(telefono).mensajes.slice(-limite);
}

export async function marcarHumano(telefono, valor) {
  if (USAR_SUPABASE) {
    await supabase
      .from("conversaciones")
      .upsert({ telefono, requiere_humano: valor, actualizado: new Date() });
    return;
  }
  const l = getLocal(telefono);
  l.humano = valor;
  l.desde = valor ? new Date() : null;
  if (valor) l._huboHandoff = true;
}

/**
 * ¿La conversación está en manos del asesor AHORA?
 * Devuelve true solo si está marcada Y no han pasado más de HORAS_HANDOFF.
 * Si el tiempo venció, libera automáticamente al cliente (el bot retoma).
 */
export async function estaEnHumano(telefono) {
  if (USAR_SUPABASE) {
    const { data } = await supabase
      .from("conversaciones")
      .select("requiere_humano, actualizado")
      .eq("telefono", telefono)
      .maybeSingle();

    if (!data || !data.requiere_humano) return false;

    const marcadoDesde = new Date(data.actualizado);
    const horas = (Date.now() - marcadoDesde.getTime()) / (1000 * 60 * 60);

    if (horas >= HORAS_HANDOFF) {
      await supabase
        .from("conversaciones")
        .update({ requiere_humano: false, actualizado: new Date() })
        .eq("telefono", telefono);
      return false;
    }
    return true;
  }

  const l = getLocal(telefono);
  if (!l.humano) return false;
  if (!l.desde) return true;
  const horas = (Date.now() - l.desde.getTime()) / (1000 * 60 * 60);
  if (horas >= HORAS_HANDOFF) {
    l.humano = false;
    l.desde = null;
    return false;
  }
  return true;
}

/**
 * NUEVO — ¿El chat está bajo CONTROL HUMANO desde el panel?
 * A diferencia del pase al asesor, esta bandera no vence sola:
 * se activa y desactiva con los botones del Centro de Chats.
 * Mientras esté activa, el bot guarda lo que el cliente escribe pero NO responde.
 */
export async function estaBajoControlHumano(telefono) {
  if (USAR_SUPABASE) {
    const { data } = await supabase
      .from("conversaciones")
      .select("control_humano")
      .eq("telefono", telefono)
      .maybeSingle();
    return !!(data && data.control_humano);
  }
  return false;
}

/**
 * ¿A este cliente se le pasó un lead al asesor ALGUNA vez?
 * Ajustado: la señal es que exista la marca de tiempo del handoff (actualizado),
 * porque el panel de chats también puede crear filas en conversaciones
 * (para el control humano) sin que haya habido pase al asesor.
 */
export async function yaFuePasadoAntes(telefono) {
  if (USAR_SUPABASE) {
    const { data } = await supabase
      .from("conversaciones")
      .select("actualizado")
      .eq("telefono", telefono)
      .maybeSingle();
    return !!(data && data.actualizado);
  }
  const l = getLocal(telefono);
  return l._huboHandoff === true;
}

/**
 * NUEVO — Despacho de mensajes manuales escritos en el Centro de Chats.
 * El panel inserta en la tabla `salientes`; aquí se detectan (tiempo real +
 * chequeo cada 15 s) y se envían por WhatsApp con la función que reciba.
 * Llamar una vez al arrancar: iniciarEnvioManual(enviarWhatsApp)
 */
export function iniciarEnvioManual(enviarFn) {
  if (!USAR_SUPABASE) return;

  async function despachar() {
    const { data } = await supabase
      .from("salientes")
      .select("*")
      .eq("estado", "POR ENVIAR")
      .order("created_at", { ascending: true })
      .limit(10);
    for (const s of data || []) {
      const ok = await enviarFn(s.telefono, s.contenido);
      await supabase
        .from("salientes")
        .update(
          ok !== false
            ? { estado: "ENVIADO", enviado_at: new Date().toISOString() }
            : { estado: "ERROR" }
        )
        .eq("id", s.id);
      if (ok !== false) {
        // Queda en el historial como mensaje del taller
        await supabase.from("mensajes").insert({
          telefono: s.telefono,
          rol: "assistant",
          contenido: s.contenido,
        });
      }
      console.log("[chats] manual →", s.telefono, ok !== false ? "enviado" : "ERROR");
    }
  }

  supabase
    .channel("salientes-nuevos")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "salientes" },
      () => despachar()
    )
    .subscribe((s) => console.log("[chats] realtime salientes:", s));

  despachar();
  setInterval(despachar, 15000);
  console.log("[chats] envío manual desde el panel activo");
}
