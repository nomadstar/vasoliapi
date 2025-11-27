// mail.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { sendEmail, verifySMTP } = require("../utils/mail.helper"); // Importamos la lógica

const router = express.Router();

// --- CONFIGURACIÓN DE ACCESO ---
const ACCESS_KEY = process.env.MAIL_KEY;
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

// --- ENDPOINT ---
router.post("/send", async (req, res) => {
  try {
    const { accessKey, ...emailData } = req.body || {};

    // 1. Validación de seguridad (API Key)
    if (accessKey !== ACCESS_KEY) {
      return res.status(401).json({ error: "Clave de acceso inválida." });
    }

    // 2. Delegar el envío al helper
    const result = await sendEmail(emailData);
    
    // 3. Responder éxito
    res.json(result);

  } catch (err) {
    // Manejo de errores (los que lanzamos desde el helper o inesperados)
    const status = err.status || 500;
    const message = err.message || "Error desconocido del servidor";
    
    if (status === 500) console.error("Error en endpoint /send:", err);
    
    res.status(status).json({ error: message });
  }
});

  // --- RUTA: diagnóstico manual SMTP (STARTTLS) ---
  router.get('/debug/manual', async (req, res) => {
    const log = [];
    const accessKey = req.query.accessKey || req.headers['x-access-key'];
    if (accessKey !== ACCESS_KEY) return res.status(401).json({ error: 'Clave de acceso inválida.' });

    const SMTP_HOST = process.env.SMTP_HOST || '45.239.111.63';
    const SMTP_PORT = Number(process.env.SMTP_PORT || 587);

    // Decodificar variables base64 (prioritarias). Para simplicidad usamos B64.
    const decodeB64 = (k) => {
      const v = process.env[k];
      if (!v) return undefined;
      try { return Buffer.from(v, 'base64').toString('utf8'); } catch (e) { return undefined; }
    };

    const SMTP_USER = decodeB64('SMTP_USER_B64') || process.env.SMTP_USER;
    const SMTP_PASS = decodeB64('SMTP_PASS_B64') || process.env.SMTP_PASS;

    // Verificación temprana para evitar enviar credenciales vacías al servidor
    if (!SMTP_USER || !SMTP_PASS) {
      return res.status(400).json({ error: 'Faltan variables de entorno: SMTP_USER y/o SMTP_PASS' });
    }

    const net = require('net');
    const tls = require('tls');

    let rawSocket;
    let tlsSocket;

    const cleanup = () => {
      try { if (tlsSocket && !tlsSocket.destroyed) tlsSocket.end(); } catch(e){}
      try { if (rawSocket && !rawSocket.destroyed) rawSocket.end(); } catch(e){}
    };

    try {
      // Intenta obtener la IP pública (solo para logs)
      try {
        const ipRes = await fetch('https://api.ipify.org?format=json');
        const { ip } = await ipRes.json();
        log.push(`Testing from IP: ${ip}`);
      } catch (e) {
        log.push('Could not fetch public IP: ' + e.message);
      }

      // Conexión TCP
      rawSocket = await new Promise((resolve, reject) => {
        const s = net.createConnection({ host: SMTP_HOST, port: SMTP_PORT }, () => resolve(s));
        s.once('error', reject);
        s.setTimeout(15000, () => reject(new Error('TCP connect timeout')));
      });

      const readResponse = (socket, timeout = 10000) => {
        return new Promise((resolve, reject) => {
          const onData = (data) => {
            cleanupTimer();
            socket.removeListener('data', onData);
            resolve(data.toString());
          };
          const onError = (err) => { cleanupTimer(); socket.removeListener('data', onData); reject(err); };
          const onTimeout = () => { socket.removeListener('data', onData); reject(new Error('read timeout')); };

          const cleanupTimer = () => clearTimeout(timer);
          socket.once('error', onError);
          socket.on('data', onData);
          const timer = setTimeout(onTimeout, timeout);
        });
      };

      const sendCommand = (socket, command) => {
        return new Promise(async (resolve, reject) => {
          try {
            log.push(`C: ${command}`);
            socket.write(command + '\r\n');
            const resp = await readResponse(socket);
            log.push(`S: ${resp.trim()}`);
            resolve(resp);
          } catch (err) { reject(err); }
        });
      };

      // banner
      const banner = await readResponse(rawSocket);
      log.push(`S: ${banner.trim()}`);

      await sendCommand(rawSocket, 'EHLO test.local');

      const starttlsResp = await sendCommand(rawSocket, 'STARTTLS');
      if (!/^220/.test(starttlsResp.trim())) {
        throw new Error('STARTTLS not accepted: ' + starttlsResp.trim());
      }

      // upgrade to TLS; use servername matching cert (SMTP_HOST)
      tlsSocket = tls.connect({ socket: rawSocket, servername: process.env.SMTP_HOST || 'vasoli.cl', rejectUnauthorized: true });

      await new Promise((resolve, reject) => {
        tlsSocket.once('secureConnect', resolve);
        tlsSocket.once('error', reject);
        tlsSocket.setTimeout(15000, () => reject(new Error('TLS connect timeout')));
      });
      log.push('TLS connection established');

      await sendCommand(tlsSocket, 'EHLO test.local');

      // AUTH LOGIN using base64 encoded credentials
      const userB64 = Buffer.from(SMTP_USER).toString('base64');
      const passB64 = Buffer.from(SMTP_PASS).toString('base64');

      await sendCommand(tlsSocket, 'AUTH LOGIN');
      await sendCommand(tlsSocket, userB64);
      await sendCommand(tlsSocket, passB64);

      const mailFromResponse = await sendCommand(tlsSocket, `MAIL FROM:<${SMTP_USER || 'noreply@vasoli.cl'}>`);
      if (/^250/.test(mailFromResponse.trim())) {
        log.push('✅ MAIL FROM accepted!');
      } else {
        log.push('❌ MAIL FROM rejected! Response: ' + mailFromResponse.trim());
      }

      try { await sendCommand(tlsSocket, 'QUIT'); } catch(e){}
      cleanup();

      return res.json({ log, success: /^250/.test(mailFromResponse.trim()) });
    } catch (err) {
      cleanup();
      log.push('ERROR: ' + (err && err.message ? err.message : String(err)));
      return res.status(200).json({ log, success: false });
    }
  });

  module.exports = router;

// --- RUTA DE DIAGNÓSTICO SMTP (protegida por API key) ---
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

// Prioriza las variables B64 si existen, sino usa las normales
function decodeEnvB64(keyB64, keyPlain) {
  const b64 = process.env[keyB64];
  if (b64 && b64.length) {
    try {
      return Buffer.from(b64, 'base64').toString('utf8');
    } catch (err) {
      console.warn(`Fallo al decodificar ${keyB64}:`, err && err.message);
      return process.env[keyPlain] || '';
    }
  }
  return process.env[keyPlain] || '';
}

const SMTP_USER = decodeEnvB64('SMTP_USER_B64', 'SMTP_USER');
const SMTP_PASS = decodeEnvB64('SMTP_PASS_B64', 'SMTP_PASS');