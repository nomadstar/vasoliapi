const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// Colección donde están los flujos/tareas
const WORKFLOW_COLLECTION = "flujos";

// Middleware simple para asegurar que hay conexión a la BD
function ensureDb(req, res, next) {
    if (!req.db) {
        return res.status(503).json({ error: 'Servicio no disponible: no hay conexión a la base de datos (MONGO_URI no configurado).' });
    }
    next();
}

// Aplicar al router: todas las rutas requieren DB
router.use(ensureDb);

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

        // 1. Buscar Usuario para obtener el nombre del departamento
        const usuario = await req.db.collection('usuarios').findOne(
            { mail: email },
            { projection: { departamento: 1, empresa: 1 } }
        );

        if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

        const nombreDepartamento = usuario.departamento || usuario.empresa;
        if (!nombreDepartamento) return res.status(404).json({ error: "Departamento no definido para el usuario" });

        // 2. Buscar el documento del Departamento para obtener su _id
        // Usamos Regex para ignorar mayúsculas/minúsculas
        const departamentDoc = await req.db.collection("departamentos").findOne({
            name: { $regex: new RegExp(`^${nombreDepartamento}$`, 'i') }
        });

        if (!departamentDoc) return res.status(404).json({ error: `Departamento '${nombreDepartamento}' no existe en la DB` });

        const targetDeptId = departamentDoc._id.toString(); // El ID que buscamos en los nodos

        console.log(`Buscando tareas para Dept: ${nombreDepartamento} (ID: ${targetDeptId})`);

        // 3. Buscar Workflows y filtrar nodos específicos
        // Paso A: Encontrar workflows que tengan AL MENOS un nodo con ese department ID
        const workflows = await req.db.collection(WORKFLOW_COLLECTION).find({
            "nodes.department": targetDeptId
        }).toArray();

        // Paso B: Extraer solo los nodos (tareas) que coincidan.
        // La consulta de Mongo devuelve el documento entero, necesitamos filtrar el array 'nodes' con JS.
        let tareasEncontradas = [];
        let startDate = null;
        workflows.forEach(workflow => {
            startDate = workflow.createdAt || null;
            // Filtramos los nodos internos que pertenecen a este departamento
            const nodosDelDepto = workflow.nodes.filter(node => 
                node.department === targetDeptId && node.type === 'task' // Opcional: asegurar que sea tipo tarea
            );

            // Agregamos info del workflow padre por si la necesitas en el frontend
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
            startDate: startDate || null,
            count: tareasEncontradas.length, 
            tareas: tareasEncontradas 
        });

    } catch (err) {
        console.error("Error en tasks-by-email:", err);
        res.status(500).json({ error: "Error interno al obtener tareas por email" });
    }
});

// 4) Obtener un flujo por su ID (completo)
router.get('/:id', async (req, res) => {
    try {
        const taskId = req.params.id;

        if (!taskId) {
            return res.status(400).json({ error: 'ID de tarea requerido.' });
        }

        // 1. Buscar el flujo que contiene un nodo con este ID
        // La query "nodes.id": taskId busca en todos los documentos donde el array 'nodes'
        // tenga algún elemento con la propiedad 'id' igual a taskId.
        const workflow = await req.db.collection(WORKFLOW_COLLECTION).findOne(
            { "nodes.id": taskId }
        );

        if (!workflow) {
            return res.status(404).json({ error: 'Tarea no encontrada en ningún flujo.' });
        }

        // 2. Extraer la tarea específica del array de nodos
        const taskNode = workflow.nodes.find(node => node.id === taskId);

        if (!taskNode) {
            // Esto sería raro si el findOne funcionó, pero por seguridad
            return res.status(404).json({ error: 'Nodo de tarea no encontrado dentro del flujo.' });
        }

        // 3. Enriquecer la respuesta (Opcional pero recomendado)
        // Agregamos info del flujo padre para contexto
        const response = {
            ...taskNode,
            workflowId: workflow._id,
            workflowName: workflow.name,
            // Normalizar campos si es necesario para tu frontend
            files: taskNode.files || [], 
            comments: taskNode.comments || []
        };

        res.json(response);

    } catch (err) {
        console.error('Error al obtener tarea por id:', err);
        res.status(500).json({ error: 'Error interno al obtener la tarea' });
    }
});


// actualizar el status de una tarea
router.patch('/:id', async (req, res) => {
    try {
        const taskId = req.params.id;
        const { status } = req.body;

        if (!taskId) {
            return res.status(400).json({ error: 'ID de tarea requerido.' });
        }

        if (!status) {
            return res.status(400).json({ error: 'El campo "status" es requerido.' });
        }

        // Buscar workflow que contenga el nodo
        const workflow = await req.db.collection(WORKFLOW_COLLECTION).findOne(
            { "nodes.id": taskId }
        );

        // 5) Obtener tareas asignadas a un usuario (por id o email)
        // URL: GET /api/workflows/tasks-by-user/:user
        router.get('/tasks-by-user/:user', async (req, res) => {
            try {
                const { user } = req.params;
                if (!user) return res.status(400).json({ error: "Usuario requerido (id o email)" });

                const collection = req.db.collection(WORKFLOW_COLLECTION);

                // Construir condiciones posibles dentro de nodes para cubrir distintos esquemas
                const orConditions = [
                    { "nodes.owner": user },
                    { "nodes.assignedTo": user },
                    { "nodes.userId": user },
                    { "nodes.responsible": user },
                    { "nodes.email": user }
                ];

                // Si user parece un ObjectId, también intentamos con ObjectId en campos que lo tengan
                if (ObjectId.isValid(user)) {
                    const obj = new ObjectId(user);
                    orConditions.push(
                        { "nodes.owner": obj },
                        { "nodes.assignedTo": obj },
                        { "nodes.userId": obj }
                    );
                }

                const workflows = await collection.find({ $or: orConditions }).toArray();

                // Extraer solo los nodos que correspondan al usuario
                const tareas = [];
                workflows.forEach(wf => {
                    const matched = (wf.nodes || []).filter(n =>
                        n && (
                            n.owner === user ||
                            n.assignedTo === user ||
                            n.userId === user ||
                            n.responsible === user ||
                            n.email === user ||
                            (ObjectId.isValid(user) && (
                                (n.owner && ObjectId.isValid(n.owner) && n.owner.toString() === user) ||
                                (n.assignedTo && ObjectId.isValid(n.assignedTo) && n.assignedTo.toString() === user) ||
                                (n.userId && ObjectId.isValid(n.userId) && n.userId.toString() === user)
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
                console.error("Error en tasks-by-user:", err);
                res.status(500).json({ error: "Error interno al obtener tareas por usuario" });
            }
        });

        // Actualizar o crear el campo status dentro del nodo correspondiente
        const updateResult = await req.db.collection(WORKFLOW_COLLECTION).updateOne(
            { _id: workflow._id },
            {
                $set: {
                    "nodes.$[task].status": status   // <-- crea o actualiza
                }
            },
            {
                arrayFilters: [
                    { "task.id": taskId }
                ]
            }
        );

        res.json({
            message: "Status actualizado correctamente.",
            taskId,
            newStatus: status
        });

    } catch (err) {
        console.error("Error al actualizar status:", err);
        res.status(500).json({ error: "Error interno al actualizar el status" });
    }
});


module.exports = router;