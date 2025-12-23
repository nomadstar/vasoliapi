const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Cargar .env con logging y soporte básico para plantillas de Railway
function loadEnv() {
  const envLocal = path.resolve(__dirname, '.env');
  const envParent = path.resolve(__dirname, '..', '.env');
  let res;
  if (fs.existsSync(envLocal)) {
    res = dotenv.config({ path: envLocal });
    console.info('dotenv: cargado desde', envLocal);
  } else if (fs.existsSync(envParent)) {
    res = dotenv.config({ path: envParent });
    console.info('dotenv: cargado desde', envParent);
  } else {
    res = dotenv.config();
    console.info('dotenv: cargado desde process.cwd() (fallback)');
  }
  if (res.error) console.warn('dotenv load error:', res.error);
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
const MONGO_URI = process.env.MONGO_URI || "";

// Importar rutas
const authRoutes = require("./endpoints/auth");
const flujos = require("./endpoints/flujos");
const departments = require("./endpoints/departments");
const tareas = require("./endpoints/tareas");
const mailRoutes = require("./endpoints/mail");
const gen = require("./endpoints/Generador");
const noti = require("./endpoints/notificaciones");
const menu = require("./endpoints/web");
const plantillas = require("./endpoints/plantillas");
const historial = require("./endpoints/historial");
const googleDrive = require("./endpoints/googleDrive");
const analytics = require("./endpoints/analytics");

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

const corsOptions = {
  origin: (origin, callback) => {
    // Permite requests de same-origin (curl/local) donde origin es undefined
    if (!origin) return callback(null, true);
    if (allowAll) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
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

// Middleware para manejar errores de CORS de manera más informativa
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
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
let client;
let db;

if (MONGO_URI) {
  client = new MongoClient(MONGO_URI);
} else {
  console.warn("MONGO_URI no definido — la API funcionará sin conexión a MongoDB.");
}

async function connectDB() {
  if (!MONGO_URI) return null;
  if (!db) {
    await client.connect();
    db = client.db("Vasoli");
    console.log("Conectado a MongoDB");
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

//rutas sin uso
app.use("/api/menu", menu);
app.use("/api/plantillas", plantillas);
app.use("/api/generador", gen);
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
  app.listen(PORT, () => {
    console.log(`Servidor Express escuchando en puerto ${PORT}`);
  });
}
