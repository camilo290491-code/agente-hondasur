// migrar.js — Migración DE UNA SOLA VEZ: TallerNet → Supabase del AGENTE.
// Copia las tablas del taller (con verificación de conteos: si algo no cuadra,
// se detiene y lo dice) y las fotos de los buckets "fotos" y "motos",
// corrigiendo las direcciones guardadas para que apunten al proyecto nuevo.
// Se puede ejecutar varias veces sin dañar nada (usa upsert).
// Cuando la migración quede verificada, este archivo se puede borrar.

import { createClient } from "@supabase/supabase-js";

const origen =
  process.env.TALLERNET_URL && process.env.TALLERNET_SERVICE_KEY
    ? createClient(process.env.TALLERNET_URL, process.env.TALLERNET_SERVICE_KEY)
    : null;
const destino =
  process.env.SUPABASE_URL && process.env.SUPABASE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;

const TABLAS = [
  "servicios", "mecanicos", "motos_catalogo", "motos", "config", "parametros",
  "citas", "registros", "ordenes", "orden_renglones", "fotos",
  "aprobaciones", "eliminaciones", "liquidaciones_mecanico",
];

function hostDe(url) { return String(url || "").replace(/https?:\/\//, "").replace(/\/.*$/, ""); }

// Reemplaza en TODO el contenido de la fila (textos, json, listas) las
// direcciones del proyecto viejo por las del nuevo (fotos, etc.).
function reescribir(fila, viejo, nuevo) {
  return JSON.parse(JSON.stringify(fila).split(viejo).join(nuevo));
}

async function contar(cli, tabla) {
  const { count, error } = await cli.from(tabla).select("*", { count: "exact", head: true });
  if (error) throw new Error(tabla + ": " + error.message);
  return count || 0;
}

export async function migrarTablasTaller() {
  if (!origen || !destino) return "Faltan llaves (TALLERNET_* o SUPABASE_*) en Railway.";
  if (process.env.TALLERNET_URL === process.env.SUPABASE_URL)
    return "TALLERNET_URL ya apunta al mismo proyecto que SUPABASE_URL: no hay nada que migrar (¿ya cambiaste las variables? Para migrar deben apuntar al proyecto VIEJO del taller).";
  const vHost = hostDe(process.env.TALLERNET_URL);
  const nHost = hostDe(process.env.SUPABASE_URL);
  const lineas = ["MIGRACIÓN DE TABLAS · TallerNet → Agente", ""];
  let perfecto = true;

  for (const tabla of TABLAS) {
    try {
      // 1) Leer TODO del origen, por páginas (jamás confiar en una sola lectura)
      let filas = [];
      for (let d = 0; ; d += 1000) {
        const { data, error } = await origen.from(tabla).select("*").range(d, d + 999);
        if (error) throw new Error("leyendo: " + error.message);
        filas = filas.concat(data || []);
        if (!data || data.length < 1000) break;
      }
      const esperado = await contar(origen, tabla);
      if (filas.length !== esperado)
        throw new Error("lectura incompleta (" + filas.length + " de " + esperado + ") — NO se copió");

      // 2) Corregir direcciones del proyecto viejo y copiar por lotes
      for (let i = 0; i < filas.length; i += 500) {
        const lote = filas.slice(i, i + 500).map((f) => reescribir(f, vHost, nHost));
        const { error } = await destino.from(tabla).upsert(lote);
        if (error) throw new Error("copiando: " + error.message);
      }

      // 3) Verificar el conteo en el destino
      const quedo = await contar(destino, tabla);
      const ok = quedo >= esperado;
      if (!ok) perfecto = false;
      lineas.push((ok ? "✓ " : "✗ ") + tabla + ": " + esperado + " filas en origen → " + quedo + " en destino");
    } catch (e) {
      perfecto = false;
      lineas.push("✗ " + tabla + ": ERROR — " + e.message);
    }
  }
  lineas.push("");
  lineas.push(perfecto
    ? "✅ TODAS LAS TABLAS CUADRARON. Sigue con las fotos: abre /migrar-fotos con la misma clave."
    : "⚠️ HAY TABLAS CON ERROR (marcadas con ✗). NO cambies nada todavía: copia este reporte y mándamelo.");
  return lineas.join("\n");
}

// ── Esquema: genera el SQL de las tablas leyendo la API del proyecto viejo ──
// (así no hace falta entrar a la cuenta de Supabase del taller para nada)
export async function generarEsquemaTaller() {
  if (!process.env.TALLERNET_URL || !process.env.TALLERNET_SERVICE_KEY) return "Faltan llaves TALLERNET_* en Railway.";
  if (process.env.TALLERNET_URL === process.env.SUPABASE_URL) return "TALLERNET_URL ya apunta al proyecto nuevo.";
  const k = process.env.TALLERNET_SERVICE_KEY;
  const r = await fetch(process.env.TALLERNET_URL + "/rest/v1/", { headers: { apikey: k, Authorization: "Bearer " + k } });
  if (!r.ok) return "ERROR leyendo el esquema: HTTP " + r.status;
  const j = await r.json();
  const defs = j.definitions || {};
  const tipoDe = (f) => {
    if (!f) return "text";
    if (f.endsWith("[]")) return f;
    const m = { "character varying": "text", "timestamp without time zone": "timestamp", "timestamp with time zone": "timestamptz", "time without time zone": "time", "double precision": "double precision" };
    if (m[f]) return m[f];
    if (["bigint","integer","smallint","text","boolean","numeric","real","json","jsonb","uuid","date"].includes(f)) return f;
    return "text";
  };
  const out = ["-- GENERADO AUTOMÁTICAMENTE desde el TallerNet viejo.", "-- Ejecutar COMPLETO en el Supabase del AGENTE → SQL Editor → Run.", ""];
  for (const [tabla, def] of Object.entries(defs)) {
    const cols = [], pks = [];
    for (const [col, p] of Object.entries(def.properties || {})) {
      const fmt = p.format || p.type || "text";
      const esSerial = p.default !== undefined && /^nextval\(/.test(String(p.default));
      let linea;
      if (esSerial) {
        const t = tipoDe(fmt);
        linea = '"' + col + '" ' + (t === "bigint" ? "bigserial" : t === "integer" ? "serial" : t);
      } else {
        linea = '"' + col + '" ' + tipoDe(fmt);
        if (p.default !== undefined) {
          let d = p.default;
          if (typeof d === "string" && !/\(|::|^'/.test(d) && !/^-?[\d.]+$/.test(d) && d !== "true" && d !== "false")
            d = "'" + d.replace(/'/g, "''") + "'";
          linea += " default " + d;
        }
      }
      if ((p.description || "").includes("<pk")) pks.push('"' + col + '"');
      cols.push(linea);
    }
    out.push("create table if not exists \"" + tabla + "\" (" + cols.join(", ") + (pks.length ? ", primary key (" + pks.join(",") + ")" : "") + ");");
  }
  out.push("");
  out.push("-- Candados: el equipo (con sesión) puede todo; nadie más ve nada…");
  for (const tabla of Object.keys(defs)) {
    out.push('alter table "' + tabla + '" enable row level security;');
    out.push('drop policy if exists "equipo_' + tabla + '" on "' + tabla + '";');
    out.push('create policy "equipo_' + tabla + '" on "' + tabla + '" for all to authenticated using (true) with check (true);');
  }
  out.push("-- …excepto el catálogo de motos, que es público (lo usa la página web)");
  out.push('drop policy if exists "catalogo_publico" on "motos_catalogo";');
  out.push('create policy "catalogo_publico" on "motos_catalogo" for select to anon using (true);');
  out.push("");
  out.push("-- Fotos (storage): el equipo sube, todo el mundo puede ver");
  out.push('drop policy if exists "fotos_equipo" on storage.objects;');
  out.push("create policy \"fotos_equipo\" on storage.objects for all to authenticated using (bucket_id in ('fotos','motos')) with check (bucket_id in ('fotos','motos'));");
  out.push('drop policy if exists "fotos_publicas" on storage.objects;');
  out.push("create policy \"fotos_publicas\" on storage.objects for select to anon using (bucket_id in ('fotos','motos'));");
  return out.join("\n");
}

// ── Fotos: buckets "fotos" (recepción de motos) y "motos" (catálogo) ─────────
async function listarRec(cli, bucket, prefijo) {
  let out = [];
  const { data, error } = await cli.storage.from(bucket).list(prefijo, { limit: 1000 });
  if (error) throw new Error("listando " + bucket + "/" + prefijo + ": " + error.message);
  for (const it of data || []) {
    const ruta = prefijo ? prefijo + "/" + it.name : it.name;
    if (it.id) out.push(ruta);               // archivo
    else out = out.concat(await listarRec(cli, bucket, ruta)); // carpeta
  }
  return out;
}

export async function migrarFotosTaller() {
  if (!origen || !destino) return "Faltan llaves en Railway.";
  if (process.env.TALLERNET_URL === process.env.SUPABASE_URL)
    return "TALLERNET_URL ya apunta al proyecto nuevo: nada que migrar.";
  const lineas = ["MIGRACIÓN DE FOTOS", ""];
  let pendientesTotal = 0;

  for (const bucket of ["fotos", "motos"]) {
    try {
      // Asegurar el bucket en el destino (público, como el original)
      const { error: eb } = await destino.storage.createBucket(bucket, { public: true });
      if (eb && !/exist|duplicate/i.test(eb.message || "")) throw new Error("creando bucket: " + eb.message);

      const deOrigen = await listarRec(origen, bucket, "");
      const deDestino = new Set(await listarRec(destino, bucket, ""));
      const faltan = deOrigen.filter((r) => !deDestino.has(r));

      let copiadas = 0;
      for (const ruta of faltan.slice(0, 40)) { // 40 por pasada, para no agotar el tiempo
        const { data: archivo, error: e1 } = await origen.storage.from(bucket).download(ruta);
        if (e1) { lineas.push("✗ " + bucket + "/" + ruta + ": " + e1.message); continue; }
        const { error: e2 } = await destino.storage.from(bucket)
          .upload(ruta, archivo, { upsert: true, contentType: archivo.type || "image/jpeg" });
        if (e2) { lineas.push("✗ " + bucket + "/" + ruta + ": " + e2.message); continue; }
        copiadas++;
      }
      const quedan = faltan.length - copiadas;
      pendientesTotal += quedan;
      lineas.push("• " + bucket + ": " + deOrigen.length + " fotos en origen · copiadas ahora " + copiadas + " · pendientes " + quedan);
    } catch (e) {
      pendientesTotal += 1;
      lineas.push("✗ bucket " + bucket + ": ERROR — " + e.message);
    }
  }
  lineas.push("");
  lineas.push(pendientesTotal > 0
    ? "⏳ Aún quedan fotos: RECARGA ESTA PÁGINA (F5) hasta que diga pendientes 0."
    : "✅ FOTOS COMPLETAS. Sigue con el paso de las secuencias (SQL) y el cambio de llaves.");
  return lineas.join("\n");
}
