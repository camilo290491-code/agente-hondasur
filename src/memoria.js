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
    // Si usáramos ascending + limit, traeríamos los más ANTIGUOS y el agente
    // nunca vería el mensaje actual del cliente.
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
      .single();

    if (!data || !data.requiere_humano) return false;

    // ¿Cuánto tiempo lleva en manos del asesor?
    const marcadoDesde = new Date(data.actualizado);
    const horas = (Date.now() - marcadoDesde.getTime()) / (1000 * 60 * 60);

    if (horas >= HORAS_HANDOFF) {
      // Venció la ventana: liberar al cliente para que el bot retome
      await supabase
        .from("conversaciones")
        .update({ requiere_humano: false, actualizado: new Date() })
        .eq("telefono", telefono);
      return false;
    }
    return true;
  }

  // Modo local (simulación)
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
 * Cuenta cuántos mensajes ha enviado el cliente DESPUÉS de ser pasado al asesor.
 * Sirve para variar el recordatorio y no sonar repetitivo.
 * Cuenta los mensajes del cliente ('user') desde la última vez que se marcó handoff.
 */
export async function contarMensajesTrasHandoff(telefono) {
  if (USAR_SUPABASE) {
    // Momento en que se marcó el handoff
    const { data: conv } = await supabase
      .from("conversaciones")
      .select("actualizado")
      .eq("telefono", telefono)
      .single();
    if (!conv) return 0;

    // Cuenta mensajes del cliente después de esa marca (menos el actual)
    const { count } = await supabase
      .from("mensajes")
      .select("*", { count: "exact", head: true })
      .eq("telefono", telefono)
      .eq("rol", "user")
      .gt("created_at", conv.actualizado);
    return Math.max(0, (count || 1) - 1);
  }

  // Modo local: cuenta aproximada por los mensajes guardados tras 'desde'
  const l = getLocal(telefono);
  if (!l.desde) return 0;
  return Math.max(0, (l._recordatorios || 0));
}

/**
 * ¿A este cliente se le pasó un lead al asesor ALGUNA vez?
 * Se usa para que, cuando el bot retoma tras las 12h, sepa que ya hubo un pase
 * y no vuelva a molestar al asesor salvo que el cliente pida algo nuevo.
 * Detecta si existe un registro de conversación (que solo se crea al hacer handoff).
 */
export async function yaFuePasadoAntes(telefono) {
  if (USAR_SUPABASE) {
    const { data } = await supabase
      .from("conversaciones")
      .select("telefono")
      .eq("telefono", telefono)
      .maybeSingle();
    return !!data; // si existe registro, es que hubo handoff antes
  }
  const l = getLocal(telefono);
  return l._huboHandoff === true;
}
