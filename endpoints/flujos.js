const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb'); // Asumiendo que MongoDB está en req.db

// Nombre de la colección donde guardarás los flujos
const WORKFLOW_COLLECTION = "flujos"; 

const encryptNode = (node) => ({
    ...node,
    title: node.title ? encrypt(node.title) : node.title,
    description: node.description ? encrypt(node.description) : node.description,
    type: node.type ? encrypt(node.type) : node.type,
    priority: node.priority ? encrypt(node.priority) : node.priority,
    assignedTo: node.assignedTo ? encrypt(node.assignedTo) : node.assignedTo,
});

const decryptNode = (node) => ({
    ...node,
    title: node.title ? decrypt(node.title) : node.title,
    description: node.description ? decrypt(node.description) : node.description,
    type: node.type ? decrypt(node.type) : node.type,
    priority: node.priority ? decrypt(node.priority) : node.priority,
    assignedTo: node.assignedTo ? decrypt(node.assignedTo) : node.assignedTo,
});

const encryptWorkflow = (wf) => {
    const encrypted = { ...wf };
    if (encrypted.name) encrypted.name = encrypt(encrypted.name);
    if (encrypted.status) encrypted.status = encrypt(encrypted.status);
    if (encrypted.gestion) encrypted.gestion = encrypt(encrypted.gestion);
    if (encrypted.empresa) encrypted.empresa = encrypt(encrypted.empresa);
    if (encrypted.nodes && Array.isArray(encrypted.nodes)) {
        encrypted.nodes = encrypted.nodes.map(encryptNode);
    }
    return encrypted;
};

const decryptWorkflow = (wf) => {
    if (!wf) return wf;
    const decrypted = { ...wf };
    if (decrypted.name) decrypted.name = decrypt(decrypted.name);
    if (decrypted.status) decrypted.status = decrypt(decrypted.status);
    if (decrypted.gestion) decrypted.gestion = decrypt(decrypted.gestion);
    if (decrypted.empresa) decrypted.empresa = decrypt(decrypted.empresa);
    if (decrypted.nodes && Array.isArray(decrypted.nodes)) {
        decrypted.nodes = decrypted.nodes.map(decryptNode);
    }
    return decrypted;
};

// --- MIDDLEWARE ---
function ensureDb(req, res, next) {
    if (!req.db) return res.status(503).json({ error: 'Servicio no disponible' });
    next();
}
router.use(ensureDb);


