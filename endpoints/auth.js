const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { ObjectId } = require('mongodb');
const multer = require('multer');
const { validarToken } = require('../utils/validarToken');
const useragent = require('useragent');
const { hashPassword, encrypt, createBlindIndex, verifyPassword, decrypt } = require("../utils/seguridad.helper");

let activeTokens = [];
const TOKEN_EXPIRATION = 1000 * 60 * 60;

const getAhoraChile = () => {
  const d = new Date();
  return new Date(d.toLocaleString("en-US", {timeZone: "America/Santiago"}));
};

// Configurar Multer para almacenar logos en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'), false);
    }
  },
  limits: {
    fileSize: 2 * 1024 * 1024
  }
});

const generateAndSend2FACode = async (db, user, type) => {
  let EXPIRATION_TIME;
  let subject;
  let contextMessage;

  if (type === '2FA_SETUP') {
    EXPIRATION_TIME = 15 * 60 * 1000;
    subject = 'Código de Activación de 2FA - Vasoli';
    contextMessage = 'Hemos recibido una solicitud para **activar** la Autenticación de Dos Factores (2FA).';
  } else if (type === '2FA_LOGIN') {
    EXPIRATION_TIME = 5 * 60 * 1000;
    subject = 'Código de Verificación de Acceso 2FA - Vasoli';
    contextMessage = 'Estás intentando **iniciar sesión**. Ingresa el código en el sistema.';
  } else {
    throw new Error("Tipo de código 2FA inválido.");
  }

  const verificationCode = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + EXPIRATION_TIME);
  const userId = user._id.toString();

  await db.collection("2fa_codes").updateMany(
    { userId: userId, active: true, type: type },
    { $set: { active: false, revokedAt: new Date(), reason: "new_code_issued" } }
  );

  await db.collection("2fa_codes").insertOne({
    userId: userId,
    code: verificationCode,
    type: type,
    createdAt: new Date(),
    expiresAt: expiresAt,
    active: true
  });

  const userEmail = decrypt(user.mail);
  const userName = decrypt(user.nombre);

  const minutes = EXPIRATION_TIME / 1000 / 60;
  const htmlContent = `
    <p>Hola ${userName},</p>
    <p>${contextMessage}</p>
    <p>Tu código de verificación es:</p>
    <h2 style="color: #f94b16ff; font-size: 24px; text-align: center; border: 1px solid #f94b16ff; padding: 10px; border-radius: 8px;">
      ${verificationCode}
    </h2>
    <p>Este código expira en ${minutes} minutos. Si no solicitaste esta acción, ignora este correo.</p>
    <p>Saludos cordiales,</p>
    <p>El equipo de Vasoli</p>
  `;

  await sendEmail({
    to: userEmail,
    subject: subject,
    html: htmlContent
  });
};

router.get("/", async (req, res) => {
  try {
    const usuarios = await req.db.collection("usuarios").find().toArray();
    
    // Desencriptar cada usuario para que sea legible en el cliente
    const decryptedUsers = usuarios.map(u => ({
      ...u,
      nombre: u.nombre ? decrypt(u.nombre) : "",
      apellido: u.apellido ? decrypt(u.apellido) : "",
      mail: u.mail ? decrypt(u.mail) : ""
    }));

    res.json(decryptedUsers);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
});


router.get("/:mail", async (req, res) => {
  try {
    const normalizedEmail = req.params.mail.toLowerCase().trim();
    const usr = await req.db
      .collection("usuarios")
      .findOne({ mail_index: createBlindIndex(normalizedEmail) });

    if (!usr) return res.status(404).json({ error: "Usuario no encontrado" });
    
    res.json({
      id: usr._id, 
      departamento: usr.departamento || usr.empresa, 
      cargo: usr.cargo
    });
  } catch (err) {
    res.status(500).json({ error: "Error al obtener Usuario" });
  }
});

router.get("/full/:mail", async (req, res) => {
  try {
    const userMail = req.params.mail.toLowerCase().trim();
    const authHeader = req.headers.authorization;

    if (!req.isInternal) {
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Token de autenticación requerido" });
      }
      const token = authHeader.split(' ')[1];
      const validationResult = await validarToken(req.db, token);
      if (!validationResult.ok) {
        return res.status(401).json({ error: `Acceso no autorizado: ${validationResult.reason}` });
      }
    }
    
    const usr = await req.db
      .collection("usuarios")
      .findOne({ mail_index: createBlindIndex(userMail) });

    if (!usr) return res.status(404).json({ error: "Usuario no encontrado" });

    const profileData = {
      _id: usr._id,
      nombre: decrypt(usr.nombre),
      apellido: decrypt(usr.apellido),
      mail: decrypt(usr.mail),
      departamento: usr.departamento || usr.empresa, 
      cargo: usr.cargo,
      rol: usr.rol,
      estado: usr.estado,
      createdAt: usr.createdAt,
      updatedAt: usr.updatedAt,                   
    };

    res.json(profileData);
  } catch (err) {
    console.error("Error al obtener Usuario completo:", err);
    res.status(500).json({ error: "Error al obtener Usuario completo" });
  }
});


