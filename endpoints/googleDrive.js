const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const Stream = require('stream');
const XLSX = require('xlsx');
const multer = require('multer');

const router = express.Router();

const TOKEN_PATH = path.join(__dirname, '..', 'data', 'google_tokens.json');

// Scopes usados para el consentimiento de Google (subir/gestionar archivos)
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive'
];

function ensureDataDir() {
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

function loadSavedTokens() {
  // Primero intenta cargar desde variables de entorno (para producción)
  if (process.env.GOOGLE_ACCESS_TOKEN) {
    return {
      access_token: process.env.GOOGLE_ACCESS_TOKEN,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      scope: process.env.GOOGLE_TOKEN_SCOPE,
      token_type: process.env.GOOGLE_TOKEN_TYPE || 'Bearer',
      refresh_token_expires_in: parseInt(process.env.GOOGLE_REFRESH_TOKEN_EXPIRES_IN) || 604799,
      expiry_date: parseInt(process.env.GOOGLE_EXPIRY_DATE)
    };
  }

  // Fallback: cargar desde archivo (para desarrollo local)
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const raw = fs.readFileSync(TOKEN_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // support two shapes: either the tokens object is saved directly
      // or a wrapper was saved like { ok: true, message: '', tokens: { ... } }
      if (parsed && parsed.tokens) return parsed.tokens;
      return parsed;
    }
  } catch (e) {
    console.error('Error leyendo tokens:', e.message || e);
  }
  return null;
}

function saveTokens(tokens) {
  // En producción (Vercel), no podemos escribir archivos, 
  // así que solo guardamos localmente en desarrollo
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    console.log('Tokens no se pueden guardar en archivo en producción. Usa variables de entorno.');
    return;
  }

  try {
    ensureDataDir();
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
    console.log('Tokens guardados localmente en:', TOKEN_PATH);
  } catch (e) {
    console.error('Error guardando tokens:', e.message || e);
  }
}

function getOAuth2Client(redirectUri) {
  const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = process.env;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Faltan variables de entorno CLIENT_ID y/o CLIENT_SECRET para Google Drive');
  }
  const uri = redirectUri || REDIRECT_URI;
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, uri);
}

function resolveRedirectUri(req) {
  const localUri = 'http://localhost:3000/api/drive/oauth2callback';
  const prodUri = 'https://vasoliltdaapi.vercel.app/api/drive/oauth2callback';
  const host = req.headers?.host || '';
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https');

  const isLocal = host.includes('localhost') || host.startsWith('127.0.0.1');
  if (isLocal) return localUri;

  // Usa env si está configurado; si apunta a localhost en prod, deriva del host
  if (process.env.REDIRECT_URI && !process.env.REDIRECT_URI.includes('localhost')) {
    return process.env.REDIRECT_URI;
  }
  return `${proto}://${host}/api/drive/oauth2callback`; // fallback (prod)
}

function makeReauthUrl() {
  try {
    const oauth2Client = getOAuth2Client();
    return oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  } catch (e) {
    return null;
  }
}

