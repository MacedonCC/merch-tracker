import { money } from '@/lib/types';

// Builds the "here's your order, please pay" email sent from the /sell
// flow when a coach chooses "Send payment link" and the parent gave an
// email address.
//
// Email clients are not browsers. Everything here is deliberately old
// fashioned: nested tables rather than flex or grid, every style inline
// rather than in a <style> block (Gmail strips <head>), and an HTML
// width attribute alongside the CSS one on the logo, since Outlook
// ignores CSS width on images.
//
// THE BUTTON is drawn twice. Outlook (the Word rendering engine) drops
// padding on both <a> and <td>, which collapsed the first version into
// a thin pink strip. The fix is the VML route: a <v:roundrect> inside
// an `[if mso]` conditional that only Outlook sees, and an ordinary
// anchor inside `[if !mso]` that everything else sees. Neither uses
// vertical padding — both set an explicit height with a matching
// line-height, which is the one approach Word honours. The VML needs
// the v: and w: namespaces declared on <html>, and a fixed pixel width,
// so it is sized to the content column (600 card - 2x32 padding = 536).
// The non-Outlook anchor is display:block at width 100%, so it fills
// the column on a phone instead of shrinking to fit its text.
//
// THE HEADER BAND is a full-width white row rather than a logo dropped
// into the card. The logo is a JPEG with a baked-in white background,
// and a client running in dark mode inverts the card while leaving the
// image alone — which is what made it look like a white square pasted
// onto a dark panel. Spanning the band across the whole card means that
// wherever the inversion lands, it reads as a deliberate masthead.
//
// NOTE ON WORDING: one paragraph differs depending on whether the
// parent walked away with the item (`takenNow`) or the club is holding
// it. The collect-later wording must not promise the item is RESERVED:
// a payment-link sale is recorded as `pending`, stock_overview counts
// only `paid` orders as committed, so nothing is actually held back and
// another coach can sell the last one. It says the order is recorded
// and will be ready once payment clears, which is true. The taken-now
// wording acknowledges they already have it and asks for payment —
// getting these two backwards would either nag someone holding nothing
// or tell someone holding the goods that we are keeping them safe.

export const CONTACT_NAME = 'Anthony Belcher';
export const CONTACT_PHONE = '0404 221 003';
export const CONTACT_EMAIL = 'juniorsmcc@gmail.com';

export const LOGO_CID = 'mcc-logo';

const RED = '#d81e2c';
const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const PAGE = '#f4f5f7';

/** Card width, and the content column inside its 32px side padding. */
const CARD_WIDTH = 600;
const CONTENT_WIDTH = CARD_WIDTH - 32 * 2;
/** Button height, reused as line-height so Outlook centres the label. */
const BUTTON_HEIGHT = 54;

export interface PaymentLinkEmailInput {
  customerName: string;
  productName: string;
  size: string;
  quantity: number;
  unitPrice: number;
  paymentUrl: string;
  /** True when the parent walked away with the item and will pay
   *  afterwards, false when the club is holding it until they do. Only
   *  changes one paragraph of copy, but getting it backwards would
   *  either nag someone who has nothing or tell someone holding the
   *  goods that we are keeping them safe. */
  takenNow: boolean;
  /** False when the logo file could not be read; the <img> is then
   *  omitted rather than left pointing at a missing attachment. */
  hasLogo: boolean;
}

// The one paragraph that differs between the two payment-link cases.
const TAKEN_NOW_TEXT =
  'You&rsquo;ve got this one with you already. When you get a moment, ' +
  'please pay using the link and we&rsquo;ll mark it off.';
const COLLECT_LATER_TEXT =
  "Once your payment comes through we&rsquo;ll have this ready to collect " +
  'at the club. Bring nothing &mdash; we&rsquo;ll match it up with your name.';

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
    ...(input.takenNow
      ? [
          "You've got this one with you already. When you get a",
          "moment, please pay using the link and we'll mark it off.",
        ]
      : [
          "Once your payment comes through we'll have this ready to",
          "collect at the club. Bring nothing - we'll match it up with",
          'your name.',
        ]),
    '',
    `Questions? ${CONTACT_NAME}`,
    CONTACT_PHONE,
    CONTACT_EMAIL,
    '',
    '--',
    'Macedon Cricket Club merchandise',
  ].join('\n');
}

