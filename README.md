# Agente Comercial HondaSur 🏍️

Agente de WhatsApp que atiende clientes automáticamente con Claude, da precios,
ofrece financiación (sin decir con quién) y **pasa los leads calientes al asesor
apenas hay interés de compra.**

## Cómo está armado

```
Cliente → WhatsApp → server.js (webhook) → agente.js → Claude
                                              │
                                  ¿interés de compra?
                                              │
                                    marca handoff + te notifica
                                              │
                                   tú cierras desde tu WhatsApp
```

- `GUION_AGENTE.md` → el "cerebro": cómo se comporta. **Lee esto primero.**
- `src/config.js` → tus precios, horario, dirección. **EDITA AQUÍ.**
- `src/prompt.js` → arma las instrucciones del agente.
- `src/agente.js` → lógica central + detección de handoff.
- `src/memoria.js` → historial (Supabase o memoria local).
- `src/whatsapp.js` → envío por Cloud API (se activa con el número).
- `src/server.js` → webhook para producción.
- `src/simulador.js` → **probar sin WhatsApp.**

## Paso 1 — Probar YA (sin número, sin Supabase)

Solo necesitas una API key de Anthropic.

```bash
cd agente-hondasur
npm install
cp .env.example .env      # y pon tu ANTHROPIC_API_KEY
npm run sim
```

Escribe como cliente y mira cómo responde. Prueba decir "¿cuánto vale la XR150L?"
o "¿se puede financiar?" para ver el pase a asesor.

> ⚠️ Mientras los precios en `config.js` sean de ejemplo ($0), el agente dará
> valores falsos. Llena tu tabla real antes de usarlo en serio.

## Paso 2 — Cargar tus datos reales

Edita `src/config.js`:
- Lista de `MODELOS` con precio lista, papeles y total (en pesos, números sin puntos).
- Horario, dirección, tu número de asesor.

## Paso 3 — Conectar Supabase (memoria persistente)

1. Crea proyecto en Supabase.
2. Ejecuta `supabase.sql` en el editor SQL.
3. Pon `SUPABASE_URL` y `SUPABASE_KEY` en `.env`.

## Paso 4 — Conectar WhatsApp (cuando tengas el número) 🔌

1. Consigue el **número dedicado** (chip nuevo recomendado).
2. En [Meta for Developers](https://developers.facebook.com): crea una app,
   agrega el producto WhatsApp, registra el número → obtienes `WHATSAPP_TOKEN` y
   `WHATSAPP_PHONE_ID`.
3. Despliega el server (Railway/Render) y pon la URL `https://tu-app/webhook`
   como webhook en Meta, con `WEBHOOK_VERIFY_TOKEN`.
4. Llena esas variables en `.env`. ¡Ya está en vivo!

## Estado actual

- [x] Guion / instrucciones del agente
- [x] Reglas de precio y financiación
- [x] Pase a asesor (handoff) apenas hay interés
- [x] Notificación de lead caliente
- [x] Modo simulación
- [ ] Precios reales (los cargas tú)
- [ ] Número de WhatsApp (esta tarde)
- [ ] Panel web para atender por el mismo número (v2, opcional)
```