router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Datos incompletos" });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();

    const user = await req.db.collection("usuarios").findOne({
      mail_index: createBlindIndex(normalizedEmail)
    });

    if (!user || !(await verifyPassword(user.pass, password))) {
      return res.status(401).json({ success: false, message: "Credenciales inválidas" });
    }

    if (user.estado === "pendiente") {
      return res.status(401).json({
        success: false,
        message: "Usuario pendiente de activación. Revisa tu correo."
      });
    }

    if (user.estado === "inactivo") {
      return res.status(401).json({
        success: false,
        message: "Usuario inactivo. Contacta al administrador."
      });
    }

    if (user.twoFactorEnabled === true) {
      await generateAndSend2FACode(req.db, user, '2FA_LOGIN');

      return res.json({
        success: true,
        twoFA: true,
        userId: user._id.toString(),
        email: normalizedEmail, // IMPORTANTE: Devuelve también el email
        message: "Se requiere código 2FA. Enviado a tu correo."
      });
    }

    const now = getAhoraChile()

    let finalToken = null;
    let expiresAt = null;

    const existingToken = await req.db.collection("tokens").findOne({
      email: normalizedEmail,
      active: true
    });

    if (existingToken && new Date(existingToken.expiresAt) > now) {
      finalToken = existingToken.token;
      expiresAt = existingToken.expiresAt;
    } else {
      if (existingToken) {
        await req.db.collection("tokens").updateOne(
          { _id: existingToken._id },
          { $set: { active: false, revokedAt: now } }
        );
      }

      finalToken = crypto.randomBytes(32).toString("hex");
      expiresAt = new Date(Date.now() + TOKEN_EXPIRATION);

      await req.db.collection("tokens").insertOne({
        token: finalToken,
        email: normalizedEmail,
        userId: user._id.toString(),
        rol: user.rol,
        createdAt: now,
        expiresAt,
        active: true
      });
    }

    let nombre = "";
    try {
      nombre = decrypt(user.nombre);
    } catch {
      nombre = user.nombre || "";
    }

    const ipAddress = req.ip || req.connection.remoteAddress;
    const agent = useragent.parse(req.headers["user-agent"] || "Desconocido");

    await req.db.collection("ingresos").insertOne({
      usr: {
        name: nombre,
        email: normalizedEmail,
        cargo: user.rol,
        userId: user._id.toString()
      },
      ipAddress,
      os: agent.os?.toString?.() || "Desconocido",
      browser: agent.toAgent?.() || "Desconocido",
      now
    });

    return res.json({
      success: true,
      token: finalToken,
      usr: {
        name: nombre,
        email: normalizedEmail,
        cargo: user.rol,
        userId: user._id.toString()
      }
    });

  } catch (err) {
    console.error("Error en login:", err);
    return res.status(500).json({ error: "Error interno en login" });
  }
});

