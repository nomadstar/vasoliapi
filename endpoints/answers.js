const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const multer = require('multer');
const { addNotification } = require("../utils/notificaciones.helper");
const { generarAnexoDesdeRespuesta } = require("../utils/generador.helper");
const { validarToken } = require("../utils/validarToken.js");

// Configurar Multer para almacenar en memoria (buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: function (req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos PDF'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});


router.post("/", async (req, res) => {
  try {
    const { formId, user, responses, formTitle, adjuntos = [] } = req.body;
    const usuario = user?.nombre;
    const empresa = user?.empresa;
    const userId = user?.uid;
    const token = user?.token;

    const tokenValido = await validarToken(req.db, token);
    if (!tokenValido.ok) {
      return res.status(401).json({ error: tokenValido.reason });
    }

    const form = await req.db
      .collection("forms")
      .findOne({ _id: new ObjectId(formId) });

    if (!form) {
      return res.status(404).json({ error: "Formulario no encontrado" });
    }

    const empresaAutorizada = form.companies?.includes(empresa) || form.companies?.includes("Todas");
    if (!empresaAutorizada) {
      return res.status(403).json({
        error: `La empresa ${empresa} no está autorizada para responder este formulario.`,
      });
    }

    const result = await req.db.collection("respuestas").insertOne({
      ...req.body,
      adjuntos: adjuntos,
      status: "pendiente",
      createdAt: new Date(),
    });

    await addNotification(req.db, {
      filtro: { cargo: "RRHH" },
      titulo: `El usuario ${usuario} de la empresa ${empresa} ha respondedido el formulario ${formTitle}`,
      descripcion: adjuntos.length > 0
        ? `Incluye ${adjuntos.length} archivo(s) adjunto(s)`
        : "Puedes revisar los detalles en el panel de respuestas.",
      prioridad: 2,
      color: "#fb8924",
      icono: "form",
      actionUrl: `/RespuestasForms?id=${result.insertedId}`,
    });

    await addNotification(req.db, {
      userId,
      titulo: "Formulario completado",
      descripcion: `El formulario ${formTitle} fue completado correctamente.`,
      prioridad: 2,
      icono: "CheckCircle",
      color: "#3B82F6",
      actionUrl: `/?id=${result.insertedId}`,
    });

    try {
      await generarAnexoDesdeRespuesta(responses, result.insertedId.toString(), req.db, form.section, {
        nombre: usuario,
        empresa: empresa,
        uid: userId
      });
      console.log("Documento generado automáticamente:", result.insertedId);
    } catch (error) {
      console.error("Error generando documento:", error.message);
    }

    res.json({
      _id: result.insertedId,
      ...req.body,
      adjuntosCount: adjuntos.length
    });

  } catch (err) {
    console.error("Error general al guardar respuesta:", err);
    res.status(500).json({ error: "Error al guardar respuesta: " + err.message });
  }
});