// The card, masthead and contact footer every payment email shares;
// `content` is everything between the greeting and the footer.
function emailShell(name: string, preheader: string, hasLogo: boolean, content: string): string {
  const logo = hasLogo
    ? `<img src="cid:${LOGO_CID}" alt="Macedon Cricket Club" width="104" height="106"
                       style="display:block;border:0;outline:none;width:104px;height:106px;margin:0 auto 10px auto;" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Your Macedon Cricket Club order</title>
<!--[if mso]>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${PAGE};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    ${preheader}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:${PAGE};">
    <tr>
      <td align="center" style="padding:24px 12px;">

        <table role="presentation" width="${CARD_WIDTH}" cellpadding="0" cellspacing="0" border="0"
               style="width:${CARD_WIDTH}px;max-width:${CARD_WIDTH}px;background-color:#ffffff;border-radius:8px;">

          <tr>
            <td align="center" bgcolor="#ffffff"
                style="background-color:#ffffff;padding:26px 24px 18px 24px;border-radius:8px 8px 0 0;
                       font-family:Arial,Helvetica,sans-serif;">
              ${logo}
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:bold;
                          letter-spacing:4px;text-transform:uppercase;color:${INK};line-height:26px;">
                Macedon&nbsp;Cricket&nbsp;Club
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:0;">
              <div style="height:3px;background-color:${RED};line-height:3px;font-size:0;">&nbsp;</div>
            </td>
          </tr>

          <tr>
            <td style="padding:26px 32px 32px 32px;font-family:Arial,Helvetica,sans-serif;">

              <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:22px;
                 font-weight:bold;color:${INK};">Thanks, ${name}</p>

${content}              <div style="height:1px;background-color:${LINE};line-height:1px;font-size:0;">&nbsp;</div>

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

export function paymentLinkHtml(input: PaymentLinkEmailInput): string {
  const total = money(input.unitPrice * input.quantity);
  const name = escapeHtml(firstName(input.customerName));
  const product = escapeHtml(input.productName);
  const size = escapeHtml(input.size);
  const url = escapeHtml(input.paymentUrl);
  const buttonLabel = `Pay ${total} online`;

  const detailRow = (label: string, value: string) => `
              <tr>
                <td style="padding:6px 0;font-size:14px;color:${MUTED};width:70px;" valign="top">${label}</td>
                <td style="padding:6px 0;font-size:14px;color:${INK};font-weight:600;" valign="top">${value}</td>
              </tr>`;


  return emailShell(name, `${total} to pay &middot; tap the button to pay online`, input.hasLogo, `              <p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;
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

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="margin:26px 0 22px 0;">
                <tr>
                  <td align="center" style="font-family:Arial,Helvetica,sans-serif;">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
   href="${url}" style="height:${BUTTON_HEIGHT}px;v-text-anchor:middle;width:${CONTENT_WIDTH}px;"
   arcsize="11%" stroke="f" fillcolor="${RED}">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:bold;">
    ${buttonLabel}
  </center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
                    <a href="${url}"
                       style="display:block;width:100%;height:${BUTTON_HEIGHT}px;line-height:${BUTTON_HEIGHT}px;
                              background-color:${RED};color:#ffffff;font-family:Arial,Helvetica,sans-serif;
                              font-size:17px;font-weight:bold;text-align:center;text-decoration:none;
                              border-radius:6px;mso-hide:all;">${buttonLabel} &rarr;</a>
<!--<![endif]-->
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;
                 line-height:22px;color:${INK};">
                ${input.takenNow ? TAKEN_NOW_TEXT : COLLECT_LATER_TEXT}
              </p>

              <p style="margin:0 0 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;
                 line-height:18px;color:${MUTED};">
                If the button doesn&rsquo;t work, paste this into your browser:<br />
                <span style="word-break:break-all;color:${MUTED};">${url}</span>
              </p>

`);
}

// ---- Several items in one sale (orders.sale_id) ----
//
// A payment link only opens a product page, and Wix has no link that
// fills a cart, so a sale of several items lists each one with its own
// page and asks for one checkout using the address we match on. There
// is no single big pay button: it could only point at one of the items.
// Each item says whether they already have it; the rest use the same
// collect-later wording as a single item, which must not say "reserved"
// (see the note at the top).

export interface SaleEmailItem {
  productName: string;
  size: string;
  quantity: number;
  unitPrice: number;
  /** null when the item has no shop page; it is still listed. */
  paymentUrl: string | null;
  /** Handed over already (distributed_at set on the unpaid row). */
  takenNow: boolean;
}

export interface SaleEmailInput {
  customerName: string;
  email: string;
  items: SaleEmailItem[];
  hasLogo: boolean;
}

const NO_LINK_TEXT = 'No online link for this one &mdash; we&rsquo;ll sort it with you.';

function saleTotal(input: SaleEmailInput): string {
  return money(input.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));
}

function checkoutLine(email: string): string {
  return `Add each item to your cart, then check out once using ${email}.`;
}

export function saleEmailSubject(input: SaleEmailInput): string {
  return `Your Macedon Cricket Club order — ${input.items.length} items`;
}

export function saleEmailText(input: SaleEmailInput): string {
  const anyTaken = input.items.some((i) => i.takenNow);
  const anyHeld = input.items.some((i) => !i.takenNow);
  return [
    'MACEDON CRICKET CLUB',
    '',
    `Thanks, ${firstName(input.customerName)}`,
    '',
    "Here's what you've ordered:",
    '',
    ...input.items.flatMap((i) => [
      `  ${i.quantity} x ${i.productName} (${i.size}) - ${money(i.unitPrice * i.quantity)}` +
        (i.takenNow ? ' - with you already' : ''),
      `    ${i.paymentUrl ?? "No online link for this one - we'll sort it with you."}`,
    ]),
    '',
    `  Total:  ${saleTotal(input)}`,
    '',
    checkoutLine(input.email),
    '',
    ...(anyTaken ? ["Anything marked 'with you already' you've taken home; please pay when you get a moment."] : []),
    ...(anyHeld
      ? [`Once your payment comes through we'll have ${anyTaken ? 'the rest' : 'everything'} ready to collect at the club. Bring nothing - we'll match it up with your name.`]
      : []),
    '',
    `Questions? ${CONTACT_NAME}`,
    CONTACT_PHONE,
    CONTACT_EMAIL,
    '',
    '--',
    'Macedon Cricket Club merchandise',
  ].join('\n');
}

export function saleEmailHtml(input: SaleEmailInput): string {
  const total = saleTotal(input);
  const name = escapeHtml(firstName(input.customerName));
  const anyTaken = input.items.some((i) => i.takenNow);
  const anyHeld = input.items.some((i) => !i.takenNow);

  const itemRow = (i: SaleEmailItem, last: boolean) => {
    const url = i.paymentUrl ? escapeHtml(i.paymentUrl) : null;
    const qty = i.quantity > 1 ? `${i.quantity} &times; ` : '';
    const taken = i.takenNow
      ? `<span style="font-size:12px;color:${MUTED};font-weight:normal;"> &middot; with you already</span>`
      : '';
    const link = url
      ? `<a href="${url}" style="color:${RED};font-weight:bold;text-decoration:underline;">Add to cart &rarr;</a>`
      : `<span style="color:${MUTED};">${NO_LINK_TEXT}</span>`;
    return `
                      <tr>
                        <td style="padding:10px 0;font-size:14px;color:${INK};font-weight:600;${last ? '' : `border-bottom:1px solid ${LINE};`}" valign="top">
                          ${qty}${escapeHtml(i.productName)} (${escapeHtml(i.size)})${taken}
                          <div style="padding-top:4px;font-size:14px;font-weight:normal;">${link}</div>
                        </td>
                        <td align="right" style="padding:10px 0 10px 12px;font-size:14px;color:${INK};font-weight:600;white-space:nowrap;${last ? '' : `border-bottom:1px solid ${LINE};`}" valign="top">${money(i.unitPrice * i.quantity)}</td>
                      </tr>`;
  };

  const content = `
              <p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;
                 line-height:22px;color:${INK};">Here&rsquo;s what you&rsquo;ve ordered:</p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="border:1px solid ${LINE};border-radius:6px;">
                <tr>
                  <td style="padding:4px 18px 14px 18px;font-family:Arial,Helvetica,sans-serif;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${input.items.map((i, n) => itemRow(i, n === input.items.length - 1)).join('')}
                      <tr>
                        <td colspan="2" style="padding:4px 0 0 0;">
                          <div style="height:1px;background-color:${LINE};line-height:1px;font-size:0;">&nbsp;</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:10px 0 0 0;font-size:14px;color:${MUTED};" valign="top">Total</td>
                        <td align="right" style="padding:10px 0 0 0;font-size:18px;color:${INK};font-weight:bold;" valign="top">${total}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:22px 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;
                 line-height:23px;color:${INK};font-weight:bold;">${escapeHtml(checkoutLine(input.email))}</p>
${anyTaken ? `
              <p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;
                 line-height:22px;color:${INK};">
                Anything marked &ldquo;with you already&rdquo; you&rsquo;ve taken home &mdash; please pay when you get a moment.
              </p>` : ''}${anyHeld ? `
              <p style="margin:0 0 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;
                 line-height:22px;color:${INK};">
                Once your payment comes through we&rsquo;ll have ${anyTaken ? 'the rest' : 'everything'} ready to collect at the club. Bring nothing &mdash; we&rsquo;ll match it up with your name.
              </p>` : ''}

`;
  return emailShell(name, `${total} to pay &middot; ${input.items.length} items`, input.hasLogo, content);
}
