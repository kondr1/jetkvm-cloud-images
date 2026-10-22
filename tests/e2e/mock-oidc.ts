// A minimal OIDC provider standing in for Google in the e2e tests.
// Authorization code flow with PKCE, RS256 id_tokens, userinfo and JWKS; no dependencies.
//
// GET /authorize auto-approves. Tests pick the identity with ?mock_email=..., so the
// login flow needs no UI.

const ISSUER = process.env.ISSUER ?? "http://mock-oidc:9000";
const CLIENT_ID = process.env.CLIENT_ID ?? "e2e-client";
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? "e2e-secret";
const PORT = Number(new URL(ISSUER).port || 9000);
const KID = "e2e";

const keys = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);

const b64url = (data: string | ArrayBuffer | Uint8Array) =>
  Buffer.from(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer)).toString(
    "base64url",
  );

async function signJwt(claims: Record<string, unknown>) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const payload = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(signature)}`;
}

const subFor = (email: string) =>
  new Bun.CryptoHasher("sha256").update(email).digest("hex").slice(0, 21);

type Grant = { email: string; clientId: string; redirectUri: string; challenge: string | null };
const codes = new Map<string, Grant>();
const accessTokens = new Map<string, string>(); // access token -> email

function clientFromRequest(req: Request, form: URLSearchParams) {
  const basic = req.headers.get("authorization")?.match(/^Basic (.+)$/i)?.[1];
  if (basic) {
    const [id, secret] = Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent);
    return { id, secret };
  }
  return { id: form.get("client_id"), secret: form.get("client_secret") };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    switch (url.pathname) {
      case "/healthz":
        return new Response("ok");

      case "/.well-known/openid-configuration":
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          userinfo_endpoint: `${ISSUER}/userinfo`,
          jwks_uri: `${ISSUER}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "email", "profile"],
        });

      case "/jwks":
        return json({ keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] });

      case "/authorize": {
        const p = url.searchParams;
        const redirectUri = p.get("redirect_uri");
        if (p.get("client_id") !== CLIENT_ID || !redirectUri) {
          return json({ error: "invalid_request" }, 400);
        }
        const code = crypto.randomUUID();
        codes.set(code, {
          email: p.get("mock_email") ?? "owner@example.com",
          clientId: CLIENT_ID,
          redirectUri,
          challenge: p.get("code_challenge"),
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        if (p.get("state")) back.searchParams.set("state", p.get("state")!);
        return Response.redirect(back.toString(), 302);
      }

      case "/token": {
        const form = new URLSearchParams(await req.text());
        const client = clientFromRequest(req, form);
        if (client.id !== CLIENT_ID || client.secret !== CLIENT_SECRET) {
          return json({ error: "invalid_client" }, 401);
        }
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!grant || grant.redirectUri !== form.get("redirect_uri")) {
          return json({ error: "invalid_grant" }, 400);
        }
        if (grant.challenge) {
          const verifier = form.get("code_verifier") ?? "";
          const digest = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
          if (digest !== grant.challenge) return json({ error: "invalid_grant", detail: "pkce" }, 400);
        }

        const now = Math.floor(Date.now() / 1000);
        const accessToken = crypto.randomUUID();
        accessTokens.set(accessToken, grant.email);
        const idToken = await signJwt({
          iss: ISSUER,
          sub: subFor(grant.email),
          aud: grant.clientId,
          iat: now,
          exp: now + 3600,
          email: grant.email,
          email_verified: true,
        });
        return json({ access_token: accessToken, id_token: idToken, token_type: "Bearer", expires_in: 3600 });
      }

      case "/userinfo": {
        const token = req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
        const email = accessTokens.get(token);
        if (!email) return json({ error: "invalid_token" }, 401);
        return json({ sub: subFor(email), email, email_verified: true, picture: "https://example.com/p.png" });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`mock OIDC provider at ${ISSUER}`);
