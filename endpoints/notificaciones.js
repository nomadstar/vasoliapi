// routes/notificaciones.js
const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { addNotification } = require("../utils/notificaciones.helper");

// Crear una notificación (para 1 usuario o filtro de usuarios)
// Body esperado: { userId?, filtro?, titulo, descripcion, prioridad, color, icono, actionUrl }
router.post("/", async (req, res) => {
  try {
    const data = req.body || {};
    const { userId, filtro, titulo, descripcion, prioridad, color, icono, actionUrl } = data;

    if (!titulo || !descripcion) {
      return res.status(400).json({ error: "Faltan campos requeridos: titulo y descripcion" });
    }

    const { notificacion, modifiedCount } = await addNotification(req.db, {
      userId,
      filtro,
      titulo,
      descripcion,
      prioridad,
      color,
      icono,
      actionUrl,
    });

    if (modifiedCount === 0) {
      return res.status(404).json({ error: "No se encontraron usuarios para la notificación" });
    }

    res.status(201).json({
      message: "Notificación creada exitosamente",
      notificacion,
      usuarios_afectados: modifiedCount,
    });
  } catch (err) {
    console.error("❌ Error al crear notificación:", err);
    res.status(500).json({ error: "Error al crear notificación", detalles: err.message });
  }
});

