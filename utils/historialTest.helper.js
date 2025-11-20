export async function registrarHistorial(db, titulo, areaTrabajo, descripcion) {
    const db = await conectarDB();
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

// --------------------------------------------------------------------
// Si ejecutas el archivo directamente, toma parámetros desde la consola
// node historialTest.js "titulo" "area" "descripcion"
// --------------------------------------------------------------------
if (process.argv[1].includes("historialTest.js")) {
  const [titulo, areaTrabajo, descripcion] = process.argv.slice(2);

  if (!titulo || !areaTrabajo || !descripcion) {
    console.log(" Uso: node historialTest.js \"titulo\" \"areaTrabajo\" \"descripcion\"");
    process.exit(1);
  }

  registrarHistorial(titulo, areaTrabajo, descripcion);
}
