const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");



// 1. Crear / Actualizar una Plantilla (Asociación crítica al Formulario)
router.post("/", async (req, res) => {
  try {
    const data = req.body;
    const { formId } = data; // ID del formulario asociado (REQUIRED)
    let result;

    if (!formId) {
        return res.status(400).json({ error: "El campo 'formId' es obligatorio para asociar la plantilla." });
    }

    if (!data.id) {
      // 1. CREACIÓN: Insertar nueva plantilla
      result = await req.db.collection("plantillas").insertOne({
        ...req.body,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const newPlantillaId = result.insertedId;

      // 2. VINCULACIÓN CRÍTICA: Actualizar el formulario con el ID de la plantilla
      await req.db.collection("forms").updateOne(
        { formId: formId },
        { $set: { plantillaId: newPlantillaId } }
      );
      
      res.status(201).json({ ...req.body, _id: newPlantillaId });

    } else {
      // 1. ACTUALIZACIÓN (PUT): Actualizar la plantilla existente
      result = await req.db.collection("plantillas").findOneAndUpdate(
        { _id: new ObjectId(data.id) },
        { $set: { 
            ...req.body, 
            updatedAt: new Date()
        } },
        { returnDocument: "after" }
      );
      
      if (!result.value) return res.status(404).json({ error: "Plantilla no encontrada" });

      res.status(200).json(result.value);
    }
  } catch (err) {
    console.error("Error al crear/actualizar plantilla:", err);
    res.status(500).json({ error: "Error al crear/actualizar plantilla" });
  }
});

// 2. Obtener una Plantilla por ID
router.get("/:id", async (req, res) => {
  try {
    const plantilla = await req.db
      .collection("plantillas")
      .findOne({ formId: req.params.id });

    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });
    res.json(plantilla);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener plantilla" });
  }
});

// 3. Listar todas las Plantillas
router.get("/", async (req, res) => {
  try {
    const plantillas = await req.db.collection("plantillas").find().toArray();
    res.json(plantillas);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener plantillas" });
  }
});


// 4. Eliminar una Plantilla y DESVINCULAR del Formulario
router.delete("/:id", async (req, res) => {
  try {
    const plantillaId = req.params.id;

    // 1. Buscar la plantilla para obtener el formId asociado
    const plantilla = await req.db.collection("plantillas").findOne({ _id: new ObjectId(plantillaId) });
    
    // 2. Eliminar la plantilla
    const result = await req.db.collection("plantillas").deleteOne({ _id: new ObjectId(plantillaId) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Plantilla no encontrada" });
    }

    // 3. DESVINCULAR CRÍTICA: Eliminar la referencia 'plantillaId' del formulario asociado
    if (plantilla && plantilla.formId) {
       await req.db.collection("forms").updateOne(
        { _id: new ObjectId(plantilla.formId) },
        { $unset: { plantillaId: "" } } // Remueve el campo plantillaId
       );
    }

    res.status(200).json({ message: "Plantilla eliminada y desvinculada exitosamente" });
  } catch (err) {
    console.error("Error al eliminar plantilla:", err);
    res.status(500).json({ error: "Error al eliminar plantilla" });
  }
});



module.exports = router;