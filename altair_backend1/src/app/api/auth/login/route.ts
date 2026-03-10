import { NextResponse } from 'next/server';
import { syncUserFromAccessToken } from '@/lib/users';
import { connectToDatabase } from '@/lib/db';
import { getPrivyUserFromAccessToken } from '@/lib/privy';
import { User } from '@/models/User';
import { withWaitLogger } from '@/lib/waitLogger';

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { accessToken?: string; email?: string; phone?: string };
    const accessToken = typeof body.accessToken === 'string' && body.accessToken.length > 0 ? body.accessToken : null;

    if (!accessToken) {
      return NextResponse.json({ error: 'Missing Privy access token' }, { status: 401 });
    }

    const synced = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/auth/login/route.ts',
        target: 'syncUserFromAccessToken',
        description: 'Privy + Mongo user sync',
      },
      () => syncUserFromAccessToken(accessToken)
    );

    const hasEmail = typeof body.email === 'string' && body.email.length > 0;
    const hasPhone = typeof body.phone === 'string' && body.phone.length > 0;

    if (!hasEmail && !hasPhone) {
      return NextResponse.json({ user: synced });
    }

    const { claims } = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/auth/login/route.ts',
        target: 'getPrivyUserFromAccessToken',
        description: 'Privy user lookup',
      },
      () => getPrivyUserFromAccessToken(accessToken)
    );
    await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/auth/login/route.ts',
        target: 'connectToDatabase',
        description: 'MongoDB connection for login update',
      },
      () => connectToDatabase()
    );

    const update: Record<string, string> = {};
    if (hasEmail) update.email = body.email as string;
    if (hasPhone) update.phone = body.phone as string;

    const user = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/auth/login/route.ts',
        target: 'User.findOneAndUpdate',
        description: 'Mongo login update',
      },
      () =>
        User.findOneAndUpdate(
          { privyUserId: claims.userId },
          { $set: { ...update, lastSeenAt: new Date() } },
          { new: true }
        )
    );

    return NextResponse.json({ user: user ?? synced });
  } catch (error) {
    console.error('Login sync error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