router.post("/verify-login-2fa", async (req, res) => {
  const { email, verificationCode } = req.body;

  console.log("DEBUG verify-login-2fa - Datos recibidos:", {
    email: email,
    verificationCode: verificationCode,
    codeLength: verificationCode?.length
  });

  if (!email || !verificationCode || verificationCode.length !== 6) {
    return res.status(400).json({
      success: false,
      message: "Datos incompletos o código inválido."
    });
  }

  const now = new Date();

  try {
    // Buscar usuario por email (usando blind index)
    const user = await req.db.collection("usuarios").findOne({
      mail_index: createBlindIndex(email.toLowerCase().trim())
    });

    if (!user) {
      console.log("DEBUG: Usuario no encontrado para email:", email);
      return res.status(401).json({
        success: false,
        message: "Usuario no encontrado."
      });
    }

    const userId = user._id.toString();
    console.log("DEBUG: Usuario encontrado, ID:", userId);

    // Buscar código 2FA activo para LOGIN
    const codeRecord = await req.db.collection("2fa_codes").findOne({
      userId: userId,
      code: verificationCode,
      type: '2FA_LOGIN',
      active: true,
      expiresAt: { $gt: now }
    });

    console.log("DEBUG: Código encontrado:", codeRecord);

    if (!codeRecord) {
      // Verificar si hay códigos pero expirados
      const expiredCode = await req.db.collection("2fa_codes").findOne({
        userId: userId,
        code: verificationCode,
        type: '2FA_LOGIN'
      });

      if (expiredCode) {
        console.log("DEBUG: Código encontrado pero expirado o inactivo");
        return res.status(401).json({
          success: false,
          message: "Código 2FA expirado. Solicita uno nuevo."
        });
      }

      return res.status(401).json({
        success: false,
        message: "Código 2FA incorrecto."
      });
    }

    // Marcar código como usado
    await req.db.collection("2fa_codes").updateOne(
      { _id: codeRecord._id },
      { $set: { active: false, usedAt: now } }
    );

    // ✅ RESTAURAR LÓGICA DE REUTILIZACIÓN DE TOKENS
    let finalToken = null;
    let expiresAt = null;
    const userEmail = decrypt(user.mail);

    const existingTokenRecord = await req.db.collection("tokens").findOne({
      email: userEmail,
      active: true
    });

    if (existingTokenRecord && new Date(existingTokenRecord.expiresAt) > now) {
      finalToken = existingTokenRecord.token;
      expiresAt = existingTokenRecord.expiresAt;
    } else {
      if (existingTokenRecord) {
        await req.db.collection("tokens").updateOne(
          { _id: existingTokenRecord._id },
          { $set: { active: false, revokedAt: now } }
        );
      }

      finalToken = crypto.randomBytes(32).toString("hex");
      expiresAt = new Date(now.getTime() + TOKEN_EXPIRATION);

      await req.db.collection("tokens").insertOne({
        token: finalToken,
        email: userEmail,
        userId: userId,
        rol: user.rol,
        createdAt: now,
        expiresAt,
        active: true
      });
    }

    // Registrar ingreso
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgentString = req.headers['user-agent'] || 'Desconocido';
    const agent = useragent.parse(userAgentString);

    const userName = decrypt(user.nombre);
    const usr = {
      name: userName,
      email: userEmail,
      cargo: user.rol,
      userId: userId
    };

    await req.db.collection("ingresos").insertOne({
      usr,
      ipAddress,
      os: agent.os.toString(),
      browser: agent.toAgent(),
      now: now,
    });

    console.log("DEBUG: Login 2FA exitoso para usuario:", userEmail);

    return res.json({
      success: true,
      token: finalToken,
      usr
    });
  } catch (err) {
    console.error("Error en verify-login-2fa:", err);
    return res.status(500).json({
      success: false,
      message: "Error interno en la verificación 2FA."
    });
  }
});

