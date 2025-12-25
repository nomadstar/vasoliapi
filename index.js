const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Cargar .env con logging y soporte básico para plantillas de Railway
function loadEnv() {
  const envLocal = path.resolve(__dirname, '.env');
  const envParent = path.resolve(__dirname, '..', '.env');

  function tryLoadFile(p) {
    try {
      let content = fs.readFileSync(p, 'utf8');
      // Eliminar líneas que comiencen con // (comentarios JS) para compatibilidad
      const cleaned = content.split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
      const parsed = dotenv.parse(cleaned);
      // Sólo definir en process.env si no está definido (no sobrescribir)
      Object.entries(parsed).forEach(([k, v]) => {
        if (!Object.prototype.hasOwnProperty.call(process.env, k) || process.env[k] === '') {
          process.env[k] = v;
        }
      });
      console.info('dotenv: cargado desde', p);
      return parsed;
    } catch (err) {
      console.warn('dotenv load error for', p, err && err.message ? err.message : err);
      return null;
    }
  }

  if (fs.existsSync(envLocal)) return tryLoadFile(envLocal);
  if (fs.existsSync(envParent)) return tryLoadFile(envParent);

  const envCwd = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envCwd)) {
    if (process.env.NODE_ENV !== 'production' && !process.env.RAILWAY && !process.env.VERCEL) {
      console.warn('dotenv: no se encontró archivo .env en rutas conocidas');
    }
    return null;
  }

  const res = dotenv.config({ path: envCwd });
  if (res.error) console.warn('dotenv config error:', res.error);
  else console.info('dotenv: cargado desde process.cwd() (fallback)');
  return res.parsed || null;
}
loadEnv();

// Expande placeholders tipo ${VAR} o ${{service.VAR}} usando process.env
function expandEnvPlaceholders(input) {
  if (!input || typeof input !== 'string') return input;
  return input.replace(/\$\{\{([^}]+)\}\}|\$\{([^}]+)\}/g, (_, g1, g2) => {
    const key = (g1 || g2 || '').trim();
    if (!key) return '';
    // Pruebas de lookup: exacto, con puntos->underscore, uppercase
    const candidates = [
      key,
      key.replace(/\./g, '_'),
      key.toUpperCase(),
      key.replace(/\./g, '_').toUpperCase()
    ];
    for (const c of candidates) {
      if (Object.prototype.hasOwnProperty.call(process.env, c) && process.env[c]) return process.env[c];
    }
    console.warn('No se resolvió placeholder de env:', key);
    return '';
  });
}

const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
// Resolver MONGO_URI y expandir placeholders (si vienen de Railway templating)
const MONGO_URI_RAW = process.env.MONGO_URI || "";
const MONGO_URI = (typeof expandEnvPlaceholders === 'function')
  ? String(expandEnvPlaceholders(MONGO_URI_RAW || '')).trim()
  : String(MONGO_URI_RAW || '').trim();

// Importar rutas
const authRoutes = require("./endpoints/auth");
const flujos = require("./endpoints/flujos");
const departments = require("./endpoints/departments");
const tareas = require("./endpoints/tareas");
const mailRoutes = require("./endpoints/mail");
const noti = require("./endpoints/notificaciones");
const menu = require("./endpoints/web");
const plantillas = require("./endpoints/plantillas");
const historial = require("./endpoints/historial");
const googleDrive = require("./endpoints/googleDrive");
const analytics = require("./endpoints/analytics");
const internalProxy = require("./endpoints/internal-proxy");

const app = express();

app.set('trust proxy', 1); // permite leer X-Forwarded-For cuando hay proxy/load-balancer

// 🔑 CORS con credenciales y lista blanca
const allowAll = (String(process.env.CORS_ALLOW_ALL || '').toLowerCase() === 'true');
const envFrontend = (process.env.FRONTEND_URL || '').trim();
const defaultOrigins = 'http://localhost:5173,http://localhost:3000,https://vasoliweb-production.up.railway.app,https://vasoliltdaapi.vercel.app';

// Leer orígenes desde env y expandir placeholders (Railway templates)
const rawOrigins = process.env.CORS_ORIGINS || (envFrontend ? envFrontend + ',' + defaultOrigins : defaultOrigins);
const expandedOrigins = expandEnvPlaceholders(rawOrigins || '');
const allowedOrigins = allowAll
  ? ['*']
  : (expandedOrigins)
      .split(',')
      .map(o => o.trim())
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i); // unique

