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

    // El helper addNotification ya maneja internamente la conversión de filtro.mail a mail_index
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
    if (!req.db) return res.status(503).json({ error: 'Servicio no disponible' });
    const collection = req.db.collection('usuarios');

    let usuario = null;

    // 1) Búsqueda robusta adaptada a cifrado
    if (ObjectId.isValid(userId)) {
      usuario = await collection.findOne({ _id: new ObjectId(userId) });
    } else if (userId.includes('@')) {
      // Búsqueda por correo usando Blind Index
      usuario = await collection.findOne({ 
        mail_index: createBlindIndex(userId.toLowerCase().trim()) 
      });
    }

    if (!usuario) {
      // Intento final por ID secundario string
      usuario = await collection.findOne({ id: userId });
    }

    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    // --- PREPARACIÓN DE DATOS DESENCRIPTADOS PARA LÓGICA DINÁMICA ---
    const userEmailDesc = decrypt(usuario.mail);
    const userDeptName = usuario.departamento || usuario.empresa || null;
    const now = new Date();
    const upcomingDays = parseInt(req.query.upcomingDays || '3', 10);
    const upcomingLimit = new Date(now.getTime() + (upcomingDays * 24 * 60 * 60 * 1000));

    function parseDate(d) {
      if (!d) return null;
      const dt = new Date(d);
      return isNaN(dt.getTime()) ? null : dt;
    }

    // Resolver IDs de departamento para el match
    let deptMatchValues = [];
    if (userDeptName) {
      deptMatchValues.push(userDeptName);
      try {
        const deptDoc = await req.db.collection('departamentos').findOne(
          { name: { $regex: new RegExp(`^${userDeptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }
        );
        if (deptDoc) {
          deptMatchValues.push(deptDoc._id.toString());
          deptMatchValues.push(deptDoc._id);
        }
      } catch (e) {
        console.error('Error resolviendo departamento:', e.message);
      }
    }

    // --- CONSULTA DE WORKFLOWS ---
    const wfCol = req.db.collection('flujos');
    const matchConditions = [
      { 'nodes.owner': usuario._id },
      { 'nodes.assignedTo': usuario._id },
      { 'nodes.userId': usuario._id },
      { 'nodes.email': userEmailDesc }, // Match con email real (plano) en flujos
      { 'nodes.responsible': userEmailDesc }
    ];

    if (deptMatchValues.length > 0) {
      matchConditions.push(
        { 'nodes.department': { $in: deptMatchValues } },
        { 'nodes.dept': { $in: deptMatchValues } }
      );
    }

    let workflows = await wfCol.find({ $or: matchConditions }).limit(200).toArray();
    const dynamicNotis = [];
    const completedSet = ['done', 'completed', 'finalizado', 'completado', 'terminado'];
    
    let deptOverdueCount = 0;
    let deptUpcomingCount = 0;

    workflows.forEach(wf => {
      (wf.nodes || []).forEach(node => {
        if (!node) return;

        // ¿Es para el usuario? (Comparamos con ID o email plano)
        const isForUser = [node.owner, node.assignedTo, node.userId, node.responsible, node.email].some(o => 
          String(o) === String(usuario._id) || String(o) === userEmailDesc || (usuario.id && String(o) === String(usuario.id))
        );

        const due = parseDate(node.dueDate || node.due || node.deadline || node.fecha_limite);
        const status = (node.status || '').toString().toLowerCase();
        const isCompleted = completedSet.includes(status) || node.completedAt || node.done;

        // Conteos por departamento
        const nodeDept = node.department || node.dept;
        const isDeptTask = deptMatchValues.length > 0 && nodeDept != null && deptMatchValues.some(v => String(v) === String(nodeDept));
        
        if (isDeptTask && !isCompleted) {
          if (due && due < now) deptOverdueCount++;
          else if (due && due >= now && due <= upcomingLimit) deptUpcomingCount++;
        }

        if (!isForUser) return;

        // Notificación: Vencida
        if (due && due < now && !isCompleted) {
          dynamicNotis.push({
            id: `gen-overdue-${node.id || Math.random()}`,
            titulo: 'Tarea vencida',
            descripcion: `La tarea '${node.title || node.name}' del flujo '${wf.name}' está vencida.`,
            prioridad: 3,
            fecha_creacion: now,
            tipo: 'overdue',
            workflowId: wf._id,
            nodeId: node.id
          });
        }

        // Notificación: Próxima a vencer
        else if (due && due >= now && due <= upcomingLimit && !isCompleted) {
          dynamicNotis.push({
            id: `gen-upcoming-${node.id || Math.random()}`,
            titulo: 'Próxima fecha límite',
            descripcion: `La tarea '${node.title || node.name}' vence pronto (${due.toLocaleDateString()}).`,
            prioridad: 2,
            fecha_creacion: now,
            tipo: 'upcoming',
            workflowId: wf._id,
            nodeId: node.id
          });
        }

        // Notificación: Cuello de botella (Stuck)
        const createdAtNode = parseDate(node.createdAt || wf.createdAt);
        const stuckDays = parseInt(req.query.stuckDays || '3', 10);
        if (!isCompleted && createdAtNode) {
          const ageMs = now.getTime() - createdAtNode.getTime();
          if (ageMs > (stuckDays * 24 * 60 * 60 * 1000)) {
            dynamicNotis.push({
              id: `gen-stuck-${node.id || Math.random()}`,
              titulo: 'Tarea en espera prolongada',
              descripcion: `La tarea '${node.title || node.name}' lleva más de ${stuckDays} días sin movimiento.`,
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

    // --- NOTIFICACIONES AGREGADAS POR DEPARTAMENTO ---
    if (userDeptName) {
      if (deptOverdueCount > 0) {
        dynamicNotis.push({
          id: `gen-dept-overdue-${userDeptName}`,
          titulo: 'Tareas vencidas en departamento',
          descripcion: `${userDeptName} tiene ${deptOverdueCount} tareas vencidas.`,
          prioridad: 3,
          fecha_creacion: now,
          tipo: 'dept-overdue',
          departamento: userDeptName
        });
      }
      
      // Cálculo de Bottleneck por departamento (Pipeline Agregado)
      const deptPipeline = [
        { $project: { nodes: { $ifNull: ['$nodes', []] } } },
        { $unwind: '$nodes' },
        { $project: { 
            dept: { $ifNull: ['$nodes.department', '$nodes.dept'] }, 
            status: { $toLower: { $ifNull: ['$nodes.status', ''] } } 
        } },
        { $match: { dept: { $in: deptMatchValues } } },
        { $match: { status: { $nin: completedSet } } },
        { $group: { _id: null, count: { $sum: 1 } } }
      ];

      const deptRes = await wfCol.aggregate(deptPipeline).toArray();
      const pendingCount = deptRes[0] ? deptRes[0].count : 0;
      if (pendingCount >= (parseInt(req.query.deptThreshold || '8', 10))) {
        dynamicNotis.push({
          id: `gen-dept-bottleneck-${userDeptName}`,
          titulo: 'Alta carga en departamento',
          descripcion: `Hay ${pendingCount} tareas pendientes en ${userDeptName}.`,
          prioridad: 3,
          fecha_creacion: now,
          tipo: 'dept-bottleneck'
        });
      }
    }

    // --- MERGE FINAL ---
    const existing = usuario.notificaciones || [];
    const seen = new Set();
    const merged = [];
    
    existing.forEach(n => { 
      merged.push(n); 
      if (n.nodeId && n.tipo) seen.add(`${n.nodeId}|${n.tipo}`); 
    });
    
    dynamicNotis.forEach(n => { 
      if (!(n.nodeId && n.tipo && seen.has(`${n.nodeId}|${n.tipo}`))) {
        merged.push(n); 
      }
    });

    res.json(merged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al procesar notificaciones dinámicas' });
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
    let query = { _id: ObjectId.isValid(userId) ? new ObjectId(userId) : userId };

    const result = await req.db.collection('usuarios').updateOne(
      query,
      { $set: { 'notificaciones.$[].leido': true } }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({ message: 'Todas las notificaciones fueron marcadas como leídas' });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar' });
  }
});

// Contador de no leídas por userId
router.get('/:userId/unread-count', async (req, res) => {
  try {
    const { userId } = req.params;
    const collection = req.db.collection('usuarios');
    let usuario = null;

    if (ObjectId.isValid(userId)) {
      usuario = await collection.findOne({ _id: new ObjectId(userId) });
    } else if (userId.includes('@')) {
      usuario = await collection.findOne({ mail_index: createBlindIndex(userId.toLowerCase().trim()) });
    } else {
      usuario = await collection.findOne({ id: userId });
    }

    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    const unreadCount = (usuario.notificaciones || []).filter(n => !n.leido).length;
    res.json({ unreadCount });
  } catch (err) {
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Alias compatible hacia atrás: aceptar GET /api/noti/:userId/unread-count
// Permite pasar un email sin necesidad de que sea ObjectId.
router.get('/:userId/unread-count', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!req.db) return res.status(503).json({ error: 'Servicio no disponible: base de datos no conectada' });

    const users = req.db.collection('usuarios');
    let usuario = null;

    // Intentar por ObjectId primero (si aplica)
    if (ObjectId.isValid(userId)) {
      try {
        usuario = await users.findOne({ _id: new ObjectId(userId) }, { projection: { notificaciones: 1 } });
      } catch (e) {
        // ignore and try other lookups
        usuario = null;
      }
    }

    // Si no resultó, intentar por mail / id / nombre
    if (!usuario) {
      usuario = await users.findOne({ $or: [{ mail: userId }, { id: userId }, { nombre: userId }] }, { projection: { notificaciones: 1 } });
    }

    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    const unreadCount = (usuario.notificaciones || []).filter(n => n.leido === false).length;
    res.json({ unreadCount });
  } catch (err) {
    console.error('Error al obtener contador de no leídas (alias):', err);
    res.status(500).json({ error: 'Error al obtener contador de notificaciones no leídas', detalles: err.message });
  }
});

module.exports = router;
