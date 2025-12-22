const express = require('express');
const router = express.Router();

// Middleware: asegurar conexión DB
function requireDb(req, res, next) {
  if (!req.db) return res.status(503).json({ error: 'Servicio no disponible: no hay conexión a la base de datos.' });
  next();
}

// Middleware: validar access key por header/query/body
function requireAccessKey(req, res, next) {
  const provided = req.headers['x-access-key'] || req.query.accessKey || (req.body && req.body.accessKey);
  const expected = process.env.ACCESS_KEY || process.env.MAIL_KEY || process.env.MAIL_KEY_OLD || process.env.MAIL_KEY_DEFAULT || null;
  const allowNoKey = (String(process.env.ALLOW_ANALYTICS_NO_KEY || '').toLowerCase() === 'true') || (process.env.NODE_ENV && process.env.NODE_ENV !== 'production');

  // Si no hay clave esperada y no permitimos omitirla, bloquear.
  if (!expected && !allowNoKey) return res.status(403).json({ error: 'Access key no configurada en el servidor.' });

  // En entornos de desarrollo o si se habilita explícitamente, permitir acceso cuando no hay clave.
  if (!expected && allowNoKey) {
    console.warn('Warning: analytics access key no configurada — acceso permitido en modo dev/ALLOW_ANALYTICS_NO_KEY.');
    return next();
  }

  if (!provided || String(provided) !== String(expected)) return res.status(401).json({ error: 'Clave de acceso inválida.' });
  next();
}

router.use(requireDb);
router.use(requireAccessKey);

// Helper: safe collection count
async function countCollection(db, name) {
  try { return await db.collection(name).countDocuments(); } catch (e) { return 0; }
}

// GET /summary - conteos por colección clave
router.get('/summary', async (req, res) => {
  try {
    const db = req.db;
    const collections = ['usuarios', 'flujos', 'docxs', 'plantillas', 'departamentos', 'historial', 'tokens', 'empresas', 'forms'];
    const counts = {};
    await Promise.all(collections.map(async (c) => { counts[c] = await countCollection(db, c); }));
    return res.json({ ok: true, counts });
  } catch (err) {
    console.error('Analytics /summary error:', err);
    return res.status(500).json({ error: 'Error generando summary' });
  }
});

