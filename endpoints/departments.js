const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb'); 

const DEPARTMENTS_COLLECTION = "departamentos"; 

// --- 1. POST: Crear Nuevo Departamento ---
// URL: POST /api/departments
router.post('/', async (req, res) => {
    try {
        const data = req.body;
        
        // Evitar creación si se envía ID
        if (data.id || data._id) { 
             return res.status(400).json({ message: "Use PUT para actualizar un departamento existente." });
        }

        const { name, description, icon, supervisorId, status } = data;
        
        // Lógica DB: Inserta nuevo documento
        const result = await req.db.collection(DEPARTMENTS_COLLECTION).insertOne({
            name,
            description,
            icon,
            supervisorId, // ID del supervisor
            status: status || 'active',
            memberCount: 0, // Inicializar contadores
            activeWorkflows: 0,
            completedTasks: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // Retorna el objeto creado con el ID de MongoDB
        const newDepartment = await req.db.collection(DEPARTMENTS_COLLECTION).findOne({ _id: result.insertedId });
        
        // Mapear _id a id para el frontend (si es necesario)
        if (newDepartment) {
            newDepartment.id = newDepartment._id.toString();
        }
        
        res.status(201).json(newDepartment);

    } catch (error) {
        console.error("Error al crear el departamento:", error);
        res.status(500).json({ message: "Error al crear el departamento", error: error.message });
    }
});


// --- 2. PUT: Actualizar Departamento Existente ---
// URL: PUT /api/departments/:id
router.put('/:id', async (req, res) => {
    try {
        const deptId = req.params.id;
        const updates = req.body; 

        if (!ObjectId.isValid(deptId)) {
            return res.status(400).json({ error: "ID de departamento no válido." });
        }
        
        // Limpiamos los IDs del cuerpo antes de $set
        delete updates.id; 

        const result = await req.db.collection(DEPARTMENTS_COLLECTION).findOneAndUpdate(
            { _id: new ObjectId(deptId) },
            { $set: { 
                ...updates, 
                updatedAt: new Date()
            } },
            { returnDocument: "after" } 
        );
        
        if (!result) {
            return res.status(404).json({ message: "Departamento no encontrado para actualizar." });
        }
        
        // Mapear _id a id para el frontend
        result.value.id = result.value?._id?.toString() || deptId;

        res.status(200).json(result.value); 
    } catch (error) {
        console.error("Error al actualizar el departamento:", error);
        res.status(500).json({ message: "Error al actualizar el departamento", error: error.message });
    }
});


// --- 3. DELETE: Eliminar un Departamento ---
// URL: DELETE /api/departments/:id
router.delete('/:id', async (req, res) => {
    try {
        const deptId = req.params.id;
        
        if (!ObjectId.isValid(deptId)) {
            return res.status(400).json({ error: "ID de departamento no válido." });
        }
        
        // [PENDIENTE: Aquí se debe verificar si hay flujos activos o usuarios asociados]
        // Tu frontend ya hace una verificación preliminar (activeWorkflows > 0), pero es mejor hacerlo en el backend.

        const result = await req.db
            .collection(DEPARTMENTS_COLLECTION)
            .deleteOne({ _id: new ObjectId(deptId) });

        if (result.deletedCount === 0) {
             return res.status(404).json({ message: "Departamento no encontrado." });
        }

        res.status(200).json({ message: "Departamento eliminado exitosamente", id: deptId });
    } catch (error) {
        console.error("Error al eliminar el departamento:", error);
        res.status(500).json({ message: "Error al eliminar el departamento", error: error.message });
    }
});


// --- 4. GET: Obtener Lista de Departamentos (Incluye Mapeo) ---
// URL: GET /api/departments
router.get("/", async (req, res) => {
  try {
    const departments = await req.db.collection(DEPARTMENTS_COLLECTION).find().toArray();
    
    // Mapear _id a id para que coincida con el frontend
    const mappedDepartments = departments.map(dept => ({
        ...dept,
        id: dept._id.toString()
    }));
    
    res.json(mappedDepartments);
  } catch (err) {
    console.error("Error al obtener la lista de departamentos:", err);
    res.status(500).json({ error: "Error al obtener la lista de departamentos" });
  }
});

router.get("/mini", async (req, res) => {
  try {
    // Usamos 'projection' para pedir SOLO name y supervisorId (y _id que viene por defecto)
    const departments = await req.db.collection(DEPARTMENTS_COLLECTION)
      .find({}, { 
        projection: { 
          name: 1, 
          supervisorId: 1 
        } 
      })
      .toArray();
    
    // Mapeo limpio para el frontend
    const miniList = departments.map(dept => ({
        id: dept._id.toString(),
        name: dept.name,
        supervisorId: dept.supervisorId
    }));
    
    res.json(miniList);
  } catch (err) {
    console.error("Error al obtener la lista mini de departamentos:", err);
    res.status(500).json({ error: "Error al cargar departamentos simplificados" });
  }
});


module.exports = router;