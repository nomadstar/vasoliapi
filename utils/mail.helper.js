// mail.helper.js
const nodemailer = require("nodemailer");
const { isEmail } = require("validator");

// --- CONFIGURACIÓN SMTP ---
const MAIL_CREDENTIALS = {
  host: process.env.SMTP_HOST || "vasoli.cl",
  port: Number(process.env.SMTP_PORT) || 465,
  secure:
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === "true"
      : true,
  auth: {
    user: process.env.SMTP_USER || "noreply@vasoli.cl",
    pass: process.env.SMTP_PASS || "Vasoli19.",
  },
};

const MAX_RECIPIENTS = 10;

// --- INICIALIZACIÓN DEL TRANSPORTER ---
const transporter = nodemailer.createTransport({
  host: MAIL_CREDENTIALS.host,
  port: MAIL_CREDENTIALS.port,
  secure: MAIL_CREDENTIALS.secure,
  auth: MAIL_CREDENTIALS.auth,
  logger: true,
  debug: true,
  tls: {
    // Si el servidor tiene certificado autofirmado, usa "false" temporalmente:
    rejectUnauthorized:
      process.env.SMTP_REJECT_UNAUTHORIZED === "true" ? true : false,
  },
});

// Verificación de conexión al iniciar
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Error al conectar al SMTP:", error);
  } else {
    console.log("✅ Servidor SMTP listo para enviar correos");
  }
});

// --- LÓGICA DE VALIDACIÓN (Interna) ---
function validarDestinatarios(raw) {
  if (!raw) return { error: "Campo 'to' requerido." };
  let lista = [];

  if (Array.isArray(raw)) lista = raw;
  else if (typeof raw === "string") {
    lista = raw.split(/\s*[;,]\s*/).map(s => s.trim()).filter(Boolean);
    if (lista.length === 0 && raw.trim()) lista = [raw.trim()];
  } else {
    return { error: "El campo 'to' debe ser string o array." };
  }

  if (lista.length > MAX_RECIPIENTS)
    return { error: `Máximo ${MAX_RECIPIENTS} destinatarios permitidos.` };

  const parsed = [];
  for (const entry of lista) {
    // soporto "Name <email@dom>" o solo "email@dom"
    const match = entry.match(/<([^>]+)>/);
    const email = match ? match[1].trim() : entry.trim();
    if (!isEmail(email)) return { error: `Email inválido: ${entry}` };
    // conservo la forma original (para permitir Name <...>)
    parsed.push(entry.trim());
  }

  return { lista: parsed };
}

// --- FUNCIÓN PRINCIPAL EXPORTADA ---
/**
 * Procesa y envía un correo electrónico.
 * @param {Object} data - { to, subject, html, text, from }
 * @returns {Promise<Object>} Resultado del envío o lanza un error
 */
const sendEmail = async ({ to, subject, html, text, from }) => {
  // 1. Validar destinatarios
  const valid = validarDestinatarios(to);
  if (valid.error) {
    throw { status: 400, message: valid.error };
  }

  // 2. Validar contenido
  if (!subject) throw { status: 400, message: "Campo 'subject' requerido." };
  if (!html && !text) throw { status: 400, message: "Debe incluir 'html' o 'text'." };

  // 3. Construir opciones
  const mailOptions = {
    from: from || MAIL_CREDENTIALS.auth.user,
    to: valid.lista.join(", "),
    subject,
    html,
    text,
    envelope: { from: MAIL_CREDENTIALS.auth.user }, // fuerza MAIL FROM autenticado
  };

  // 4. Enviar
  try {
    const info = await transporter.sendMail(mailOptions);
    return { ok: true, messageId: info.messageId, response: info.response };
  } catch (err) {
    console.error("Error interno en Nodemailer:", err);
    throw { status: 500, message: "Fallo interno al enviar correo." };
  }
};

module.exports = { sendEmail };