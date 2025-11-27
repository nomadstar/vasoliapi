const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const router = express.Router();

const TOKEN_PATH = path.join(__dirname, '..', 'data', 'google_tokens.json');

function ensureDataDir() {
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

function loadSavedTokens() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const raw = fs.readFileSync(TOKEN_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Error leyendo tokens:', e.message || e);
  }
  return null;
}

function saveTokens(tokens) {
  try {
    ensureDataDir();
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (e) {
    console.error('Error guardando tokens:', e.message || e);
  }
}

function getOAuth2Client() {
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const redirectUri = process.env.REDIRECT_URI || 'http://localhost:3000/api/drive/oauth2callback';

  if (!clientId || !clientSecret) {
    throw new Error('Faltan CLIENT_ID o CLIENT_SECRET en variables de entorno');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// Step 1: iniciar autorización (redirige al consentimiento de Google)
router.get('/auth', (req, res) => {
  try {
    const oauth2Client = getOAuth2Client();
    const scopes = ['https://www.googleapis.com/auth/drive.readonly'];
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
    });
    res.redirect(url);
  } catch (err) {
    console.error('Auth init error:', err.message || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Step 2: callback donde Google redirige con el código
router.get('/oauth2callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ ok: false, error: 'Missing code' });

    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    saveTokens(tokens);
    res.json({ ok: true, message: 'Tokens guardados', tokens });
  } catch (err) {
    console.error('OAuth2 callback error:', err.message || err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
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
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

module.exports = router;
