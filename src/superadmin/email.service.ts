import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private config: ConfigService) {
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');

    if (user && pass) {
      this.transporter = nodemailer.createTransport({
        host: config.get<string>('SMTP_HOST') ?? 'smtp.gmail.com',
        port: config.get<number>('SMTP_PORT') ?? 587,
        secure: false,
        auth: { user, pass },
      });
    } else {
      this.logger.warn('SMTP no configurado — los emails se mostrarán en los logs');
    }
  }

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

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter) {
      // Sin SMTP configurado — logear el código para debugging local
      this.logger.log(`[EMAIL SIMULADO] Para: ${to} | Asunto: ${subject}`);
      this.logger.log(`Contenido: ${html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}`);
      return;
    }

    try {
      await this.transporter.sendMail({
        from: `"Stockup Superadmin" <${this.config.get('SMTP_USER')}>`,
        to,
        subject,
        html,
      });
      this.logger.log(`Email enviado a ${to}`);
    } catch (err) {
      this.logger.error(`Error enviando email a ${to}: ${err}`);
      throw err;
    }
  }
}
