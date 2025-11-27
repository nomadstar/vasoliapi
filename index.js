const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const MONGO_URI = process.env.MONGO_URI || "";

// Importar rutas
const authRoutes = require("./endpoints/auth");
const flujos = require("./endpoints/flujos");
const departments = require("./endpoints/departments");
const mailRoutes = require("./endpoints/mail");
const gen = require("./endpoints/Generador");
const noti = require("./endpoints/notificaciones");
const menu = require("./endpoints/web");
const plantillas = require("./endpoints/plantillas");
const historial = require("./endpoints/historial");

const app = express();

app.set('trust proxy', 1); // o true — permite leer X-Forwarded-For cuando hay proxy/load-balancer

// 🔑 APLICAR EL MIDDLEWARE DE CORS CON LAS OPCIONES
app.use(cors());

app.use(express.json());

// Configurar conexión a MongoDB (desde variable de entorno)
const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db("Vasoli");
    console.log("Conectado a MongoDB");
  }
  return db;
}

// Middleware para inyectar la base de datos en cada request
app.use(async (req, res, next) => {
  try {
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
app.use("/api/departments", departments);
app.use("/api/mail", mailRoutes);
app.use("/api/noti", noti);

//rutas sin uso
app.use("/api/menu", menu);
app.use("/api/plantillas", plantillas);
app.use("/api/generador", gen);
app.use("/api/historial", historial);


// Ruta base
app.get("/", (req, res) => {
  res.json({ message: "API funcionando" });
});

// Exportar la app para que Vercel la maneje como serverless function
module.exports = app;