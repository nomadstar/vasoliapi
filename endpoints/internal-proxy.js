const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Base interno al que reenviar (puede ser host interno como vasoliapi.railway.internal)
const INTERNAL_BASE = process.env.INTERNAL_API_BASE || 'https://vasoliapi.railway.internal';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

router.all('/*', (req, res) => {
  // Seguridad: permitir si la petición ya fue marcada como interna por el middleware
  // o si trae el header X-Internal-Secret correcto.
  if (!req.isInternal) {
    if (!INTERNAL_SECRET || req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
      return res.status(403).json({ error: 'Forbidden - internal proxy requires internal request or valid secret' });
    }
  }

  // Construir URL destino reemplazando el prefijo /internal-proxy
  const prefix = req.baseUrl || '/internal-proxy';
  const forwardPath = (req.originalUrl || '').replace(new RegExp('^' + prefix), '') || '/';
  const target = new URL(forwardPath, INTERNAL_BASE);

  const client = target.protocol === 'https:' ? https : http;

  // Clonar headers y limpiar hop-by-hop
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers['content-length'];
  delete headers.connection;
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers['upgrade'];

  const options = {
    method: req.method,
    headers: headers,
  };

  const proxyReq = client.request(target, options, (proxyRes) => {
    // Copiar status y headers
    const responseHeaders = Object.assign({}, proxyRes.headers);
    // Eliminar posibles hop-by-hop headers
    delete responseHeaders.connection;
    res.writeHead(proxyRes.statusCode || 200, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('internal-proxy error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) res.status(502).json({ error: 'Bad Gateway', details: String(err) });
  });

  // Encaminar cuerpo si lo hay
  if (req.readable) {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
});

module.exports = router;
