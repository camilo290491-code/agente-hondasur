// telefono.js — Valida y normaliza números celulares colombianos.
// Se usa cuando el cliente da un número ADICIONAL (distinto al de WhatsApp).

/**
 * Valida un número celular colombiano.
 * Acepta formatos que la gente suele escribir:
 *   300 123 4567 | 300-123-4567 | (300)1234567 | +57 300 123 4567 | 573001234567
 *
 * @param {string} entrada
 * @returns {{ valido: boolean, normalizado: string|null, motivo: string|null }}
 */
export function validarCelularColombiano(entrada) {
  if (!entrada || typeof entrada !== "string") {
    return { valido: false, normalizado: null, motivo: "vacío" };
  }

  // 1. Dejar solo dígitos
  let d = entrada.replace(/\D/g, "");

  // 2. Quitar el código de país 57 si viene
  if (d.length === 12 && d.startsWith("57")) {
    d = d.slice(2);
  }
  // A veces ponen 0057 o el indicativo largo
  if (d.length === 13 && d.startsWith("057")) {
    d = d.slice(3);
  }

  // 3. Validar: 10 dígitos, empieza por 3 (celular en Colombia)
  if (d.length !== 10) {
    return {
      valido: false,
      normalizado: null,
      motivo: "debe tener 10 dígitos",
    };
  }
  if (!d.startsWith("3")) {
    return {
      valido: false,
      normalizado: null,
      motivo: "un celular colombiano empieza por 3",
    };
  }

  // 4. Normalizado con código de país, listo para WhatsApp
  return { valido: true, normalizado: "57" + d, motivo: null };
}