router.post("/recuperacion", async (req, res) => {
  const { email } = req.body;
  try {
    const user = await req.db.collection("usuarios").findOne({
      mail_index: createBlindIndex(email.toLowerCase().trim())
    });

    if (!user || user.estado === "inactivo") {
      return res.status(404).json({ message: "No disponible." });
    }

    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + RECOVERY_CODE_EXPIRATION);

    const userEmail = decrypt(user.mail);

    await req.db.collection("recovery_codes").updateMany(
      { email: userEmail, active: true },
      { $set: { active: false } }
    );

    await req.db.collection("recovery_codes").insertOne({
      email: userEmail,
      code,
      userId: user._id.toString(),
      createdAt: new Date(),
      expiresAt,
      active: true
    });

    await sendEmail({
      to: userEmail,
      subject: 'Recuperación de Contraseña',
      html: `<h2>Tu código es: ${code}</h2>`
    });

    res.json({ success: true, message: "Enviado." });
  } catch (err) {
    console.error("Error en recuperación:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

router.post("/borrarpass", async (req, res) => {
  const { email, code } = req.body;
  const now = new Date();

  if (!email || !code) {
    return res.status(400).json({ message: "Correo y código de verificación son obligatorios." });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();

    // Buscamos el registro de recuperación. 
    // Nota: 'recovery_codes' suele guardar el mail en plano para facilitar el matching con el input del usuario.
    const recoveryRecord = await req.db.collection("recovery_codes").findOne({
      email: normalizedEmail,
      code: code,
      active: true
    });

    if (!recoveryRecord) {
      return res.status(401).json({ message: "Código inválido o ya utilizado." });
    }

    if (recoveryRecord.expiresAt < now) {
      await req.db.collection("recovery_codes").updateOne(
        { _id: recoveryRecord._id },
        { $set: { active: false, revokedAt: now, reason: "expired" } }
      );
      return res.status(401).json({ message: "Código expirado. Solicita uno nuevo." });
    }

    // Marcar como consumido
    await req.db.collection("recovery_codes").updateOne(
      { _id: recoveryRecord._id },
      { $set: { active: false, revokedAt: now, reason: "consumed" } }
    );

    const userId = recoveryRecord.userId;

    if (!userId) {
      return res.status(404).json({ message: "Error interno: ID de usuario no encontrado." });
    }

    // Retornamos el userId para que el frontend pueda proceder al siguiente paso (cambiar contraseña)
    return res.json({ success: true, uid: userId });

  } catch (err) {
    console.error("Error en /borrarpass:", err);
    res.status(500).json({ message: "Error interno al verificar el código." });
  }
});

// SEND 2FA CODE - ACTIVACIÓN
router.post("/send-2fa-code", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        message: "Email requerido."
      });
    }

    const user = await req.db.collection("usuarios").findOne({
      mail_index: createBlindIndex(email.toLowerCase().trim())
    });

    if (!user) {
      return res.status(404).json({
        message: "Usuario no encontrado."
      });
    }

    await generateAndSend2FACode(req.db, user, '2FA_SETUP');

    res.status(200).json({
      success: true,
      message: "Código de activación 2FA enviado a tu correo."
    });
  } catch (err) {
    console.error("Error en /send-2fa-code:", err);
    res.status(500).json({
      success: false,
      message: "Error interno al procesar la solicitud."
    });
  }
});

// VERIFICAR ACTIVACIÓN 2FA - VERSIÓN CORREGIDA
router.post("/verify-2fa-activation", async (req, res) => {
  const { email, verificationCode } = req.body;

  console.log("DEBUG verify-2fa-activation - Body recibido:", req.body);

  if (!email || !verificationCode || verificationCode.length !== 6) {
    return res.status(400).json({
      success: false,
      message: "Datos incompletos o código inválido."
    });
  }

  try {
    // Buscar usuario por email (usando blind index)
    const user = await req.db.collection("usuarios").findOne({
      mail_index: createBlindIndex(email.toLowerCase().trim())
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado."
      });
    }

    const userId = user._id.toString();

    // Buscar código 2FA activo
    const codeRecord = await req.db.collection("2fa_codes").findOne({
      userId: userId,
      code: verificationCode,
      type: '2FA_SETUP',
      active: true,
      expiresAt: { $gt: new Date() }
    });

    if (!codeRecord) {
      return res.status(400).json({
        success: false,
        message: "Código incorrecto o expirado."
      });
    }

    // Marcar código como usado
    await req.db.collection("2fa_codes").updateOne(
      { _id: codeRecord._id },
      { $set: { active: false, usedAt: new Date() } }
    );

    // Actualizar estado 2FA del usuario
    await req.db.collection("usuarios").updateOne(
      { _id: new ObjectId(userId) },
      { $set: { twoFactorEnabled: true } }
    );

    res.status(200).json({
      success: true,
      message: "Autenticación de Dos Factores activada exitosamente."
    });
  } catch (err) {
    console.error("Error en /verify-2fa-activation:", err);
    res.status(500).json({
      success: false,
      message: "Error interno en la verificación."
    });
  }
});

