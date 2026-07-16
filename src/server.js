// server.js — Servidor que recibe los webhooks de WhatsApp Cloud API.
// Para producción (cuando tengas número). Para probar sin número usa: npm run sim

import express from "express";
import "dotenv/config";
import { procesarMensaje } from "./agente.js";
import { enviarWhatsApp } from "./whatsapp.js";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "hondasur_verify";

// 1. Verificación del webhook (Meta lo llama una vez al configurar)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // Logs de diagnóstico
  console.log("--- Verificación de webhook ---");
  console.log("mode recibido:", JSON.stringify(mode));
  console.log("token recibido:", JSON.stringify(token));
  console.log("token esperado:", JSON.stringify(VERIFY_TOKEN));
  console.log("¿coinciden?:", token === VERIFY_TOKEN);
  console.log("-------------------------------");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado ✓");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 2. Recepción de mensajes
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responder rápido a Meta

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const mensaje = change?.value?.messages?.[0];
    if (!mensaje || mensaje.type !== "text") return;

    const telefono = mensaje.from;
    const texto = mensaje.text.body;

    const { respuesta } = await procesarMensaje(telefono, texto);
    if (respuesta) await enviarWhatsApp(telefono, respuesta);
  } catch (err) {
    console.error("Error procesando webhook:", err);
  }
});

app.get("/", (_, res) => res.send("Agente HondaSur activo 🏍️"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
