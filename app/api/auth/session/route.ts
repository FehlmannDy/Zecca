import { currentUser, endSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await currentUser();
  return user ? Response.json({ user }) : Response.json({ user: null }, { status: 401 });
}

export async function DELETE() {
  await endSession();
  return Response.json({ ok: true });
}
