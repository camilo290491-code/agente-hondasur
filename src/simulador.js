// simulador.js — Prueba el agente por consola, SIN WhatsApp ni número.
// Uso: npm run sim   (necesita solo ANTHROPIC_API_KEY en .env)

import "dotenv/config";
import readline from "readline";
import { procesarMensaje } from "./agente.js";

const TELEFONO_PRUEBA = "57300_CLIENTE_PRUEBA";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("\n🏍️  SIMULADOR AGENTE HONDASUR");
console.log("Escribe como si fueras un cliente. Ctrl+C para salir.\n");

function preguntar() {
  rl.question("Cliente> ", async (texto) => {
    if (!texto.trim()) return preguntar();
    const { respuesta, handoff } = await procesarMensaje(TELEFONO_PRUEBA, texto);
    if (respuesta) {
      console.log(`\nAgente> ${respuesta}\n`);
    } else {
      console.log("\n[La conversación está en manos del asesor; el agente no responde.]\n");
    }
    if (handoff) {
      console.log("⚡ (Se activó el pase a asesor. El agente dejará de responder a este cliente.)\n");
    }
    preguntar();
  });
}

preguntar();
