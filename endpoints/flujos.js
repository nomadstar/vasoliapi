const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { encrypt, decrypt } = require("../utils/seguridad.helper");

const WORKFLOW_COLLECTION = "flujos";

// --- HELPERS INTERNOS DE TRANSFORMACIÓN ---

const processNode = (node, mode = 'encrypt') => {
    if (!node) return node;
    const action = mode === 'encrypt' ? encrypt : decrypt;
    return {
        ...node,
        title: node.title ? action(node.title) : node.title,
        description: node.description ? action(node.description) : node.description,
        type: node.type ? action(node.type) : node.type,
        priority: node.priority ? action(node.priority) : node.priority,
        assignedTo: node.assignedTo ? action(node.assignedTo) : node.assignedTo,
    };
};

const processWorkflow = (wf, mode = 'encrypt') => {
    if (!wf) return wf;
    const action = mode === 'encrypt' ? encrypt : decrypt;
    
    const result = { ...wf };
    if (result.name) result.name = action(result.name);
    if (result.status) result.status = action(result.status);
    if (result.gestion) result.gestion = action(result.gestion);
    if (result.empresa) result.empresa = action(result.empresa);
    if (result.summary) result.summary = action(result.summary);
    
    // Si el campo es 'status' pero en la DB se llama 'estadoFlujo' según tu esquema
    if (result.estadoFlujo) result.estadoFlujo = action(result.estadoFlujo);

    if (result.nodes && Array.isArray(result.nodes)) {
        result.nodes = result.nodes.map(node => processNode(node, mode));
    }
    return result;
};

// --- MIDDLEWARE ---

function ensureDb(req, res, next) {
    if (!req.db) {
        return res.status(503).json({ error: 'Servicio no disponible: no hay conexión a la base de datos.' });
    }
    next();
}

router.use(ensureDb);

// --- 1. POST: Crear o Upsert ---

router.post('/', async (req, res) => {
    try {
        const data = req.body;
        const providedId = data._id || data.id;
        
        // Cifrar datos antes de guardar
        const encryptedData = processWorkflow(data, 'encrypt');

        if (providedId) {
            const filter = ObjectId.isValid(providedId) ? { _id: new ObjectId(providedId) } : { _id: providedId };
            
            // Limpiar IDs del set para evitar conflictos en Mongo
            const { _id, id, ...toSet } = encryptedData;
            toSet.updatedAt = new Date();

            const result = await req.db.collection(WORKFLOW_COLLECTION).updateOne(
                filter,
                { $set: toSet, $setOnInsert: { createdAt: new Date() } },
                { upsert: true }
            );

            const finalDoc = await req.db.collection(WORKFLOW_COLLECTION).findOne(filter);
            const statusCode = result.upsertedCount ? 201 : 200;
            
            return res.status(statusCode).json({ 
                success: true, 
                upserted: !!result.upsertedId, 
                workflow: processWorkflow(finalDoc, 'decrypt') 
            });
        }

        const result = await req.db.collection(WORKFLOW_COLLECTION).insertOne({
            ...encryptedData,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        const newWorkflow = await req.db.collection(WORKFLOW_COLLECTION).findOne({ _id: result.insertedId });
        return res.status(201).json(processWorkflow(newWorkflow, 'decrypt'));

    } catch (error) {
        console.error("Error al crear el flujo:", error);
        res.status(500).json({ message: "Error al crear el flujo", error: error.message });
    }
});

// --- 2. PUT: Actualizar Flujo Existente ---

router.put('/:id', async (req, res) => {
    try {
        const workflowId = req.params.id;
        if (!ObjectId.isValid(workflowId)) {
            return res.status(400).json({ error: "ID de flujo no válido." });
        }

        const updates = req.body;
        // Cifrar los campos sensibles que vienen en el body
        const encryptedUpdates = processWorkflow(updates, 'encrypt');

        // Limpiar IDs
        delete encryptedUpdates.id; 
        delete encryptedUpdates._id;

        const result = await req.db.collection(WORKFLOW_COLLECTION).findOneAndUpdate(
            { _id: new ObjectId(workflowId) },
            { $set: { ...encryptedUpdates, updatedAt: new Date() } },
            { returnDocument: "after" } 
        );
        
        if (!result || !result.value) {
            return res.status(404).json({ message: "Flujo no encontrado." });
        }

        res.status(200).json(processWorkflow(result.value, 'decrypt'));
    } catch (error) {
        console.error("Error al actualizar el flujo:", error);
        res.status(500).json({ message: "Error al actualizar el flujo", error: error.message });
    }
});

// --- 3. PATCH: Actualizar campos de un nodo ---

router.patch('/:id/nodes', async (req, res) => {
    try {
        const workflowId = req.params.id;
        const { nodeId, fields } = req.body;

        if (!ObjectId.isValid(workflowId)) return res.status(400).json({ error: "ID de flujo no válido." });
        if (!nodeId || !fields) return res.status(400).json({ error: "nodeId y fields son requeridos." });

        // Cifrar solo los campos sensibles si vienen en 'fields'
        const sensitiveNodeFields = ['title', 'description', 'type', 'priority', 'assignedTo'];
        const processedFields = { ...fields };
        
        sensitiveNodeFields.forEach(f => {
            if (processedFields[f]) processedFields[f] = encrypt(processedFields[f]);
        });

        const setObj = {};
        for (const [k, v] of Object.entries(processedFields)) {
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
        return res.json({ ok: true, workflow: processWorkflow(result.value, 'decrypt') });
    } catch (err) {
        console.error("Error patch node:", err);
        res.status(500).json({ error: "Error interno al actualizar nodo" });
    }
});

// --- 4. GET: Obtener un flujo por ID ---

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
            return res.status(404).json({ message: "Flujo no encontrado." });
        }

        res.status(200).json(processWorkflow(workflow, 'decrypt'));
    } catch (error) {
        res.status(500).json({ message: "Error al obtener el flujo", error: error.message });
    }
});

