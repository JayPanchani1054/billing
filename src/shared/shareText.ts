/**
 * Share texts (print group): the e-mail subject / body and WhatsApp message used when a document is
 * shared, from the templates in F12 › Invoice printing › Sharing (CompanyConfig.share). Pure — used by
 * the core ('print.share.context') and the settings screen preview.
 *
 * Placeholders (case-insensitive, unknown ones are left as typed so a typo is visible):
 *   {document} 'Tax Invoice'   {number} 'INV/12'   {date} '09-Oct-2026'   {amount} '1,180.00'
 *   {party} 'Sharma Traders'   {company} 'Acme Pvt Ltd'   {period} '01-Apr-2026 to 30-Sep-2026'
 */

export const SHARE_PLACEHOLDERS = ['document', 'number', 'date', 'amount', 'party', 'company', 'period'] as const;
export type SharePlaceholder = (typeof SHARE_PLACEHOLDERS)[number];
export type ShareValues = Partial<Record<SharePlaceholder, string | null>>;

/** Replace {placeholders}; a missing value becomes '' and the spaces / punctuation around it are tidied. */
export function fillShareTemplate(template: string, values: ShareValues): string {
  const filled = template.replace(/\{([a-zA-Z]+)\}/g, (whole, key: string) => {
    const k = key.toLowerCase() as SharePlaceholder;
    if (!(SHARE_PLACEHOLDERS as readonly string[]).includes(k)) return whole;
    return (values[k] ?? '').trim();
  });
  return filled
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:!?])/g, '$1').replace(/\s+$/g, ''))
    .join('\n')
    .trim();
}

/** Subject lines are a single line (an e-mail header). */
export function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Problems with the share templates (settings form), keyed like CompanyConfig.share. */
export function shareTemplateErrors(t: { emailSubject: string; emailBody: string; whatsappText: string }): Partial<Record<'emailSubject' | 'emailBody' | 'whatsappText', string>> {
  const out: Partial<Record<'emailSubject' | 'emailBody' | 'whatsappText', string>> = {};
  if (/[\r\n]/.test(t.emailSubject)) out.emailSubject = 'The subject must be a single line.';
  else if (t.emailSubject.length > 200) out.emailSubject = 'Keep the subject under 200 characters.';
  if (t.emailBody.length > 4000) out.emailBody = 'The e-mail text is too long (4,000 characters at most).';
  if (t.whatsappText.length > 1000) out.whatsappText = 'Keep the WhatsApp message under 1,000 characters — the PDF carries the details.';
  return out;
}
