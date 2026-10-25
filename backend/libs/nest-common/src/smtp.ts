/**
 * SMTP settings for every mailer (notifications, signup confirmations, dev SMS-to-mail). One place, so none of them
 * forgets credentials or TLS (docs/ROLE-FLOWS-AND-GAPS.md A-4). Pass to nodemailer.createTransport().
 */
export function smtpOptions() {
  return {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 61025),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
  };
}
