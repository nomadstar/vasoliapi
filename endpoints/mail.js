// mail.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { sendEmail, verifySMTP, debugManual } = require("../utils/mail.helper");
const fs = require("dotenv").config();

const router = express.Router();

// --- CONFIGURACIÓN DE ACCESO ---
const ACCESS_KEY = process.env.MAIL_KEY || "Vasoli19";

console.log('All SMTP-related env vars:');
console.log(`SMTP_USER: ${process.env.SMTP_USER}`);
console.log(`SMTP_PASS: ${process.env.SMTP_PASS}`);
console.log(`SMTP_USER_B64: ${process.env.SMTP_USER_B64}`);
console.log(`SMTP_PASS_B64: ${process.env.SMTP_PASS_B64}`);
console.log(`SMTP_HOST: ${process.env.SMTP_HOST}`);
console.log(`SMTP_PORT: ${process.env.SMTP_PORT}`);

// --- HELPER: Decodificar variables B64 ---
function decodeEnvB64(keyB64, keyPlain) {
  const b64 = process.env[keyB64];
  const plain = process.env[keyPlain];
  
  console.log(`decodeEnvB64: ${keyB64}=${b64 ? '"' + b64 + '"' : '[NOT SET]'}, ${keyPlain}=${plain ? '"' + plain + '"' : '[NOT SET]'}`);
  
  if (b64 && b64.trim().length > 0) {
    try {
      const decoded = Buffer.from(b64.trim(), 'base64').toString('utf8');
      console.log(`decodeEnvB64: Decoded ${keyB64} to: ${decoded}`);
      return decoded;
    } catch (err) {
      console.warn(`Fallo al decodificar ${keyB64}:`, err && err.message);
      console.log(`decodeEnvB64: Falling back to ${keyPlain}: ${plain || '[NOT SET]'}`);
      return plain || '';
    }
  }
  console.log(`decodeEnvB64: Using plain ${keyPlain}: ${plain || '[NOT SET]'}`);
  return plain || '';
}

// Configuración de SMTP (prioritario vasoli.cl)
const SMTP_USER = decodeEnvB64('SMTP_USER_B64', 'SMTP_USER');
const SMTP_PASS = decodeEnvB64('SMTP_PASS_B64', 'SMTP_PASS');
const SMTP_HOST = process.env.SMTP_HOST_VASOLI || process.env.SMTP_HOST || 'mail.vasoli.cl';
const SMTP_PORT = Number(process.env.SMTP_PORT_VASOLI || process.env.SMTP_PORT || 465);

console.log('SMTP Configuration loaded:');
console.log(`SMTP_USER: ${SMTP_USER ? '[SET]' : '[EMPTY]'}`);
console.log(`SMTP_PASS: ${SMTP_PASS ? '[SET]' : '[EMPTY]'}`);
console.log(`SMTP_HOST: ${SMTP_HOST}`);
console.log(`SMTP_PORT: ${SMTP_PORT}`);

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
    const { accessKey, ...emailData } = req.body || {};

    // Validación de seguridad (API Key)
    if (accessKey !== ACCESS_KEY) {
      return res.status(401).json({ error: "Clave de acceso inválida." });
    }

    // Intenta vasoli.cl primero, si falla usa la instancia de API
    let result;
    try {
      result = await sendEmail(emailData, { host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, pass: SMTP_PASS });
    } catch (vasoliError) {
      console.warn('Error enviando por vasoli.cl, intentando instancia de API:', vasoliError.message);
      // Fallback a la instancia de API
      result = await sendEmail(emailData);
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

    const result = await verifySMTP();
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
    const result = await debugManual({ host, port, user, pass });
    return res.status(200).json(result);
  } catch (err) {
    console.error('Error en /debug/manual:', err);
    return res.status(200).json({ log: [String(err)], success: false });
  }
});

module.exports = router;