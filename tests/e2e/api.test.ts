// End-to-end tests for the cloud-api image, run against the stack in compose.yaml.
// They go through the real HTTP and WebSocket surface the UI and the device use,
// so the same file checks the Bun image and the upstream node image alike.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { turnAllocate } from "./turn";

const API = process.env.API ?? "http://api:3000";
const MOCK = process.env.MOCK_OIDC ?? "http://mock-oidc:9000";
const TURN_SECRET = process.env.TURN_SECRET ?? "e2e-turn-secret";
const TURN_URLS = (process.env.TURN_URLS ?? "").split(",").filter(Boolean);
const WS_API = API.replace(/^http/, "ws");

const OWNER = "owner@example.com";
const OTHER = "other@example.com"; // allowed, but owns no device
const DENIED = "denied@example.com"; // not in ALLOWED_IDENTITIES
const DEVICE_ID = `e2e-${Date.now()}`;

class Jar {
  cookies = new Map<string, string>();
  store(res: Response) {
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const eq = pair.indexOf("=");
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
  }
  toString() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** Calls the API like the browser behind traefik: HTTPS as far as the app knows, cookies, no auto-redirects. */
async function api(target: string, init: RequestInit = {}, jar?: Jar) {
  const headers = new Headers(init.headers);
  headers.set("X-Forwarded-Proto", "https");
  if (jar) headers.set("Cookie", jar.toString());
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(new URL(target, API), { ...init, headers, redirect: "manual" });
  jar?.store(res);
  return res;
}

/** Runs the whole OIDC login through the mock provider and returns the session plus the final response. */
async function login(email: string, body: Record<string, string> = {}) {
  const jar = new Jar();

  let res = await api("/oidc/google", { method: "POST", body: JSON.stringify(body) }, jar);
  expect(res.status).toBe(302);
  const authorize = new URL(res.headers.get("location")!);
  expect(authorize.origin).toBe(MOCK);
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${API}/oidc/callback`);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("state")).toContain("csrf");

  authorize.searchParams.set("mock_email", email);
  res = await fetch(authorize, { redirect: "manual" });
  expect(res.status).toBe(302);
  const callback = res.headers.get("location")!;

  // /oidc/callback answers with an HTML refresh to /oidc/callback_o, so the SameSite=Strict cookie comes along.
  res = await api(callback, {}, jar);
  expect(res.status).toBe(200);
  const refresh = (await res.text()).match(/URL='([^']+)'/)?.[1];
  expect(refresh).toStartWith("/oidc/callback_o?");

  res = await api(refresh!, {}, jar);
  return { jar, res };
}

type Inbox = { next(timeoutMs?: number): Promise<string> };

function inbox(ws: WebSocket): Inbox {
  const queue: string[] = [];
  const waiters: ((msg: string) => void)[] = [];
  ws.addEventListener("message", event => {
    const msg = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString();
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  return {
    next(timeoutMs = 5000) {
      if (queue.length) return Promise.resolve(queue.shift()!);
      return new Promise((resolve, reject) => {
        const waiter = (msg: string) => {
          clearTimeout(timer);
          resolve(msg);
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error("no WebSocket message within timeout"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

/** Opens a WebSocket and resolves once it is open; rejects if the server refuses the upgrade. */
function connect(url: string, headers: Record<string, string>) {
  return new Promise<{ ws: WebSocket; inbox: Inbox }>((resolve, reject) => {
    // Bun extends the WebSocket constructor with request headers, which device auth needs.
    const ws = new WebSocket(url, { headers } as any);
    const box = inbox(ws);
    ws.addEventListener("open", () => resolve({ ws, inbox: box }), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket refused")), { once: true });
    ws.addEventListener("close", () => reject(new Error("WebSocket closed")), { once: true });
  });
}

const connectDevice = (secretToken: string, id = DEVICE_ID) =>
  connect(`${WS_API}/`, {
    Authorization: `Bearer ${secretToken}`,
    "X-Device-Id": id,
    "X-App-Version": "0.5.1",
  });

const connectClient = (jar: Jar, id = DEVICE_ID) =>
  connect(`${WS_API}/webrtc/signaling/client?id=${id}`, {
    Cookie: jar.toString(),
    "X-Forwarded-Proto": "https",
  });

const closed = (ws: WebSocket) =>
  ws.readyState === WebSocket.CLOSED
    ? Promise.resolve()
    : new Promise<void>(resolve => ws.addEventListener("close", () => resolve(), { once: true }));

beforeAll(async () => {
  // The api starts after migrations; give it a moment to listen.
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${API}/healthz`)).ok) return;
    } catch {}
    await Bun.sleep(1000);
  }
  throw new Error(`${API} did not become healthy`);
});

