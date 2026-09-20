import { money } from '@/lib/types';

// Builds the "here's your order, please pay" email sent from the /sell
// flow when a coach chooses "Send payment link" and the parent gave an
// email address.
//
// Email clients are not browsers. Everything here is deliberately old
// fashioned: nested tables rather than flex or grid, every style inline
// rather than in a <style> block (Gmail strips <head>), an HTML width
// attribute alongside the CSS one on the logo (Outlook ignores CSS
// width on images), and a bulletproof button — a padded <td bgcolor>
// wrapping the anchor — because Outlook drops padding on an <a> and
// would otherwise render a bare text link.
//
// Colours are stated explicitly on both the container and the text so a
// client running in dark mode cannot invert the card into unreadable
// dark-red-on-black.
//
// NOTE ON WORDING: this must not promise the item is reserved. A
// payment-link sale is recorded as `pending`, and stock_overview counts
// only `paid` orders as committed, so nothing is actually held back and
// another coach can sell the last one. The copy says the order is
// recorded and will be ready once payment clears, which is true.

export const CONTACT_NAME = 'Anthony Belcher';
export const CONTACT_PHONE = '0404 221 003';
export const CONTACT_EMAIL = 'juniorsmcc@gmail.com';

export const LOGO_CID = 'mcc-logo';

const RED = '#d81e2c';
const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const PAGE = '#f4f5f7';

export interface PaymentLinkEmailInput {
  customerName: string;
  productName: string;
  size: string;
  quantity: number;
  unitPrice: number;
  paymentUrl: string;
  /** False when the logo file could not be read; the <img> is then
   *  omitted rather than left pointing at a missing attachment. */
  hasLogo: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The customer's first name only, for the greeting. Falls back to the
// whole string when there is nothing to split on.
function firstName(full: string): string {
  const trimmed = full.trim();
  const first = trimmed.split(/\s+/)[0];
  return first || trimmed;
}

export function paymentLinkSubject(input: PaymentLinkEmailInput): string {
  return `Your Macedon Cricket Club order — ${input.productName} (${input.size})`;
}

export function paymentLinkText(input: PaymentLinkEmailInput): string {
  const total = money(input.unitPrice * input.quantity);
  return [
    'MACEDON CRICKET CLUB',
    '',
    `Thanks, ${firstName(input.customerName)}`,
    '',
    "Here's what you've ordered:",
    '',
    `  Item:   ${input.productName}`,
    `  Size:   ${input.size}`,
    `  Qty:    ${input.quantity}`,
    `  Total:  ${total}`,
    '',
    'Pay online here:',
    input.paymentUrl,
    '',
    "Once your payment comes through we'll have this ready to",
    "collect at the club. Bring nothing - we'll match it up with",
    'your name.',
    '',
    `Questions? ${CONTACT_NAME}`,
    CONTACT_PHONE,
    CONTACT_EMAIL,
    '',
    '--',
    'Macedon Cricket Club merchandise',
  ].join('\n');
}

export function paymentLinkHtml(input: PaymentLinkEmailInput): string {
  const total = money(input.unitPrice * input.quantity);
  const name = escapeHtml(firstName(input.customerName));
  const product = escapeHtml(input.productName);
  const size = escapeHtml(input.size);
  const url = escapeHtml(input.paymentUrl);

  const detailRow = (label: string, value: string) => `
              <tr>
                <td style="padding:6px 0;font-size:14px;color:${MUTED};width:70px;" valign="top">${label}</td>
                <td style="padding:6px 0;font-size:14px;color:${INK};font-weight:600;" valign="top">${value}</td>
              </tr>`;

  const logoBlock = input.hasLogo
    ? `
            <tr>
              <td align="center" style="padding:0 0 12px 0;">
                <img src="cid:${LOGO_CID}" alt="Macedon Cricket Club" width="110" height="112"
                     style="display:block;border:0;outline:none;width:110px;height:112px;" />
              </td>
            </tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Your Macedon Cricket Club order</title>
</head>
<body style="margin:0;padding:0;background-color:${PAGE};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    ${total} to pay &middot; tap the button to pay online
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:${PAGE};">
    <tr>
      <td align="center" style="padding:24px 12px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="width:600px;max-width:600px;background-color:#ffffff;border-radius:8px;">
          <tr>
            <td style="padding:28px 32px 32px 32px;font-family:Arial,Helvetica,sans-serif;">

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${logoBlock}
                <tr>
                  <td align="center" style="padding:0 0 10px 0;font-family:Arial,Helvetica,sans-serif;
                      font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:${MUTED};">
                    Macedon Cricket Club
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 0 22px 0;">
                    <div style="height:3px;background-color:${RED};line-height:3px;font-size:0;">&nbsp;</div>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:22px;
                 font-weight:bold;color:${INK};">Thanks, ${name}</p>

              <p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;
                 line-height:22px;color:${INK};">Here&rsquo;s what you&rsquo;ve ordered:</p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="border:1px solid ${LINE};border-radius:6px;">
                <tr>
                  <td style="padding:14px 18px;font-family:Arial,Helvetica,sans-serif;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${detailRow('Item', product)}
${detailRow('Size', size)}
${detailRow('Qty', String(input.quantity))}
                      <tr>
                        <td colspan="2" style="padding:10px 0 0 0;">
                          <div style="height:1px;background-color:${LINE};line-height:1px;font-size:0;">&nbsp;</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:10px 0 0 0;font-size:14px;color:${MUTED};" valign="top">Total</td>
                        <td style="padding:10px 0 0 0;font-size:18px;color:${INK};font-weight:bold;" valign="top">${total}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"
                     style="margin:26px auto 22px auto;">
                <tr>
                  <td align="center" bgcolor="${RED}" style="border-radius:6px;">
                    <a href="${url}"
                       style="display:inline-block;padding:17px 34px;font-family:Arial,Helvetica,sans-serif;
                              font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;
                              border-radius:6px;">Pay ${total} online &rarr;</a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;
                 line-height:22px;color:${INK};">
                Once your payment comes through we&rsquo;ll have this ready to collect at the
                club. Bring nothing &mdash; we&rsquo;ll match it up with your name.
              </p>

              <p style="margin:0 0 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;
                 line-height:18px;color:${MUTED};">
                If the button doesn&rsquo;t work, paste this into your browser:<br />
                <span style="word-break:break-all;color:${MUTED};">${url}</span>
              </p>

              <div style="height:1px;background-color:${LINE};line-height:1px;font-size:0;">&nbsp;</div>

              <p style="margin:18px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;
                 line-height:20px;color:${MUTED};">
                Questions? ${CONTACT_NAME}<br />
                ${CONTACT_PHONE}<br />
                <a href="mailto:${CONTACT_EMAIL}" style="color:${MUTED};">${CONTACT_EMAIL}</a>
              </p>

            </td>
          </tr>
        </table>

        <p style="margin:14px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${MUTED};">
          Macedon Cricket Club merchandise
        </p>

      </td>
    </tr>
  </table>
</body>
</html>`;
}
