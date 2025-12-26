const { ObjectId } = require("mongodb");


async function registrarHistorial(db, titulo, areaTrabajo, descripcion) {
    const historial = db.collection("historial");

    const data = {
      titulo,
      areaTrabajo,
      descripcion,
      fecha: new Date()
    };

    const result = await historial.insertOne(data);

    console.log(" Historial registrado con ID:", result.insertedId);
    return { data_historial: data, modifiedCount: result.modifiedCount };


}

// Si ejecutas el archivo directamente, toma parámetros desde la consola
// node historialTest.js "titulo" "area" "descripcion"
// Protección: comprobar que process.argv[1] existe antes de usarlo
try {
  if (typeof process !== 'undefined' && process.argv && typeof process.argv[1] === 'string' && process.argv[1].includes("historialTest.js")) {
    const [titulo, areaTrabajo, descripcion] = process.argv.slice(2);

    if (!titulo || !areaTrabajo || !descripcion) {
      console.log(" Uso: node historialTest.js \"titulo\" \"areaTrabajo\" \"descripcion\"");
      process.exit(1);
    }

    registrarHistorial(titulo, areaTrabajo, descripcion).catch(e => {
      console.error('Error ejecutando registrarHistorial desde CLI:', e && e.message ? e.message : e);
      process.exit(1);
    });
  }
} catch (e) {
  // no bloquear la importación del módulo si algo falla en la comprobación
}

module.exports = { registrarHistorial };
