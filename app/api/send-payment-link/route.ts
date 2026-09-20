import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { getCurrentMember } from '@/lib/member';
import { createServerSupabase } from '@/lib/supabase-server';
import {
  LOGO_CID,
  paymentLinkHtml,
  paymentLinkSubject,
  paymentLinkText,
  type PaymentLinkEmailInput,
} from '@/lib/payment-link-email';

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

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  orderId?: string;
}

type Result =
  | { sent: true }
  | { sent: false; reason: string };

function ok(result: Result) {
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const member = await getCurrentMember();
  if (!member) {
    // The only genuine error status here: the caller is not a committee
    // member, so they should not be sending club email at all.
    return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
  }

  const { orderId } = (await req.json().catch(() => ({}))) as Body;
  if (!orderId) return ok({ sent: false, reason: 'No order was given.' });

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return ok({ sent: false, reason: 'Email is not configured.' });
  }

  // Read the order back rather than trusting what the browser posted:
  // the product, size and price in the email must be what was actually
  // recorded, not whatever a client claimed.
  const supabase = createServerSupabase();
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, customer_name, customer_email, quantity, unit_price, stock_items(name, size, wix_product_url)')
    .eq('id', orderId)
    .maybeSingle();

  if (error || !order) return ok({ sent: false, reason: 'Could not find that order.' });

  // Supabase types an embedded row as an array when it cannot prove the
  // relationship is to-one, so accept either shape.
  const rawItem = (order as { stock_items?: unknown }).stock_items;
  const item = (Array.isArray(rawItem) ? rawItem[0] : rawItem) as
    | { name: string; size: string; wix_product_url: string | null }
    | undefined;

  if (!order.customer_email) return ok({ sent: false, reason: 'No email address on the order.' });
  if (!item?.wix_product_url) return ok({ sent: false, reason: 'This item has no shop page.' });

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

  const input: PaymentLinkEmailInput = {
    customerName: order.customer_name,
    productName: item.name,
    size: item.size,
    quantity: order.quantity,
    unitPrice: Number(order.unit_price) || 0,
    paymentUrl: item.wix_product_url,
    hasLogo: !!logo,
  };

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
      subject: paymentLinkSubject(input),
      text: paymentLinkText(input),
      html: paymentLinkHtml(input),
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

    return ok({ sent: true });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'Sending failed.';
    return ok({ sent: false, reason });
  }
}
