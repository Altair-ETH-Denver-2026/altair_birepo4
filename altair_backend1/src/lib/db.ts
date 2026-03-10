import mongoose from 'mongoose';
import { withWaitLogger } from '@/lib/waitLogger';

const MONGODB_URI = process.env.MONGODB_URI ?? '';
const MONGODB_DB = process.env.MONGODB_DB;

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

const cached = global.mongooseCache ?? { conn: null, promise: null };
global.mongooseCache = cached;

const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
let keepAliveStarted = false;

const startDbKeepAlive = () => {
  if (keepAliveStarted) return;
  keepAliveStarted = true;
  const interval = setInterval(async () => {
    try {
      const connection = await connectToDatabase();
      const db = connection.connection?.db;
      if (db) {
        await db.admin().ping();
      }
    } catch (err) {
      console.warn('[db] keepalive ping failed', err);
    }
  }, KEEPALIVE_INTERVAL_MS);
  (interval as unknown as { unref?: () => void }).unref?.();
};

if (MONGODB_URI) {
  startDbKeepAlive();
}

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (!MONGODB_URI) {
    throw new Error('Missing MONGODB_URI environment variable');
  }
  if (cached.conn) return cached.conn;

  console.log('[db] MongoDB Connection Initializing...');
  if (!cached.promise) {
    cached.promise = withWaitLogger(
      {
        file: 'altair_backend1/src/lib/db.ts',
        target: 'MongoDB connect',
        description: 'mongoose connection',
      },
      () =>
        mongoose.connect(MONGODB_URI, {
          dbName: MONGODB_DB,
          bufferCommands: false,
        })
    );
  }

  cached.conn = await cached.promise;
  return cached.conn;
}
