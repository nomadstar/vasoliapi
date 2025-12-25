const express = require("express");
const router = express.Router();
const { validarToken } = require('../utils/validarToken');
const { createBlindIndex } = require("../utils/seguridad.helper");

router.post("/filter", async (req, res) => {
  try {
    const { mail, token } = req.body;
    
    if (!mail || !token) {
        return res.status(400).json({ error: "Faltan parámetros de autenticación (mail y token)." });
    }
    
    // =========================================================
    // --- PASO 1: Validar el Token ---
    // =========================================================

    if (!req.isInternal) {
      const tokenResult = await validarToken(req.db, token);
      if (!tokenResult.ok) {
        console.warn(`Intento de acceso fallido para ${mail}. Razón del token: ${tokenResult.reason}`);
        return res.status(401).json({ error: `Acceso denegado: ${tokenResult.reason}.` });
      }
    }
    
    // =========================================================
    // --- PASO 2: Obtener el Rol del Usuario ---
    // =========================================================
    
    // CAMBIO CRÍTICO: Buscar por mail_index usando createBlindIndex
    const normalizedEmail = mail.toLowerCase().trim();
    const user = await req.db.collection('usuarios').findOne({ 
      mail_index: createBlindIndex(normalizedEmail) 
    });
    
    if (!user) {
        return res.status(401).json({ error: "Acceso denegado. Usuario no existe." });
    }
    
    // Usamos 'cargo' o 'rol' según lo definido en tu estructura de DB
    const userRole = user.cargo || user.rol; 

    if (!userRole) {
         return res.status(403).json({ error: "Cargo no definido para el usuario." });
    }

    // =========================================================
    // --- PASO 3: Filtrar las Secciones del Menú con el Rol ---
    // =========================================================
    
    const allowedRoles = [userRole, 'Todas'];

    // Colección 'sidebar'
    const menuItems = await req.db.collection('sidebar').find({
        cargo: { $in: allowedRoles }
    }).toArray();
    
    res.json(menuItems);

  } catch (err) {
    console.error("Error en el endpoint de filtro de menú:", err);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

module.exports = router;