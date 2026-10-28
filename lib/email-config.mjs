export function normalizeEmailFromValue(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length < 2) return trimmed;

  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  if (quote === '"') {
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return inner.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

// EMAIL_PROVIDER=telnyx sends system notifications (invites, password resets)
// through Telnyx Email instead of Mailgun. EMAIL_FROM may be "Name <addr>".
export function emailNotificationProvider(env = process.env) {
  return String(env.EMAIL_PROVIDER || "").trim().toLowerCase() === "telnyx" ? "telnyx" : "mailgun";
}

export function parseEmailFrom(value) {
  const from = normalizeEmailFromValue(value);
  const match = from.match(/^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (!match) return { address: from.trim(), name: "" };
  return { address: match[2], name: match[1].replace(/^"(.*)"$/, "$1").replace(/[\r\n"<>]/g, " ").trim() };
}

export function buildTelnyxNotificationEmail({ from, to, subject, html, text, inlineAttachments = [] }) {
  const sender = parseEmailFrom(from);
  const payload = { from: sender.address, to: [to], subject, html_body: html };
  if (sender.name) payload.from_name = sender.name;
  if (text) payload.text_body = text;
  const attachments = inlineAttachments.filter((a) => a?.data && a.filename).map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.data).toString("base64"),
    content_type: a.contentType || "image/png",
    // Mailgun exposes inline parts by filename; templates reference cid:<filename>.
    content_id: a.filename,
    disposition: "inline",
  }));
  if (attachments.length) payload.attachments = attachments;
  return payload;
}
