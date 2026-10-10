/**
 * Pure rules of the Share dialog (tested in share.test.ts). Main validates everything again
 * (src/main/share.ts); these give the user the message next to the field before anything is sent.
 */
import type { ShareChannel, ShareContext } from '../../../../shared/types/print.ts';

export interface ShareDraft {
  channel: ShareChannel;
  to: string;
  mobile: string;
  subject: string;
  body: string;
  whatsappText: string;
}

/** Prefill from 'print.share.context': e-mail when the party has an address, else WhatsApp when it has a mobile. */
export function initialDraft(c: ShareContext, preferred?: ShareChannel): ShareDraft {
  const channel: ShareChannel = preferred ?? (c.email || !c.mobile ? 'email' : 'whatsapp');
  return { channel, to: c.email ?? '', mobile: c.mobile ?? '', subject: c.subject, body: c.body, whatsappText: c.whatsappText };
}

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Addresses separated by ',' or ';'. */
export function recipients(to: string): string[] {
  return to
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** '9876543210' from '+91 98765 43210' / '098765-43210' / '919876543210'; '' when not an Indian mobile. */
export function normaliseMobile(raw: string): string {
  if (!/^[+0-9 ()./-]*$/.test(raw)) return '';
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : '';
}

export type ShareErrors = Partial<Record<'to' | 'mobile' | 'subject' | 'body' | 'whatsappText', string>>;

export function shareErrors(d: ShareDraft): ShareErrors {
  const e: ShareErrors = {};
  if (d.channel === 'email') {
    const list = recipients(d.to);
    const bad = list.find((a) => a.length > 254 || !EMAIL.test(a));
    if (bad) e.to = `“${bad}” is not a valid e-mail address (e.g. accounts@example.com).`;
    else if (list.length > 20) e.to = 'Send to at most 20 addresses at a time.';
    if (/[\r\n]/.test(d.subject)) e.subject = 'The subject must be a single line.';
    else if (d.subject.trim() === '') e.subject = 'Enter a subject.';
    else if (d.subject.length > 300) e.subject = 'Keep the subject under 300 characters.';
    if (d.body.length > 20_000) e.body = 'The message is too long.';
  } else {
    if (d.mobile.trim() !== '' && !normaliseMobile(d.mobile)) e.mobile = 'Enter a 10-digit Indian mobile number (starting with 6, 7, 8 or 9), or leave it blank to choose the contact in WhatsApp.';
    if (d.whatsappText.trim() === '') e.whatsappText = 'Enter a short message.';
    else if (d.whatsappText.length > 1000) e.whatsappText = 'Keep the message under 1,000 characters — the PDF carries the details.';
  }
  return e;
}

/** What the success toast says. */
export function shareDoneMessage(channel: ShareChannel, opened: 'draft' | 'mailto' | 'none' | boolean): { title: string; message: string } {
  if (channel === 'email') {
    if (opened === 'draft') return { title: 'E-mail draft opened', message: 'Check it and press Send in your mail program. The PDF is attached and saved in the company’s exports folder.' };
    if (opened === 'mailto') return { title: 'E-mail opened', message: 'Your mail program could not open the draft with the attachment: attach the PDF from the folder shown.' };
    return { title: 'PDF and e-mail draft saved', message: 'No mail program is set up. Open the .eml file from the folder, or attach the PDF to an e-mail.' };
  }
  return opened
    ? { title: 'WhatsApp opened', message: 'Attach the PDF from the folder shown (drag it into the chat), then send.' }
    : { title: 'PDF saved', message: 'WhatsApp was not opened. Attach the PDF from the folder shown.' };
}

/** Rail hint when the user may not export (sharing is an export, like printing). */
export const EXPORT_DENIED_HINT_TEXT = 'Sharing needs the Data › Export permission.';