// Añadir exposición directa del host interno de Railway para tráfico entre servicios
try {
  const internalHostHttps = 'https://vasoliapi.railway.internal';
  const internalHostHttp = 'http://vasoliapi.railway.internal';
  if (!allowAll && Array.isArray(allowedOrigins)) {
    if (!allowedOrigins.includes(internalHostHttps)) allowedOrigins.push(internalHostHttps);
    if (!allowedOrigins.includes(internalHostHttp)) allowedOrigins.push(internalHostHttp);
  }
} catch (e) {
  // no hacer nada si hay algún problema al mutar allowedOrigins
}

// Log allowed origins al arrancar (mascara URIs que parezcan contener credenciales)
function maskOriginForLog(o) {
  if (!o) return o;
  // Si parece una conexión a DB u contiene user:pass, la enmascaramos
  if (/mongodb(:|\+srv)/i.test(o) || /:\/\/.*:.*@/.test(o)) return '[MASKED]';
  return o;
}

if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development') {
  try {
    const display = Array.isArray(allowedOrigins) ? allowedOrigins.map(maskOriginForLog) : [maskOriginForLog(String(allowedOrigins))];
    console.info('CORS: allowedOrigins=', display.join(', '));
  } catch (e) {
    console.info('CORS: allowedOrigins (error al formatear)');
  }
}

// Comprueba si un origin pertenece a la red local (IP privada, localhost, .local, .internal)
function isLocalNetworkOrigin(origin) {
  if (!origin) return false;
  try {
    // Intentar parsear como URL; si falla, prefijar http:// y reintentar
    let url;
    try {
      url = new URL(origin);
    } catch (e) {
      url = new URL(origin.startsWith('http') ? origin : `http://${origin}`);
    }
    const host = url.hostname;
    if (!host) return false;
    const lc = host.toLowerCase();
    if (lc === 'localhost' || lc === '::1' || lc === '127.0.0.1') return true;
    if (lc.endsWith('.local') || lc.endsWith('.lan') || lc.endsWith('.internal')) return true;
    // Hostnames sin puntos (p. ej. 'backend') tratarlos como internos
    if (!host.includes('.') && host.length > 0) return true;
    // IPv4 private ranges
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
    if (ipv4) {
      const parts = host.split('.').map(n => parseInt(n, 10));
      if (parts.length !== 4 || parts.some(isNaN)) return false;
      const [a, b] = parts;
      if (a === 10) return true; // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
      if (a === 192 && b === 168) return true; // 192.168.0.0/16
      return false;
    }
    // IPv6 simple checks
    if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

const corsOptions = {
  origin: (origin, callback) => {
    // Permite requests de same-origin (curl/local) donde origin es undefined
    if (!origin) return callback(null, true);
    if (allowAll) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (isLocalNetworkOrigin(origin)) {
      if (process.env.LOG_LEVEL === 'debug') console.info('CORS: allowing local network origin', origin);
      return callback(null, true);
    }
    console.error(`CORS blocked origin: ${origin}. Allowed origins:`, allowedOrigins);
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: !allowAll, // no usar credenciales cuando se permite cualquier origen
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-access-key', 'X-Requested-With'],
  preflightContinue: false,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Refuerza los headers CORS (para entornos donde queremos controlar el header explicitamente)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowAll) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-access-key, X-Requested-With');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-access-key, X-Requested-With');
    res.header('Vary', 'Origin');
  }
  next();
});

app.use(express.json());

// Detectar solicitudes internas y marcar en `req.isInternal`.
function isPrivateIp(ip) {
  if (!ip) return false;
  // limpiar formato IPv6 mapeado ::ffff:192.168.0.1
  const cleaned = ip.replace(/^::ffff:/, '').split('%')[0];
  const parts = cleaned.split('.');
  if (parts.length === 4 && parts.every(p => p !== '' && !isNaN(Number(p)))) {
    const [a, b] = parts.map(n => Number(n));
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    return false;
  }
  // Simple IPv6 checks
  if (cleaned === '::1') return true;
  if (/^fe80:/i.test(cleaned)) return true;
  return false;
}

function isInternalRequest(req) {
  try {
    // 1) Host header contains internal domains
    const host = (req.headers.host || '').toLowerCase();
    if (host && (host.includes('.internal') || host.includes('.lan') || host.includes('railway.internal'))) return true;

    // 2) Origin header that is local (uses isLocalNetworkOrigin)
    const origin = req.headers.origin;
    if (origin && isLocalNetworkOrigin(origin)) return true;

    // 3) X-Forwarded-For or req.ip
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (isPrivateIp(first)) return true;
    }
    const ip = req.ip || req.connection && req.connection.remoteAddress;
    if (ip && isPrivateIp(String(ip))) return true;
  } catch (e) {
    return false;
  }
  return false;
}

