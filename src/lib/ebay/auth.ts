import { env } from "@/lib/env";
import { tokenCache } from "@/lib/cache";

type TokenResponse = {
  access_token: string;
  expires_in: number; // seconds
  token_type: string;
  scope?: string;
};

function getTokenEndpoint() {
  return env.EBAY_ENV === "sandbox"
    ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    : "https://api.ebay.com/identity/v1/oauth2/token";
}

const BROWSE_SCOPE = "https://api.ebay.com/oauth/api_scope/buy.browse";
const BASE_SCOPE = "https://api.ebay.com/oauth/api_scope";

export async function getAppAccessToken(): Promise<string> {
  const cacheKey = `appToken:${env.EBAY_ENV}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error("EBAY_CLIENT_ID/EBAY_CLIENT_SECRET が設定されていません");
  }

  const endpoint = getTokenEndpoint();
  const basic = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString(
    "base64"
  );
  async function request(scope: string): Promise<TokenResponse> {
    const maxRetries = 3;
    let lastErr: unknown = null;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const body = new URLSearchParams({ grant_type: "client_credentials", scope }).toString();
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!res.ok) {
          const text = await res.text();
          console.error(JSON.stringify({ level: "error", msg: "ebay token error", status: res.status, text }));
          // try fallback on invalid_scope
          try {
            const j = JSON.parse(text);
            if (j?.error === "invalid_scope" && scope !== BASE_SCOPE) {
              return await request(BASE_SCOPE);
            }
          } catch {}
          throw new Error(`Failed to get eBay token: ${res.status}`);
        }
        return (await res.json()) as TokenResponse;
      } catch (e) {
        lastErr = e;
        // network系であればリトライ
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        continue;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  const data = await request(BROWSE_SCOPE);
  const expiresAt = Date.now() + data.expires_in * 1000;
  tokenCache.set(cacheKey, { accessToken: data.access_token, expiresAt }, data.expires_in * 1000);
  return data.access_token;
}


