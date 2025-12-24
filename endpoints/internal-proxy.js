const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Base interno al que reenviar (puede ser host interno como vasoliapi.railway.internal)
const INTERNAL_BASE = process.env.INTERNAL_API_BASE || 'https://vasoliapi.railway.internal';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
const INTERNAL_API_PORT = process.env.INTERNAL_API_PORT || '';
const INTERNAL_BASE_FALLBACK = process.env.INTERNAL_API_BASE_FALLBACK || process.env.INTERNAL_FALLBACK_PUBLIC || '';

// Readable request body helper
function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e));
  });
}

router.all('/*', async (req, res) => {
  // Seguridad: permitir si la petición ya fue marcada como interna por el middleware,
  // o si trae el header X-Internal-Secret correcto, o si proviene de un frontend listado
  // en CORS_ORIGINS (permite llamadas desde navegador de esos frontends).
  if (!req.isInternal) {
    const origin = (req.headers.origin || '').toString();
    const corsEnv = String(process.env.CORS_ORIGINS || '') || '';
    const allowedFromEnv = corsEnv.split(',').map(s => s.trim()).filter(Boolean);
    const originAllowed = origin && allowedFromEnv.some(a => a.toLowerCase() === origin.toLowerCase());
    const frontendAllow = origin && (origin.includes('vasoliweb-testing.up.railway.app') || origin.includes('vasoliweb.up.railway.app') || origin.startsWith('http://localhost') || origin.startsWith('https://localhost'));

    if (INTERNAL_SECRET && req.headers['x-internal-secret'] && req.headers['x-internal-secret'] === INTERNAL_SECRET) {
      // allow via secret header
    } else if (originAllowed || frontendAllow) {
      // allow because origin is trusted (CORS protects browser environments)
    } else {
      return res.status(403).json({ error: 'Forbidden - internal proxy requires internal request, valid secret, or trusted origin' });
    }
  }

  // Construir path destino reemplazando el prefijo /internal-proxy
  const prefix = req.baseUrl || '/internal-proxy';
  const forwardPath = (req.originalUrl || '').replace(new RegExp('^' + prefix), '') || '/';

  // Construir lista de candidatos a probar en orden
  const candidates = [];
  try {
    const primary = new URL(INTERNAL_BASE);
    candidates.push(primary.origin);
    // si INTERNAL_API_PORT está definido, añadir variante http con ese puerto
    if (INTERNAL_API_PORT) {
      candidates.push(`http://${primary.hostname}:${INTERNAL_API_PORT}`);
    } else {
      // si la base es https, intentar http://hostname:8080 por defecto (común en dev)
      if (primary.protocol === 'https:') candidates.push(`http://${primary.hostname}:8080`);
    }
  } catch (e) {
    // INTERNAL_BASE no parseable; usar literal
    if (INTERNAL_BASE) candidates.push(INTERNAL_BASE);
  }
  if (INTERNAL_BASE_FALLBACK) candidates.push(INTERNAL_BASE_FALLBACK);

  if (process.env.LOG_LEVEL === 'debug') console.info('internal-proxy candidates:', candidates, 'forwardPath:', forwardPath);

  // Buffer the incoming request body so we can retry
  let bodyBuffer = Buffer.alloc(0);
  try {
    bodyBuffer = await collectRequestBody(req);
  } catch (e) {
    console.error('Error collecting request body for proxy:', e);
    return res.status(500).json({ error: 'Error reading request body' });
  }

  // Prepare headers for forwarding
  const baseHeaders = Object.assign({}, req.headers);
  delete baseHeaders.host;
  delete baseHeaders.connection;
  delete baseHeaders['keep-alive'];
  delete baseHeaders['transfer-encoding'];
  delete baseHeaders['upgrade'];

  // Try each candidate sequentially
  let attempted = 0;
  const tryNext = (index) => {
    if (index >= candidates.length) {
      if (!res.headersSent) res.status(502).json({ error: 'Bad Gateway - all internal targets failed', attempted });
      return;
    }
    attempted++;
    const base = candidates[index];
    let targetUrl;
    try {
      targetUrl = new URL(forwardPath, base);
    } catch (e) {
      // fallback: simple concat
      targetUrl = new URL(base + forwardPath);
    }

    if (process.env.LOG_LEVEL === 'debug') console.info('internal-proxy trying', targetUrl.href);

    const client = targetUrl.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, baseHeaders);
    if (bodyBuffer && bodyBuffer.length) headers['content-length'] = String(bodyBuffer.length);
    else delete headers['content-length'];

    const options = {
      method: req.method,
      headers,
    };

    const proxyReq = client.request(targetUrl, options, (proxyRes) => {
      // Copiar status y headers
      const responseHeaders = Object.assign({}, proxyRes.headers);
      delete responseHeaders.connection;
      if (!res.headersSent) res.writeHead(proxyRes.statusCode || 200, responseHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.warn('internal-proxy error for', targetUrl.href, err && err.message ? err.message : err);
      // Intentar siguiente candidato
      tryNext(index + 1);
    });

    // Timeout for the request
    proxyReq.setTimeout(5000, () => {
      proxyReq.abort();
    });

    // Send buffered body
    if (bodyBuffer && bodyBuffer.length) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  };

  tryNext(0);
});

module.exports = router;