// --- 5. DELETE: Eliminar un flujo ---

router.delete('/:id', async (req, res) => {
    try {
        const workflowId = req.params.id;
        if (!ObjectId.isValid(workflowId)) return res.status(400).json({ error: "ID no válido." });
        
        const result = await req.db.collection(WORKFLOW_COLLECTION).deleteOne({ _id: new ObjectId(workflowId) });

        if (result.deletedCount === 0) return res.status(404).json({ message: "No encontrado." });
        res.status(200).json({ message: "Flujo eliminado exitosamente", id: workflowId });
    } catch (error) {
        res.status(500).json({ message: "Error al eliminar el flujo", error: error.message });
    }
});

// --- 6. GET: Listar flujos (Paginación) ---

router.get('/', async (req, res) => {
    try {
        const pageSize = Math.min(100, parseInt(req.query.pageSize, 10) || 20);
        const lastId = req.query.lastId;

        const filter = {};
        if (req.query.owner) filter.owner = req.query.owner;
        if (req.query.status) filter.status = req.query.status;

        const collection = req.db.collection(WORKFLOW_COLLECTION);
        
        // --- REPLICACIÓN EXACTA DE LA LÓGICA DE BÚSQUEDA ORIGINAL ---
        let query;
        if (lastId && ObjectId.isValid(lastId)) {
            // Se debe mantener el ordenamiento consistente (ej: sort _id: 1)
            query = collection.find({ ...filter, _id: { $gt: new ObjectId(lastId) } })
                              .sort({ _id: 1 })
                              .limit(pageSize + 1);
        } else {
            // Primera carga: orden descendente por creación
            query = collection.find(filter)
                              .sort({ createdAt: -1 })
                              .limit(pageSize + 1);
        }

        // Proyección de campos necesarios para el listado (incluyendo los que se descifran)
        const projection = { 
            name: 1, owner: 1, isPublished: 1, status: 1, 
            createdAt: 1, updatedAt: 1, summary: 1, 
            gestion: 1, empresa: 1 
        };
        
        const docs = await query.project(projection).toArray();

        // --- MANEJO DE HAS_MORE Y POP (Lógica de parada) ---
        const hasMore = docs.length > pageSize;
        if (hasMore) {
            docs.pop(); // Elimina el registro N+1 usado para detectar más datos
        }

        // Descifrar solo los documentos resultantes después del pop
        const decryptedItems = docs.map(item => processWorkflow(item, 'decrypt'));
        
        // Obtener el cursor del último elemento real (ya descifrado)
        const nextCursor = decryptedItems.length ? decryptedItems[decryptedItems.length - 1]._id : null;

        res.json({ 
            items: decryptedItems, 
            hasMore, 
            nextCursor 
        });
    } catch (err) {
        console.error('Error al listar flujos:', err);
        res.status(500).json({ error: 'Error al obtener la lista de flujos' });
    }
});
module.exports = router;