function isInsufficientPermissionError(err) {
  try {
    if (!err) return false;
    const msg = (err.message || (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || '').toString().toLowerCase();
    if (msg.includes('insufficient permission') || msg.includes('insufficient permissions')) return true;
    if (err && err.errors && Array.isArray(err.errors) && err.errors.some(e => e.reason && e.reason.toLowerCase().includes('insufficient'))) return true;
    if (err && (err.code === 403 || err.statusCode === 403)) return true;
  } catch (e) {
    // ignore
  }
  return false;
}

// Step 1: iniciar autorización (redirige al consentimiento de Google)
router.get('/auth', (req, res) => {
  try {
    const oauth2Client = getOAuth2Client(resolveRedirectUri(req));
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Step 2: callback donde Google redirige con el código
router.get('/oauth2callback', async (req, res) => {
  try {
    const oauth2Client = getOAuth2Client(resolveRedirectUri(req));
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);
    console.log('Tokens guardados en:', TOKEN_PATH);
    res.json({ ok: true, message: 'Tokens guardados', tokens });
  } catch (err) {
    console.error('OAuth callback error:', err.message || err);
    res.status(500).json({ ok: false, message: 'OAuth callback error', error: err.message || String(err) });
  }
});

async function ensureAuthClient() {
  const oauth2Client = getOAuth2Client();
  const saved = loadSavedTokens();
  if (!saved) throw new Error('No hay tokens guardados. Visita /api/drive/auth para autorizar.');
  oauth2Client.setCredentials(saved);
  // refresh token if needed
  return oauth2Client;
}

function extractFolderId(folderUrl) {
  try {
    if (!folderUrl) return null;
    const m = folderUrl.match(/[-\w]{25,}/);
    return m ? m[0] : null;
  } catch (e) {
    return null;
  }
}

// Listar archivos (si DRIVE_FOLDER_URL en env, lista ese folder)
router.get('/list', async (req, res) => {
  try {
    const auth = await ensureAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    const folderEnv = process.env.DRIVE_FOLDER_URL;
    const folderId = extractFolderId(folderEnv);

    const q = folderId ? `'${folderId}' in parents and trashed=false` : 'trashed=false';

    const response = await drive.files.list({
      q,
      pageSize: 100,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)'
    });

    res.json({ ok: true, files: response.data.files || [] });
  } catch (err) {
    console.error('Drive list error:', err.message || err);
    
    // Error de configuración
    if (err.message && err.message.includes('Faltan variables de entorno')) {
      return res.status(500).json({ 
        ok: false, 
        error: 'Google Drive no configurado correctamente. Faltan CLIENT_ID y/o CLIENT_SECRET en variables de entorno.' 
      });
    }
    
    // Error de autorización
    if (err.message && err.message.includes('No hay tokens guardados')) {
      return res.status(401).json({ 
        ok: false, 
        error: 'Google Drive no autorizado. Visita /api/drive/auth para autorizar.',
        auth_url: '/api/drive/auth'
      });
    }
    
    // Error de permisos
    if (isInsufficientPermissionError(err)) {
      const reauth = makeReauthUrl();
      return res.status(403).json({ 
        ok: false, 
        error: 'Insufficient Permission. Reauthorize the app.', 
        reauth_url: reauth 
      });
    }
    
    // Error genérico
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Descargar archivo por id
router.get('/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const auth = await ensureAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    const meta = await drive.files.get({ fileId, fields: 'id, name, mimeType, size' });

    const streamRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

    res.setHeader('Content-Type', meta.data.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${meta.data.name || fileId}"`);

    streamRes.data.pipe(res);
  } catch (err) {
    console.error('Drive download error:', err.message || err);
    if (isInsufficientPermissionError(err)) {
      const reauth = makeReauthUrl();
      return res.status(403).json({ ok: false, error: 'Insufficient Permission. Reauthorize the app.', reauth_url: reauth });
    }
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Helper: make headers unique by appending suffix if duplicated
function makeUniqueHeaders(headers) {
  const seen = {};
  return headers.map(h => {
    const key = (h || '').toString();
    if (!seen[key]) {
      seen[key] = 1;
      return key;
    }
    seen[key] += 1;
    return `${key} ${seen[key]}`;
  });
}

function mapRowToHeaders(headers, row) {
  const unique = makeUniqueHeaders(headers);
  const obj = {};
  for (let i = 0; i < unique.length; i++) {
    obj[unique[i]] = row[i] !== undefined ? row[i] : null;
  }
  return obj;
}

// Generic sheet parser used by named endpoints
async function parseSheetWithOptions({ fileId, sheetName, startRow = 2, endCol = 'L', headers }) {
  const auth = await ensureAuthClient();
  const drive = google.drive({ version: 'v3', auth });
  const meta = await drive.files.get({ fileId, fields: 'id, name, mimeType' });
  const streamRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(streamRes.data);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  if (!workbook.SheetNames.includes(sheetName)) {
    const err = new Error(`Sheet '${sheetName}' not found`);
    err.code = 'NO_SHEET';
    err.availableSheets = workbook.SheetNames;
    throw err;
  }
  const sheet = workbook.Sheets[sheetName];
  const endColIndex = XLSX.utils.decode_col(endCol);
  const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  const rows = allRows.slice(startRow - 1).map(r => {
    const out = [];
    for (let i = 0; i <= endColIndex; i++) out.push(r && r[i] !== undefined ? r[i] : null);
    return out;
  });
  const data = rows.map(r => mapRowToHeaders(headers, r));
  return { file: meta.data.name, sheet: sheetName, rows: data };
}

// Parse sheet into raw arrays (no headers mapping)
async function parseSheetRaw({ fileId, sheetName, startRow = 2, endCol = 'L' }) {
  const auth = await ensureAuthClient();
  const drive = google.drive({ version: 'v3', auth });
  const meta = await drive.files.get({ fileId, fields: 'id, name, mimeType' });
  const streamRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(streamRes.data);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  if (!workbook.SheetNames.includes(sheetName)) {
    const err = new Error(`Sheet '${sheetName}' not found`);
    err.code = 'NO_SHEET';
    err.availableSheets = workbook.SheetNames;
    throw err;
  }
  const sheet = workbook.Sheets[sheetName];
  const endColIndex = XLSX.utils.decode_col(endCol);
  const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  const rows = allRows.slice(startRow - 1).map(r => {
    const out = [];
    for (let i = 0; i <= endColIndex; i++) out.push(r && r[i] !== undefined ? r[i] : null);
    return out;
  });
  return { file: meta.data.name, sheet: sheetName, rows };
}

function parseFiltersFromQuery(q) {
  // accepts filter=Field:Value repeated or as a single string
  const raw = q.filter;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(s => {
    const parts = (s || '').split(':');
    return { field: parts[0] ? parts[0].trim() : '', value: parts.slice(1).join(':').trim() };
  }).filter(f => f.field && f.value);
}

function applyFilters(rows, filters) {
  if (!filters || filters.length === 0) return rows;
  return rows.filter(row => {
    return filters.every(f => {
      const val = row[f.field] !== undefined && row[f.field] !== null ? String(row[f.field]).trim().toLowerCase() : '';
      return val.includes(String(f.value).trim().toLowerCase());
    });
  });
}

function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const r of rows) {
    const vals = headers.map(h => {
      const v = r[h] === null || r[h] === undefined ? '' : String(r[h]).replace(/"/g, '""');
      return `"${v}"`;
    });
    lines.push(vals.join(','));
  }
  return lines.join('\n');
}

// Generic parse endpoint with params: sheet, startRow, endCol, range, headers (comma-separated), format=json|csv, filter=Field:Value
router.get('/parse/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const sheetName = req.query.sheet || req.query.sheetName || 'Sitios Nuevos';
    let startRow = req.query.startRow ? parseInt(req.query.startRow, 10) : null;
    let endCol = req.query.endCol ? String(req.query.endCol).toUpperCase() : null;
    const range = req.query.range; // e.g., A2:L100
    if (range) {
      try {
        const rng = XLSX.utils.decode_range(range);
        startRow = rng.s.r + 1; // zero-based to 1-based
        endCol = XLSX.utils.encode_col(rng.e.c);
      } catch (e) {
        // ignore
      }
    }
    if (!startRow) startRow = 2;
    if (!endCol) endCol = 'L';

    const headersParam = req.query.headers; // comma-separated
    let result;
    if (headersParam) {
      const headers = headersParam.split(',').map(h => h.trim());
      result = await parseSheetWithOptions({ fileId, sheetName, startRow, endCol, headers });
    } else {
      result = await parseSheetRaw({ fileId, sheetName, startRow, endCol });
      // rows are arrays; convert to objects with numeric keys
      const rowsObjs = result.rows.map(r => {
        const obj = {};
        for (let i = 0; i < r.length; i++) obj[`col${i+1}`] = r[i];
        return obj;
      });
      result.rows = rowsObjs;
    }

    // filters
    const filters = parseFiltersFromQuery(req.query);
    if (filters.length) result.rows = applyFilters(result.rows, filters);

    const format = (req.query.format || 'json').toLowerCase();
    if (format === 'csv') {
      const csv = toCsv(result.rows);
      res.setHeader('Content-Type', 'text/csv');
      return res.send(csv);
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Generic parse error:', err.message || err);
    if (isInsufficientPermissionError(err)) {
      const reauth = makeReauthUrl();
      return res.status(403).json({ ok: false, error: 'Insufficient Permission. Reauthorize the app.', reauth_url: reauth });
    }
    if (err.code === 'NO_SHEET') return res.status(404).json({ ok: false, error: err.message, availableSheets: err.availableSheets });
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Named endpoints for each sheet
router.get('/parse-sheet/nuevos-sitios/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const result = await parseSheetWithOptions({
      fileId,
      sheetName: 'Sitios Nuevos',
      startRow: 2,
      endCol: 'L',
      headers: [
        'Nro. Orden', 'Nro. Orden', 'Orden de Compra', 'ID', 'Nombre sitio',
        'Fecha Asignación', 'Estado', 'Responsable', 'Observaciones', 'Gestores', 'Coordenadas', 'Coordenadas'
      ]
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Nuevos Sitios parse error:', err.message || err);
    if (isInsufficientPermissionError(err)) {
      const reauth = makeReauthUrl();
      return res.status(403).json({ ok: false, error: 'Insufficient Permission. Reauthorize the app.', reauth_url: reauth });
    }
    if (err.code === 'NO_SHEET') return res.status(404).json({ ok: false, error: err.message, availableSheets: err.availableSheets });
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

router.get('/parse-sheet/renegociacion/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const result = await parseSheetWithOptions({
      fileId,
      sheetName: 'Renegociación',
      startRow: 3,
      endCol: 'M',
      headers: [
        'filtro','Nro. Orden','Orden de Compra','ID','Nombre sitio','Fecha Asignación','Estado','Responsable','Observaciones','Gestor / Abogado','OBS','OBS','Gestor'
      ]
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Renegociación parse error:', err.message || err);
    if (isInsufficientPermissionError(err)) {
      const reauth = makeReauthUrl();
      return res.status(403).json({ ok: false, error: 'Insufficient Permission. Reauthorize the app.', reauth_url: reauth });
    }
    if (err.code === 'NO_SHEET') return res.status(404).json({ ok: false, error: err.message, availableSheets: err.availableSheets });
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

router.get('/parse-sheet/c_13/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const result = await parseSheetWithOptions({
      fileId,
      sheetName: 'C_13',
      startRow: 3,
      endCol: 'K',
      headers: [
        'Nro. Orden','Orden de Compra','ID','Nombre sitio','Fecha Asignación','Estado','Responsable','Observaciones','Gestores','Obs','Gestor'
      ]
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('C_13 parse error:', err.message || err);
    if (isInsufficientPermissionError(err)) {
      const reauth = makeReauthUrl();
      return res.status(403).json({ ok: false, error: 'Insufficient Permission. Reauthorize the app.', reauth_url: reauth });
    }
    if (err.code === 'NO_SHEET') return res.status(404).json({ ok: false, error: err.message, availableSheets: err.availableSheets });
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

router.get('/parse-sheet/bbnns/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const result = await parseSheetWithOptions({
      fileId,
      sheetName: 'BBNNs',
      startRow: 4,
      endCol: 'O',
      headers: [
        'Nº','Orden de Compra','ID','Nombre Sitio','Fecha Asignación','Región','Estado','Observaciones','Estatus','Proyecto ATP','Expediente Antiguo','Exp. 2023','Fecha ingreso','Contacto','Planos'
      ]
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('BBNNs parse error:', err.message || err);
    if (isInsufficientPermissionError(err)) {
      const reauth = makeReauthUrl();
      return res.status(403).json({ ok: false, error: 'Insufficient Permission. Reauthorize the app.', reauth_url: reauth });
    }
    if (err.code === 'NO_SHEET') return res.status(404).json({ ok: false, error: err.message, availableSheets: err.availableSheets });
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Crear un archivo de texto en la carpeta configurada (o en la raíz si no hay carpeta)
// POST /api/drive/create-text
// Body JSON: { name: 'archivo.txt', content: 'texto...' }
// Actualmente no aplica porque el scope actual no lo permite.
router.post('/create-text', async (req, res) => {
  try {
    const { name, content } = req.body || {};
    const auth = await ensureAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    const folderEnv = process.env.DRIVE_FOLDER_URL;
    const folderId = extractFolderId(folderEnv);

    const fileMetadata = { name: name || `archivo-${Date.now()}.txt`, mimeType: 'text/plain' };
    if (folderId) fileMetadata.parents = [folderId];

    const bufferStream = new Stream.PassThrough();
    bufferStream.end(Buffer.from(content || '', 'utf8'));

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: 'text/plain',
        body: bufferStream,
      },
      fields: 'id, name, mimeType, parents'
    });

    res.json({ ok: true, file: response.data });
  } catch (err) {
    console.error('Drive create-text error:', err.message || err);
    if (isInsufficientPermissionError(err)) {
      const reauth = makeReauthUrl();
      return res.status(403).json({ ok: false, error: 'Insufficient Permission. Reauthorize the app.', reauth_url: reauth });
    }
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20 MB

// Subir un archivo a Drive (usa multipart/form-data, campo "file")
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo (campo file)' });

    const auth = await ensureAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    // Prioridad de carpeta: folderId param -> folderUrl param -> env DRIVE_FOLDER_URL -> raíz
    const folderIdFromUrl = extractFolderId(req.body.folderUrl || req.query.folderUrl);
    const folderId = req.body.folderId || req.query.folderId || folderIdFromUrl || extractFolderId(process.env.DRIVE_FOLDER_URL);
    const fileMetadata = {
      name: req.file.originalname,
      parents: folderId ? [folderId] : undefined,
    };

    const bufferStream = new Stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: req.file.mimetype || 'application/octet-stream',
        body: bufferStream,
      },
      fields: 'id, name, mimeType, size, parents, webViewLink, webContentLink',
    });

    res.json({ ok: true, file: response.data });
  } catch (err) {
    console.error('Drive upload error:', err.message || err);
    if (isInsufficientPermissionError(err)) {
      return res.status(403).json({
        ok: false,
        error: 'Permisos insuficientes. Reautoriza en /api/drive/auth',
        reauthUrl: makeReauthUrl(),
      });
    }
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Borrar un archivo por id
router.delete('/delete/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const auth = await ensureAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    await drive.files.delete({ fileId });
    res.json({ ok: true, deleted: fileId });
  } catch (err) {
    console.error('Drive delete error:', err.message || err);
    if (isInsufficientPermissionError(err)) {
      return res.status(403).json({
        ok: false,
        error: 'Permisos insuficientes. Reautoriza en /api/drive/auth',
        reauthUrl: makeReauthUrl(),
      });
    }
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Crear carpeta en Drive
router.post('/create-folder', async (req, res) => {
  try {
    const name = req.body?.name;
    if (!name) return res.status(400).json({ ok: false, error: 'Falta name' });

    const parentFromUrl = extractFolderId(req.body?.parentUrl || req.query?.parentUrl);
    const parentId =
      req.body?.parentId ||
      req.query?.parentId ||
      parentFromUrl ||
      extractFolderId(process.env.DRIVE_FOLDER_URL);

    const auth = await ensureAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined,
      },
      fields: 'id, name, mimeType, parents, webViewLink',
    });

    res.json({ ok: true, folder: response.data });
  } catch (err) {
    console.error('Drive create-folder error:', err.message || err);
    if (isInsufficientPermissionError(err)) {
      return res.status(403).json({
        ok: false,
        error: 'Permisos insuficientes. Reautoriza en /api/drive/auth',
        reauthUrl: makeReauthUrl(),
      });
    }
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

module.exports = router;