// DESACTIVAR 2FA - VERSIÓN CORREGIDA
router.post("/disable-2fa", async (req, res) => {
  const { email } = req.body;

  console.log("DEBUG disable-2fa - Body recibido:", req.body);

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email es requerido."
    });
  }

  try {
    // Buscar usuario por email (usando blind index)
    const user = await req.db.collection("usuarios").findOne({
      mail_index: createBlindIndex(email.toLowerCase().trim())
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado."
      });
    }

    if (!user.twoFactorEnabled) {
      return res.status(400).json({
        success: false,
        message: "El 2FA no está activado para este usuario."
      });
    }

    const userId = user._id.toString();

    // Actualizar estado
    await req.db.collection("usuarios").updateOne(
      { _id: new ObjectId(userId) },
      { $set: { twoFactorEnabled: false } }
    );

    // Invalidar códigos 2FA activos
    await req.db.collection("2fa_codes").updateMany(
      { userId: userId, active: true },
      { $set: { active: false, revokedAt: new Date(), reason: "2fa_disabled" } }
    );

    res.status(200).json({
      success: true,
      message: "Autenticación de Dos Factores desactivada exitosamente."
    });
  } catch (err) {
    console.error("Error en /disable-2fa:", err);
    res.status(500).json({
      success: false,
      message: "Error interno al desactivar 2FA."
    });
  }
});

router.get("/logins/todos", async (req, res) => {
  try {
    const ingresos = await req.db.collection("ingresos").find().toArray();
    
    // Desencriptamos los datos del usuario dentro del historial de ingresos si fuera necesario.
    // Si al insertar en 'ingresos' ya insertaste el nombre plano, este map no romperá nada,
    // pero asegura que si están cifrados, se muestren bien.
    const decryptedIngresos = ingresos.map(i => {
      try {
        return {
          ...i,
          usr: {
            ...i.usr,
            name: i.usr?.name ? (i.usr.name.includes(':') ? decrypt(i.usr.name) : i.usr.name) : "Desconocido",
            email: i.usr?.email ? (i.usr.email.includes(':') ? decrypt(i.usr.email) : i.usr.email) : "Desconocido"
          }
        };
      } catch (e) {
        return i; // Si falla el decrypt, devuelve el registro original
      }
    });

    res.json(decryptedIngresos);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener ingresos" });
  }
});

// VALIDATE - Consulta token desde DB
router.post("/validate", async (req, res) => {
  const { token, email, cargo } = req.body;
  // Permitir validación automática para solicitudes internas
  if (req.isInternal) {
    if (!email || !cargo) return res.status(401).json({ valid: false, message: "Parámetros missing" });
    if (process.env.LOG_LEVEL === 'debug') console.info('/validate - internal request, auto-validating');
    return res.json({ valid: true, user: { email, cargo } });
  }

  if (!token || !email || !cargo) return res.status(401).json({ valid: false, message: "Acceso inválido" });
  try {
    const tokenRecord = await req.db.collection("tokens").findOne({ token, active: true });
    if (!tokenRecord) return res.status(401).json({ valid: false, message: "Token inválido o inexistente" });
    const now = new Date();
    const expiresAt = new Date(tokenRecord.expiresAt);
    const createdAt = new Date(tokenRecord.createdAt);
    const expired = expiresAt < now;
    const isSameDay = createdAt.getFullYear() === now.getFullYear() && createdAt.getMonth() === now.getMonth() && createdAt.getDate() === now.getDate();
    if (expired || !isSameDay) {
      await req.db.collection("tokens").deleteOne({ token });
      return res.status(401).json({ valid: false, message: expired ? "Token expirado. Inicia sesión nuevamente." : "El token ya no es válido porque pertenece a otro día." });
    }
    if (tokenRecord.email !== email) return res.status(401).json({ valid: false, message: "Token no corresponde al usuario" });
    if (tokenRecord.rol !== cargo) return res.status(401).json({ valid: false, message: "Cargo no corresponde al usuario" });
    return res.json({ valid: true, user: { email, cargo } });
  } catch (err) {
    console.error("Error validando token:", err);
    res.status(500).json({ valid: false, message: "Error interno al validar token" });
  }
});

