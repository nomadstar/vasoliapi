// routes/notificaciones.js
const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { addNotification } = require("../utils/notificaciones.helper");

// Crear una notificación (para 1 usuario o grupo)
router.post("/", async (req, res) => {
  try {
    const data = req.body;
    const { filtro, formTitle, prioridad, color, icono, actionUrl } = data;

    if (!titulo) {
      return res.status(400).json({ error: "Faltan campos requeridos: titulo, descripcion" });
    }

    const { notificacion, modifiedCount } = await addNotification(req.db, {
      userId,
      filtro,
      formTitle: `Se ha añadido notificacion manual.`,
      descripcion: `Se a usado postman para añadir nuevas notificaciones desde fuera`,
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

// Listar notificaciones de un usuario
router.get("/:nombre", async (req, res) => {
  try {
    const usuario = await req.db
      .collection("usuarios")
      .findOne({ nombre: req.params.nombre }, { projection: { notificaciones: 1 } });

    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json(usuario.notificaciones || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener notificaciones" });
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

// Eliminar una notificación
router.delete("/:mail/:notiId", async (req, res) => {
  try {
    const result = await req.db.collection("usuarios").findOneAndUpdate(
      { mail: req.params.mail },
      { $pull: { notificaciones: { id: req.params.notiId } } },
      { returnDocument: "after" }
    );

    if (!result)
      return res.status(404).json({ error: "Usuario o notificación no encontrada: ", result});

    res.json({ message: "Notificación eliminada", usuario: result.value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar notificación" });
  }
});

router.delete("/:mail", async (req, res) => {
  try {
    const result = await req.db.collection("usuarios").findOneAndUpdate(
      { mail: req.params.mail },
      { $set: { notificaciones: [] } }, // ✅ Vacía el array completo
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json({
      message: "Todas las notificaciones fueron eliminadas correctamente.",
      usuario: result.value
    });
  } catch (err) {
    console.error("Error al eliminar todas las notificaciones:", err);
    res.status(500).json({ error: "Error al eliminar notificaciones" });
  }
});

router.put("/:mail/leido-todas", async (req, res) => {
  try {
    const { mail } = req.params;

    const result = await req.db.collection("usuarios").updateOne(
      { mail },
      { $set: { "notificaciones.$[].leido": true } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json({
      message: "Todas las notificaciones fueron marcadas como leídas",
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    console.error("Error al marcar todas como leídas:", err);
    res.status(500).json({ error: "Error al marcar todas las notificaciones como leídas" });
  }
});

router.get("/:mail/unread-count", async (req, res) => {
  try {
    const { mail } = req.params;

    // Buscar usuario y proyectar solo las notificaciones
    const usuario = await req.db
      .collection("usuarios")
      .findOne({ mail }, { projection: { notificaciones: 1 } });

    if (!usuario) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    // Contar las notificaciones con leido = false
    const unreadCount = (usuario.notificaciones || []).filter(
      (n) => n.leido === false
    ).length;

    res.json({ unreadCount });
  } catch (err) {
    console.error("Error al obtener contador de no leídas:", err);
    res.status(500).json({
      error: "Error al obtener contador de notificaciones no leídas",
      detalles: err.message,
    });
  }
});

module.exports = router;
