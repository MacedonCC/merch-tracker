import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { getCurrentMember, requireAdmin } from '@/lib/member';
import { createServerSupabase } from '@/lib/supabase-server';
import {
  LOGO_CID,
  paymentLinkHtml,
  paymentLinkSubject,
  paymentLinkText,
  saleEmailHtml,
  saleEmailSubject,
  saleEmailText,
  type PaymentLinkEmailInput,
  type SaleEmailInput,
} from '@/lib/payment-link-email';
import { sizedProductUrl } from '@/lib/payment-message';

// Emails a parent the shop link for an order recorded through /sell.
//
// This route is called AFTER the order has already been written, and it
// never reports failure as an error status. A sale must not be lost
// because SMTP was down, so every failure path returns 200 with
// { sent: false, reason }, and the caller shows "saved, but the email
// did not send" alongside the link to copy by hand.
//
// Auth follows the committee-action pattern (cookie-bound client, check
// the caller is on the members list), not the CRON_SECRET pattern: this
// is triggered by a signed-in coach, not a cron job. It is NOT
// admin-only — any committee member can sell.
//
// One email per SALE, not per row: when the order belongs to a /sell
// checkout of several items (orders.sale_id), every unpaid manual row
// in that sale goes into the same email, and the outcome is recorded on
// each of them. A row with no sale_id is a sale of one.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  orderId?: string;
  // Set by the Orders page's "Resend payment link": admin only, and only
  // for an order that is still unpaid.
  resend?: boolean;
}

type Result =
  | { sent: true }
  | { sent: false; reason: string };

function ok(result: Result) {
  return NextResponse.json(result);
}

const ORDER_COLUMNS =
  'id, sale_id, customer_name, customer_email, quantity, unit_price, distributed_at, payment_status, source, ordered_at, stock_items!stock_item_id(name, size, wix_product_url, wix_variant_id)';

interface StockItem {
  name: string;
  size: string;
  wix_product_url: string | null;
  wix_variant_id: string | null;
}

interface OrderWithItem {
  id: string;
  sale_id: string | null;
  customer_name: string;
  customer_email: string | null;
  quantity: number;
  unit_price: number | string;
  distributed_at: string | null;
  payment_status: string;
  source: string;
  stock_items?: unknown;
}

