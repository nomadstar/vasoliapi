const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { createBlindIndex, decrypt } = require("../utils/seguridad.helper");

// Colección donde están los flujos/tareas
const WORKFLOW_COLLECTION = "flujos";

// Middleware simple para asegurar que hay conexión a la BD
function ensureDb(req, res, next) {
    if (!req.db) {
        return res.status(503).json({ error: 'Servicio no disponible.' });
    }
    next();
}

router.use(ensureDb);

// 1) Obtener departamento a partir de un email
router.get('/department-by-email/:email', async (req, res) => {
    try {
        const { email } = req.params;
        if (!email) return res.status(400).json({ error: "Email requerido" });

        // ⚠️ CAMBIO: Búsqueda por mail_index
        const normalizedEmail = email.toLowerCase().trim();
        const usuario = await req.db.collection('usuarios').findOne(
            { mail_index: createBlindIndex(normalizedEmail) },
            { projection: { departamento: 1, empresa: 1, nombre: 1, mail: 1 } }
        );

        if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

        // ⚠️ CAMBIO: Desencriptar nombre si es necesario
        const nombreReal = usuario.nombre.includes(':') ? decrypt(usuario.nombre) : usuario.nombre;
        const departamento = usuario.departamento || usuario.empresa || null;

        return res.json({ email, departamento, nombre: nombreReal });
    } catch (err) {
        console.error("Error en department-by-email:", err);
        res.status(500).json({ error: "Error interno" });
    }
});

// 2) Obtener tareas/flujos a partir de un departamento
router.get('/tasks-by-department/:dept', async (req, res) => {
    try {
        const { dept } = req.params;
        if (!dept) return res.status(400).json({ error: "Departamento requerido" });

        let query = {};
        if (ObjectId.isValid(dept)) {
            const objId = new ObjectId(dept);
            query = {
                $or: [
                    { departmentId: objId },
                    { departamentoId: objId },
                    { departamento: dept }
                ]
            };
        } else {
            const re = new RegExp(dept, 'i');
            query = {
                $or: [
                    { departamento: { $regex: re } },
                    { departmentName: { $regex: re } },
                    { ownerDepartment: { $regex: re } }
                ]
            };
        }

        const tareas = await req.db.collection(WORKFLOW_COLLECTION).find(query).toArray();
        res.json({ count: tareas.length, tareas });
    } catch (err) {
        res.status(500).json({ error: "Error interno" });
    }
});

// 3) Combinado: obtener tareas a partir del email
router.get('/tasks-by-email/:email', async (req, res) => {
    try {
        const { email } = req.params;
        if (!email) return res.status(400).json({ error: "Email requerido" });

        // ⚠️ CAMBIO: Búsqueda por mail_index
        const normalizedEmail = email.toLowerCase().trim();
        const usuario = await req.db.collection('usuarios').findOne(
            { mail_index: createBlindIndex(normalizedEmail) },
            { projection: { departamento: 1, empresa: 1 } }
        );

        if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

        const nombreDepartamento = usuario.departamento || usuario.empresa;
        if (!nombreDepartamento) return res.status(404).json({ error: "Departamento no definido" });

        const departamentDoc = await req.db.collection("departamentos").findOne({
            name: { $regex: new RegExp(`^${nombreDepartamento}$`, 'i') }
        });

        if (!departamentDoc) return res.status(404).json({ error: "Departamento no existe en DB" });

        const targetDeptId = departamentDoc._id.toString();

        const workflows = await req.db.collection(WORKFLOW_COLLECTION).find({
            "nodes.department": targetDeptId
        }).toArray();

        let tareasEncontradas = [];
        workflows.forEach(workflow => {
            const nodosDelDepto = workflow.nodes.filter(node => 
                node.department === targetDeptId && node.type === 'task'
            );

            const nodosConContexto = nodosDelDepto.map(node => ({
                ...node,
                workflowName: workflow.name,
                workflowId: workflow._id
            }));

            tareasEncontradas = [...tareasEncontradas, ...nodosConContexto];
        });

        res.json({ 
            departamento: departamentDoc.name, 
            departamentoId: targetDeptId,
            count: tareasEncontradas.length, 
            tareas: tareasEncontradas 
        });

    } catch (err) {
        res.status(500).json({ error: "Error interno" });
    }
});

// 5) Obtener tareas asignadas a un usuario
router.get('/tasks-by-user/:user', async (req, res) => {
    try {
        const { user } = req.params; // Puede ser ID o Email
        if (!user) return res.status(400).json({ error: "Usuario requerido" });

        // Si el parámetro parece un email, lo normalizamos
        const isEmail = user.includes('@');
        const userSearchValue = isEmail ? user.toLowerCase().trim() : user;

        const collection = req.db.collection(WORKFLOW_COLLECTION);

        // Mantenemos la lógica de búsqueda en nodos (los nodos guardan el email en texto plano o el ID)
        const orConditions = [
            { "nodes.owner": userSearchValue },
            { "nodes.assignedTo": userSearchValue },
            { "nodes.userId": userSearchValue },
            { "nodes.responsible": userSearchValue },
            { "nodes.email": userSearchValue }
        ];

        if (ObjectId.isValid(user)) {
            const obj = new ObjectId(user);
            orConditions.push(
                { "nodes.owner": obj },
                { "nodes.assignedTo": obj },
                { "nodes.userId": obj }
            );
        }

        const workflows = await collection.find({ $or: orConditions }).toArray();
        const tareas = [];

        workflows.forEach(wf => {
            const matched = (wf.nodes || []).filter(n =>
                n && (
                    n.owner === userSearchValue ||
                    n.assignedTo === userSearchValue ||
                    n.userId === userSearchValue ||
                    n.responsible === userSearchValue ||
                    n.email === userSearchValue ||
                    (ObjectId.isValid(user) && (
                        (n.owner?.toString() === user) ||
                        (n.assignedTo?.toString() === user) ||
                        (n.userId?.toString() === user)
                    ))
                )
            );

            matched.forEach(n => tareas.push({
                ...n,
                workflowId: wf._id,
                workflowName: wf.name
            }));
        });

        res.json({ count: tareas.length, tareas });
    } catch (err) {
        res.status(500).json({ error: "Error interno" });
    }
});

// Los endpoints de PATCH y GET por ID de nodo se mantienen iguales 
// ya que operan sobre IDs de nodos y flujos, no directamente sobre campos cifrados del usuario.

module.exports = router;