// Listar notificaciones de un usuario por userId
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    // Intentos de búsqueda flexibles: ObjectId, string _id, id, mail o nombre
    if (!req.db) return res.status(503).json({ error: 'Servicio no disponible: base de datos no conectada' });
    const collection = req.db.collection('usuarios');

    let usuario = null;

    // 1) Si parece ObjectId válido, prueba por _id
    if (ObjectId.isValid(userId)) {
      usuario = await collection.findOne({ _id: new ObjectId(userId) }, { projection: { notificaciones: 1 } });
    }

    // 2) Si no encontrado, intenta por _id como string (algunos registros tienen _id como string)
    if (!usuario) {
      usuario = await collection.findOne({ _id: userId }, { projection: { notificaciones: 1 } });
    }

    // 3) Si aún no encontrado, intenta por campo `id`
    if (!usuario) {
      usuario = await collection.findOne({ id: userId }, { projection: { notificaciones: 1 } });
    }

    // 4) Finalmente intenta buscar por mail o nombre
    if (!usuario) {
      usuario = await collection.findOne({ $or: [{ mail: userId }, { nombre: userId }] }, { projection: { notificaciones: 1 } });
    }

    if (!usuario) {
      console.warn('notificaciones: usuario no encontrado con userId=', userId);
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // --- Generar notificaciones dinámicas desde la DB ---
    const now = new Date();
    const upcomingDays = parseInt(req.query.upcomingDays || '3', 10); // ventana para próximas fechas límite
    const upcomingLimit = new Date(now.getTime() + (upcomingDays * 24 * 60 * 60 * 1000));

    // Helper: parsear posibles campos de fecha en nodos
    function parseDate(d) {
      if (!d) return null;
      if (d instanceof Date) return d;
      try {
        const dt = new Date(d);
        if (isNaN(dt.getTime())) return null;
        return dt;
      } catch (e) {
        return null;
      }
    }

    function escapeRegExp(str) {
      return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Resolver departamento (nombre y posible _id) para notificaciones por departamento
    const userDeptName = usuario.departamento || usuario.empresa || null;
    let deptMatchValues = [];
    if (userDeptName) {
      deptMatchValues.push(userDeptName);
      try {
        const deptDoc = await req.db.collection('departamentos').findOne(
          { name: { $regex: new RegExp(`^${escapeRegExp(userDeptName)}$`, 'i') } },
          { projection: { _id: 1, name: 1 } }
        );
        if (deptDoc && deptDoc._id) {
          deptMatchValues.push(deptDoc._id.toString());
          deptMatchValues.push(deptDoc._id);
        }
      } catch (e) {
        console.error('notificaciones: error resolviendo departamento:', e && e.message);
      }
    }

    // Obtener workflows que contengan tareas/nodos asignados al usuario
    const wfCol = req.db.collection('flujos');

    // Matchar por varios campos: owner, assignedTo, userId, responsible, email
    const matchConditions = [
      { 'nodes.owner': usuario._id },
      { 'nodes.assignedTo': usuario._id },
      { 'nodes.userId': usuario._id },
      { 'nodes.responsible': usuario._id },
      { 'nodes.email': usuario.mail },
      { 'nodes.owner': usuario.mail },
      { 'nodes.assignedTo': usuario.mail },
      { 'nodes.userId': usuario.mail }
    ];

    // Incluir nodos del departamento del usuario para notificaciones agregadas
    if (deptMatchValues.length > 0) {
      matchConditions.push(
        { 'nodes.department': { $in: deptMatchValues } },
        { 'nodes.dept': { $in: deptMatchValues } }
      );
    }

    // Además soportar string IDs
    if (usuario.id) {
      matchConditions.push({ 'nodes.owner': usuario.id }, { 'nodes.assignedTo': usuario.id }, { 'nodes.userId': usuario.id });
    }

    let workflows = [];
    try {
      // Limitar la búsqueda para evitar escaneos largos en producción
      workflows = await wfCol.find({ $or: matchConditions }).maxTimeMS(5000).limit(200).toArray();
    } catch (e) {
      console.error('notificaciones: error consultando workflows (se devolvieron 0):', e && e.message);
      workflows = [];
    }

    const dynamicNotis = [];

    const overdueSet = ['overdue', 'atrasado', 'vencido', 'vencida', 'delayed'];
    const completedSet = ['done', 'completed', 'finalizado', 'completado', 'terminado'];
    let deptOverdueCount = 0;
    let deptUpcomingCount = 0;

    workflows.forEach(wf => {
      (wf.nodes || []).forEach(node => {
        if (!node) return;

        // Determinar si el nodo pertenece al usuario
        const nodeOwners = [node.owner, node.assignedTo, node.userId, node.responsible, node.email, node.user, node.assign];
        const isForUser = nodeOwners.some(o => {
          if (!o) return false;
          if (typeof o === 'object' && o.toString) return o.toString() === usuario._id.toString();
          return String(o) === String(usuario._id) || String(o) === String(usuario.mail) || String(o) === String(usuario.id);
        });

        // Detectar due date
        const possibleDue = node.dueDate || node.due || node.deadline || node.due_at || node.fecha_limite || node.fechaVencimiento;
        const due = parseDate(possibleDue);

        // Detectar completed
        const status = (node.status || '').toString().toLowerCase();
        const isCompleted = completedSet.includes(status) || node.completedAt || node.finishedAt || node.done;

        // Detectar tareas de departamento para conteos agregados
        const nodeDept = node.department || node.dept;
        const isDeptTask = deptMatchValues.length > 0 && nodeDept != null && deptMatchValues.some(v => String(v) === String(nodeDept));
        if (isDeptTask && !isCompleted) {
          if (due && due < now) deptOverdueCount += 1;
          else if (due && due >= now && due <= upcomingLimit) deptUpcomingCount += 1;
        }

        if (!isForUser) return;

        // Overdue: due < now && not completed
        if (due && due < now && !isCompleted) {
          dynamicNotis.push({
            id: `gen-overdue-${node.id || (node._id || Math.random()).toString()}`,
            titulo: 'Tarea vencida',
            descripcion: `La tarea '${node.title || node.name || node.id}' del flujo '${wf.name || wf._id}' está vencida desde ${due.toISOString()}`,
            prioridad: 3,
            fecha_creacion: now,
            tipo: 'overdue',
            workflowId: wf._id,
            nodeId: node.id
          });
          return; // ya es overdue
        }

        // Upcoming deadline: due between now y upcomingLimit
        if (due && due >= now && due <= upcomingLimit && !isCompleted) {
          dynamicNotis.push({
            id: `gen-upcoming-${node.id || (node._id || Math.random()).toString()}`,
            titulo: 'Próxima fecha límite',
            descripcion: `La tarea '${node.title || node.name || node.id}' vence el ${due.toISOString()}`,
            prioridad: 2,
            fecha_creacion: now,
            tipo: 'upcoming',
            workflowId: wf._id,
            nodeId: node.id
          });
          return;
        }

        // Cuellos de botella: nodo pendiente (no completado) con antigüedad > N días
        const createdAtNode = parseDate(node.createdAt || node.created || wf.createdAt);
        const stuckDays = parseInt(req.query.stuckDays || '3', 10);
        if (!isCompleted && createdAtNode) {
          const ageMs = now.getTime() - createdAtNode.getTime();
          if (ageMs > (stuckDays * 24 * 60 * 60 * 1000)) {
            dynamicNotis.push({
              id: `gen-stuck-${node.id || (node._id || Math.random()).toString()}`,
              titulo: 'Tarea en espera prolongada',
              descripcion: `La tarea '${node.title || node.name || node.id}' lleva más de ${stuckDays} días sin movimiento.`,
              prioridad: 2,
              fecha_creacion: now,
              tipo: 'stuck',
              workflowId: wf._id,
              nodeId: node.id
            });
          }
        }
      });
    });

    // Notificaciones agregadas por departamento (overdue / upcoming)
    if (userDeptName && (deptOverdueCount > 0 || deptUpcomingCount > 0)) {
      if (deptOverdueCount > 0) {
        dynamicNotis.push({
          id: `gen-dept-overdue-${userDeptName}`,
          titulo: 'Tareas vencidas en tu departamento',
          descripcion: `Tu departamento ('${userDeptName}') tiene ${deptOverdueCount} tareas vencidas.`,
          prioridad: 3,
          fecha_creacion: now,
          tipo: 'dept-overdue',
          departamento: userDeptName,
          pendientes: deptOverdueCount
        });
      }
      if (deptUpcomingCount > 0) {
        dynamicNotis.push({
          id: `gen-dept-upcoming-${userDeptName}`,
          titulo: 'Próximas fechas límite en tu departamento',
          descripcion: `Tu departamento ('${userDeptName}') tiene ${deptUpcomingCount} tareas próximas a vencer.`,
          prioridad: 2,
          fecha_creacion: now,
          tipo: 'dept-upcoming',
          departamento: userDeptName,
          pendientes: deptUpcomingCount
        });
      }
    }

    // Detectar cuellos de botella por departamento: contar nodos pendientes en el departamento del usuario
    const userDept = userDeptName;
    if (userDept) {
      // pipeline similar al de analytics: contar nodos pendientes por department
      const deptPipeline = [
        { $project: { nodes: { $ifNull: ['$nodes', []] } } },
        { $unwind: { path: '$nodes', preserveNullAndEmptyArrays: false } },
        { $project: { department: { $ifNull: ['$nodes.department', '$nodes.dept'] }, status: { $toLower: { $ifNull: ['$nodes.status', ''] } }, createdAt: { $ifNull: ['$nodes.createdAt', '$nodes.created'] } } },
        { $match: { department: userDept } },
        { $addFields: { isCompleted: { $cond: [{ $in: ['$status', ['done','completed','finalizado','completado','terminado']] }, 1, 0] } } },
        { $match: { isCompleted: 0 } },
        { $group: { _id: '$department', count: { $sum: 1 } } }
      ];

      try {
        const deptRes = await wfCol.aggregate(deptPipeline).toArray();
        const pendingCount = deptRes[0] ? deptRes[0].count : 0;
        const deptThreshold = parseInt(req.query.deptThreshold || '8', 10);
        if (pendingCount >= deptThreshold) {
          dynamicNotis.push({
            id: `gen-dept-bottleneck-${userDept}`,
            titulo: 'Cuello de botella en el departamento',
            descripcion: `Tu departamento ('${userDept}') tiene ${pendingCount} tareas pendientes.`,
            prioridad: 3,
            fecha_creacion: now,
            tipo: 'dept-bottleneck',
            departamento: userDept,
            pendientes: pendingCount
          });
        }
      } catch (e) {
        console.error('Error calculando bottleneck por departamento:', e);
      }
    }

    // Combinar notificaciones guardadas + dinámicas (evitar duplicados por nodeId+tipo)
    const existing = usuario.notificaciones || [];
    const seen = new Set();
    const merged = [];
    existing.forEach(n => { merged.push(n); if (n.nodeId && n.tipo) seen.add(`${n.nodeId}|${n.tipo}`); });
    dynamicNotis.forEach(n => { if (!(n.nodeId && n.tipo && seen.has(`${n.nodeId}|${n.tipo}`))) merged.push(n); });

    res.json(merged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener notificaciones' });
  }
});