// LOGOUT - Elimina o desactiva token en DB
router.post("/logout", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: "Token requerido" });

  try {
    await req.db.collection("tokens").updateOne(
      { token },
      { $set: { active: false, revokedAt: new Date() } }
    );
    res.json({ success: true, message: "Sesión cerrada" });
  } catch (err) {
    console.error("Error cerrando sesión:", err);
    res.status(500).json({ success: false, message: "Error interno al cerrar sesión" });
  }
});

router.post("/register", async (req, res) => {
  try {
    const { nombre, apellido, mail, departamento, cargo, rol, estado } = req.body;
    
    if (!nombre || !apellido || !mail || !departamento || !cargo || !rol) {
      return res.status(400).json({ error: "Todos los campos son obligatorios" });
    }
    
    const normalizedEmail = mail.toLowerCase().trim();
    const mailIndex = createBlindIndex(normalizedEmail);

    const existingUser = await req.db.collection("usuarios").findOne({ mail_index: mailIndex });
    if (existingUser) {
      return res.status(400).json({ error: "El usuario ya existe" });
    }
    
    const newUser = {
      nombre: encrypt(nombre),
      apellido: encrypt(apellido),
      mail: encrypt(normalizedEmail),
      mail_index: mailIndex,
      departamento, 
      cargo,
      rol,
      pass: "", // Se establece luego en set-password
      estado: estado || "pendiente",
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    const result = await req.db.collection("usuarios").insertOne(newUser);
    res.status(201).json({
      success: true,
      message: "Usuario registrado exitosamente",
      userId: result.insertedId
    });
  } catch (err) {
    console.error("Error al registrar usuario:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// PUT - Actualizar usuario
router.put("/users/:id", async (req, res) => {
  try {
    const { nombre, apellido, mail, departamento, cargo, rol, estado } = req.body;
    const normalizedEmail = mail.toLowerCase().trim();
    
    const updateData = {
      nombre: encrypt(nombre),
      apellido: encrypt(apellido),
      mail: encrypt(normalizedEmail),
      mail_index: createBlindIndex(normalizedEmail),
      departamento,
      cargo,
      rol,
      estado,
      updatedAt: new Date()
    };
    
    const result = await req.db.collection("usuarios").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: "Usuario no encontrado" });
    
    res.json({ success: true, message: "Usuario actualizado exitosamente" });
  } catch (err) {
    res.status(500).json({ error: "Error interno al actualizar" });
  }
});

// DELETE - Eliminar usuario
router.delete("/users/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    
    const result = await req.db.collection("usuarios").deleteOne({
      _id: new ObjectId(userId)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json({ success: true, message: "Usuario eliminado exitosamente" });

  } catch (err) {
    console.error("Error eliminando usuario:", err);
    if (err.message.includes("ObjectId")) {
      return res.status(400).json({ error: "ID de usuario inválido" });
    }
    res.status(500).json({ error: "Error al eliminar usuario" });
  }
});

router.post("/set-password", async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password || password.length < 4) {
      return res.status(400).json({ error: "Datos insuficientes" });
    }

    // Hashear la contraseña antes de guardar
    const hashedPassword = await hashPassword(password);

    const result = await req.db.collection("usuarios").updateOne(
      { _id: new ObjectId(userId), estado: "pendiente" },
      { 
        $set: { 
          pass: hashedPassword,
          estado: "activo",
          updatedAt: new Date()
        } 
      }
    );

    if (result.matchedCount === 0) {
      return res.status(400).json({ error: "No se puede establecer la contraseña o el usuario no está pendiente." });
    }

    res.json({ success: true, message: "Contraseña establecida correctamente" });
  } catch (error) {
    res.status(500).json({ error: "Error interno" });
  }
});

// EMPRESAS ENDPOINTS

