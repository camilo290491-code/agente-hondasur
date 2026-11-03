// server.js — Servidor que recibe los webhooks de WhatsApp Cloud API.
// Para producción (cuando tengas número). Para probar sin número usa: npm run sim
import express from "express";
import "dotenv/config";
import { procesarMensaje } from "./agente.js";
import { enviarWhatsApp } from "./whatsapp.js";
import { iniciarEnvioManual } from "./memoria.js";
// NUEVO — integración TallerNet
import {
  iniciarEscuchaAprobaciones,
  procesarRespuestaAprobacion,
  procesarConfirmacionCita,
  manejarEstadoWhatsApp,
  iniciarRecordatoriosCitas,
  iniciarAvisosMotoLista,
} from "./tallernet.js";
// NUEVO — recordatorios de pago de CarteraNet
import { iniciarRecordatoriosCartera } from "./cartera.js";
// NUEVO — clasificación de chats (ventas / taller / cartera)
import { iniciarClasificacion } from "./clasificar.js";
// NUEVO — seguimiento de cotizaciones de CarteraNet
import { iniciarSeguimientosCotizacion } from "./seguimientos.js";
// TEMPORAL — migración TallerNet → Supabase del agente (borrar al terminar)
import { migrarTablasTaller, migrarFotosTaller, generarEsquemaTaller } from "./migrar.js";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "hondasur_verify";

// 1. Verificación del webhook (Meta lo llama una vez al configurar)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado ✓");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 2. Recepción de mensajes
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responder rápido a Meta
  let telFallback = null; // para poder avisarle al cliente si algo falla
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];

    // NUEVO — Avisos de estado de entrega (aquí llega el "failed" de la ventana 24h)
    const estados = change?.value?.statuses;
    if (estados && estados.length) {
      for (const s of estados) await manejarEstadoWhatsApp(s);
    }

    const mensaje = change?.value?.messages?.[0];
    if (!mensaje) return;
    telFallback = mensaje.from;

    // NUEVO — Botones de aprobación del taller (mensajes tipo "interactive")
    if (mensaje.type === "interactive") {
      const manejado = (await procesarRespuestaAprobacion(mensaje)) ||
                       (await procesarConfirmacionCita(mensaje));
      if (!manejado) {
        // Otro tipo de interacción: tratar el texto del botón como mensaje normal
        const textoBoton =
          mensaje.interactive?.button_reply?.title ||
          mensaje.interactive?.list_reply?.title;
        if (textoBoton) {
          const { respuesta } = await procesarMensaje(mensaje.from, textoBoton);
          if (respuesta) await enviarWhatsApp(mensaje.from, respuesta);
        }
      }
      return;
    }

    // NUEVO — Respuesta a botones de PLANTILLA (llegan como tipo "button")
    if (mensaje.type === "button") {
      const manejado = (await procesarRespuestaAprobacion(mensaje)) ||
                       (await procesarConfirmacionCita(mensaje));
      if (!manejado && mensaje.button?.text) {
        const { respuesta } = await procesarMensaje(mensaje.from, mensaje.button.text);
        if (respuesta) await enviarWhatsApp(mensaje.from, respuesta);
      }
      return;
    }

    if (mensaje.type !== "text") return;
    const telefono = mensaje.from;
    const texto = mensaje.text.body;

    const { respuesta } = await procesarMensaje(telefono, texto);
    if (respuesta) await enviarWhatsApp(telefono, respuesta);
  } catch (err) {
    console.error("Error procesando webhook:", err);
    // Blindaje: que un tropiezo interno NUNCA sea silencio para el cliente
    if (telFallback) {
      try {
        await enviarWhatsApp(
          telFallback,
          "¡Ups! Se me enredó el sistema un momento 🙈 ¿Me repites tu mensaje, por favor? Ya te atiendo."
        );
      } catch (e2) {
        console.error("No se pudo enviar el aviso de error:", e2?.message);
      }
    }
  }
});

app.get("/", (_, res) => res.send("Agente HondaSur activo 🏍️"));

