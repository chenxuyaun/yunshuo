import { randomUUID } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { sql } from '@yunshuo/db';
import { env, isSmtpConfigured } from '../env.js';

export type MailTemplate = 'workspace_invite' | 'password_reset';
export type MailProvider = 'smtp' | 'memory' | 'off';
export type MailStatus = 'sent' | 'captured' | 'failed' | 'not_configured';

export interface MailDelivery {
  id: string;
  provider: MailProvider;
  status: MailStatus;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: string | null;
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  template: MailTemplate;
  workspaceId?: string | null;
  userId?: string | null;
}

export interface MemoryMail extends MailInput {
  id: string;
  createdAt: string;
}

const MEMORY_MAILBOX_LIMIT = 50;
const memoryMailbox: MemoryMail[] = [];

let transporter: Transporter | null = null;

function smtpTransport(): Transporter {
  if (!transporter) {
    const smtp = env.mail.smtp;
    transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
    });
  }
  return transporter;
}

function sanitizeError(error: unknown): { code: string; message: string } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? 'MAIL_SEND_FAILED')
      : 'MAIL_SEND_FAILED';
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
  return { code: code.slice(0, 80), message: message || '邮件发送失败' };
}

async function deliver(input: MailInput): Promise<{
  status: MailStatus;
  errorCode: string | null;
  errorMessage: string | null;
}> {
  if (env.mail.mode === 'off') {
    return {
      status: 'not_configured',
      errorCode: 'MAIL_DISABLED',
      errorMessage: '邮件投递未启用（MAIL_MODE=off）',
    };
  }

  if (env.mail.mode === 'memory') {
    return { status: 'captured', errorCode: null, errorMessage: null };
  }

  if (!isSmtpConfigured()) {
    return {
      status: 'not_configured',
      errorCode: 'MAIL_NOT_CONFIGURED',
      errorMessage: 'SMTP 未配置完整（缺少 MAIL_HOST 或 MAIL_FROM）',
    };
  }

  try {
    await smtpTransport().sendMail({
      from: env.mail.smtp.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
    return { status: 'sent', errorCode: null, errorMessage: null };
  } catch (error) {
    const sanitized = sanitizeError(error);
    return {
      status: 'failed',
      errorCode: sanitized.code,
      errorMessage: sanitized.message,
    };
  }
}

export async function sendMail(input: MailInput): Promise<MailDelivery> {
  const id = randomUUID();
  const delivery = await deliver(input);
  const sentAt =
    delivery.status === 'sent' || delivery.status === 'captured' ? new Date() : null;

  await sql`
    INSERT INTO mail_messages (
      id, workspace_id, user_id, to_email, template, provider, status,
      error_code, error_message, sent_at
    )
    VALUES (
      ${id}, ${input.workspaceId ?? null}, ${input.userId ?? null}, ${input.to},
      ${input.template}, ${env.mail.mode}, ${delivery.status},
      ${delivery.errorCode}, ${delivery.errorMessage}, ${sentAt}
    )
  `;

  if (delivery.status === 'captured') {
    memoryMailbox.unshift({
      ...input,
      id,
      createdAt: (sentAt ?? new Date()).toISOString(),
    });
    if (memoryMailbox.length > MEMORY_MAILBOX_LIMIT) {
      memoryMailbox.length = MEMORY_MAILBOX_LIMIT;
    }
  }

  return {
    id,
    provider: env.mail.mode,
    status: delivery.status,
    errorCode: delivery.errorCode,
    errorMessage: delivery.errorMessage,
    sentAt: sentAt?.toISOString() ?? null,
  };
}

export function listMemoryMailbox(): MemoryMail[] {
  return memoryMailbox.map((message) => ({ ...message }));
}

export function findLatestMemoryMail(to: string): MemoryMail | undefined {
  const target = to.trim().toLowerCase();
  return memoryMailbox.find((message) => message.to.trim().toLowerCase() === target);
}

export function clearMemoryMailbox(): void {
  memoryMailbox.length = 0;
}

export function mailDeliveryMessage(delivery: MailDelivery): string {
  switch (delivery.status) {
    case 'sent':
      return '邮件已交由 SMTP 服务发送';
    case 'captured':
      return '已写入开发内存邮箱，未真实投递';
    case 'failed':
      return '邮件发送失败，链接仍可手动复制';
    case 'not_configured':
      return '邮件服务未配置，链接需手动发送';
  }
}
