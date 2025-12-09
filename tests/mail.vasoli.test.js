/**
 * Mockear utils/mail.helper antes de requerir la app para evitar llamadas SMTP reales

*/

const fs = require('dotenv').config();

jest.mock('../utils/mail.helper', () => ({
  sendEmail: jest.fn(),
  debugManual: jest.fn()
}));

// Set up environment variables before requiring the app


console.log('Test environment variables set:', {
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS ? '***' : undefined
});

const request = require('supertest');
const mailHelper = require('../utils/mail.helper');
const app = require('../index'); // ← Cambiado: require después de mockear
const ACCESS_KEY = 'Vasoli19';

describe('Mail Endpoint - Vasoli.cl Priority', () => {
  jest.setTimeout(30000); // Aumentar timeout para operaciones que tarden

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('debe rechazar sin accessKey válida', async () => {
    const emailData = {
      from:'noreply@vasoli.cl',
      to: 'ignacio.marambio.z@gmail.com',
      subject: 'Test Email',
      text: 'Este es un correo de prueba.'
    };

    const res = await request(app)
      .post('/api/mail/send')
      .send(emailData);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('debe conectar a vasoli.cl primero (debug/manual)', async () => {
    // Forzar respuesta del debug manual
    mailHelper.debugManual.mockResolvedValue({
      log: ['Debug mock ok'],
      success: true
    });

    const res = await request(app)
      .get('/api/mail/debug/manual')
      .set('x-access-key', ACCESS_KEY);

    console.log('Debug Manual Response:', JSON.stringify(res.body, null, 2));
    
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('log');
    expect(res.body).toHaveProperty('success');
    expect(res.body.success).toBe(true);
  });

  it('debe enviar email correctamente', async () => {
    // Forzar que sendEmail resuelva exitosamente
    mailHelper.sendEmail.mockResolvedValue({
      ok: true,
      messageId: '<msg-123@test.local>'
    });

    const emailData = {
      accessKey: ACCESS_KEY,
      to: 'ignacio.marambio.z@gmail.com',
      subject: 'Test Email',
      text: 'Este es un correo de prueba.'
    };

    const res = await request(app)
      .post('/api/mail/send')
      .send(emailData);

    console.log('Send Email Response:', JSON.stringify(res.body, null, 2));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('messageId');
  });
});