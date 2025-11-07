// routes/notificaciones.helper.js
const { ObjectId } = require("mongodb");

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
    filtro,
    titulo,
    descripcion,
    prioridad = 1,
    color = "#f5872dff",
    icono = "paper",
    actionUrl = null,
  }
) {
  if (!userId && !filtro) {
    throw new Error("Debe proporcionar un userId o un filtro de usuarios (rol/cargo).");
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

  const query = userId ? { _id: new ObjectId(userId) } : filtro;
  console.log(query);
  const result = await db.collection("usuarios").updateMany(query, {
    $push: { notificaciones: notificacion },
  });
  console.log(result);

  return { notificacion, modifiedCount: result.modifiedCount };
}

module.exports = { addNotification };