// Endpoint para descargar archivos adjuntos
router.get("/:id/adjuntos/:index", async (req, res) => {
  try {
    const { id, index } = req.params;

    const respuesta = await req.db
      .collection("respuestas")
      .findOne({ _id: new ObjectId(id) });

    if (!respuesta) {
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    if (!respuesta.adjuntos || !respuesta.adjuntos[index]) {
      return res.status(404).json({ error: "Archivo no encontrado" });
    }

    const adjunto = respuesta.adjuntos[index];

    const base64Data = adjunto.fileData.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    res.set({
      'Content-Type': adjunto.mimeType,
      'Content-Disposition': `attachment; filename="${adjunto.fileName}"`,
      'Content-Length': buffer.length
    });

    res.send(buffer);

  } catch (err) {
    console.error("Error descargando archivo:", err);
    res.status(500).json({ error: "Error descargando archivo" });
  }
});

// Endpoint para obtener información de adjuntos
router.get("/:id/adjuntos", async (req, res) => {
  try {
    const { id } = req.params;

    const respuesta = await req.db
      .collection("respuestas")
      .findOne({ _id: new ObjectId(id) }, { projection: { adjuntos: 1 } });

    if (!respuesta) {
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    res.json(respuesta.adjuntos || []);

  } catch (err) {
    console.error("Error obteniendo adjuntos:", err);
    res.status(500).json({ error: "Error obteniendo adjuntos" });
  }
});


router.get("/", async (req, res) => {
  try {
    const answers = await req.db.collection("respuestas").find().toArray();
    res.json(answers);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener formularios" });
  }
});

router.get("/mail/:mail", async (req, res) => {
  try {
    const form = await req.db
      .collection("respuestas")
      .find({ "user.mail": req.params.mail })
      .toArray();
    console.log(req.params);
    if (!form) return res.status(404).json({ error: "Formulario no encontrado" });
    res.json(form);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener formulario" });
  }
});


router.get("/:id", async (req, res) => {
  try {
    const form = await req.db
      .collection("respuestas")
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!form) return res.status(404).json({ error: "Formulario no encontrado" });
    res.json(form);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener formulario" });
  }
});


router.get("/section/:section", async (req, res) => {
  try {
    const forms = await req.db
      .collection("respuestas")
      .find({ section: req.params.section })
      .toArray();

    if (!forms.length)
      return res.status(404).json({ error: "No se encontraron formularios en esta sección" });

    res.status(200).json(forms);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener formularios por sección" });
  }
});

//actualizar respuesta
router.put("/:id", async (req, res) => {
  try {
    const result = await req.db.collection("respuestas").findOneAndUpdate(
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

//publicar formulario
router.put("/public/:id", async (req, res) => {
  try {
    const result = await req.db.collection("respuestas").findOneAndUpdate(
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

//eliminar respuesta
router.delete("/:id", async (req, res) => {
  try {
    const result = await req.db
      .collection("respuestas")
      .deleteOne({ _id: new ObjectId(req.params.id) });

    if (result.deletedCount === 1) {
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    res.status(200).json({ message: "Formulario eliminado" });
  } catch (err) {
    res.status(500).json({ error: "Error al eliminar formulario" });
  }
});

//solicitar de mensajes
router.get("/:formId/chat", async (req, res) => {
  try {
    const { formId } = req.params;

    let query;
    if (ObjectId.isValid(formId)) {
      query = { $or: [{ _id: new ObjectId(formId) }, { formId }] };
    } else {
      query = { formId };
    }

    const respuesta = await req.db
      .collection("respuestas")
      .findOne(query, { projection: { mensajes: 1 } });

    if (!respuesta) {
      return res.status(404).json({ error: "No se encontró la respuesta con ese formId o _id" });
    }

    res.json(respuesta.mensajes || []);
  } catch (err) {
    console.error("Error obteniendo chat:", err);
    res.status(500).json({ error: "Error al obtener chat" });
  }
});

//enviar mensaje
router.post("/chat", async (req, res) => {
  try {
    const { formId, autor, mensaje } = req.body;

    if (!autor || !mensaje || !formId) {
      return res.status(400).json({ error: "Faltan campos: formId, autor o mensaje" });
    }

    const nuevoMensaje = {
      autor,
      mensaje,
      leido: false,
      fecha: new Date(),
    };

    let query;
    if (ObjectId.isValid(formId)) {
      query = { $or: [{ _id: new ObjectId(formId) }, { formId }] };
    } else {
      query = { formId };
    }

    const respuesta = await req.db.collection("respuestas").findOne(query);
    if (!respuesta) {
      return res.status(404).json({ error: "No se encontró la respuesta para agregar el mensaje" });
    }

    await req.db.collection("respuestas").updateOne(
      { _id: respuesta._id },
      { $push: { mensajes: nuevoMensaje } }
    );

    if (respuesta?.user?.nombre === autor) {
      await addNotification(req.db, {
        filtro: { cargo: "RRHH" },
        titulo: "Nuevo mensaje en tu formulario",
        descripcion: `${autor} le ha enviado un mensaje respecto a un formulario.`,
        icono: "chat",
        actionUrl: `/RespuestasForms/${respuesta._id}`,
      });
    } else {
      await addNotification(req.db, {
        userId: respuesta.user.uid,
        titulo: "Nuevo mensaje recibido",
        descripcion: `${autor} le ha enviado un mensaje respecto a un formulario.`,
        icono: "chat",
        actionUrl: `/?id=${result.insertedId}`,
      });
    }

    res.json({
      message: "Mensaje agregado correctamente y notificación enviada",
      data: nuevoMensaje,
    });
  } catch (err) {
    console.error("Error al agregar mensaje:", err);
    res.status(500).json({ error: "Error al agregar mensaje" });
  }
});


router.put("/chat/marcar-leidos", async (req, res) => {
  try {
    const result = await req.db.collection("respuestas").updateMany(
      { "mensajes.leido": false },
      { $set: { "mensajes.$[].leido": true } }
    );

    res.json({
      message: "Todos los mensajes fueron marcados como leídos",
      result,
    });
  } catch (err) {
    console.error("Error al marcar mensajes como leídos:", err);
    res.status(500).json({ error: "Error al marcar mensajes como leídos" });
  }
});

// Subir corrección PDF
router.post("/:id/upload-correction", upload.single('correctedFile'), async (req, res) => {
  try {
    console.log("Debug: Iniciando upload-correction para ID:", req.params.id);

    if (!req.file) {
      console.log("Debug: No se subió ningún archivo");
      return res.status(400).json({ error: "No se subió ningún archivo" });
    }

    console.log("Debug: Archivo recibido:", req.file.originalname, "Tamaño:", req.file.size);

    const correctionData = {
      fileName: req.file.originalname,
      tipo: 'pdf',
      fileData: req.file.buffer,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      uploadedAt: new Date()
    };

    const result = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          correctedFile: correctionData,
          updatedAt: new Date()
        }
      }
    );

    console.log("Debug: Resultado de la actualización en BD:", result);

    if (result.matchedCount === 0) {
      console.log("Debug: No se encontró la respuesta con ID:", req.params.id);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    console.log("Debug: Corrección subida exitosamente para ID:", req.params.id);

    res.json({
      message: "Corrección subida correctamente",
      fileName: correctionData.fileName,
      fileSize: correctionData.fileSize
    });
  } catch (err) {
    console.error("Error subiendo corrección:", err);
    res.status(500).json({ error: "Error subiendo corrección" });
  }
});

// Aprobar formulario y guardar en aprobados (con upload incluido)
router.post("/:id/approve", upload.single('correctedFile'), async (req, res) => {
  try {
    console.log("Debug: Iniciando approve para ID:", req.params.id);

    const respuesta = await req.db.collection("respuestas").findOne({ _id: new ObjectId(req.params.id) });

    if (!respuesta) {
      console.log("Debug: Respuesta no encontrada para ID:", req.params.id);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    // Si no hay correctedFile en la respuesta Y no se subió un archivo
    if (!respuesta.correctedFile && !req.file) {
      console.log("Debug: No hay corrección subida para ID:", req.params.id);
      return res.status(400).json({ error: "No hay corrección subida para aprobar" });
    }

    let correctedFileData;

    // Si se subió un archivo en este request, usarlo
    if (req.file) {
      console.log("Debug: Subiendo nuevo archivo de corrección:", req.file.originalname);

      correctedFileData = {
        fileName: req.file.originalname,
        tipo: 'pdf',
        fileData: req.file.buffer,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        uploadedAt: new Date()
      };

      // Actualizar correctedFile en la respuesta
      await req.db.collection("respuestas").updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            correctedFile: correctedFileData,
            updatedAt: new Date()
          }
        }
      );
    } else {
      // Usar el correctedFile existente
      correctedFileData = respuesta.correctedFile;
      console.log("Debug: Usando corrección existente:", correctedFileData.fileName);
    }

    console.log("Debug: Aprobando respuesta con corrección:", correctedFileData.fileName);

    // Actualizar estado a "aprobado"
    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          status: "aprobado",
          approvedAt: new Date()
        }
      }
    );

    console.log("Debug: Resultado de actualización de estado:", updateResult);

    // Guardar en colección aprobados
    const insertResult = await req.db.collection("aprobados").insertOne({
      responseId: req.params.id,
      correctedFile: correctedFileData,
      approvedAt: new Date(),
      approvedBy: req.user?.id,
      createdAt: new Date(),
      formTitle: respuesta.formTitle,
      submittedBy: respuesta.submittedBy,
      company: respuesta.company
    });

    console.log("Debug: Resultado de inserción en aprobados:", insertResult);

    res.json({
      message: "Formulario aprobado correctamente",
      approved: true
    });

  } catch (err) {
    console.error("Error aprobando formulario:", err);
    res.status(500).json({ error: "Error aprobando formulario" });
  }
});

// Eliminar corrección de formularios APROBADOS
router.delete("/:id/remove-correction", async (req, res) => {
  try {
    console.log("Debug: Iniciando remove-correction para ID:", req.params.id);
    console.log("Debug: ID recibido:", req.params.id);

    const deleteResult = await req.db.collection("aprobados").deleteOne({
      responseId: req.params.id
    });

    console.log("Debug: Resultado de la eliminación en aprobados:", deleteResult);

    const updateResult = await req.db.collection("respuestas").updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          status: "en_revision",
          correctedFile: null,
          updatedAt: new Date()
        }
      }
    );

    console.log("Debug: Resultado de actualización en respuestas:", updateResult);

    if (updateResult.matchedCount === 0) {
      console.log("Debug: No se encontró la respuesta con ID:", req.params.id);
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }

    console.log("Debug: Estado actualizado a 'en_revision' en la base de datos para ID:", req.params.id);

    const updatedResponse = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(req.params.id)
    });

    res.json({
      message: "Corrección eliminada exitosamente",
      updatedRequest: updatedResponse
    });

  } catch (err) {
    console.error("Error eliminando corrección:", err);
    res.status(500).json({ error: "Error eliminando corrección" });
  }
});

