import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  resolveRidAuthConfig,
  verifyRidAccessToken,
  type RidAuthConfig,
} from '../src/rid-auth.js';

const TEST_ISSUER = 'https://id.a-l-l-a-h.com';
const TEST_AUDIENCE = 'urn:moonwitness:api';

interface KeyFixture {
  readonly privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  readonly publicJwk: Awaited<ReturnType<typeof exportJWK>>;
}

async function createRsaKeyFixture(alg: string = 'RS256'): Promise<KeyFixture> {
  const { publicKey, privateKey } = await generateKeyPair(alg);
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = `dock-negative-contract-key-${alg.toLowerCase()}`;
  publicJwk.alg = alg;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function signRsaToken(
  privateKey: KeyFixture['privateKey'],
  options: {
    readonly alg?: string;
    readonly issuer?: string;
    readonly audience?: string;
  } = {}
): Promise<string> {
  return new SignJWT({ scope: 'api:read' })
    .setProtectedHeader({
      alg: options.alg ?? 'RS256',
      typ: 'at+jwt',
      kid: `dock-negative-contract-key-${(options.alg ?? 'RS256').toLowerCase()}`,
    })
    .setSubject('usr-negative-contract')
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? TEST_AUDIENCE)
    .setExpirationTime('15m')
    .sign(privateKey, { alg: (options.alg ?? 'RS256') as 'RS256' });
}

function encodeUnsignedNoneToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

function localJwksConfig(jwksUrl: string, keys: Array<{ kid: string; alg: string }> = []): RidAuthConfig {
  return resolveRidAuthConfig({
    jwksUrl,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
  });
}

describe('mw-dock RID JWT negative contract', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });

  function startJwksServer(
    handler: (requestUrl: URL) => { status: number; body: string; headers?: Record<string, string> }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const result = handler(url);
        response.writeHead(result.status, {
          'Content-Type': 'application/json',
          ...result.headers,
        });
        response.end(result.body);
      });
      servers.push(server);
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('JWKS test server failed to bind'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}/jwks`);
      });
    });
  }

  it('allows RS256, RS384, RS512 and rejects HS256, and alg:none', async () => {
    const rs256Fixture = await createRsaKeyFixture('RS256');
    const rs384Fixture = await createRsaKeyFixture('RS384');
    const rs512Fixture = await createRsaKeyFixture('RS512');

    const jwksUrl = await startJwksServer(() => ({
      status: 200,
      body: JSON.stringify({
        keys: [rs256Fixture.publicJwk, rs384Fixture.publicJwk, rs512Fixture.publicJwk],
      }),
    }));
    const config = localJwksConfig(jwksUrl);

    // RS256, RS384, RS512 are all currently allowed by ALLOWED_ASYMMETRIC_ALGS
    for (const [alg, fixture] of [
      ['RS256', rs256Fixture],
      ['RS384', rs384Fixture],
      ['RS512', rs512Fixture],
    ] as const) {
      const token = await signRsaToken(fixture.privateKey, { alg });
      await expect(verifyRidAccessToken(token, config), `algorithm ${alg}`).resolves.toMatchObject({
        subject: 'usr-negative-contract',
      });
    }

    const hsToken = await new SignJWT({ scope: 'api:read' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setSubject('usr-negative-contract')
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('forged-hmac-secret'));
    await expect(verifyRidAccessToken(hsToken, config)).rejects.toThrow(
      /"alg" \(Algorithm\) Header Parameter value not allowed|algorithm not allowed|unsupported|key/i
    );

    const noneToken = encodeUnsignedNoneToken({
      scope: 'api:read',
      sub: 'usr-negative-contract',
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    await expect(verifyRidAccessToken(noneToken, config)).rejects.toThrow(
      /"alg" \(Algorithm\) Header Parameter value not allowed|algorithm not allowed|unsupported|signature/i
    );
  });

  it('rejects JWKS responses that exceed the 64 KiB body cap', async () => {
    const fixture = await createRsaKeyFixture();
    const oversizedPadding = 'A'.repeat(70 * 1024);
    let requestCount = 0;
    const jwksUrl = await startJwksServer(() => {
      requestCount += 1;
      return {
        status: 200,
        headers: { 'Content-Length': String(oversizedPadding.length + 2) },
        body: `"${oversizedPadding}"`,
      };
    });
    const config = localJwksConfig(jwksUrl);
    const token = await signRsaToken(fixture.privateKey);

    await expect(verifyRidAccessToken(token, config)).rejects.toThrow(/JSON Web Key Set malformed|too large|body|payload/i);
    expect(requestCount).toBe(1);
  });

  it('rejects JWKS responses that exceed the 5 second fetch timeout', async () => {
    const fixture = await createRsaKeyFixture();
    const jwksUrl = await startJwksServer(() => ({
      status: 200,
      body: JSON.stringify({ keys: [fixture.publicJwk] }),
    }));
    const config = localJwksConfig(jwksUrl);
    const token = await signRsaToken(fixture.privateKey);

    const originalFetch = globalThis.fetch;
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = async (input, init) => {
      observedSignal = init?.signal ?? undefined;
      throw new DOMException('The operation was aborted', 'TimeoutError');
    };

    try {
      await expect(verifyRidAccessToken(token, config)).rejects.toThrow(/request timed out|timeout|abort/i);
      expect(observedSignal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects tokens with the wrong issuer', async () => {
    const fixture = await createRsaKeyFixture();
    const jwksUrl = await startJwksServer(() => ({
      status: 200,
      body: JSON.stringify({ keys: [fixture.publicJwk] }),
    }));
    const config = localJwksConfig(jwksUrl);
    const token = await signRsaToken(fixture.privateKey, {
      issuer: 'https://issuer.example.com',
    });

    await expect(verifyRidAccessToken(token, config)).rejects.toThrow(/unexpected "iss" claim value|issuer/i);
  });

  it('rejects tokens with the wrong audience', async () => {
    const fixture = await createRsaKeyFixture();
    const jwksUrl = await startJwksServer(() => ({
      status: 200,
      body: JSON.stringify({ keys: [fixture.publicJwk] }),
    }));
    const config = localJwksConfig(jwksUrl);
    const token = await signRsaToken(fixture.privateKey, {
      audience: 'urn:moonwitness:other-api',
    });

    await expect(verifyRidAccessToken(token, config)).rejects.toThrow(/unexpected "aud" claim value|audience/i);
  });
});
