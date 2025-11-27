// mail.helper.js
const nodemailer = require("nodemailer");
const { isEmail } = require("validator");

// --- CONFIGURACIÓN SMTP ---
// Decodifica variables base64; por simplicidad priorizamos las variables *_B64
function decodeB64(key) {
  const v = process.env[key];
  if (!v) return undefined;
  try {
    return Buffer.from(v, "base64").toString("utf8");
  } catch (e) {
    console.warn(`Fallo al decodificar ${key}:`, e && e.message);
    return undefined;
  }
}

const MAIL_CREDENTIALS = {
  host: process.env.SMTP_HOST || "45.239.111.63",
  port: Number(process.env.SMTP_PORT) || 587,
  // por defecto usar STARTTLS en 587 -> secure false
  secure:
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === "true"
      : false,
  auth: {
    user: decodeB64("SMTP_USER_B64") || process.env.SMTP_USER || "",
    pass: decodeB64("SMTP_PASS_B64") || process.env.SMTP_PASS || "",
  },
};

const MAX_RECIPIENTS = 10;

// --- INICIALIZACIÓN DEL TRANSPORTER ---
const transporter = nodemailer.createTransport({
  host: MAIL_CREDENTIALS.host,
  port: Number(process.env.SMTP_PORT || MAIL_CREDENTIALS.port),
  secure:
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === "true"
      : MAIL_CREDENTIALS.secure, // false -> STARTTLS
  // Si secure=false, forzar upgrade a TLS (STARTTLS)
  requireTLS: MAIL_CREDENTIALS.secure ? false : (process.env.SMTP_REQUIRE_TLS !== undefined ? process.env.SMTP_REQUIRE_TLS === "true" : true),
  auth: MAIL_CREDENTIALS.auth,
  authMethod: process.env.SMTP_AUTH_METHOD || "LOGIN",
  tls: {
    rejectUnauthorized:
      process.env.SMTP_REJECT_UNAUTHORIZED === "true" ? true : false,
  },
  logger: true,
  debug: true,
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

  // Aceptar array de strings o array de objetos { name, email }
  if (Array.isArray(raw)) {
    lista = raw
      .map(item => {
        if (!item) return "";
        if (typeof item === "string") return item.trim();
        if (typeof item === "object" && item.email) {
          const email = String(item.email).trim();
          if (item.name) return `${String(item.name).trim()} <${email}>`;
          return email;
        }
        return "";
      })
      .filter(Boolean);
  } else if (typeof raw === "string") {
    lista = raw.split(/\s*[;,]\s*/).map(s => s.trim()).filter(Boolean);
    if (lista.length === 0 && raw.trim()) lista = [raw.trim()];
  } else {
    return { error: "El campo 'to' debe ser string o array." };
  }

  if (lista.length > MAX_RECIPIENTS)
    return { error: `Máximo ${MAX_RECIPIENTS} destinatarios permitidos.` };

  const parsed = [];
  const invalid = [];
  for (const entry of lista) {
    // soporto "Name <email@dom>" o solo "email@dom"
    const match = entry.match(/<([^>]+)>/);
    const email = match ? match[1].trim() : entry.trim();
    if (!isEmail(email)) {
      invalid.push(entry);
      continue;
    }
    // conservo la forma original (para permitir Name <...>)
    parsed.push(entry.trim());
  }

  if (parsed.length === 0) {
    return {
      error: `No hay destinatarios válidos.${invalid.length ? " Entradas inválidas: " + invalid.join(", ") : ""}`,
    };
  }

  return { lista: parsed, invalid };
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

  // 3. Construir opciones y envelope seguro
  const toField = valid.lista.join(", ").trim();
  if (!toField) throw { status: 400, message: "No recipients definidos." };

  // Extraer correos limpios para el envelope (sin nombre)
  const envelopeTo = valid.lista
    .map(entry => {
      const match = entry.match(/<([^>]+)>/);
      return match ? match[1].trim() : entry.trim();
    })
    .filter(Boolean)
    .map(e => e.toLowerCase())
    .filter(e => isEmail(e)); // doble comprobación

  if (envelopeTo.length === 0) {
    throw { status: 400, message: "No hay destinatarios válidos para el envelope." };
  }

  const mailOptions = {
    from: from || MAIL_CREDENTIALS.auth.user,
    to: toField,
    subject,
    html,
    text,
    envelope: { from: MAIL_CREDENTIALS.auth.user, to: envelopeTo },
  };

  // 4. Enviar
  try {
    // log diagnóstico (sin exponer credenciales)
    console.info("Enviando correo:", {
      from: mailOptions.from,
      to: mailOptions.envelope && mailOptions.envelope.to,
      authUser: MAIL_CREDENTIALS.auth.user ? MAIL_CREDENTIALS.auth.user.replace(/(.{3}).+@/, "$1***@") : undefined,
      host: MAIL_CREDENTIALS.host,
      port: Number(process.env.SMTP_PORT || MAIL_CREDENTIALS.port),
      secure: transporter.options.secure,
      authMethod: transporter.options.authMethod,
    });

    const info = await transporter.sendMail(mailOptions);
    return { ok: true, messageId: info.messageId, response: info.response };
  } catch (err) {
    console.error("Error interno en Nodemailer:", {
      message: err.message,
      code: err.code,
      response: err.response,
      responseCode: err.responseCode,
      command: err.command,
      envelope: mailOptions.envelope,
    });

    // Si falla por autorización en MAIL FROM, intentar reintento con STARTTLS (puerto 587)
    if (err && err.responseCode === 550 && err.command === "MAIL FROM") {
      try {
        console.info("Intentando reintento con STARTTLS en puerto 587 (fallback)...");
        const altTransporter = nodemailer.createTransport({
          host: MAIL_CREDENTIALS.host,
          port: Number(process.env.FALLBACK_SMTP_PORT || 587),
          secure: false,
          requireTLS: true,
          auth: MAIL_CREDENTIALS.auth,
          authMethod: process.env.SMTP_AUTH_METHOD || "LOGIN",
          tls: {
            rejectUnauthorized:
              process.env.SMTP_REJECT_UNAUTHORIZED === "true" ? true : false,
          },
        });

        const info2 = await altTransporter.sendMail(mailOptions);
        console.info("Reintento OK con STARTTLS:", { response: info2.response });
        return { ok: true, messageId: info2.messageId, response: info2.response, fallback: true };
      } catch (err2) {
        console.error("Reintento con STARTTLS falló:", {
          message: err2.message,
          code: err2.code,
          response: err2.response,
          responseCode: err2.responseCode,
          command: err2.command,
        });
      }
    }

    throw { status: 500, message: "Fallo interno al enviar correo." };
  }
};

// Exponer una función de verificación para diagnóstico
const verifySMTP = async () => {
  return new Promise((resolve, reject) => {
    transporter.verify((err, success) => {
      if (err) return reject(err);
      resolve(success);
    });
  });
};

module.exports = { sendEmail, verifySMTP };

// Diagnóstico seguro de la contraseña (no imprime la contraseña)
const _pass = MAIL_CREDENTIALS.auth.pass || "";
console.info("SMTP auth user:", MAIL_CREDENTIALS.auth.user ? MAIL_CREDENTIALS.auth.user.replace(/(.{3}).+@/, "$1***@") : undefined);
console.info("SMTP_PASS length:", _pass.length);
console.info("SMTP_PASS endsWithDot:", _pass.endsWith("."));
console.info("SMTP_PASS hasWhitespace:", /\s/.test(_pass));