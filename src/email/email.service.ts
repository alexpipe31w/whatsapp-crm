import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private fromEmail = '';

  constructor(private config: ConfigService) {
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');
    this.fromEmail = user ?? '';

    if (user && pass) {
      this.transporter = nodemailer.createTransport({
        host: config.get<string>('SMTP_HOST') ?? 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user, pass },
        family: 4,
      } as any);
    } else {
      this.logger.warn('SMTP no configurado — los emails se mostrarán en los logs');
    }
  }

  // ── Superadmin 2FA ────────────────────────────────────────────────────────

  async sendMfaCode(to: string, code: string): Promise<void> {
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#f8fafc;border-radius:16px">
        <div style="background:linear-gradient(135deg,#7c3aed,#4f46e5);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <h1 style="color:white;margin:0;font-size:22px">Panel Superadmin</h1>
          <p style="color:rgba(255,255,255,.8);margin:4px 0 0;font-size:14px">Stockup Messages</p>
        </div>
        <h2 style="color:#1e293b;font-size:18px;margin-bottom:8px">Código de verificación</h2>
        <p style="color:#64748b;font-size:14px;margin-bottom:24px">
          Usa este código para completar tu inicio de sesión. Expira en <strong>10 minutos</strong>.
        </p>
        <div style="background:white;border:2px solid #e2e8f0;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <span style="font-size:40px;font-weight:700;letter-spacing:8px;color:#7c3aed">${code}</span>
        </div>
        <p style="color:#94a3b8;font-size:12px;text-align:center">
          Si no solicitaste este código, ignora este mensaje.
        </p>
      </div>`;
    await this.send(to, 'Código de verificación — Stockup Superadmin', html);
  }

  async sendResetCode(to: string, code: string): Promise<void> {
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#f8fafc;border-radius:16px">
        <div style="background:linear-gradient(135deg,#7c3aed,#4f46e5);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <h1 style="color:white;margin:0;font-size:22px">Panel Superadmin</h1>
          <p style="color:rgba(255,255,255,.8);margin:4px 0 0;font-size:14px">Stockup Messages</p>
        </div>
        <h2 style="color:#1e293b;font-size:18px;margin-bottom:8px">Restablecer contraseña</h2>
        <p style="color:#64748b;font-size:14px;margin-bottom:24px">
          Usa este código para restablecer tu contraseña. Expira en <strong>15 minutos</strong>.
        </p>
        <div style="background:white;border:2px solid #e2e8f0;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <span style="font-size:40px;font-weight:700;letter-spacing:8px;color:#7c3aed">${code}</span>
        </div>
        <p style="color:#94a3b8;font-size:12px;text-align:center">
          Si no solicitaste este código, ignora este mensaje.
        </p>
      </div>`;
    await this.send(to, 'Restablecer contraseña — Stockup Superadmin', html);
  }

  // ── Verificación de email al registrarse ─────────────────────────────────

  async sendEmailVerification(to: string, code: string): Promise<void> {
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#f8fafc;border-radius:16px">
        <div style="background:linear-gradient(135deg,#2563eb,#9333ea);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <h1 style="color:white;margin:0;font-size:22px">Stockup Messages</h1>
          <p style="color:rgba(255,255,255,.8);margin:4px 0 0;font-size:14px">Verificación de email</p>
        </div>
        <h2 style="color:#1e293b;font-size:18px;margin-bottom:8px">Confirma tu dirección de correo</h2>
        <p style="color:#64748b;font-size:14px;margin-bottom:24px">
          Usa este código para verificar tu email y completar tu registro.
          Expira en <strong>15 minutos</strong>.
        </p>
        <div style="background:white;border:2px solid #e2e8f0;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <span style="font-size:44px;font-weight:800;letter-spacing:10px;color:#2563eb">${code}</span>
        </div>
        <p style="color:#64748b;font-size:13px;margin-bottom:16px">
          Si no estás creando una cuenta en Stockup Messages, puedes ignorar este correo con seguridad.
        </p>
        <p style="color:#94a3b8;font-size:12px;text-align:center">© 2026 Stockup Messages</p>
      </div>`;
    await this.send(to, 'Verifica tu email — Stockup Messages', html);
  }

  // ── Bienvenida al nuevo usuario ───────────────────────────────────────────

  async sendWelcome(to: string, ownerName: string, storeName: string): Promise<void> {
    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173';

    const steps = [
      { num: '1', title: 'Activa tu suscripción', desc: 'Completa el pago para desbloquear todas las funciones.', url: `${frontendUrl}/config#suscripcion`, btn: 'Ir a Suscripción' },
      { num: '2', title: 'Conecta tu WhatsApp', desc: 'Escanea el código QR para vincular tu número de negocio.', url: `${frontendUrl}/whatsapp`, btn: 'Conectar WhatsApp' },
      { num: '3', title: 'Obtén tu API key de Groq', desc: 'Regístrate gratis en console.groq.com y genera una API key.', url: 'https://console.groq.com', btn: 'Ir a Groq' },
      { num: '4', title: 'Configura el asistente IA', desc: 'Escribe las instrucciones para que la IA responda como tu negocio.', url: `${frontendUrl}/config`, btn: 'Configurar IA' },
      { num: '5', title: 'Agrega tus productos o servicios', desc: 'La IA los usa para responder preguntas de clientes y generar órdenes.', url: `${frontendUrl}/products`, btn: 'Agregar productos' },
    ];

    const stepsHtml = steps.map(s => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;vertical-align:top">
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td width="36" style="vertical-align:top;padding-top:2px">
                <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#9333ea);display:flex;align-items:center;justify-content:center;text-align:center;line-height:28px">
                  <span style="color:white;font-weight:700;font-size:13px">${s.num}</span>
                </div>
              </td>
              <td style="padding-left:12px">
                <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:14px">${s.title}</p>
                <p style="margin:0 0 8px;color:#64748b;font-size:13px">${s.desc}</p>
                <a href="${s.url}" style="display:inline-block;padding:6px 14px;background:#f1f5f9;border-radius:8px;color:#2563eb;font-size:12px;font-weight:600;text-decoration:none">${s.btn} →</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>`).join('');

    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#f8fafc;padding:32px;border-radius:16px">
        <div style="background:linear-gradient(135deg,#2563eb,#9333ea);border-radius:12px;padding:28px 24px;text-align:center;margin-bottom:28px">
          <p style="color:rgba(255,255,255,.7);margin:0 0 6px;font-size:13px;letter-spacing:.5px;text-transform:uppercase">Bienvenido a</p>
          <h1 style="color:white;margin:0;font-size:26px;font-weight:800">Stockup Messages</h1>
          <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:14px">CRM inteligente para WhatsApp</p>
        </div>

        <p style="color:#1e293b;font-size:15px;margin:0 0 6px"><strong>Hola ${ownerName},</strong></p>
        <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 24px">
          Tu negocio <strong>${storeName}</strong> ya está registrado en Stockup Messages.
          Sigue estos pasos para empezar a automatizar tus ventas con IA en WhatsApp:
        </p>

        <div style="background:white;border-radius:12px;padding:16px 20px;margin-bottom:24px;border:1px solid #e2e8f0">
          <table cellpadding="0" cellspacing="0" width="100%">
            ${stepsHtml}
          </table>
        </div>

        <div style="background:#eff6ff;border-radius:12px;padding:16px;margin-bottom:24px;border-left:4px solid #2563eb">
          <p style="margin:0;color:#1e40af;font-size:13px;line-height:1.5">
            💡 <strong>Tip:</strong> Una vez configures la IA con tu catálogo, ella responderá a tus clientes
            automáticamente 24/7, creará órdenes y agendará citas sin que tengas que intervenir.
          </p>
        </div>

        <p style="color:#94a3b8;font-size:12px;text-align:center;margin:0">
          ¿Tienes dudas? Escríbenos por WhatsApp o responde este correo.<br/>
          © 2026 Stockup Messages
        </p>
      </div>`;

    await this.send(to, `¡Bienvenido a Stockup Messages, ${ownerName}! 🚀`, html);
  }

  // ── Notificación al admin de nuevo registro ───────────────────────────────

  async sendNewAccountAlert(ownerName: string, ownerEmail: string, storeName: string, storePhone: string): Promise<void> {
    const adminEmail = this.fromEmail;
    if (!adminEmail) return;

    const now = new Date().toLocaleString('es-CO', {
      timeZone: 'America/Bogota',
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#f8fafc;padding:28px;border-radius:16px">
        <div style="background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:12px;padding:20px 24px;margin-bottom:24px">
          <p style="color:#94a3b8;margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Stockup Messages</p>
          <h2 style="color:white;margin:0;font-size:18px">Nuevo registro de cuenta</h2>
        </div>

        <div style="background:white;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;margin-bottom:20px">
          ${[
            ['Negocio', storeName],
            ['Teléfono', storePhone],
            ['Propietario', ownerName],
            ['Email', ownerEmail],
            ['Fecha', now],
          ].map(([k, v]) => `
            <div style="display:flex;padding:12px 16px;border-bottom:1px solid #f1f5f9">
              <span style="color:#94a3b8;font-size:13px;width:110px;flex-shrink:0">${k}</span>
              <span style="color:#1e293b;font-size:13px;font-weight:500">${v}</span>
            </div>`).join('')}
        </div>

        <div style="background:#fef3c7;border-radius:10px;padding:12px 16px;border-left:4px solid #f59e0b">
          <p style="margin:0;color:#92400e;font-size:13px">
            ⏳ Esta cuenta tiene <strong>24 horas</strong> para completar el pago, de lo contrario se eliminará automáticamente.
          </p>
        </div>
      </div>`;

    await this.send(adminEmail, `🆕 Nueva cuenta: ${storeName} — Stockup Messages`, html);
  }

  // ── Core ──────────────────────────────────────────────────────────────────

  async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter) {
      this.logger.log(`[EMAIL SIMULADO] Para: ${to} | Asunto: ${subject}`);
      this.logger.log(html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300));
      return;
    }
    try {
      await this.transporter.sendMail({
        from: `"Stockup Messages" <${this.fromEmail}>`,
        to,
        subject,
        html,
      });
      this.logger.log(`✉️  Email enviado a ${to}`);
    } catch (err) {
      this.logger.error(`Error enviando email a ${to}: ${err}`);
      throw err;
    }
  }
}