// ── Usuarios del equipo: el ADMIN crea/cambia/elimina asesoras desde la app ──
// La app manda el token de sesión del admin; aquí se verifica que el token sea
// real y que el correo esté en la lista de administradores. Solo entonces se usa
// la llave maestra. Nunca viaja ninguna llave secreta al navegador.
const ADMIN_CORREOS = ["camilo290491@gmail.com"];
app.use((req, res, next) => {
  if (req.path === "/usuarios") {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});
app.post("/usuarios", async (req, res) => {
  try {
    const { accion, correo, clave, token } = req.body || {};
    const URL_SB = process.env.SUPABASE_URL, LLAVE = process.env.SUPABASE_KEY;
    if (!URL_SB || !LLAVE) return res.json({ ok: false, error: "Servidor sin llaves." });
    // 1) ¿Quién pide esto? Validar el token contra Supabase
    const rQuien = await fetch(URL_SB + "/auth/v1/user", {
      headers: { apikey: LLAVE, Authorization: "Bearer " + (token || "") },
    });
    const quien = rQuien.ok ? await rQuien.json() : null;
    if (!quien || !ADMIN_CORREOS.includes(String(quien.email || "").toLowerCase()))
      return res.json({ ok: false, error: "Solo el administrador puede gestionar usuarios." });
    const correoLimpio = String(correo || "").trim().toLowerCase();
    if (!correoLimpio.includes("@")) return res.json({ ok: false, error: "Escribe un correo válido." });
    const cab = { apikey: LLAVE, Authorization: "Bearer " + LLAVE, "Content-Type": "application/json" };

    if (accion === "crear") {
      if (!clave || clave.length < 6) return res.json({ ok: false, error: "La contraseña debe tener al menos 6 caracteres." });
      const r = await fetch(URL_SB + "/auth/v1/admin/users", {
        method: "POST", headers: cab,
        body: JSON.stringify({ email: correoLimpio, password: clave, email_confirm: true }),
      });
      const d = await r.json();
      if (!r.ok) return res.json({ ok: false, error: (d.msg || d.message || "").includes("already") ? "Ese correo ya tiene usuario." : (d.msg || d.message || "No se pudo crear.") });
      return res.json({ ok: true, mensaje: "Usuario creado: " + correoLimpio });
    }

    // Para cambiar clave o eliminar: buscar el usuario por correo
    const rB = await fetch(URL_SB + "/auth/v1/admin/users?page=1&per_page=1000", { headers: cab });
    const dB = await rB.json();
    const u = (dB.users || dB || []).find?.((x) => String(x.email || "").toLowerCase() === correoLimpio);
    if (!u) return res.json({ ok: false, error: "No encuentro un usuario con ese correo." });
    if (ADMIN_CORREOS.includes(correoLimpio) && accion === "eliminar")
      return res.json({ ok: false, error: "No puedes eliminar al administrador." });

    if (accion === "clave") {
      if (!clave || clave.length < 6) return res.json({ ok: false, error: "La contraseña debe tener al menos 6 caracteres." });
      const r = await fetch(URL_SB + "/auth/v1/admin/users/" + u.id, {
        method: "PUT", headers: cab, body: JSON.stringify({ password: clave }),
      });
      if (!r.ok) return res.json({ ok: false, error: "No se pudo cambiar la contraseña." });
      return res.json({ ok: true, mensaje: "Contraseña cambiada para " + correoLimpio });
    }
    if (accion === "eliminar") {
      const r = await fetch(URL_SB + "/auth/v1/admin/users/" + u.id, { method: "DELETE", headers: cab });
      if (!r.ok) return res.json({ ok: false, error: "No se pudo eliminar." });
      return res.json({ ok: true, mensaje: "Usuario eliminado: " + correoLimpio + ". Sus sesiones quedan fuera." });
    }
    return res.json({ ok: false, error: "Acción no válida." });
  } catch (e) {
    res.json({ ok: false, error: "Error del servidor: " + e.message });
  }
});

// TEMPORAL — migración del taller (borrar estas dos rutas al terminar)
const CLAVE_MIGRA = "hs-migra-7319";
app.get("/migrar-taller", async (req, res) => {
  if (req.query.clave !== CLAVE_MIGRA) return res.status(403).send("Clave incorrecta.");
  try { res.type("text/plain; charset=utf-8").send(await migrarTablasTaller()); }
  catch (e) { res.type("text/plain").send("ERROR: " + e.message); }
});
app.get("/migrar-esquema", async (req, res) => {
  if (req.query.clave !== CLAVE_MIGRA) return res.status(403).send("Clave incorrecta.");
  try { res.type("text/plain; charset=utf-8").send(await generarEsquemaTaller()); }
  catch (e) { res.type("text/plain").send("ERROR: " + e.message); }
});
app.get("/migrar-fotos", async (req, res) => {
  if (req.query.clave !== CLAVE_MIGRA) return res.status(403).send("Clave incorrecta.");
  try { res.type("text/plain; charset=utf-8").send(await migrarFotosTaller()); }
  catch (e) { res.type("text/plain").send("ERROR: " + e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
  iniciarEscuchaAprobaciones(); // detecta cotizaciones creadas en TallerNet
  iniciarRecordatoriosCitas();  // recordatorio de cita el día anterior
  iniciarEnvioManual(enviarWhatsApp); // mensajes escritos desde el Centro de Chats
  iniciarAvisosMotoLista();           // NUEVO — aviso al cliente cuando su moto está lista
  iniciarRecordatoriosCartera();      // NUEVO — recordatorios de pago de CarteraNet
  iniciarClasificacion();             // NUEVO — separa chats de ventas, taller y cartera
  iniciarSeguimientosCotizacion();    // NUEVO — retoma cotizaciones de CarteraNet hasta que respondan
});
