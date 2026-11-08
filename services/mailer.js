// services/mailer.js
const nodemailer = require('nodemailer');

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!isConfigured()) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendInvite({ to, businessName, inviteUrl }) {
  const t = getTransporter();
  if (!t) return { sent: false, reason: 'SMTP no configurado' };
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await t.sendMail({
      from: `"${businessName || 'CashFlow'}" <${from}>`,
      to,
      subject: `Invitación a ${businessName || 'tu negocio'} en CashFlow`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:auto">
          <h2>Te han invitado a ${businessName || 'un negocio'} en CashFlow</h2>
          <p>Para acceder, inicia sesión con tu cuenta de Google usando este correo (${to}).</p>
          <p><a href="${inviteUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Aceptar invitación</a></p>
          <p style="color:#666;font-size:12px">Si no esperabas esta invitación, ignora este correo.</p>
        </div>
      `,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

module.exports = { isConfigured, sendInvite };