// GET /users/by-department
router.get('/users/by-department', async (req, res) => {
  try {
    const db = req.db;
    const agg = [
      { $match: { departamento: { $exists: true, $ne: null, $ne: '' } } },
      { $group: { _id: '$departamento', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ];
    const byDept = await db.collection('usuarios').aggregate(agg).toArray();
    return res.json({ ok: true, byDepartment: byDept });
  } catch (err) {
    console.error('Analytics /users/by-department error:', err);
    return res.status(500).json({ error: 'Error generando users by department' });
  }
});

// GET /workflows/stats
router.get('/workflows/stats', async (req, res) => {
  try {
    const db = req.db;
    const total = await db.collection('flujos').countDocuments();
    const published = await db.collection('flujos').countDocuments({ isPublished: true });
    const avgNodesRes = await db.collection('flujos').aggregate([
      { $project: { nodesCount: { $size: { $ifNull: ['$nodes', []] } } } },
      { $group: { _id: null, avgNodes: { $avg: '$nodesCount' }, maxNodes: { $max: '$nodesCount' }, minNodes: { $min: '$nodesCount' } } }
    ]).toArray();
    const avgNodesInfo = avgNodesRes[0] || { avgNodes: 0, maxNodes: 0, minNodes: 0 };
    return res.json({ ok: true, total, published, avgNodes: avgNodesInfo.avgNodes, maxNodes: avgNodesInfo.maxNodes, minNodes: avgNodesInfo.minNodes });
  } catch (err) {
    console.error('Analytics /workflows/stats error:', err);
    return res.status(500).json({ error: 'Error generando workflows stats' });
  }
});

// GET /documents/daily?days=30
router.get('/documents/daily', async (req, res) => {
  try {
    const db = req.db;
    const days = Math.max(1, Math.min(365, parseInt(req.query.days || '30', 10)));
    const since = new Date(); since.setDate(since.getDate() - (days - 1));

    // Attempt to support createdAt that may be string or Date
    const agg = [
      { $match: { createdAt: { $exists: true } } },
      { $addFields: { _createdAt: { $cond: [{ $isArray: ['$createdAt'] }, '$createdAt', '$createdAt'] } } },
      { $project: { createdAt: 1 } },
      { $addFields: { createdAtDate: { $cond: [{ $eq: [{ $type: '$createdAt' }, 'string'] }, { $dateFromString: { dateString: '$createdAt' } }, '$createdAt'] } } },
      { $match: { createdAtDate: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAtDate' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ];

    const daily = await db.collection('docxs').aggregate(agg).toArray();
    return res.json({ ok: true, daily });
  } catch (err) {
    console.error('Analytics /documents/daily error:', err);
    return res.status(500).json({ error: 'Error generando documentos diarios' });
  }
});

// GET /historial/top?limit=10
router.get('/historial/top', async (req, res) => {
  try {
    const db = req.db;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '10', 10)));
    const agg = [
      { $group: { _id: '$areaTrabajo', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit }
    ];
    const top = await db.collection('historial').aggregate(agg).toArray();
    return res.json({ ok: true, top });
  } catch (err) {
    console.error('Analytics /historial/top error:', err);
    return res.status(500).json({ error: 'Error generando historial top' });
  }
});

// TASKS: overview and breakdowns from 'flujos' nodes
// GET /tasks/overview
router.get('/tasks/overview', async (req, res) => {
  try {
    const db = req.db;
    // total nodes, pending, completed (by node.status)
    const agg = [
      { $project: { nodes: { $ifNull: ['$nodes', []] } } },
      { $unwind: { path: '$nodes', preserveNullAndEmptyArrays: false } },
      { $group: { _id: '$nodes.status', count: { $sum: 1 } } }
    ];
    const byStatus = await db.collection('flujos').aggregate(agg).toArray();
    const totalNodesRes = await db.collection('flujos').aggregate([{ $project: { nodesCount: { $size: { $ifNull: ['$nodes', []] } } } }, { $group: { _id: null, total: { $sum: '$nodesCount' }, avgNodesPerFlow: { $avg: '$nodesCount' } } }]).toArray();
    const totals = totalNodesRes[0] || { total: 0, avgNodesPerFlow: 0 };
    return res.json({ ok: true, totalTasks: totals.total, avgNodesPerFlow: totals.avgNodesPerFlow, byStatus });
  } catch (err) {
    console.error('Analytics /tasks/overview error:', err);
    return res.status(500).json({ error: 'Error generando tasks overview' });
  }
});

// GET /tasks/by-assignee
router.get('/tasks/by-assignee', async (req, res) => {
  try {
    const db = req.db;
    const agg = [
      { $project: { nodes: { $ifNull: ['$nodes', []] } } },
      { $unwind: { path: '$nodes', preserveNullAndEmptyArrays: false } },
      { $group: { _id: '$nodes.assignee', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ];
    const byAssignee = await db.collection('flujos').aggregate(agg).toArray();
    return res.json({ ok: true, byAssignee });
  } catch (err) {
    console.error('Analytics /tasks/by-assignee error:', err);
    return res.status(500).json({ error: 'Error generando tasks by assignee' });
  }
});

// GET /tasks/avg-completion - average completion time (hours) for nodes with createdAt/completedAt
router.get('/tasks/avg-completion', async (req, res) => {
  try {
    const db = req.db;
    // We expect nodes to have createdAt and completedAt (or finishedAt) fields; try several names
    const pipeline = [
      { $project: { nodes: { $ifNull: ['$nodes', []] } } },
      { $unwind: '$nodes' },
      { $project: { created: { $ifNull: ['$nodes.createdAt', '$nodes.created'] }, completed: { $ifNull: ['$nodes.completedAt', '$nodes.finishedAt'] } } },
      { $match: { created: { $exists: true, $ne: null }, completed: { $exists: true, $ne: null } } },
      { $addFields: { createdDate: { $cond: [{ $eq: [{ $type: '$created' }, 'string'] }, { $dateFromString: { dateString: '$created' } }, '$created'] }, completedDate: { $cond: [{ $eq: [{ $type: '$completed' }, 'string'] }, { $dateFromString: { dateString: '$completed' } }, '$completed'] } } },
      { $project: { diffHours: { $divide: [{ $subtract: ['$completedDate', '$createdDate'] }, 1000 * 60 * 60] } } },
      { $group: { _id: null, avgHours: { $avg: '$diffHours' }, maxHours: { $max: '$diffHours' }, minHours: { $min: '$diffHours' }, count: { $sum: 1 } } }
    ];
    const stats = await db.collection('flujos').aggregate(pipeline).toArray();
    const result = stats[0] || { avgHours: 0, maxHours: 0, minHours: 0, count: 0 };
    return res.json({ ok: true, avgHours: result.avgHours, maxHours: result.maxHours, minHours: result.minHours, sampleCount: result.count });
  } catch (err) {
    console.error('Analytics /tasks/avg-completion error:', err);
    return res.status(500).json({ error: 'Error generando avg completion' });
  }
});

// GET /monthly/trends?months=6 - trends for documents and workflows
router.get('/monthly/trends', async (req, res) => {
  try {
    const db = req.db;
    const months = Math.max(1, Math.min(36, parseInt(req.query.months || '6', 10)));
    const start = new Date(); start.setMonth(start.getMonth() - (months - 1)); start.setDate(1); start.setHours(0, 0, 0, 0);

    const docsAgg = [
      { $match: { createdAt: { $exists: true } } },
      { $addFields: { createdAtDate: { $cond: [{ $eq: [{ $type: '$createdAt' }, 'string'] }, { $dateFromString: { dateString: '$createdAt' } }, '$createdAt'] } } },
      { $match: { createdAtDate: { $gte: start } } },
      { $group: { _id: { year: { $year: '$createdAtDate' }, month: { $month: '$createdAtDate' } }, count: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ];
    const flowsAgg = [
      { $match: { createdAt: { $exists: true } } },
      { $addFields: { createdAtDate: { $cond: [{ $eq: [{ $type: '$createdAt' }, 'string'] }, { $dateFromString: { dateString: '$createdAt' } }, '$createdAt'] } } },
      { $match: { createdAtDate: { $gte: start } } },
      { $group: { _id: { year: { $year: '$createdAtDate' }, month: { $month: '$createdAtDate' } }, count: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ];

    const [docs, flows] = await Promise.all([req.db.collection('docxs').aggregate(docsAgg).toArray(), req.db.collection('flujos').aggregate(flowsAgg).toArray()]);
    return res.json({ ok: true, months, documents: docs, workflows: flows });
  } catch (err) {
    console.error('Analytics /monthly/trends error:', err);
    return res.status(500).json({ error: 'Error generando monthly trends' });
  }
});

// GET /templates/usage
router.get('/templates/usage', async (req, res) => {
  try {
    const db = req.db;
    // assume docxs may reference templateId or plantillas
    const agg = [
      { $match: { $or: [{ templateId: { $exists: true } }, { plantillaId: { $exists: true } }] } },
      { $project: { tpl: { $ifNull: ['$templateId', '$plantillaId'] } } },
      { $group: { _id: '$tpl', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ];
    const usage = await db.collection('docxs').aggregate(agg).toArray();
    return res.json({ ok: true, usage });
  } catch (err) {
    console.error('Analytics /templates/usage error:', err);
    return res.status(500).json({ error: 'Error generando templates usage' });
  }
});

// GET /tasks/status-summary - resumen de estados de FLUJOS (workflows)
router.get('/tasks/status-summary', async (req, res) => {
  try {
    const db = req.db;

    // Sets de palabras para detectar estados (lowercase)
    const completedSet = ['done', 'completed', 'finalizado', 'completado', 'terminado'];
    const inProgressSet = ['iniciado', 'tramitando', 'proceso firma', 'en proceso', 'in progress', 'processing'];
    const postponedSet = ['postponed', 'postergada', 'postergado', 'reprogramada', 'pospuesta', 'pospuesto'];
    const overdueSet = ['overdue', 'atrasado', 'vencido', 'vencida', 'delayed'];

    // Pipeline: contar flujos por su campo status directo
    const pipeline = [
      {
        $project: {
          status: { $toLower: { $ifNull: ['$status', ''] } }
        }
      },
      {
        $addFields: {
          isCompleted: { $cond: [{ $in: ['$status', completedSet] }, 1, 0] },
          isInProgress: { $cond: [{ $in: ['$status', inProgressSet] }, 1, 0] },
          isPostponed: { $cond: [{ $in: ['$status', postponedSet] }, 1, 0] },
          isOverdue: { $cond: [{ $in: ['$status', overdueSet] }, 1, 0] }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: '$isCompleted' },
          inProgress: { $sum: '$isInProgress' },
          postponed: { $sum: '$isPostponed' },
          overdue: { $sum: '$isOverdue' }
        }
      }
    ];

    const stats = await db.collection('flujos').aggregate(pipeline).toArray();
    const result = stats[0] || { total: 0, completed: 0, inProgress: 0, postponed: 0, overdue: 0 };

    // pending = flujos sin status o con status no reconocido
    const pending = Math.max(0, result.total - result.completed - result.inProgress - result.postponed - result.overdue);

    return res.json({
      ok: true,
      totalFlows: result.total,
      completed: result.completed,
      inProgress: result.inProgress,
      postponed: result.postponed,
      overdue: result.overdue,
      pending
    });
  } catch (err) {
    console.error('Analytics /tasks/status-summary error:', err);
    return res.status(500).json({ error: 'Error generando tasks status summary' });
  }
});

// GET /tasks/status-summary/by-department - breakdown por departamento
router.get('/tasks/status-summary/by-department', async (req, res) => {
  try {
    const db = req.db;
    const now = new Date();

    const completedSet = ['done', 'completed', 'finalizado', 'completado', 'terminado'];
    const postponedSet = ['postponed', 'postergada', 'postergado', 'reprogramada', 'pospuesta', 'pospuesto'];
    const overdueSet = ['overdue', 'atrasado', 'vencido', 'vencida'];

    const pipeline = [
      { $project: { nodes: { $ifNull: ['$nodes', []] } } },
      { $unwind: { path: '$nodes', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          status: { $toLower: { $ifNull: ['$nodes.status', ''] } },
          createdAt: { $ifNull: ['$nodes.createdAt', '$nodes.created'] },
          completedAt: { $ifNull: ['$nodes.completedAt', '$nodes.finishedAt'] },
          dueDateRaw: { $ifNull: ['$nodes.dueDate', { $ifNull: ['$nodes.due', null] }] },
          postponedFlag: { $ifNull: ['$nodes.postponed', false] },
          department: { $ifNull: ['$nodes.department', { $ifNull: ['$nodes.dept', null] }] }
        }
      },
      {
        $addFields: {
          dueDate: { $cond: [{ $and: [{ $ne: ['$dueDateRaw', null] }, { $ne: ['$dueDateRaw', ''] }] }, { $cond: [{ $eq: [{ $type: '$dueDateRaw' }, 'string'] }, { $dateFromString: { dateString: '$dueDateRaw' } }, '$dueDateRaw'] }, null] }
        }
      },
      {
        $addFields: {
          isCompleted: { $cond: [{ $or: [{ $in: ['$status', completedSet] }, { $and: [{ $ne: ['$completedAt', null] }, { $ne: ['$completedAt', ''] }, { $eq: [{ $type: '$completedAt' }, 'date'] }] }] }, 1, 0] },
          isPostponed: { $cond: [{ $or: [{ $in: ['$status', postponedSet] }, { $eq: ['$postponedFlag', true] }] }, 1, 0] },
          isOverdueByField: { $cond: [{ $and: [{ $ne: ['$dueDate', null] }, { $lt: ['$dueDate', now] }] }, 1, 0] },
          isOverdueByStatus: { $cond: [{ $in: ['$status', overdueSet] }, 1, 0] }
        }
      },
      {
        $addFields: {
          isOverdue: { $cond: [{ $and: [{ $or: ['$isOverdueByField', '$isOverdueByStatus'] }, { $eq: ['$isCompleted', 0] }, { $eq: ['$isPostponed', 0] }] }, 1, 0] },
          deptKey: { $cond: [{ $or: [{ $eq: ['$department', null] }, { $eq: ['$department', ''] }] }, 'unknown', '$department'] }
        }
      },
      { $group: { _id: '$deptKey', total: { $sum: 1 }, completed: { $sum: '$isCompleted' }, postponed: { $sum: '$isPostponed' }, overdue: { $sum: '$isOverdue' } } },
      { $project: { department: '$_id', total: 1, completed: 1, postponed: 1, overdue: 1, pending: { $subtract: ['$total', { $add: ['$completed', '$postponed'] }] } } },
      { $sort: { total: -1 } }
    ];

    const rows = await db.collection('flujos').aggregate(pipeline).toArray();
    return res.json({ ok: true, byDepartment: rows });
  } catch (err) {
    console.error('Analytics /tasks/status-summary/by-department error:', err);
    return res.status(500).json({ error: 'Error generando breakdown por departamento' });
  }
});

// GET /export/tasks/status-summary?format=csv - export CSV con resumen general y breakdown por departamento
router.get('/export/tasks/status-summary', async (req, res) => {
  try {
    const format = (req.query.format || 'csv').toLowerCase();

    // Run pipeline directly to get breakdown data
    const now = new Date();
    const completedSet = ['done', 'completed', 'finalizado', 'completado', 'terminado'];
    const postponedSet = ['postponed', 'postergada', 'postergado', 'reprogramada', 'pospuesta', 'pospuesto'];
    const overdueSet = ['overdue', 'atrasado', 'vencido', 'vencida'];

    const pipeline = [
      { $project: { nodes: { $ifNull: ['$nodes', []] } } },
      { $unwind: { path: '$nodes', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          status: { $toLower: { $ifNull: ['$nodes.status', ''] } },
          completedAt: { $ifNull: ['$nodes.completedAt', '$nodes.finishedAt'] },
          dueDateRaw: { $ifNull: ['$nodes.dueDate', { $ifNull: ['$nodes.due', null] }] },
          postponedFlag: { $ifNull: ['$nodes.postponed', false] },
          department: { $ifNull: ['$nodes.department', { $ifNull: ['$nodes.dept', null] }] }
        }
      },
      {
        $addFields: {
          dueDate: { $cond: [{ $and: [{ $ne: ['$dueDateRaw', null] }, { $ne: ['$dueDateRaw', ''] }] }, { $cond: [{ $eq: [{ $type: '$dueDateRaw' }, 'string'] }, { $dateFromString: { dateString: '$dueDateRaw' } }, '$dueDateRaw'] }, null] }
        }
      },
      {
        $addFields: {
          isCompleted: { $cond: [{ $or: [{ $in: ['$status', completedSet] }, { $and: [{ $ne: ['$completedAt', null] }, { $ne: ['$completedAt', ''] }, { $eq: [{ $type: '$completedAt' }, 'date'] }] }] }, 1, 0] },
          isPostponed: { $cond: [{ $or: [{ $in: ['$status', postponedSet] }, { $eq: ['$postponedFlag', true] }] }, 1, 0] },
          isOverdueByField: { $cond: [{ $and: [{ $ne: ['$dueDate', null] }, { $lt: ['$dueDate', now] }] }, 1, 0] },
          isOverdueByStatus: { $cond: [{ $in: ['$status', overdueSet] }, 1, 0] }
        }
      },
      {
        $addFields: {
          isOverdue: { $cond: [{ $and: [{ $or: ['$isOverdueByField', '$isOverdueByStatus'] }, { $eq: ['$isCompleted', 0] }, { $eq: ['$isPostponed', 0] }] }, 1, 0] },
          deptKey: { $cond: [{ $or: [{ $eq: ['$department', null] }, { $eq: ['$department', ''] }] }, 'unknown', '$department'] }
        }
      },
      { $group: { _id: '$deptKey', total: { $sum: 1 }, completed: { $sum: '$isCompleted' }, postponed: { $sum: '$isPostponed' }, overdue: { $sum: '$isOverdue' } } },
      { $project: { department: '$_id', total: 1, completed: 1, postponed: 1, overdue: 1, pending: { $subtract: ['$total', { $add: ['$completed', '$postponed'] }] } } },
      { $sort: { total: -1 } }
    ];

    const breakdown = await req.db.collection('flujos').aggregate(pipeline).toArray();

    // overall totals
    const overall = breakdown.reduce((acc, cur) => {
      acc.total += cur.total || 0;
      acc.completed += cur.completed || 0;
      acc.postponed += cur.postponed || 0;
      acc.overdue += cur.overdue || 0;
      acc.pending += cur.pending || 0;
      return acc;
    }, { total: 0, completed: 0, postponed: 0, overdue: 0, pending: 0 });

    if (format === 'csv') {
      const header = ['group', 'total', 'completed', 'postponed', 'overdue', 'pending'];
      const lines = [];
      lines.push(header.join(','));
      lines.push(['TOTAL', overall.total, overall.completed, overall.postponed, overall.overdue, overall.pending].join(','));
      breakdown.forEach(r => {
        lines.push([String(r.department).replace(/,/g, ' '), r.total, r.completed, r.postponed, r.overdue, r.pending].join(','));
      });
      const csv = lines.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="tasks_status_summary.csv"');
      return res.send(csv);
    }

    return res.json({ ok: true, overall, breakdown });
  } catch (err) {
    console.error('Analytics /export/tasks/status-summary error:', err);
    return res.status(500).json({ error: 'Error generando export CSV' });
  }
});

module.exports = router;