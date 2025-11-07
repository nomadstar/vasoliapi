const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");

// Nuevo endpoint para obtener información del documento por responseId
router.get("/info-by-response/:responseId", async (req, res) => {
    try {
        const { responseId } = req.params;
        const documento = await req.db.collection('docxs').findOne({ responseId: responseId });

        if (!documento) {
            return res.status(404).json({ error: "Documento no encontrado" });
        }

        res.json({
            IDdoc: documento.IDdoc,
            tipo: documento.tipo || 'docx',
            responseId: documento.responseId,
            createdAt: documento.createdAt
        });
    } catch (err) {
        console.error("Error obteniendo información del documento:", err);
        res.status(500).json({ error: "Error obteniendo información del documento" });
    }
});

// Endpoint para obtener todos los documentos
router.get("/docxs", async (req, res) => {
    try {
        const docxs = await req.db.collection('docxs').find().toArray();
        res.json(docxs);
    } catch (err) {
        console.error("Error obteniendo documentos:", err);
        res.status(500).json({ error: "Error obteniendo documentos" });
    }
});

// Endpoint para descargar documento (DOCX o TXT)
router.get("/download/:IDdoc", async (req, res) => {
    try {
        const { IDdoc } = req.params;
        console.log("=== SOLICITUD DE DESCARGA ===");
        console.log("Buscando documento con IDdoc:", IDdoc);

        const documento = await req.db.collection('docxs').findOne({ IDdoc: IDdoc });

        if (!documento) {
            console.log("Documento no encontrado para IDdoc:", IDdoc);
            return res.status(404).json({ error: "Documento no encontrado" });
        }

        console.log("Documento encontrado");
        console.log("Tipo de documento:", documento.tipo || 'docx');

        // OBTENER EL BUFFER CORRECTAMENTE
        const fileBuffer = documento.docxFile.buffer || documento.docxFile;
        const bufferLength = fileBuffer.length;

        // Actualizar estado en respuestas (solo si es un documento relacionado con una respuesta)
        if (documento.responseId) {
            await req.db.collection("respuestas").updateOne(
                { _id: new ObjectId(documento.responseId) },
                {
                    $set: {
                        status: "en_revision",
                        reviewedAt: new Date()
                    }
                }
            );
        }

        // CONFIGURAR HEADERS SEGÚN EL TIPO DE DOCUMENTO
        if (documento.tipo === 'txt') {
            // Para archivos TXT
            res.set({
                'Content-Type': 'text/plain',
                'Content-Disposition': `attachment; filename="${IDdoc}.txt"`,
                'Content-Length': bufferLength
            });
            console.log("Enviando archivo TXT, tamaño:", bufferLength);
        } else {
            // Para archivos DOCX (por defecto)
            res.set({
                'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'Content-Disposition': `attachment; filename="${IDdoc}.docx"`,
                'Content-Length': bufferLength
            });
            console.log("Enviando archivo DOCX, tamaño:", bufferLength);
        }

        // ENVIAR EL BUFFER
        res.send(fileBuffer);

    } catch (err) {
        console.error("Error descargando documento:", err);
        console.error("Detalles del error:", err.message);
        res.status(500).json({ error: "Error descargando el documento: " + err.message });
    }
});

// Nuevo endpoint para obtener información del documento (útil para el frontend)
router.get("/info/:IDdoc", async (req, res) => {
    try {
        const { IDdoc } = req.params;
        const documento = await req.db.collection('docxs').findOne({ IDdoc: IDdoc });

        if (!documento) {
            return res.status(404).json({ error: "Documento no encontrado" });
        }

        res.json({
            IDdoc: documento.IDdoc,
            tipo: documento.tipo || 'docx',
            responseId: documento.responseId,
            createdAt: documento.createdAt
        });
    } catch (err) {
        console.error("Error obteniendo información del documento:", err);
        res.status(500).json({ error: "Error obteniendo información del documento" });
    }
});

module.exports = router;