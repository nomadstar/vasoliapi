// mail.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { sendEmail, verifySMTP, debugManual } = require("../utils/mail.helper");
require('dotenv').config();

const router = express.Router();

// --- CONFIGURACIÓN DE ACCESO ---
const ACCESS_KEY = process.env.MAIL_KEY || "Vasoli19";

// --- HELPER: Decodificar variables B64 ---
function decodeEnvB64(keyB64, keyPlain) {
  const b64 = process.env[keyB64];
  const plain = process.env[keyPlain];
  if (b64 && b64.trim().length > 0) {
    try {
      return Buffer.from(b64.trim(), 'base64').toString('utf8');
    } catch (err) {
      console.warn(`Fallo al decodificar ${keyB64}:`, err && err.message);
      return plain || '';
    }
  }
  return plain || '';
}

// Configuración de SMTP (prioritario vasoli.cl)
const SMTP_USER = decodeEnvB64('SMTP_USER_B64', 'SMTP_USER');
const SMTP_PASS = decodeEnvB64('SMTP_PASS_B64', 'SMTP_PASS');
const SMTP_HOST = process.env.SMTP_HOST_VASOLI || process.env.SMTP_HOST || 'mail.vasoli.cl';
const SMTP_PORT = Number(process.env.SMTP_PORT_VASOLI || process.env.SMTP_PORT || 465);

// (No logging here — logs are emitted only per-request when debug is explicitly requested)

// --- MIDDLEWARES DE SEGURIDAD ---
router.use(helmet());
router.use(express.json({ limit: "200kb" }));

// Límite de solicitudes (anti abuso)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 5,
  message: { error: "Demasiadas solicitudes, intenta más tarde." },
});
router.use(limiter);

// --- ENDPOINT: Enviar email ---
router.post("/send", async (req, res) => {
  try {
    const { accessKey, debug, ...emailData } = req.body || {};

    // Validación de seguridad (API Key)
    if (accessKey !== ACCESS_KEY) {
      return res.status(401).json({ error: "Clave de acceso inválida." });
    }

    const debugFlag = !!debug;

    // Intenta vasoli.cl primero, si falla usa la instancia de API
    let result;
    try {
      result = await sendEmail(emailData, { host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, pass: SMTP_PASS, debug: debugFlag, accessKey });
    } catch (vasoliError) {
      if (debugFlag) console.warn('Error enviando por vasoli.cl, intentando instancia de API:', vasoliError && vasoliError.message);
      // Fallback a la instancia de API (no debug forwarded)
      result = await sendEmail(emailData, { debug: debugFlag, accessKey });
    }

    res.json(result);

  } catch (err) {
    const status = err.status || 500;
    const message = err.message || "Error desconocido del servidor";
    
    if (status === 500) console.error("Error en endpoint /send:", err);
    
    res.status(status).json({ error: message });
  }
});

// --- RUTA: Diagnóstico SMTP ---
router.get("/debug/smtp", async (req, res) => {
  try {
    const accessKey = req.query.accessKey || req.headers["x-access-key"];
    if (accessKey !== ACCESS_KEY) return res.status(401).json({ error: "Clave de acceso inválida." });

    const result = await verifySMTP({ host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, pass: SMTP_PASS, debug: true, accessKey });
    res.json({ ok: true, verified: result });
  } catch (err) {
    console.error("Error en /debug/smtp:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// --- RUTA: Diagnóstico manual SMTP (STARTTLS) ---
router.get('/debug/manual', async (req, res) => {
  const accessKey = req.query.accessKey || req.headers['x-access-key'];
  if (accessKey !== ACCESS_KEY) return res.status(401).json({ error: 'Clave de acceso inválida.' });

  // Usar configuración de vasoli.cl por defecto
  const host = SMTP_HOST;
  const port = SMTP_PORT;
  const user = SMTP_USER;
  const pass = SMTP_PASS;

  if (!user || !pass) {
    return res.status(400).json({ error: 'Faltan variables de entorno: SMTP_USER y/o SMTP_PASS' });
  }

  try {
    const result = await debugManual({ host, port, user, pass, debug: true, accessKey });
    return res.status(200).json(result);
  } catch (err) {
    console.error('Error en /debug/manual:', err);
    return res.status(200).json({ log: [String(err)], success: false });
  }
});

module.exports = router;