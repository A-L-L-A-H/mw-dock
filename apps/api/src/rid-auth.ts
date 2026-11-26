import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

const ALLOWED_ASYMMETRIC_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

export interface RidAuthConfig {
  readonly jwksUrl?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly keyResolver?: JWTVerifyGetKey;
}

export interface VerifiedRidIdentity {
  readonly subject: string;
  readonly issuer: string;
  readonly scope: string | null;
  readonly clientId: string | null;
}

export interface DockRidAuthRoutesOptions {
  readonly ridAuth?: RidAuthConfig;
}

const remoteJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function resolveRemoteJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = remoteJwksCache.get(jwksUrl);
  if (cached) {
    return cached;
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  remoteJwksCache.set(jwksUrl, jwks);
  return jwks;
}

export function resolveRidAuthConfig(overrides: RidAuthConfig = {}): RidAuthConfig {
  const jwksUrl = (overrides.jwksUrl ?? process.env.MW_RID_JWKS_URL ?? '').trim() || undefined;
  const issuer = (overrides.issuer ?? process.env.MW_RID_ISSUER ?? '').trim() || undefined;
  const audience = (overrides.audience ?? process.env.MW_RID_AUDIENCE ?? '').trim() || undefined;
  return {
    jwksUrl,
    issuer,
    audience,
    keyResolver: overrides.keyResolver,
  };
}

export function extractBearerToken(authorizationHeader: string | string[] | undefined): string | null {
  const headerValue = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;
  if (!headerValue) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match || !match[1]) {
    return null;
  }
  return match[1].trim();
}

export async function verifyRidAccessToken(
  token: string,
  config: RidAuthConfig,
): Promise<VerifiedRidIdentity> {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    throw new Error('Bearer access token must be a non-empty string');
  }

  const keyResolver =
    config.keyResolver ??
    (config.jwksUrl ? resolveRemoteJwks(config.jwksUrl) : undefined);
  if (!keyResolver) {
    throw new Error('mw-rid JWKS verifier is not configured');
  }

  const verification = await jwtVerify(trimmedToken, keyResolver, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: [...ALLOWED_ASYMMETRIC_ALGS],
  });

  const payload: JWTPayload = verification.payload;

  if (payload.token_use === 'id') {
    throw new Error('OIDC ID tokens are rejected; an access token is required');
  }

  if (typeof payload.at_hash === 'string' || typeof payload.c_hash === 'string') {
    throw new Error('OIDC ID tokens containing at_hash or c_hash are rejected');
  }

  if (typeof payload.exp !== 'number') {
    throw new Error('Access token must contain a numeric exp claim');
  }

  if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
    throw new Error('Access token must contain a non-empty sub claim');
  }

  return {
    subject: payload.sub,
    issuer: typeof payload.iss === 'string' ? payload.iss : (config.issuer ?? ''),
    scope: typeof payload.scope === 'string' ? payload.scope : null,
    clientId: typeof payload.client_id === 'string' ? payload.client_id : null,
  };
}

export async function verifyRidBearer(
  request: FastifyRequest,
  reply: FastifyReply,
  configOverrides?: RidAuthConfig,
): Promise<VerifiedRidIdentity | null> {
  const bearerToken = extractBearerToken(request.headers.authorization);
  if (!bearerToken) {
    await reply.status(401).send({
      authenticated: false,
      error: 'Missing or malformed Bearer authorization header',
    });
    return null;
  }

  const resolvedConfig = resolveRidAuthConfig(configOverrides);
  try {
    return await verifyRidAccessToken(bearerToken, resolvedConfig);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Invalid mw-rid access token';
    await reply.status(401).send({
      authenticated: false,
      error: reason,
    });
    return null;
  }
}

export const dockRidAuthRoutes: FastifyPluginAsync<DockRidAuthRoutesOptions> = async (
  app: FastifyInstance,
  options,
) => {
  const resolvedConfig = resolveRidAuthConfig(options.ridAuth);

  app.get('/api/v1/dock/auth/rid-session', async (request, reply) => {
    const rawAuth = request.headers.authorization;
    if (!rawAuth || (Array.isArray(rawAuth) && rawAuth.length === 0)) {
      return reply.status(200).send({ authenticated: false });
    }

    const bearerToken = extractBearerToken(rawAuth);
    if (!bearerToken) {
      return reply.status(401).send({
        authenticated: false,
        error: 'Malformed Authorization header; expected Bearer token',
      });
    }

    try {
      const identity = await verifyRidAccessToken(bearerToken, resolvedConfig);
      return reply.status(200).send({
        authenticated: true,
        subject: identity.subject,
        issuer: identity.issuer,
        scope: identity.scope,
        clientId: identity.clientId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Invalid mw-rid access token';
      return reply.status(401).send({
        authenticated: false,
        error: reason,
      });
    }
  });
};
