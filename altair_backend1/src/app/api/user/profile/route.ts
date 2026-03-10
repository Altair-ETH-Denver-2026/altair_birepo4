import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { connectToDatabase } from '@/lib/db';
import { getPrivyUserFromAccessToken } from '@/lib/privy';
import { User } from '@/models/User';
import { withWaitLogger } from '@/lib/waitLogger';

type ProfileUpdatePayload = {
  profileImageUrl?: string;
};

export async function GET() {
  try {
    const cookieStore = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/user/profile/route.ts',
        target: 'cookies()',
        description: 'read auth cookies',
      },
      () => cookies()
    );
    const accessToken = cookieStore.get('privy-token')?.value ?? null;

    if (!accessToken) {
      return NextResponse.json({ error: 'Missing Privy access token' }, { status: 401 });
    }

    const { claims } = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/user/profile/route.ts',
        target: 'getPrivyUserFromAccessToken',
        description: 'Privy user lookup',
      },
      () => getPrivyUserFromAccessToken(accessToken)
    );
    await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/user/profile/route.ts',
        target: 'connectToDatabase',
        description: 'MongoDB connection for profile fetch',
      },
      () => connectToDatabase()
    );

    const user = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/user/profile/route.ts',
        target: 'User.findOne',
        description: 'Mongo profile lookup',
      },
      () => User.findOne({ privyUserId: claims.userId }).lean()
    );
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({ user });
  } catch (error) {
    console.error('Profile fetch error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as ProfileUpdatePayload & { accessToken?: string };
    const cookieStore = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/user/profile/route.ts',
        target: 'cookies()',
        description: 'read auth cookies',
      },
      () => cookies()
    );
    const cookieToken = cookieStore.get('privy-token')?.value ?? null;
    const accessToken = typeof body.accessToken === 'string' && body.accessToken.length > 0 ? body.accessToken : cookieToken;

    if (!accessToken) {
      return NextResponse.json({ error: 'Missing Privy access token' }, { status: 401 });
    }

    const { claims } = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/user/profile/route.ts',
        target: 'getPrivyUserFromAccessToken',
        description: 'Privy user lookup',
      },
      () => getPrivyUserFromAccessToken(accessToken)
    );
    await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/user/profile/route.ts',
        target: 'connectToDatabase',
        description: 'MongoDB connection for profile update',
      },
      () => connectToDatabase()
    );

    const update: ProfileUpdatePayload = {};
    if (typeof body.profileImageUrl === 'string') {
      update.profileImageUrl = body.profileImageUrl;
    }

    const user = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/user/profile/route.ts',
        target: 'User.findOneAndUpdate',
        description: 'Mongo profile update',
      },
      () =>
        User.findOneAndUpdate(
          { privyUserId: claims.userId },
          { $set: { ...update, lastSeenAt: new Date() } },
          { new: true }
        )
    );

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({ user });
  } catch (error) {
    console.error('Profile update error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
