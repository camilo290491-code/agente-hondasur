// memoria.js — Guarda historial y estado de handoff.
// Usa Supabase si hay credenciales; si no, usa memoria local (para simulación).

import { createClient } from "@supabase/supabase-js";

const USAR_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
const supabase = USAR_SUPABASE
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;

// Fallback en memoria (se pierde al reiniciar; solo para pruebas locales)
const local = new Map(); // telefono -> { mensajes: [], humano: bool }

function getLocal(telefono) {
  if (!local.has(telefono)) local.set(telefono, { mensajes: [], humano: false });
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
    const { data } = await supabase
      .from("mensajes")
      .select("rol, contenido")
      .eq("telefono", telefono)
      .order("created_at", { ascending: true })
      .limit(limite);
    return data || [];
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
  getLocal(telefono).humano = valor;
}

export async function estaEnHumano(telefono) {
  if (USAR_SUPABASE) {
    const { data } = await supabase
      .from("conversaciones")
      .select("requiere_humano")
      .eq("telefono", telefono)
      .single();
    return data?.requiere_humano || false;
  }
  return getLocal(telefono).humano;
}