router.get("/download-approved-pdf/:responseId", async (req, res) => {
  try {
    console.log("Debug: Solicitando descarga de PDF aprobado para responseId:", req.params.responseId);

    const approvedDoc = await req.db.collection("aprobados").findOne({
      responseId: req.params.responseId
    });

    if (!approvedDoc) {
      console.log("Debug: No se encontró documento aprobado para responseId:", req.params.responseId);
      return res.status(404).json({ error: "Documento aprobado no encontrado" });
    }

    if (!approvedDoc.correctedFile || !approvedDoc.correctedFile.fileData) {
      console.log("Debug: No hay archivo PDF en el documento aprobado");
      return res.status(404).json({ error: "Archivo PDF no disponible" });
    }

    console.log("Debug: Enviando PDF:", approvedDoc.correctedFile.fileName);

    res.setHeader('Content-Type', approvedDoc.correctedFile.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${approvedDoc.correctedFile.fileName}"`);
    res.setHeader('Content-Length', approvedDoc.correctedFile.fileSize);

    res.send(approvedDoc.correctedFile.fileData.buffer || approvedDoc.correctedFile.fileData);

  } catch (err) {
    console.error("Error descargando PDF aprobado:", err);
    res.status(500).json({ error: "Error descargando PDF aprobado" });
  }
});

// Subir PDF firmado por cliente a colección firmados
router.post("/:responseId/upload-client-signature", upload.single('signedPdf'), async (req, res) => {
  try {
    const { responseId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: "No se subió ningún archivo" });
    }

    const respuesta = await req.db.collection("respuestas").findOne({
      _id: new ObjectId(responseId)
    });

    if (!respuesta) {
      return res.status(404).json({ error: "Formulario no encontrado" });
    }

    if (respuesta.status !== 'aprobado') {
      return res.status(400).json({ error: "El formulario debe estar aprobado para subir la firma" });
    }

    const existingSignature = await req.db.collection("firmados").findOne({
      responseId: responseId
    });

    if (existingSignature) {
      return res.status(400).json({ error: "Ya existe un documento firmado para este formulario" });
    }

    const signatureData = {
      fileName: req.file.originalname,
      fileData: req.file.buffer,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      uploadedAt: new Date(),
      signedBy: "client",
      clientName: respuesta.submittedBy || respuesta.user?.nombre,
      clientEmail: respuesta.userEmail || respuesta.user?.mail
    };

    const result = await req.db.collection("firmados").insertOne({
      responseId: responseId,
      formId: respuesta.formId,
      formTitle: respuesta.formTitle,
      clientSignedPdf: signatureData,
      status: "uploaded",
      uploadedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      company: respuesta.company
    });

    res.json({
      success: true,
      message: "Documento firmado subido exitosamente",
      signatureId: result.insertedId
    });

  } catch (err) {
    console.error("Error subiendo firma del cliente:", err);
    res.status(500).json({ error: "Error subiendo firma del cliente" });
  }
});

