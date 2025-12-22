const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb'); // Asumiendo que MongoDB está en req.db

// Nombre de la colección donde guardarás los flujos
const WORKFLOW_COLLECTION = "flujos"; 

// Middleware para asegurar que hay conexión a la BD antes de procesar rutas
function ensureDb(req, res, next) {
    if (!req.db) {
        return res.status(503).json({ error: 'Servicio no disponible: no hay conexión a la base de datos (MONGO_URI no configurado).' });
    }
    next();
}

router.use(ensureDb);

// --- 1. POST: Crear Nuevo Flujo (Solo Creación) ---
// URL: POST /api/workflows
router.post('/', async (req, res) => {
    try {
        const data = req.body;
        
        // Verifica si ya se envió un ID; si es así, se recomienda PUT.
        if (data._id || data.id) { 
             return res.status(400).json({ message: "Use PUT a /api/workflows/:id para actualizar un flujo existente. POST es solo para creación." });
        }

        const { name, nodes, connections, isPublished } = data;
        
        // Lógica DB: Inserta nuevo documento
        const result = await req.db.collection(WORKFLOW_COLLECTION).insertOne({
            name,
            nodes,
            connections,
            isPublished: isPublished || false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // Retorna el objeto creado con el ID de MongoDB (lo que el frontend espera)
        const newWorkflow = await req.db.collection(WORKFLOW_COLLECTION).findOne({ _id: result.insertedId });
        
        res.status(201).json(newWorkflow);

    } catch (error) {
        console.error("Error al crear el flujo:", error);
        res.status(500).json({ message: "Error al crear el flujo", error: error.message });
    }
});


// --- 2. PUT: Actualizar Flujo Existente (Coherente con handleSave del Front) ---
// URL: PUT /api/workflows/:id
router.put('/:id', async (req, res) => {
    try {
        const workflowId = req.params.id;
        const updates = req.body; 

        if (!ObjectId.isValid(workflowId)) {
            return res.status(400).json({ error: "ID de flujo no válido." });
        }
        
        // Evitar que valores numéricos (ej: counts) reemplacen los arrays reales
        if (updates.hasOwnProperty('nodes') && typeof updates.nodes !== 'object') {
            delete updates.nodes;
        }
        if (updates.hasOwnProperty('connections') && typeof updates.connections !== 'object') {
            delete updates.connections;
        }

        // El frontend envía el ID en la URL y los datos actualizados en el cuerpo.
        delete updates.id; 
        delete updates._id;

        const result = await req.db.collection(WORKFLOW_COLLECTION).findOneAndUpdate(
            { _id: new ObjectId(workflowId) },
            { $set: { 
                ...updates, 
                updatedAt: new Date()
            } },
            { returnDocument: "after" } 
        );
        
        if (!result || !result.value) {
            return res.status(404).json({ message: "Flujo de trabajo no encontrado para actualizar." });
        }

        res.status(200).json(result.value);
    } catch (error) {
        console.error("Error al actualizar el flujo:", error);
        res.status(500).json({ message: "Error al actualizar el flujo", error: error.message });
    }
});

// --- NUEVO: PATCH para actualizar campos de un nodo embebido por nodeId ---
// URL: PATCH /api/workflows/:id/nodes
// Body: { nodeId: "...", fields: { status: "...", title: "...", ... } }
router.patch('/:id/nodes', async (req, res) => {
    try {
        const workflowId = req.params.id;
        const { nodeId, fields } = req.body;

        if (!ObjectId.isValid(workflowId)) return res.status(400).json({ error: "ID de flujo no válido." });
        if (!nodeId || !fields || typeof fields !== 'object') return res.status(400).json({ error: "nodeId y fields son requeridos." });

        // Construir $set dinámico para arrayFilters
        const setObj = {};
        for (const [k, v] of Object.entries(fields)) {
            setObj[`nodes.$[node].${k}`] = v;
        }
        setObj['updatedAt'] = new Date();

        const result = await req.db.collection(WORKFLOW_COLLECTION).findOneAndUpdate(
            { _id: new ObjectId(workflowId) },
            { $set: setObj },
            {
                arrayFilters: [{ "node.id": nodeId }],
                returnDocument: "after"
            }
        );

        if (!result || !result.value) return res.status(404).json({ error: "Workflow o nodo no encontrado." });
        return res.json({ ok: true, workflow: result.value });
    } catch (err) {
        console.error("Error patch node:", err);
        res.status(500).json({ error: "Error interno al actualizar nodo" });
    }
});

// 3. ENDPOINT GET: Obtener un flujo por ID
// URL: GET /api/workflows/:id
router.get('/:id', async (req, res) => {
    try {
        const workflowId = req.params.id;
        
        if (!ObjectId.isValid(workflowId)) {
            return res.status(400).json({ error: "ID de flujo no válido." });
        }

        const workflow = await req.db
            .collection(WORKFLOW_COLLECTION)
            .findOne({ _id: new ObjectId(workflowId) });

        if (!workflow) {
            return res.status(404).json({ message: "Flujo de trabajo no encontrado." });
        }

        res.status(200).json(workflow);
    } catch (error) {
        console.error("Error al obtener el flujo:", error);
        res.status(500).json({ message: "Error al obtener el flujo", error: error.message });
    }
});


// 4. ENDPOINT DELETE: Eliminar un flujo
// URL: DELETE /api/workflows/:id
router.delete('/:id', async (req, res) => {
    try {
        const workflowId = req.params.id;
        
        if (!ObjectId.isValid(workflowId)) {
            return res.status(400).json({ error: "ID de flujo no válido." });
        }
        
        // LÓGICA DB: Elimina el flujo por ID
        const result = await req.db
            .collection(WORKFLOW_COLLECTION)
            .deleteOne({ _id: new ObjectId(workflowId) });

        if (result.deletedCount === 0) {
             return res.status(404).json({ message: "Flujo de trabajo no encontrado." });
        }

        res.status(200).json({ message: "Flujo eliminado exitosamente", id: workflowId });
    } catch (error) {
        console.error("Error al eliminar el flujo:", error);
        res.status(500).json({ message: "Error al eliminar el flujo", error: error.message });
    }
});


// 5. ENDPOINT GET: Listar todos los flujos (opcional, para una vista de administración)
// URL: GET /api/workflows
router.get("/", async (req, res) => {
  try {
    const workflows = await req.db.collection(WORKFLOW_COLLECTION).find().toArray();
    res.json(workflows);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener la lista de flujos" });
  }
});

router.get("/:mail", async (req, res) => {
  try {
    const workflows = await req.db.collection(WORKFLOW_COLLECTION).find().toArray();
    res.json(workflows);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener la lista de flujos" });
  }
});



module.exports = router;