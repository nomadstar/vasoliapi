const express = require("express");
const router = express.Router();
const { validarToken } = require('../utils/validarToken');

router.post("/filter", async (req, res) => {
  try {
    const { mail, token } = req.body;
    
    if (!mail || !token) {
        return res.status(400).json({ error: "Faltan parámetros de autenticación (mail y token)." });
    }
    
    // =========================================================
    // --- PASO 1: Validar el Token ---
    // =========================================================
    const tokenResult = await validarToken(req.db, token);

    if (!tokenResult.ok) {
        // El token no es válido (no existe, expiró o es antiguo)
        console.warn(`Intento de acceso fallido para ${mail}. Razón del token: ${tokenResult.reason}`);
        return res.status(401).json({ error: `Acceso denegado: ${tokenResult.reason}.` });
    }
    
    // Si llegamos aquí, el token es válido.
    
    // =========================================================
    // --- PASO 2: Obtener el Rol del Usuario ---
    // =========================================================
    
    // Buscar al usuario por mail para obtener su rol. 
    const user = await req.db.collection('usuarios').findOne({ mail: mail });
    
    if (!user) {
        return res.status(401).json({ error: "Acceso denegado. Usuario no existe." });
    }
    
    const userRole = user.cargo; 

    if (!userRole) {
         return res.status(403).json({ error: "Cargo no definido para el usuario." });
    }

    // =========================================================
    // --- PASO 3: Filtrar las Secciones del Menú con el Rol ---
    // =========================================================
    
    const allowedRoles = [userRole, 'Todas'];

    // Colección 'menu' (AJUSTAR si es necesario)
    const menuItems = await req.db.collection('sidebar').find({
        cargo: { $in: allowedRoles }
    }).toArray();
    
    // 4. Retornar las secciones de menú filtradas
    res.json(menuItems);

  } catch (err) {
    console.error("Error en el endpoint de filtro de menú:", err);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

module.exports = router;