let owner: Jar;
let secretToken: string;
let device: { ws: WebSocket; inbox: Inbox };

afterAll(() => device?.ws.close());

describe("health and auth", () => {
  test("healthz", async () => {
    const res = await fetch(`${API}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).ready).toBe(true);
  });

  test("protected routes need a session", async () => {
    expect((await api("/me")).status).toBe(401);
    expect((await api("/devices")).status).toBe(401);
    expect((await api("/webrtc/ice_config", { method: "POST" })).status).toBe(401);
  });

  test("a forged session cookie is rejected", async () => {
    const jar = new Jar();
    jar.cookies.set("session", Buffer.from(JSON.stringify({ id_token: "x.y.z" })).toString("base64"));
    jar.cookies.set("session.sig", "forged");
    expect((await api("/me", {}, jar)).status).toBe(401);
  });

  test("login through OIDC creates a session", async () => {
    const { jar, res } = await login(OWNER);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://app.test/devices");

    const me = await api("/me", {}, jar);
    expect(me.status).toBe(200);
    expect((await me.json()).email).toBe(OWNER);
    owner = jar;
  });

  test("ALLOWED_IDENTITIES keeps other accounts out", async () => {
    const { jar, res } = await login(DENIED);
    expect(res.status).toBe(401);
    expect((await api("/me", {}, jar)).status).toBe(401);
  });

  test("logout ends the session", async () => {
    const { jar } = await login(OWNER);
    expect((await api("/me", {}, jar)).status).toBe(200);
    expect((await api("/logout", { method: "POST" }, jar)).status).toBe(200);
    expect((await api("/me", {}, jar)).status).toBe(401);
  });
});

describe("device adoption", () => {
  test("login with a deviceId hands out a temp token", async () => {
    const { res } = await login(OWNER, { deviceId: DEVICE_ID, returnTo: "http://app.test/adopt" });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("http://app.test/adopt");
    expect(back.searchParams.get("deviceId")).toBe(DEVICE_ID);
    expect(back.searchParams.get("clientId")).toBe("e2e-client");
    expect(back.searchParams.get("oidcGoogle")).toBeTruthy();

    const tempToken = back.searchParams.get("tempToken")!;
    const token = await api("/devices/token", { method: "POST", body: JSON.stringify({ tempToken }) });
    expect(token.status).toBe(200);
    secretToken = (await token.json()).secretToken;
    expect(secretToken).toMatch(/^[0-9a-f]{40}$/);

    // A temp token works once.
    const again = await api("/devices/token", { method: "POST", body: JSON.stringify({ tempToken }) });
    expect(again.status).toBe(404);
  });
});

describe("signaling over WebSocket", () => {
  test("a device with a wrong token or id is refused", async () => {
    await expect(connectDevice("0".repeat(40))).rejects.toThrow();
    await expect(connectDevice(secretToken, "someone-else")).rejects.toThrow();
  });

  test("the device connects and shows up online", async () => {
    device = await connectDevice(secretToken);

    const res = await api("/devices", {}, owner);
    expect(res.status).toBe(200);
    const { devices } = await res.json();
    expect(devices).toContainEqual(
      expect.objectContaining({ id: DEVICE_ID, online: true, version: "0.5.1" }),
    );
  });

  test("HTTP session exchange relays the offer and answer", async () => {
    const answered = (async () => {
      const offer = JSON.parse(await device.inbox.next());
      expect(offer.sd).toBe("offer-sd");
      expect(offer.iceServers).toEqual(["stun:coturn:3478"]);
      expect(offer.OidcGoogle).toBeTruthy();
      device.ws.send(JSON.stringify({ sd: "answer-sd" }));
    })();

    const res = await api(
      "/webrtc/session",
      { method: "POST", body: JSON.stringify({ id: DEVICE_ID, sd: "offer-sd" }) },
      owner,
    );
    await answered;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sd: "answer-sd" });
  });

  test("client WebSocket relays both ways", async () => {
    const client = await connectClient(owner);

    const metadata = JSON.parse(await client.inbox.next());
    expect(metadata).toEqual({
      type: "device-metadata",
      data: expect.objectContaining({ deviceVersion: "0.5.1" }),
    });

    client.ws.send("ping");
    expect(await client.inbox.next()).toBe("pong");

    client.ws.send(JSON.stringify({ type: "offer", data: { sd: "client-offer" } }));
    const offer = JSON.parse(await device.inbox.next());
    expect(offer.type).toBe("offer");
    expect(offer.data).toMatchObject({ sd: "client-offer", iceServers: ["stun:coturn:3478"] });

    client.ws.send(JSON.stringify({ type: "new-ice-candidate", data: { candidate: "c1" } }));
    expect(JSON.parse(await device.inbox.next())).toEqual({
      type: "new-ice-candidate",
      data: { candidate: "c1" },
    });

    device.ws.send(JSON.stringify({ type: "answer", data: { sd: "device-answer" } }));
    expect(JSON.parse(await client.inbox.next())).toEqual({ type: "answer", data: { sd: "device-answer" } });

    device.ws.send(JSON.stringify({ type: "new-ice-candidate", data: { candidate: "c2" } }));
    expect(JSON.parse(await client.inbox.next())).toEqual({
      type: "new-ice-candidate",
      data: { candidate: "c2" },
    });

    client.ws.close();
    await closed(client.ws);
  });

  test("an error from the device reaches the browser", async () => {
    const client = await connectClient(owner);
    expect(JSON.parse(await client.inbox.next()).type).toBe("device-metadata");

    client.ws.send(JSON.stringify({ type: "offer", data: { sd: "client-offer" } }));
    expect(JSON.parse(await device.inbox.next()).type).toBe("offer");
    // What the firmware sends when the OIDC identity does not match its owner.
    device.ws.send(JSON.stringify({ error: "google identity mismatch" }));
    expect(JSON.parse(await client.inbox.next())).toEqual({
      type: "error",
      data: "google identity mismatch",
    });

    client.ws.close();
    await closed(client.ws);
  });

  test("a device that never answers is reported, not waited on forever", async () => {
    const client = await connectClient(owner);
    expect(JSON.parse(await client.inbox.next()).type).toBe("device-metadata");

    client.ws.send(JSON.stringify({ type: "offer", data: { sd: "client-offer" } }));
    expect(JSON.parse(await device.inbox.next()).type).toBe("offer");
    // The firmware drops the offer silently when it cannot verify the token.
    const msg = JSON.parse(await client.inbox.next(17000));
    expect(msg.type).toBe("error");
    expect(msg.data).toContain("no answer");

    client.ws.close();
    await closed(client.ws);
  }, 25000);

  test("another account can neither see nor reach the device", async () => {
    const { jar } = await login(OTHER);
    expect((await api(`/devices/${DEVICE_ID}`, {}, jar)).status).toBe(404);
    await expect(connectClient(jar)).rejects.toThrow();
  });

  test("a reconnecting device replaces its old connection", async () => {
    const old = device;
    device = await connectDevice(secretToken);
    await closed(old.ws);

    const client = await connectClient(owner);
    expect(JSON.parse(await client.inbox.next()).type).toBe("device-metadata");
    client.ws.close();
    await closed(client.ws);
  });
});

describe("ICE config from coturn", () => {
  test("ice_config hands out short-lived TURN credentials", async () => {
    const res = await api("/webrtc/ice_config", { method: "POST" }, owner);
    expect(res.status).toBe(200);
    const { iceServers } = await res.json();
    expect(iceServers.urls).toEqual(TURN_URLS);

    const [expiry] = iceServers.username.split(":").map(Number);
    const now = Math.floor(Date.now() / 1000);
    expect(expiry).toBeGreaterThan(now + 3500);
    expect(expiry).toBeLessThan(now + 3700);
    expect(iceServers.credential).toBe(
      createHmac("sha1", TURN_SECRET).update(iceServers.username).digest("base64"),
    );

    expect(await turnAllocate(TURN_URLS[0], iceServers.username, iceServers.credential)).toBe(
      "allocated",
    );
  });

  test("coturn refuses wrong and expired credentials", async () => {
    const res = await api("/webrtc/ice_config", { method: "POST" }, owner);
    const { iceServers } = await res.json();
    expect(await turnAllocate(TURN_URLS[0], iceServers.username, "wrong")).toBe(401);

    const expired = `${Math.floor(Date.now() / 1000) - 60}:1`;
    const credential = createHmac("sha1", TURN_SECRET).update(expired).digest("base64");
    expect(await turnAllocate(TURN_URLS[0], expired, credential)).toBe(401);
  });
});

describe("deregistration", () => {
  test("the device can delete itself with its secret token", async () => {
    const res = await api(`/devices/${DEVICE_ID}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${secretToken}` },
    });
    expect(res.status).toBe(204);

    // Unlike a delete from the UI, the token path leaves the socket open; it just cannot come back.
    device.ws.close();
    await closed(device.ws);
    await expect(connectDevice(secretToken)).rejects.toThrow();

    const { devices } = await (await api("/devices", {}, owner)).json();
    expect(devices.map((d: { id: string }) => d.id)).not.toContain(DEVICE_ID);
  });

  test("closing the socket of a deleted device does not crash the api", async () => {
    // Upstream updated lastSeen with find-then-update in the close handler; losing the race
    // to the delete threw P2025 as an unhandled rejection and node exited.
    await Bun.sleep(1000);
    expect((await fetch(`${API}/healthz`)).status).toBe(200);
  });
});
