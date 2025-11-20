// routes/notificaciones.js
const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { registrarHistorial } = require("../utils/historialTest.helper");
//https://vasoliltdaapi.vercel.app/api/historial
// Crear una notificación (para 1 usuario o grupo)
router.post("/", async (req, res) => {
  try {
    const data = req.body;
    const {titulo, areaTrabajo, descripcion } = data;

    if (!titulo || !areaTrabajo || !descripcion) {
      return res.status(400).json({ error: "Faltan campos requeridos: titulo, area, descripcion" });
    }

    const { data_historial, modifiedCount } = await registrarHistorial(req.db, {
      titulo,
      areaTrabajo,
      descripcion,
    });

    if (modifiedCount === 0) {
      return res.status(404).json({ error: "No se encontraron usuarios para la notificación" });
    }

    res.status(201).json({
      message: "Registro creado exitosamente",
      data_historial,
      registros_afectados: modifiedCount,
    });
  } catch (err) {
    console.error("❌ Error al crear registro:", err);
    res.status(500).json({ error: "Error al crear registro", detalles: err.message });
  }
});

// Listar notificaciones de un usuario
router.get("/", async (req, res) => {
  try {
    const registros = await req.db
      .collection("historial")
      .find().toArray();

    if (!registros) return res.status(404).json({ error: "registro no encontrado" });

    res.json(registros || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener registros" });
  }
});


// Eliminar un registro

router.delete("/:Id", async (req, res) => {
  try {
    const registroId = req.params.Id;

    const result = await req.db.collection("historial").findOneAndUpdate(
      { "registros.id": registroId },   // buscar documento que contenga ese registro
      {
        $pull: {
          registros: { id: registroId }, // eliminar ese registro del array
        },
      },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({
        error: "Registro no encontrado",
      });
    }

    res.json({
      message: "Registro eliminado",
      historial: result.value,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar el registro" });
  }
});


module.exports = router;
