import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { syncUserFromAccessToken } from '@/lib/users';

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { accessToken?: string };
    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value ?? null;
    const accessToken = typeof body.accessToken === 'string' && body.accessToken.length > 0 ? body.accessToken : cookieToken;

    if (!accessToken) {
      return NextResponse.json({ error: 'Missing Privy access token' }, { status: 401 });
    }

    const result = await syncUserFromAccessToken(accessToken, { mode: 'login' });

    return NextResponse.json({ user: result });
  } catch (error) {
    console.error('User sync error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
