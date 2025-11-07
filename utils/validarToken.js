export async function validarToken(db, token) {
  console.log("TOKEN RECIBIDO: ", token);
  const tokenData = await db.collection("tokens").findOne({ "token": token });

  console.log("TOKEN DATA: ", tokenData)
  if (!tokenData) {
    return { ok: false, reason: "parece que No existe" };
  }

  const ahora = new Date();
  const expiracion = new Date(tokenData.expiresAt || tokenData.expiration);
  const creacion = new Date(tokenData.createdAt);

  // Verificar expiración
  if (ahora > expiracion) {
    await db.collection("tokens").deleteOne({ token });
    return { ok: false, reason: "Expirado" };
  }

  // Verificar que sea del mismo día
  const mismoDia =
    creacion.getFullYear() === ahora.getFullYear() &&
    creacion.getMonth() === ahora.getMonth() &&
    creacion.getDate() === ahora.getDate();
/*
  if (!mismoDia) {
    await db.collection("tokens").deleteOne({ token });
    return { ok: false, reason: "Antiguo" };
  }
*/
  return { ok: true };
}