// Endpoint rápido y seguro para debug: intenta devolver notificaciones con consultas acotadas
router.get('/quick/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!req.db) return res.status(503).json({ error: 'Servicio no disponible: base de datos no conectada' });

    const users = req.db.collection('usuarios');
    const wfCol = req.db.collection('flujos');

    // 1) Intento rápido por _id ObjectId
    let usuario = null;
    if (ObjectId.isValid(userId)) {
      const rows = await users.find({ _id: new ObjectId(userId) }).project({ notificaciones: 1, mail: 1, id: 1, departamento: 1 }).maxTimeMS(2000).limit(1).toArray();
      usuario = rows && rows[0];
    }

    // 2) Intento por mail o id corto
    if (!usuario) {
      const rows = await users.find({ $or: [{ mail: userId }, { id: userId }, { nombre: userId }] }).project({ notificaciones: 1, mail: 1, id: 1, departamento: 1 }).maxTimeMS(2000).limit(1).toArray();
      usuario = rows && rows[0];
    }

    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado (quick)' });

    function parseDate(d) {
      if (!d) return null;
      if (d instanceof Date) return d;
      try {
        const dt = new Date(d);
        if (isNaN(dt.getTime())) return null;
        return dt;
      } catch (e) {
        return null;
      }
    }

    function escapeRegExp(str) {
      return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    const now = new Date();
    const upcomingDays = parseInt(req.query.upcomingDays || '3', 10);
    const upcomingLimit = new Date(now.getTime() + (upcomingDays * 24 * 60 * 60 * 1000));

    // Devolver notificaciones guardadas + agregados rápidos por departamento
    const existing = usuario.notificaciones || [];
    const dynamic = [];

    const userDeptName = usuario.departamento || usuario.empresa || null;
    let deptMatchValues = [];
    if (userDeptName) {
      deptMatchValues.push(userDeptName);
      try {
        const deptDoc = await req.db.collection('departamentos').findOne(
          { name: { $regex: new RegExp(`^${escapeRegExp(userDeptName)}$`, 'i') } },
          { projection: { _id: 1 } }
        );
        if (deptDoc && deptDoc._id) {
          deptMatchValues.push(deptDoc._id.toString());
          deptMatchValues.push(deptDoc._id);
        }
      } catch (e) {
        console.error('notificaciones.quick: error resolviendo departamento:', e && e.message);
      }
    }

    if (deptMatchValues.length > 0) {
      let deptOverdueCount = 0;
      let deptUpcomingCount = 0;
      try {
        const workflows = await wfCol.find({
          $or: [
            { 'nodes.department': { $in: deptMatchValues } },
            { 'nodes.dept': { $in: deptMatchValues } }
          ]
        })
          .project({ nodes: 1 })
          .maxTimeMS(2000)
          .limit(100)
          .toArray();

        const completedSet = ['done', 'completed', 'finalizado', 'completado', 'terminado'];

        workflows.forEach(wf => {
          (wf.nodes || []).forEach(node => {
            if (!node) return;
            const nodeDept = node.department || node.dept;
            if (!deptMatchValues.some(v => String(v) === String(nodeDept))) return;
            const status = (node.status || '').toString().toLowerCase();
            const isCompleted = completedSet.includes(status) || node.completedAt || node.finishedAt || node.done;
            if (isCompleted) return;
            const due = parseDate(node.dueDate || node.due || node.deadline || node.due_at || node.fecha_limite || node.fechaVencimiento);
            if (!due) return;
            if (due < now) deptOverdueCount += 1;
            else if (due >= now && due <= upcomingLimit) deptUpcomingCount += 1;
          });
        });
      } catch (e) {
        console.error('notificaciones.quick: error consultando workflows:', e && e.message);
      }

      if (deptOverdueCount > 0) {
        dynamic.push({
          id: `gen-dept-overdue-${userDeptName}`,
          titulo: 'Tareas vencidas en tu departamento',
          descripcion: `Tu departamento ('${userDeptName}') tiene ${deptOverdueCount} tareas vencidas.`,
          prioridad: 3,
          fecha_creacion: now,
          tipo: 'dept-overdue',
          departamento: userDeptName,
          pendientes: deptOverdueCount
        });
      }
      if (deptUpcomingCount > 0) {
        dynamic.push({
          id: `gen-dept-upcoming-${userDeptName}`,
          titulo: 'Próximas fechas límite en tu departamento',
          descripcion: `Tu departamento ('${userDeptName}') tiene ${deptUpcomingCount} tareas próximas a vencer.`,
          prioridad: 2,
          fecha_creacion: now,
          tipo: 'dept-upcoming',
          departamento: userDeptName,
          pendientes: deptUpcomingCount
        });
      }
    }

    const merged = [...existing, ...dynamic];
    return res.json({ quick: true, count: merged.length, notificaciones: merged });
  } catch (err) {
    console.error('notificaciones.quick error:', err && err.message);
    return res.status(500).json({ error: 'Error en quick lookup', detalles: err && err.message });
  }
});

