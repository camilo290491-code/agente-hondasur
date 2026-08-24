// whatsapp.js — Envío de mensajes por WhatsApp Cloud API.
// Se activa cuando tengas el número dedicado y las credenciales de Meta.
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID; // ID del número en la Cloud API

export async function enviarWhatsApp(para, texto) {
  if (!TOKEN || !PHONE_ID) {
    console.log(`[SIM] (sin credenciales) Enviaría a ${para}: ${texto}`);
    return;
  }
  const url = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "text",
      text: { body: texto },
    }),
  });
  if (!res.ok) {
    console.error("Error enviando WhatsApp:", await res.text());
  }
  return res.ok;
}

// NUEVO — Envío de mensaje con botones interactivos (para aprobaciones del taller).
// botones: [{ id: "APR_1", titulo: "✅ Aprobar" }, ...] (máx. 3, títulos máx. 20 caracteres)
export async function enviarWhatsAppBotones(para, texto, botones) {
  if (!TOKEN || !PHONE_ID) {
    console.log(
      `[SIM] (sin credenciales) Enviaría a ${para} con botones [${botones
        .map((b) => b.titulo)
        .join(" | ")}]: ${texto}`
    );
    return { ok: true, id: "sim" }; // en simulación se considera enviado
  }
  const url = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: String(para).replace(/\D/g, ""),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: texto },
        action: {
          buttons: botones.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.titulo.slice(0, 20) },
          })),
        },
      },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Error enviando WhatsApp con botones:", JSON.stringify(json));
    return { ok: false, id: null };
  }
  return { ok: true, id: json.messages?.[0]?.id || null };
}

// NUEVO — Envío por PLANTILLA aprobada en Meta (llega a cualquier cliente,
// aunque no haya escrito en las últimas 24 horas).
// bodyParams: textos para las variables {{1}}, {{2}}... (sin saltos de línea)
// botonesPayload: payloads de los botones de respuesta rápida, en orden.
export async function enviarWhatsAppPlantilla(para, plantilla, idioma, bodyParams, botonesPayload) {
  if (!TOKEN || !PHONE_ID) {
    console.log(`[SIM] (sin credenciales) Enviaría plantilla "${plantilla}" a ${para}: ${bodyParams.join(" | ")}`);
    return { ok: true, id: "sim" };
  }
  const componentes = [];
  if (bodyParams && bodyParams.length) {
    componentes.push({
      type: "body",
      parameters: bodyParams.map((t) => ({ type: "text", text: String(t) })),
    });
  }
  (botonesPayload || []).forEach((payload, i) => {
    componentes.push({
      type: "button",
      sub_type: "quick_reply",
      index: String(i),
      parameters: [{ type: "payload", payload }],
    });
  });
  const url = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: String(para).replace(/\D/g, ""),
      type: "template",
      template: {
        name: plantilla,
        language: { code: idioma },
        components: componentes,
      },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Error enviando plantilla:", JSON.stringify(json));
    return { ok: false, id: null };
  }
  return { ok: true, id: json.messages?.[0]?.id || null };
}
