import { localPhone, resolveLink } from '@/lib/whatsapp-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/**
 * Whose personal order link this is (lib/whatsapp-store, 26 Oct 2026): the checkout fills in their WhatsApp name and
 * number. Only the customer has the link — the bot sent it to their own WhatsApp — and it lasts three days.
 */
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('t') ?? '';
  try {
    const link = await resolveLink(token);
    if (!link) return Response.json({ ok: false, error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
    return Response.json(
      { ok: true, data: { name: link.name, phone: localPhone(link.phone) } },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    console.error('GET /api/whatsapp/link failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