// Marcar una notificación como leída
router.put("/:userId/:notiId/leido", async (req, res) => {
  try {
    const result = await req.db.collection("usuarios").findOneAndUpdate(
      { _id: new ObjectId(req.params.userId), "notificaciones.id": req.params.notiId },
      { $set: { "notificaciones.$.leido": true } },
      { returnDocument: "after" }
    );

    if (!result.value)
      return res.status(404).json({ error: "Usuario o notificación no encontrada" });

    res.json({ message: "Notificación marcada como leída", usuario: result.value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al marcar notificación como leída" });
  }
});

// Eliminar una notificación por userId y notiId
router.delete('/user/:userId/noti/:notiId', async (req, res) => {
  try {
    const { userId, notiId } = req.params;
    if (!ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId inválido' });

    const result = await req.db.collection('usuarios').findOneAndUpdate(
      { _id: new ObjectId(userId) },
      { $pull: { notificaciones: { id: notiId } } },
      { returnDocument: 'after' }
    );

    if (!result.value) return res.status(404).json({ error: 'Usuario o notificación no encontrada' });

    res.json({ message: 'Notificación eliminada', usuario: result.value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar notificación' });
  }
});

// Eliminar todas las notificaciones de un usuario por userId
router.delete('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId inválido' });

    const result = await req.db.collection('usuarios').findOneAndUpdate(
      { _id: new ObjectId(userId) },
      { $set: { notificaciones: [] } },
      { returnDocument: 'after' }
    );

    if (!result.value) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({ message: 'Todas las notificaciones fueron eliminadas correctamente.', usuario: result.value });
  } catch (err) {
    console.error('Error al eliminar todas las notificaciones:', err);
    res.status(500).json({ error: 'Error al eliminar notificaciones' });
  }
});

// Marcar todas como leídas por userId
router.put('/user/:userId/read-all', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId inválido' });

    const result = await req.db.collection('usuarios').updateOne(
      { _id: new ObjectId(userId) },
      { $set: { 'notificaciones.$[].leido': true } }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({ message: 'Todas las notificaciones fueron marcadas como leídas', modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error('Error al marcar todas como leídas:', err);
    res.status(500).json({ error: 'Error al marcar todas las notificaciones como leídas' });
  }
});

// Contador de no leídas por userId
router.get('/user/:userId/unread-count', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!ObjectId.isValid(userId)) return res.status(400).json({ error: 'userId inválido' });

    const usuario = await req.db.collection('usuarios').findOne({ _id: new ObjectId(userId) }, { projection: { notificaciones: 1 } });
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    const unreadCount = (usuario.notificaciones || []).filter(n => n.leido === false).length;
    res.json({ unreadCount });
  } catch (err) {
    console.error('Error al obtener contador de no leídas:', err);
    res.status(500).json({ error: 'Error al obtener contador de notificaciones no leídas', detalles: err.message });
  }
});

module.exports = router;
