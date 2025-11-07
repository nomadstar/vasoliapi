// mail.js
// Ruta protegida para enviar correos HTML usando nodemailer
// npm i nodemailer express-rate-limit helmet validator

const express = require("express");
const nodemailer = require("nodemailer");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { isEmail } = require("validator");

const router = express.Router();

// --- CONFIGURACIÓN ---
// ⚠️ Reemplaza por tus valores (o idealmente usa variables de entorno)
const ACCESS_KEY = "MI_CLAVE_SECRETA_AQUI";
const MAIL_CREDENTIALS = {
  host: "mail.infoacciona.cl",
  port: 465,
  secure: true, // true si usas 465
  auth: {
    user: "administracion@infoacciona.cl",
    pass: "Vicente2025",
  },
};
const MAX_RECIPIENTS = 10;

// --- MIDDLEWARES ---
router.use(helmet());
router.use(express.json({ limit: "200kb" }));

// Límite de solicitudes (anti abuso)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 5,
  message: { error: "Demasiadas solicitudes, intenta más tarde." },
});
router.use(limiter);

// --- TRANSPORTER SMTP ---
const transporter = nodemailer.createTransport({
  host: MAIL_CREDENTIALS.host,
  port: MAIL_CREDENTIALS.port,
  secure: MAIL_CREDENTIALS.secure,
  auth: MAIL_CREDENTIALS.auth,
});

// --- Función auxiliar ---
function validarDestinatarios(raw) {
  if (!raw) return [];
  let lista = [];

  if (Array.isArray(raw)) lista = raw;
  else if (typeof raw === "string") {
    lista = raw.split(/\s*[;,]\s*/).filter(Boolean);
    if (lista.length === 0 && raw.trim()) lista = [raw.trim()];
  } else {
    return { error: "El campo 'to' debe ser string o array." };
  }

  if (lista.length > MAX_RECIPIENTS)
    return { error: `Máximo ${MAX_RECIPIENTS} destinatarios permitidos.` };

  for (const email of lista) {
    if (!isEmail(email)) return { error: `Email inválido: ${email}` };
  }

  return { lista };
}

transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Error al conectar al SMTP:", error);
  } else {
    console.log("✅ Servidor SMTP listo para enviar correos");
  }
});


// --- RUTA PRINCIPAL ---
router.post("/send", async (req, res) => {
  try {
    const { accessKey, to, subject, html, text, from } = req.body || {};

    // Protección por clave
    if (accessKey !== ACCESS_KEY){
      return res.status(401).json({ error: "Clave de acceso inválida." });
    }
    // Validaciones
    if (!to) return res.status(400).json({ error: "Campo 'to' requerido." });
    const valid = validarDestinatarios(to);
    if (valid.error) return res.status(400).json({ error: valid.error });

    if (!subject) return res.status(400).json({ error: "Campo 'subject' requerido." });
    if (!html && !text)
      return res.status(400).json({ error: "Debe incluir 'html' o 'text'." });

    // Construcción del mensaje
    const mailOptions = {
      from: from || MAIL_CREDENTIALS.auth.user,
      to: valid.lista.join(", "),
      subject,
      html,
      text,
    };

    // Envío
    const info = await transporter.sendMail(mailOptions);
    res.json({ ok: true, messageId: info.messageId, response: info.response });
  } catch (err) {
    console.error("Error al enviar correo:", err);
    res.status(500).json({ error: "Fallo interno al enviar correo." });
  }
});

module.exports = router;
