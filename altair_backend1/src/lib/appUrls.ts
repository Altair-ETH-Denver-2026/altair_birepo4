const normalizeUrl = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
};

const resolveBackendOverride = () => normalizeUrl(process.env.NEXT_PUBLIC_BACKEND_URL_OVERRIDE);

const resolveFrontendOverride = () => normalizeUrl(process.env.NEXT_PUBLIC_FRONTEND_URL_OVERRIDE);

const resolveFrontendLocal = () =>
  normalizeUrl(process.env.NEXT_PUBLIC_LOCAL_FRONTEND_URL ?? 'http://localhost:3000');

const resolveFrontendProd = () => normalizeUrl(process.env.NEXT_PUBLIC_PROD_FRONTEND_URL);

const resolveFrontendDevPrefix = () => {
  const raw = process.env.NEXT_PUBLIC_DEV_FRONTEND_URL_PREFIX;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed || null;
};

const parseWildcardPrefix = (pattern: string) => {
  if (!pattern.includes('*')) return null;
  const [prefix, suffix] = pattern.split('*');
  return {
    prefix: prefix ?? '',
    suffix: suffix ?? '',
  };
};

const isLocalDevOrigin = (origin: string) => {
  const normalizedOrigin = normalizeUrl(origin);
  if (!normalizedOrigin) return false;
  try {
    const parsed = new URL(normalizedOrigin);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin: string) => {
  const normalizedOrigin = normalizeUrl(origin);
  if (!normalizedOrigin) return false;

  const override = resolveFrontendOverride();
  if (override && normalizedOrigin === override) return true;

  const local = resolveFrontendLocal();
  if (local && normalizedOrigin === local) return true;

  const prod = resolveFrontendProd();
  if (prod && normalizedOrigin === prod) return true;

  const devPrefix = resolveFrontendDevPrefix();
  if (devPrefix) {
    const wildcard = parseWildcardPrefix(devPrefix);
    if (wildcard) {
      return normalizedOrigin.startsWith(wildcard.prefix) && normalizedOrigin.endsWith(wildcard.suffix);
    }
    return normalizedOrigin === devPrefix;
  }

  return false;
};

export const resolveFrontendOrigin = (requestOrigin?: string | null) => {
  const normalizedOrigin = normalizeUrl(requestOrigin ?? '');
  if (normalizedOrigin && isLocalDevOrigin(normalizedOrigin)) {
    return normalizedOrigin;
  }
  if (normalizedOrigin && isAllowedOrigin(normalizedOrigin)) {
    return normalizedOrigin;
  }

  return resolveFrontendOverride() ?? resolveFrontendLocal() ?? resolveFrontendProd();
};

export const resolveBackendUrl = (request?: Request | { headers: Headers }) => {
  const override = resolveBackendOverride();
  if (override) return override;

  const headers = request?.headers;
  const forwardedHost = headers?.get('x-forwarded-host');
  const host = forwardedHost ?? headers?.get('host');
  const forwardedProto = headers?.get('x-forwarded-proto');
  const proto = forwardedProto ?? 'https';
  if (host) return `${proto}://${host}`;

  return (
    normalizeUrl(process.env.NEXT_PUBLIC_LOCAL_BACKEND_URL) ??
    normalizeUrl(process.env.NEXT_PUBLIC_DEV_BACKEND_URL) ??
    normalizeUrl(process.env.NEXT_PUBLIC_PROD_BACKEND_URL)
  );
};

export const buildCorsHeaders = (requestOrigin?: string | null) => {
  const allowOrigin = resolveFrontendOrigin(requestOrigin);
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
  if (allowOrigin) {
    headers['access-control-allow-origin'] = allowOrigin;
  }
  return headers;
};
