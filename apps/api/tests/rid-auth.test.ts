import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  dockRidAuthRoutes,
  verifyRidAccessToken,
  verifyRidBearer,
  type RidAuthConfig,
} from '../src/rid-auth.js';

const TEST_ISSUER = 'https://id.a-l-l-a-h.com';
const TEST_AUDIENCE = 'urn:moonwitness:api';

async function createDockKeyFixture() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'dock-test-key-1';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const keyResolver = createLocalJWKSet({ keys: [publicJwk] });
  const ridAuth: RidAuthConfig = {
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    keyResolver,
  };

  return { privateKey, ridAuth };
}

describe('mw-dock mw-rid JWKS SSO verification (ADR-001)', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('returns 200 { authenticated: false } on GET /api/v1/dock/auth/rid-session without Authorization header', async () => {
    const { ridAuth } = await createDockKeyFixture();
    app = Fastify();
    await app.register(dockRidAuthRoutes, { ridAuth });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dock/auth/rid-session',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: false });
  });

  it('verifies valid RS256 Bearer token on GET /api/v1/dock/auth/rid-session', async () => {
    const { privateKey, ridAuth } = await createDockKeyFixture();
    const accessToken = await new SignJWT({ scope: 'openid api:read', client_id: 'mw-dock' })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'dock-test-key-1' })
      .setSubject('usr-dock-7')
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime('15m')
      .sign(privateKey);

    app = Fastify();
    await app.register(dockRidAuthRoutes, { ridAuth });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dock/auth/rid-session',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authenticated: true,
      subject: 'usr-dock-7',
      issuer: TEST_ISSUER,
      scope: 'openid api:read',
      clientId: 'mw-dock',
    });
  });

  it('rejects forged HS256 token and OIDC ID token (token_use === "id") with 401', async () => {
    const { privateKey, ridAuth } = await createDockKeyFixture();
    const forgedSecret = new TextEncoder().encode('forged-dock-hmac-secret');
    const hsToken = await new SignJWT({ scope: 'api:write' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setSubject('usr-attacker')
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime('15m')
      .sign(forgedSecret);

    const idToken = await new SignJWT({ token_use: 'id' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'dock-test-key-1' })
      .setSubject('usr-dock-7')
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime('15m')
      .sign(privateKey);

    await expect(verifyRidAccessToken(hsToken, ridAuth)).rejects.toThrow();
    await expect(verifyRidAccessToken(idToken, ridAuth)).rejects.toThrow(/ID tokens are rejected/i);

    app = Fastify();
    await app.register(dockRidAuthRoutes, { ridAuth });

    const hsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/dock/auth/rid-session',
      headers: { Authorization: `Bearer ${hsToken}` },
    });
    expect(hsResponse.statusCode).toBe(401);

    const idResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/dock/auth/rid-session',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    expect(idResponse.statusCode).toBe(401);
  });

  it('supports verifyRidBearer middleware helper for protected routes', async () => {
    const { privateKey, ridAuth } = await createDockKeyFixture();
    const accessToken = await new SignJWT({ scope: 'api:read' })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'dock-test-key-1' })
      .setSubject('usr-protected-1')
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime('15m')
      .sign(privateKey);

    app = Fastify();
    app.get('/api/v1/dock/protected-check', async (request, reply) => {
      const identity = await verifyRidBearer(request, reply, ridAuth);
      if (!identity) {
        return;
      }
      return reply.status(200).send({ ok: true, subject: identity.subject });
    });

    const missingResp = await app.inject({
      method: 'GET',
      url: '/api/v1/dock/protected-check',
    });
    expect(missingResp.statusCode).toBe(401);

    const validResp = await app.inject({
      method: 'GET',
      url: '/api/v1/dock/protected-check',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(validResp.statusCode).toBe(200);
    expect(validResp.json()).toEqual({ ok: true, subject: 'usr-protected-1' });
  });
});
