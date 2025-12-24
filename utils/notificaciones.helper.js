// routes/notificaciones.helper.js
const { ObjectId } = require("mongodb");
const { createBlindIndex } = require("./seguridad.helper");

/**
 * Añade una notificación a uno o varios usuarios
 * @param {Db} db - Conexión activa a MongoDB
 * @param {Object} options - Configuración de la notificación
 * @param {string} [options.userId] - ID del usuario destino
 * @param {Object} [options.filtro] - Filtro para múltiples usuarios (por ejemplo, { rol: "admin" })
 * @param {string} options.titulo - Título de la notificación
 * @param {string} options.descripcion - Descripción de la notificación
 * @param {number} [options.prioridad=1] - Nivel de prioridad
 * @param {string} [options.color="#f5872dff"] - Color de acento
 * @param {string} [options.icono="paper"] - Icono de referencia
 * @param {string|null} [options.actionUrl=null] - URL o ruta asociada
 */
async function addNotification(
  db,
  {
    userId,
    filtro = {},
    titulo,
    descripcion,
    prioridad = 1,
    color = "#f5872dff",
    icono = "paper",
    actionUrl = null,
  }
) {
  if (!userId && (!filtro || Object.keys(filtro).length === 0)) {
    throw new Error("Debe proporcionar un userId o un filtro de usuarios (rol/cargo/email).");
  }

  const notificacion = {
    id: new ObjectId().toString(),
    titulo,
    descripcion,
    prioridad,
    color,
    icono,
    actionUrl,
    leido: false,
    fecha_creacion: new Date(),
  };

  let query = {};

  if (userId) {
    // Si hay userId, priorizamos la búsqueda por ID único
    query = { _id: new ObjectId(userId) };
  } else {
    // Si se usa filtro, clonamos para no mutar el objeto original
    query = { ...filtro };

    // ⚠️ CRÍTICO: Si el filtro incluye 'mail', debemos convertirlo a 'mail_index'
    if (query.mail) {
      const normalizedEmail = query.mail.toLowerCase().trim();
      query.mail_index = createBlindIndex(normalizedEmail);
      delete query.mail; // Eliminamos el mail en texto plano para que no falle la búsqueda en DB
    }
  }

  try {
    const result = await db.collection("usuarios").updateMany(query, {
      $push: { notificaciones: notificacion },
    });

    return { 
      success: true,
      notificacion, 
      modifiedCount: result.modifiedCount 
    };
  } catch (err) {
    console.error("Error al añadir notificación:", err);
    throw new Error("Error interno al procesar la notificación.");
  }
}

module.exports = { addNotification };