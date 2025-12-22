// routes/notificaciones.js
const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { addNotification } = require("../utils/notificaciones.helper");

// Crear una notificación (para 1 usuario o filtro de usuarios)
// Body esperado: { userId?, filtro?, titulo, descripcion, prioridad, color, icono, actionUrl }
router.post("/", async (req, res) => {
  try {
    const data = req.body || {};
    const { userId, filtro, titulo, descripcion, prioridad, color, icono, actionUrl } = data;

    if (!titulo || !descripcion) {
      return res.status(400).json({ error: "Faltan campos requeridos: titulo y descripcion" });
    }

    const { notificacion, modifiedCount } = await addNotification(req.db, {
      userId,
      filtro,
      titulo,
      descripcion,
      prioridad,
      color,
      icono,
      actionUrl,
    });

    if (modifiedCount === 0) {
      return res.status(404).json({ error: "No se encontraron usuarios para la notificación" });
    }

    res.status(201).json({
      message: "Notificación creada exitosamente",
      notificacion,
      usuarios_afectados: modifiedCount,
    });
  } catch (err) {
    console.error("❌ Error al crear notificación:", err);
    res.status(500).json({ error: "Error al crear notificación", detalles: err.message });
  }
});

// Listar notificaciones de un usuario por userId
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId inválido' });

    const usuario = await req.db
      .collection('usuarios')
      .findOne({ _id: new ObjectId(userId) }, { projection: { notificaciones: 1 } });

    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json(usuario.notificaciones || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener notificaciones' });
  }
});

// Marcar una notificación como leída
router.put("/:userId/:notiId/leido", async (req, res) => {
  try {
    const result = await req.db.collection("usuarios").findOneAndUpdate(
      { _id: new ObjectId(req.params.userId), "notificaciones.id": req.params.notiId },
      { $set: { "notificaciones.$.leido": true } },
      { returnDocument: "after" }
    );

    if (!result.value)
      return res.status(404).json({ error: "Usuario o notificación no encontrada" });

    res.json({ message: "Notificación marcada como leída", usuario: result.value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al marcar notificación como leída" });
  }
});

// Eliminar una notificación por userId y notiId
router.delete('/user/:userId/noti/:notiId', async (req, res) => {
  try {
    const { userId, notiId } = req.params;
    if (!ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId inválido' });

    const result = await req.db.collection('usuarios').findOneAndUpdate(
      { _id: new ObjectId(userId) },
      { $pull: { notificaciones: { id: notiId } } },
      { returnDocument: 'after' }
    );

    if (!result.value) return res.status(404).json({ error: 'Usuario o notificación no encontrada' });

    res.json({ message: 'Notificación eliminada', usuario: result.value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar notificación' });
  }
});

// Eliminar todas las notificaciones de un usuario por userId
router.delete('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId inválido' });

    const result = await req.db.collection('usuarios').findOneAndUpdate(
      { _id: new ObjectId(userId) },
      { $set: { notificaciones: [] } },
      { returnDocument: 'after' }
    );

    if (!result.value) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({ message: 'Todas las notificaciones fueron eliminadas correctamente.', usuario: result.value });
  } catch (err) {
    console.error('Error al eliminar todas las notificaciones:', err);
    res.status(500).json({ error: 'Error al eliminar notificaciones' });
  }
});

// Marcar todas como leídas por userId
router.put('/user/:userId/read-all', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId inválido' });

    const result = await req.db.collection('usuarios').updateOne(
      { _id: new ObjectId(userId) },
      { $set: { 'notificaciones.$[].leido': true } }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({ message: 'Todas las notificaciones fueron marcadas como leídas', modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error('Error al marcar todas como leídas:', err);
    res.status(500).json({ error: 'Error al marcar todas las notificaciones como leídas' });
  }
});

// Contador de no leídas por userId
router.get('/user/:userId/unread-count', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId inválido' });

    const usuario = await req.db.collection('usuarios').findOne({ _id: new ObjectId(userId) }, { projection: { notificaciones: 1 } });
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    const unreadCount = (usuario.notificaciones || []).filter(n => n.leido === false).length;
    res.json({ unreadCount });
  } catch (err) {
    console.error('Error al obtener contador de no leídas:', err);
    res.status(500).json({ error: 'Error al obtener contador de notificaciones no leídas', detalles: err.message });
  }
});

module.exports = router;
