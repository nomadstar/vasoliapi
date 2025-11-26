// mail.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { sendEmail } = require("../utils/mail.helper"); // Importamos la lógica

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

module.exports = router;