app.use((req, res, next) => {
  req.isInternal = isInternalRequest(req);
  if (req.isInternal && process.env.LOG_LEVEL === 'debug') {
    console.info('Request marked as internal:', req.method, req.url, 'Host:', req.headers.host, 'Origin:', req.headers.origin);
  }
  next();
});

// Middleware para manejar errores de CORS de manera más informativa
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    // Log detallado del intento bloqueado
    try {
      const who = {
        time: new Date().toISOString(),
        ip: req.ip || req.connection && req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown',
        method: req.method,
        url: req.originalUrl || req.url,
        origin: req.headers.origin || null,
        host: req.headers.host || null,
        ua: req.headers['user-agent'] || null,
        referer: req.headers.referer || req.headers.referrer || null
      };
      console.warn('CORS blocked request:', JSON.stringify(who), 'allowedOrigins:', allowedOrigins);
    } catch (logErr) {
      console.warn('CORS blocked (failed to format log)', logErr);
    }

    res.status(403).json({
      error: 'CORS error: Origin not allowed',
      origin: req.headers.origin,
      allowedOrigins: allowedOrigins
    });
  } else {
    next(err);
  }
});

// Configurar conexión a MongoDB (desde variable de entorno)
let client = null;
let db = null;

async function connectDB() {
  if (!MONGO_URI) {
    console.warn("MONGO_URI no definido — la API funcionará sin conexión a MongoDB.");
    return null;
  }

  // Validar esquema básico antes de instanciar MongoClient
  if (!(MONGO_URI.startsWith('mongodb://') || MONGO_URI.startsWith('mongodb+srv://'))) {
    console.warn('MONGO_URI parece inválida o contiene un placeholder no resuelto:', MONGO_URI);
    return null;
  }

  if (!db) {
    try {
      if (!client) client = new MongoClient(MONGO_URI);
      await client.connect();
      db = client.db(process.env.DB_NAME || "Vasoli");
      console.log("Conectado a MongoDB");
    } catch (err) {
      console.error("Error al conectar con MongoDB:", err && err.stack ? err.stack : err);
      // devolver null para que la API siga funcionando sin BD en entornos de test
      return null;
    }
  }
  return db;
}

// Middleware para inyectar la base de datos en cada request (si está configurada)
app.use(async (req, res, next) => {
  try {
    // Logging para debugging CORS
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`${req.method} ${req.url} - Origin: ${req.headers.origin}`);
    }

    if (!process.env.MONGO_URI) {
      req.db = null;
      return next();
    }
    req.db = await connectDB();
    next();
  } catch (err) {
    console.error("Error al conectar con MongoDB:", err);
    res.status(500).json({ error: "Error con base de datos" });
  }
});

// Rutas listas
app.use("/api/auth", authRoutes);
app.use("/api/workflows", flujos);
app.use("/api/tareas", tareas);
app.use("/api/tareas", tareas);
app.use("/api/departments", departments);
app.use("/api/mail", mailRoutes);
app.use("/api/noti", noti);
app.use("/api/notificaciones", noti);
// Proxy para llamadas a APIs internas desde el backend público
app.use('/internal-proxy', internalProxy);

//rutas sin uso
app.use("/api/menu", menu);
app.use("/api/plantillas", plantillas);
app.use("/api/historial", historial);
app.use("/api/drive", googleDrive);
app.use("/api/analytics", analytics);
app.use("/api/drive", googleDrive);
app.use("/api/analytics", analytics);

// Ruta base
app.get("/", (req, res) => {
  res.json({ message: "API funcionando" });
});

// Exportar la app para que Vercel la maneje como serverless function
module.exports = app;

// Si se ejecuta directamente (node index.js), arrancar un servidor HTTP
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  // Preferir variable `HOST` y no usar el nombre del contenedor (`HOSTNAME`) para bind.
  // El valor de `HOSTNAME` suele ser el id del contenedor y NO es una dirección válida
  // para hacer bind; en entornos cloud debemos escuchar en todas las interfaces.
  const HOST = process.env.HOST || '0.0.0.0';
  if (process.env.HOSTNAME && !process.env.HOST) {
    console.warn('Ignorando process.env.HOSTNAME al bindear; usando', HOST);
  }
  app.listen(PORT, HOST, () => {
    console.log(`Servidor Express escuchando en ${HOST}:${PORT}`);
  });
}
