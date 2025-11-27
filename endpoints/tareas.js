const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// Colección donde están los flujos/tareas
const WORKFLOW_COLLECTION = "flujos";

// 1) Obtener departamento a partir de un email
// URL: GET /api/workflows/department-by-email/:email
router.get('/department-by-email/:email', async (req, res) => {
    try {
        const { email } = req.params;
        if (!email) return res.status(400).json({ error: "Email requerido" });

        const usuario = await req.db.collection('usuarios').findOne(
            { mail: email },
            { projection: { departamento: 1, empresa: 1, nombre: 1 } }
        );

        if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

        const departamento = usuario.departamento || usuario.empresa || null;

        return res.json({ email, departamento, nombre: usuario.nombre });
    } catch (err) {
        console.error("Error en department-by-email:", err);
        res.status(500).json({ error: "Error interno al obtener departamento" });
    }
});

// 2) Obtener tareas/flujos a partir de un departamento (acepta ObjectId o nombre)
// URL: GET /api/workflows/tasks-by-department/:dept
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
                    { departamento: dept },
                    { departamento: { $regex: re } },
                    { departmentName: { $regex: re } },
                    { ownerDepartment: { $regex: re } }
                ]
            };
        }

        const tareas = await req.db.collection(WORKFLOW_COLLECTION).find(query).toArray();
        res.json({ count: tareas.length, tareas });
    } catch (err) {
        console.error("Error en tasks-by-department:", err);
        res.status(500).json({ error: "Error interno al obtener tareas por departamento" });
    }
});

// 3) Combinado: obtener tareas a partir del email (busca departamento y luego tareas)
// URL: GET /api/workflows/tasks-by-email/:email
router.get('/tasks-by-email/:email', async (req, res) => {
    try {
        const { email } = req.params;
        if (!email) return res.status(400).json({ error: "Email requerido" });

        const usuario = await req.db.collection('usuarios').findOne(
            { mail: email },
            { projection: { departamento: 1, empresa: 1 } }
        );

        if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });
        console.log(usuario);

        const departamento = usuario.departamento || usuario.empresa;
        if (!departamento) return res.status(404).json({ error: "Departamento no definido para el usuario" });
        console.log(departamento);

        let query = {};
        if (ObjectId.isValid(departamento._id)) {
            const objId = departamento._id;
            query = { $or: [{ department: objId }, { department: objId }, { departamento}] };
        } else {
            const re = new RegExp(departamento, 'i');
            query = { $or: [{ departamento }, { departamento: { $regex: re } }, { departmentName: { $regex: re } }] };
        }

        const tareas = await req.db.collection(WORKFLOW_COLLECTION).find(query).toArray();
        res.json({ departamento, count: tareas.length, tareas });
    } catch (err) {
        console.error("Error en tasks-by-email:", err);
        res.status(500).json({ error: "Error interno al obtener tareas por email" });
    }
});

module.exports = router;