// Supabase types an embedded row as an array when it cannot prove the
// relationship is to-one, so accept either shape.
function itemOf(row: OrderWithItem): StockItem | undefined {
  const raw = row.stock_items;
  return (Array.isArray(raw) ? raw[0] : raw) as StockItem | undefined;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const { orderId, resend } = body;
  const member = resend ? await requireAdmin() : await getCurrentMember();
  if (!member) {
    // The only genuine error status here: the caller is not a committee
    // member, so they should not be sending club email at all.
    return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
  }

  if (!orderId) return ok({ sent: false, reason: 'No order was given.' });

  // Read the order back rather than trusting what the browser posted:
  // the product, size and price in the email must be what was actually
  // recorded, not whatever a client claimed.
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('id', orderId)
    .maybeSingle();
  const order = data as OrderWithItem | null;

  if (error || !order) {
    console.error('send-payment-link: order lookup failed', { orderId, error });
    return ok({ sent: false, reason: 'Could not find that order.' });
  }

  if (resend && (order.payment_status !== 'pending' || order.source !== 'manual')) {
    return ok({ sent: false, reason: 'Only unpaid orders from /sell can be resent.' });
  }

  // The rest of its sale, if it has one: unpaid /sell rows only, so a
  // resend never asks for money already taken. A failed read falls back
  // to this one row rather than not sending at all.
  let rows: OrderWithItem[] = [order];
  if (order.sale_id) {
    const { data: sale, error: saleError } = await supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('sale_id', order.sale_id)
      .eq('source', 'manual')
      .eq('payment_status', 'pending')
      .order('ordered_at')
      .order('id');
    if (saleError) {
      console.error('send-payment-link: sale lookup failed', { orderId, saleError });
    } else if (sale && sale.length > 0) {
      rows = sale as unknown as OrderWithItem[];
      if (!rows.some((r) => r.id === order.id)) rows = [order, ...rows];
    }
  }
  const ids = rows.map((r) => r.id);
  const items = rows.map(itemOf);

  // Best-effort: remembering the outcome must never turn a sent email
  // into a reported failure.
  const record = async (patch: { email_sent_at?: string; email_error: string | null }) => {
    const { error: recordError } = await supabase.from('orders').update(patch).in('id', ids);
    if (recordError) console.error('send-payment-link: could not record result', { orderId, recordError });
  };

  if (!order.customer_email) {
    await record({ email_error: 'No email address on the order.' });
    return ok({ sent: false, reason: 'No email address on the order.' });
  }
  // An item without a shop page is still listed in a sale's email; only
  // a sale where nothing has one has no link to send.
  if (!items.some((i) => i?.wix_product_url)) {
    const reason = rows.length > 1 ? 'No item in this sale has a shop page.' : 'This item has no shop page.';
    await record({ email_error: reason });
    return ok({ sent: false, reason });
  }
  // Checked after the order is found, so even this is recorded on it:
  // every outcome of a send leaves "Link emailed" or "Link not sent" on
  // the Orders row.
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.error('send-payment-link: GMAIL_USER or GMAIL_APP_PASSWORD is not set');
    await record({ email_error: 'Email is not configured.' });
    return ok({ sent: false, reason: 'Email is not configured.' });
  }

  // The logo is attached by CID rather than linked, since most clients
  // block remote images by default. Reading it is best-effort: files in
  // public/ are served by the CDN and are not guaranteed to be in the
  // serverless bundle, so a miss drops the logo instead of the email.
  let logo: Buffer | null = null;
  try {
    logo = await readFile(path.join(process.cwd(), 'public', 'mcc-logo.jpg'));
  } catch {
    logo = null;
  }

  // Whether they walked away with it is read from the order itself,
  // not posted by the browser. distributed_at is set only by the
  // "taking it now" path, so its presence on a still-unpaid order is
  // exactly the condition the copy needs to describe.
  let mail: { subject: string; text: string; html: string };
  if (rows.length === 1) {
    const row = rows[0];
    const item = items[0] as StockItem;
    const input: PaymentLinkEmailInput = {
      customerName: row.customer_name,
      productName: item.name,
      size: item.size,
      quantity: row.quantity,
      unitPrice: Number(row.unit_price) || 0,
      paymentUrl: sizedProductUrl(item.wix_product_url as string, item.wix_variant_id),
      takenNow: !!row.distributed_at,
      hasLogo: !!logo,
    };
    mail = { subject: paymentLinkSubject(input), text: paymentLinkText(input), html: paymentLinkHtml(input) };
  } else {
    const input: SaleEmailInput = {
      customerName: order.customer_name,
      email: order.customer_email,
      items: rows.map((r, n) => ({
        productName: items[n]?.name ?? 'Item',
        size: items[n]?.size ?? '',
        quantity: r.quantity,
        unitPrice: Number(r.unit_price) || 0,
        paymentUrl: items[n]?.wix_product_url
          ? sizedProductUrl(items[n]?.wix_product_url as string, items[n]?.wix_variant_id)
          : null,
        takenNow: !!r.distributed_at,
      })),
      hasLogo: !!logo,
    };
    mail = { subject: saleEmailSubject(input), text: saleEmailText(input), html: saleEmailHtml(input) };
  }

  try {
    const transport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transport.sendMail({
      from: { name: 'Macedon Cricket Club', address: process.env.GMAIL_USER },
      to: order.customer_email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: logo
        ? [
            {
              filename: 'mcc-logo.jpg',
              content: logo,
              cid: LOGO_CID,
              contentType: 'image/jpeg',
            },
          ]
        : [],
    });

    await record({ email_sent_at: new Date().toISOString(), email_error: null });
    return ok({ sent: true });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'Sending failed.';
    console.error('send-payment-link: send failed', { orderId, reason });
    await record({ email_error: reason });
    return ok({ sent: false, reason });
  }
}