// --- 1. POST: Crear Nuevo Flujo (Solo Creación) ---
// URL: POST /api/workflows
router.post('/', async (req, res) => {
    try {
        const data = req.body;
        const encryptedData = encryptWorkflow(data);
        const providedId = data._id || data.id;

        if (providedId) {
            const filter = ObjectId.isValid(providedId) ? { _id: new ObjectId(providedId) } : { _id: providedId };
            delete encryptedData._id;
            delete encryptedData.id;

            await req.db.collection(WORKFLOW_COLLECTION).updateOne(
                filter,
                { $set: { ...encryptedData, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
                { upsert: true }
            );

            const finalDoc = await req.db.collection(WORKFLOW_COLLECTION).findOne(filter);
            return res.status(200).json(decryptWorkflow(finalDoc));
        }

        const result = await req.db.collection(WORKFLOW_COLLECTION).insertOne({
            ...encryptedData,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        const newWorkflow = await req.db.collection(WORKFLOW_COLLECTION).findOne({ _id: result.insertedId });
        return res.status(201).json(decryptWorkflow(newWorkflow));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// --- 2. PUT: Actualizar Flujo Existente (Coherente con handleSave del Front) ---
// URL: PUT /api/workflows/:id
router.put('/:id', async (req, res) => {
    try {
        const workflowId = req.params.id;
        if (!ObjectId.isValid(workflowId)) return res.status(400).json({ error: "ID no válido" });

        const encryptedUpdates = encryptWorkflow(req.body);
        delete encryptedUpdates._id;
        delete encryptedUpdates.id;

        const result = await req.db.collection(WORKFLOW_COLLECTION).findOneAndUpdate(
            { _id: new ObjectId(workflowId) },
            { $set: { ...encryptedUpdates, updatedAt: new Date() } },
            { returnDocument: "after" }
        );

        res.status(200).json(decryptWorkflow(result.value));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- NUEVO: PATCH para actualizar campos de un nodo embebido por nodeId ---
// URL: PATCH /api/workflows/:id/nodes
// Body: { nodeId: "...", fields: { status: "...", title: "...", ... } }
router.patch('/:id/nodes', async (req, res) => {
    try {
        const workflowId = req.params.id;
        const { nodeId, fields } = req.body;
        if (!ObjectId.isValid(workflowId)) return res.status(400).json({ error: "ID no válido" });

        // Cifrar campos del nodo si corresponden a los campos sensibles definidos
        const fieldsToEncrypt = ['title', 'description', 'type', 'priority', 'assignedTo'];
        const encryptedFields = { ...fields };
        
        fieldsToEncrypt.forEach(f => {
            if (encryptedFields[f]) encryptedFields[f] = encrypt(encryptedFields[f]);
        });

        const setObj = {};
        for (const [k, v] of Object.entries(encryptedFields)) {
            setObj[`nodes.$[node].${k}`] = v;
        }
        setObj['updatedAt'] = new Date();

        const result = await req.db.collection(WORKFLOW_COLLECTION).findOneAndUpdate(
            { _id: new ObjectId(workflowId) },
            { $set: setObj },
            { arrayFilters: [{ "node.id": nodeId }], returnDocument: "after" }
        );

        return res.json({ ok: true, workflow: decryptWorkflow(result.value) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. ENDPOINT GET: Obtener un flujo por ID
// URL: GET /api/workflows/:id
router.get('/:id', async (req, res) => {
    try {
        const workflowId = req.params.id;
        if (!ObjectId.isValid(workflowId)) return res.status(400).json({ error: "ID no válido" });

        const workflow = await req.db.collection(WORKFLOW_COLLECTION).findOne({ _id: new ObjectId(workflowId) });
        if (!workflow) return res.status(404).json({ message: "No encontrado" });

        res.status(200).json(decryptWorkflow(workflow));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// 4. ENDPOINT DELETE: Eliminar un flujo
// URL: DELETE /api/workflows/:id
router.delete('/:id', async (req, res) => {
    try {
        const workflowId = req.params.id;
        if (!ObjectId.isValid(workflowId)) return res.status(400).json({ error: "ID no válido" });
        
        const result = await req.db.collection(WORKFLOW_COLLECTION).deleteOne({ _id: new ObjectId(workflowId) });
        if (result.deletedCount === 0) return res.status(404).json({ message: "No encontrado" });

        res.status(200).json({ message: "Eliminado exitosamente", id: workflowId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// 5. ENDPOINT GET: Listar flujos con paginación (cursor-based preferible)
// URL: GET /api/workflows?pageSize=20&lastId=<objectId>
router.get('/', async (req, res) => {
    try {
        const pageSize = Math.min(100, parseInt(req.query.pageSize, 10) || 20);
        const lastId = req.query.lastId;
        const filter = {};

        let query = req.db.collection(WORKFLOW_COLLECTION).find(filter);

        if (lastId && ObjectId.isValid(lastId)) {
            query = req.db.collection(WORKFLOW_COLLECTION).find({ ...filter, _id: { $gt: new ObjectId(lastId) } }).sort({ _id: 1 });
        } else {
            query = query.sort({ createdAt: -1 });
        }

        // Proyectamos campos para el listado (incluyendo los cifrados para poder descifrarlos)
        const docs = await query.limit(pageSize + 1).project({
            name: 1, status: 1, gestion: 1, empresa: 1, isPublished: 1, createdAt: 1, updatedAt: 1
        }).toArray();

        const hasMore = docs.length > pageSize;
        if (hasMore) docs.pop();

        // Descifrar resultados del listado (estos no suelen traer 'nodes' por la proyección)
        const decryptedDocs = docs.map(decryptWorkflow);

        res.json({ items: decryptedDocs, hasMore, nextCursor: docs.length ? docs[docs.length - 1]._id : null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. ENDPOINT DE MIGRACIÓN: CIFRAR FLUJOS EXISTENTES ---
// URL: PATCH /api/workflows/system/migrate-encryption
router.patch('/system/migrate-encryption', async (req, res) => {
    try {
        const collection = req.db.collection(WORKFLOW_COLLECTION);
        
        // 1. Obtener todos los flujos de la colección
        const workflows = await collection.find({}).toArray();
        
        if (workflows.length === 0) {
            return res.status(404).json({ message: "No se encontraron flujos para migrar." });
        }

        let actualizados = 0;
        let errores = 0;

        // 2. Procesar cada flujo uno por uno
        const operaciones = workflows.map(async (wf) => {
            try {
                // Verificamos si ya parece estar cifrado (opcional, para evitar doble cifrado)
                // Si el nombre contiene el separador ":", asumimos que ya está procesado
                if (wf.name && wf.name.includes(':')) {
                    return; 
                }

                const encryptedWf = encryptWorkflow(wf);
                
                // Actualizamos el documento en la base de datos
                await collection.updateOne(
                    { _id: wf._id },
                    { 
                        $set: { 
                            ...encryptedWf,
                            updatedAt: new Date(),
                            migrationLog: "Encrypted on " + new Date().toISOString()
                        } 
                    }
                );
                actualizados++;
            } catch (err) {
                console.error(`Error cifrando flujo ${wf._id}:`, err);
                errores++;
            }
        });

        await Promise.all(operaciones);

        res.json({
            success: true,
            message: "Proceso de migración de cifrado completado.",
            total_procesados: workflows.length,
            actualizados_exitosamente: actualizados,
            errores: errores
        });

    } catch (error) {
        console.error("Error crítico en la migración:", error);
        res.status(500).json({ 
            error: "Error interno durante la migración de datos", 
            details: error.message 
        });
    }
});

module.exports = router;