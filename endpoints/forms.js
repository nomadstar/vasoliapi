const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");

// Crear un formulario
router.post("/", async (req, res) => {
  try {
    data = req.body;
    let result;
    if (!data.id){
      result = await req.db.collection("forms").insertOne({
        ...req.body,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    } else {
      result = await req.db.collection("forms").findOneAndUpdate(
        { _id: new ObjectId(data.id)},
        { $set: { ...req.body, updatedAt: new Date() } },
        { returnDocument: "after" }
      );
      if (!result) return res.status(404).json({ error: "Formulario no encontrado" });
    }
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: "Error al crear formulario, error: ", err });
  }
});

// Listar todos los formularios
router.get("/", async (req, res) => {
  try {
    const forms = await req.db.collection("forms").find().toArray();
    res.json(forms);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener formularios" });
  }
});

// Obtener un formulario por ID (Mongo ObjectId)
router.get("/:id", async (req, res) => {
  try {
    const form = await req.db
      .collection("forms")
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!form) return res.status(404).json({ error: "Formulario no encontrado" });
    res.json(form);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener formulario" });
  }
});

//Filtrado de forms por seccion y empresa en web clientes
router.get("/section/:section/:mail", async (req, res) => {
  try {
    const { section, mail } = req.params;

    // 1. Buscar la empresa asociada al usuario
    const user = await req.db.collection("usuarios").findOne({ mail });
    if (!user || !user.empresa) {
      return res.status(404).json({ error: "Usuario o empresa no encontrados" });
    }

    const empresaUsuario = user.empresa; // Ejemplo: "acciona"

    // 2. Definir la consulta de filtrado
    const query = {
      // Condición estricta: debe pertenecer a la sección indicada
      section: section, 
      status: "publicado", // Condición estricta: debe estar publicado

      // Condición OR: el campo 'companies' debe coincidir con la empresa O con "Todas"
      $or: [
        { companies: empresaUsuario }, // Condición A: La empresa coincide exactamente
        { companies: "Todas" }         // Condición B: Es un formulario público
      ],
    };

    // 3. Buscar formularios que cumplan todas las condiciones
    const forms = await req.db
      .collection("forms")
      .find(query)
      .toArray();

    if (!forms || forms.length === 0) { // Importante: Verificar si el array está vacío
      return res.status(404).json({
        error: `No se encontraron formularios para la sección "${section}" y la empresa "${empresaUsuario}"`,
      });
    }

    res.status(200).json(forms);
  } catch (err) {
    console.error("Error al obtener formularios filtrados:", err);
    res.status(500).json({ error: "Error al obtener formularios por sección y empresa" });
  }
});

// Actualizar un formulario
router.put("/:id", async (req, res) => {
  try {
    const result = await req.db.collection("forms").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { ...req.body, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result.value) return res.status(404).json({ error: "Formulario no encontrado" });
    res.json(result.value);
  } catch (err) {
    res.status(500).json({ error: "Error al actualizar formulario" });
  }
});

// Publicar un formulario (cambiar status de borrador → publicado)
router.put("/public/:id", async (req, res) => {
  try {
    const result = await req.db.collection("forms").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      {
        $set: { 
          status: "publicado", 
          updatedAt: new Date() 
        } 
      },
      { returnDocument: "after" }
    );

    if (!result.value)
      return res.status(404).json({ error: "Formulario no encontrado" });

    res.status(200).json(result.value);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al publicar formulario" });
  }
});

// Eliminar un formulario
router.delete("/:id", async (req, res) => {
  try {
    const result = await req.db
      .collection("forms")
      .deleteOne({ _id: new ObjectId(req.params.id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Formulario no encontrado" });
    }

    res.status(200).json({ message: "Formulario eliminado" });
  } catch (err) {
    res.status(500).json({ error: "Error al eliminar formulario" });
  }
});

router.post("/respuestas", async (req, res) => {
  try {
    const result = await req.db.collection("respuestas").insertOne({
      ...req.body,
      createdAt: new Date()
    });

    res.json({ _id: result.insertedId, ...req.body });
  } catch (err) {
    res.status(500).json({ error: "Error al guardar respuesta" });
  }
});


module.exports = router;