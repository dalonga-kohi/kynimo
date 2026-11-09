import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";

/**
 * A stand-in authorization server for tests: one ES256 key, its JWKS, and a signer. Claims set
 * to `undefined` are left out; `iss` and a 10-minute `exp` are filled in unless given.
 */
export async function testIssuer(issuer: string) {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "ES256" };
  const jwks = { keys: [jwk] };
  return {
    jwks,
    keys: createLocalJWKSet(jwks),
    async token(claims: Record<string, unknown>): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      const payload: JWTPayload = { iss: issuer, iat: now, exp: now + 600 };
      for (const [k, v] of Object.entries(claims)) {
        if (v === undefined) delete payload[k];
        else payload[k] = v;
      }
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "ES256", kid: "test" })
        .sign(privateKey);
    },
  };
}
