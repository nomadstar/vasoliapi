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

// Detectar y decodificar si el usuario/clave fueron proporcionados en base64
function isLikelyBase64(s) {
  if (!s || typeof s !== "string") return false;
  // cadenas base64 típicas: sólo A-Za-z0-9+/= y longitud mínima
  return /^[A-Za-z0-9+/=]{8,}$/.test(s);
}

function readCredential({ b64Key, plainKey, type = "user" }) {
  // 1) priorizar variable *_B64
  const fromB64 = decodeB64(b64Key);
  if (fromB64) return fromB64;

  // 2) luego la variable plain; si parece base64, intentar decodificar
  const raw = process.env[plainKey];
  if (!raw) return undefined;
  if (isLikelyBase64(raw) && !raw.includes("@") && type === "user") {
    try {
      const dec = Buffer.from(raw, "base64").toString("utf8");
      return dec;
    } catch (e) {
      return raw;
    }
  }

  if (isLikelyBase64(raw) && type === "pass") {
    try {
      return Buffer.from(raw, "base64").toString("utf8");
    } catch (e) {
      return raw;
    }
  }

  return raw;
}

const MAIL_CREDENTIALS = {
  // Por defecto usar SMTP de Google (puedes sobreescribir con SMTP_HOST)
  host: process.env.SMTP_HOST || "smtp.mailersend.net",
  // Puerto por defecto para MailerSend: 587 (STARTTLS) o 2525
  port: Number(process.env.SMTP_PORT) || 587,
  // usar STARTTLS por defecto (secure=false) — el transporte hará STARTTLS
  secure:
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === "true"
      : false,
  auth: {
    user: readCredential({ b64Key: "SMTP_USER_B64", plainKey: "SMTP_USER", type: "user" }) || "MS_gPthcy@test-r6ke4n1881vgon12.mlsender.net",
    pass: readCredential({ b64Key: "SMTP_PASS_B64", plainKey: "SMTP_PASS", type: "pass" }) || "mssp.DyaWL5x.pr9084zmnwxgw63d.RJLpmhE",
  },
};

const MAX_RECIPIENTS = 10;

// --- Envío vía MailerSend API (si se provee API key) ---
async function sendViaMailerSend({ from, envelopeTo, subject, html, text }) {
  const apiKey = process.env.MAILERSEND_API_KEY || process.env.API_KEY;
  if (!apiKey) throw new Error('No MailerSend API key');

  // construir payload según API de MailerSend
  const parseNameEmail = (input) => {
    // soporta formatos: 'Name <email@dom>' o 'email@dom' o 'Name|email@dom'
    if (!input) return { email: MAIL_CREDENTIALS.auth.user };
    const m = String(input).match(/^(?:\s*(.*?)\s*<)?([^<>\s]+@[^<>\s]+)>?$/);
    if (m) {
      return { name: m[1] || undefined, email: m[2] };
    }
    // fallback simple
    return { email: String(input) };
  };

  const fromObj = parseNameEmail(from || MAIL_CREDENTIALS.auth.user);
  const toArr = (envelopeTo || []).map(e => ({ email: e }));

  const payload = {
    from: { email: fromObj.email, name: fromObj.name },
    to: toArr,
    subject: subject,
  };
  if (text) payload.text = text;
  if (html) payload.html = html;
  // reply_to not mandatory

  // usar fetch global (Node 18+) o node-fetch si está instalado
  let _fetch = global.fetch;
  if (typeof _fetch !== 'function') {
    try {
      _fetch = require('node-fetch');
    } catch (e) {
      throw new Error('No fetch disponible para usar MailerSend API');
    }
  }

  const res = await _fetch('https://api.mailersend.com/v1/email', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
  });

  // leer body como text y luego intentar parsear JSON (si aplica)
  const rawText = await res.text().catch(() => "");
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (e) {
    data = { _raw: rawText };
  }

  if (!res.ok) {
    const err = new Error('MailerSend API error');
    err.response = data;
    err.raw = rawText;
    err.status = res.status;
    throw err;
  }

  console.info('MailerSend API response:', { status: res.status, body: data, raw: rawText });
  return { ok: true, status: res.status, response: data, raw: rawText };
}

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

    // Si hay MailerSend API key, intentar enviar por su API primero
    if (process.env.MAILERSEND_API_KEY || process.env.API_KEY) {
      try {
        const apiRes = await sendViaMailerSend({ from: mailOptions.from, envelopeTo: mailOptions.envelope.to, subject, html, text });
        console.info('Envio via MailerSend:', { status: apiRes.status, response: apiRes.response });
        return { ok: true, provider: 'mailersend', status: apiRes.status, response: apiRes.response };
      } catch (apiErr) {
        console.warn('Envio vía MailerSend API falló, intentando SMTP. Error:', apiErr && (apiErr.message || apiErr.status));
      }
    }

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