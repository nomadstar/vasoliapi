const crypto = require("crypto");
const argon2 = require("argon2");

// En producción, usa process.env.MASTER_KEY (debe ser de 32 bytes / 64 caracteres hex)
const MASTER_KEY = Buffer.from(process.env.MASTER_KEY || "]UY@UhC2$}!ixuC)KJ3bN5*@Rg22=8ux_DW0Ba@{N+uN4i#Q-=.phv;DcRhBN@N9", 'hex');
const ALGORITHM = 'aes-256-gcm';

/**
 * Crea un hash determinístico para buscar datos cifrados (como el mail) 
 * sin revelar el contenido original.
 */
const createBlindIndex = (text) => {
    if (!text) return null;
    return crypto.createHash('sha256').update(text.toLowerCase().trim()).digest('hex');
};

/**
 * Cifra texto usando AES-256-GCM.
 * Retorna formato iv:authTag:encryptedText
 */
const encrypt = (text) => {
    if (!text) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
};

/**
 * Descifra strings en formato iv:authTag:encryptedText
 */
const decrypt = (encryptedData) => {
    if (!encryptedData || !encryptedData.includes(':')) return encryptedData;
    try {
        const [ivHex, authTagHex, encryptedText] = encryptedData.split(':');
        const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        return "[Error de descifrado]";
    }
};

/**
 * Hashea contraseñas con Argon2id (Post-Quantum Resistant)
 */
const hashPassword = async (password) => {
    return await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 2 ** 16, // 64MB
        timeCost: 3,
        parallelism: 1
    });
};

/**
 * Verifica contraseñas contra un hash Argon2id
 */
const verifyPassword = async (hash, password) => {
    try {
        return await argon2.verify(hash, password);
    } catch (err) {
        return false;
    }
};

module.exports = {
    encrypt,
    decrypt,
    createBlindIndex,
    hashPassword,
    verifyPassword
};