// GET - Obtener todas las empresas
router.get("/empresas/todas", async (req, res) => {
  try {
    const empresas = await req.db.collection("empresas").find().toArray();
    res.json(empresas);
  } catch (err) {
    console.error("Error obteniendo empresas:", err);
    res.status(500).json({ error: "Error al obtener empresas" });
  }
});

// GET - Obtener empresa por ID
router.get("/empresas/:id", async (req, res) => {
  try {
    const empresa = await req.db.collection("empresas").findOne({ 
      _id: new ObjectId(req.params.id) 
    });

    if (!empresa) {
      return res.status(404).json({ error: "Empresa no encontrada" });
    }

    res.json(empresa);
  } catch (err) {
    console.error("Error obteniendo empresa:", err);
    res.status(500).json({ error: "Error al obtener empresa" });
  }
});

// POST - Registrar nueva empresa
router.post("/empresas/register", upload.single('logo'), async (req, res) => {
  try {
    console.log("Debug: Iniciando registro de empresa");
    console.log("Debug: Datos recibidos:", req.body);

    const { nombre, rut, direccion, encargado } = req.body;

    if (!nombre || !rut) {
      return res.status(400).json({ error: "Nombre y RUT son obligatorios" });
    }

    const empresaExistente = await req.db.collection("empresas").findOne({
      $or: [
        { nombre: nombre.trim() },
        { rut: rut.trim() }
      ]
    });

    if (empresaExistente) {
      const campoDuplicado = empresaExistente.nombre === nombre.trim() ? 'nombre' : 'RUT';
      return res.status(400).json({ 
        error: `Ya existe una empresa con el mismo ${campoDuplicado}` 
      });
    }

    const empresaData = {
      nombre: nombre.trim(),
      rut: rut.trim(),
      direccion: direccion ? direccion.trim() : '',
      encargado: encargado ? encargado.trim() : '',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    if (req.file) {
      empresaData.logo = {
        fileName: req.file.originalname,
        fileData: req.file.buffer,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        uploadedAt: new Date()
      };
    }

    const result = await req.db.collection("empresas").insertOne(empresaData);

    console.log("Debug: Empresa registrada exitosamente, ID:", result.insertedId);

    const nuevaEmpresa = await req.db.collection("empresas").findOne({
      _id: result.insertedId
    });

    res.status(201).json({
      message: "Empresa registrada exitosamente",
      empresa: nuevaEmpresa
    });

  } catch (err) {
    console.error("Error registrando empresa:", err);
    
    if (err.code === 11000) {
      return res.status(400).json({ error: "Empresa duplicada" });
    }
    
    res.status(500).json({ error: "Error al registrar empresa: " + err.message });
  }
});

// PUT - Actualizar empresa
router.put("/empresas/:id", upload.single('logo'), async (req, res) => {
  try {
    const { nombre, rut, direccion, encargado } = req.body;

    const updateData = {
      nombre: nombre.trim(),
      rut: rut.trim(),
      direccion: direccion ? direccion.trim() : '',
      encargado: encargado ? encargado.trim() : '',
      updatedAt: new Date()
    };

    if (req.file) {
      updateData.logo = {
        fileName: req.file.originalname,
        fileData: req.file.buffer,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        uploadedAt: new Date()
      };
    }

    const result = await req.db.collection("empresas").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Empresa no encontrada" });
    }

    const empresaActualizada = await req.db.collection("empresas").findOne({
      _id: new ObjectId(req.params.id)
    });

    res.json({
      message: "Empresa actualizada exitosamente",
      empresa: empresaActualizada
    });

  } catch (err) {
    console.error("Error actualizando empresa:", err);
    res.status(500).json({ error: "Error al actualizar empresa" });
  }
});

// DELETE - Eliminar empresa
router.delete("/empresas/:id", async (req, res) => {
  try {
    const result = await req.db.collection("empresas").deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Empresa no encontrada" });
    }

    res.json({ message: "Empresa eliminada exitosamente" });

  } catch (err) {
    console.error("Error eliminando empresa:", err);
    res.status(500).json({ error: "Error al eliminar empresa" });
  }
});

module.exports = router;