// Obtener PDF firmado por cliente - CORREGIDO
router.get("/:responseId/client-signature", async (req, res) => {
  try {
    const { responseId } = req.params;

    const signature = await req.db.collection("firmados").findOne({
      responseId: responseId
    });

    if (!signature) {
      return res.status(404).json({ error: "Documento firmado no encontrado" });
    }

    const pdfData = signature.clientSignedPdf;

    if (!pdfData || !pdfData.fileData) {
      return res.status(404).json({ error: "Archivo PDF no disponible" });
    }

    res.setHeader('Content-Type', pdfData.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pdfData.fileName}"`);
    res.setHeader('Content-Length', pdfData.fileSize);

    // CORRECCIÓN: Usar .buffer igual que en download-approved-pdf
    res.send(pdfData.fileData.buffer || pdfData.fileData);

  } catch (err) {
    console.error("Error descargando firma del cliente:", err);
    res.status(500).json({ error: "Error descargando firma del cliente" });
  }
});

// Eliminar PDF firmado por cliente
router.delete("/:responseId/client-signature", async (req, res) => {
  try {
    const { responseId } = req.params;

    const deleteResult = await req.db.collection("firmados").deleteOne({
      responseId: responseId
    });

    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ error: "Documento firmado no encontrado" });
    }

    res.json({
      success: true,
      message: "Documento firmado eliminado exitosamente"
    });

  } catch (err) {
    console.error("Error eliminando firma del cliente:", err);
    res.status(500).json({ error: "Error eliminando firma del cliente" });
  }
});

// Verificar si existe PDF firmado para una respuesta específica
router.get("/:responseId/has-client-signature", async (req, res) => {
  try {
    const { responseId } = req.params;

    const signature = await req.db.collection("firmados").findOne({
      responseId: responseId
    }, {
      projection: {
        "clientSignedPdf.fileName": 1,
        "clientSignedPdf.uploadedAt": 1,
        "clientSignedPdf.fileSize": 1,
        status: 1
      }
    });

    if (!signature) {
      return res.json({ exists: false });
    }

    res.json({
      exists: true,
      signature: {
        fileName: signature.clientSignedPdf.fileName,
        uploadedAt: signature.clientSignedPdf.uploadedAt,
        fileSize: signature.clientSignedPdf.fileSize,
        status: signature.status
      }
    });

  } catch (err) {
    console.error("Error verificando firma del cliente:", err);
    res.status(500).json({ error: "Error verificando documento firmado" });
  }
});

module.exports = router;