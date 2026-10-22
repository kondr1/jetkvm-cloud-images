// Just enough of STUN/TURN (RFC 8489, RFC 8656) to ask coturn for a relay allocation
// with long-term credentials, which proves it accepts what /webrtc/ice_config hands out.

import { createHash, createHmac, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { lookup } from "node:dns/promises";

const MAGIC_COOKIE = 0x2112a442;
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_SUCCESS = 0x0103;
const ALLOCATE_ERROR = 0x0113;

const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  REALM: 0x0014,
  NONCE: 0x0015,
  REQUESTED_TRANSPORT: 0x0019,
};

type Attr = [type: number, value: Buffer];

function encodeAttrs(attrs: Attr[]) {
  return Buffer.concat(
    attrs.map(([type, value]) => {
      const head = Buffer.alloc(4);
      head.writeUInt16BE(type, 0);
      head.writeUInt16BE(value.length, 2);
      const pad = Buffer.alloc((4 - (value.length % 4)) % 4);
      return Buffer.concat([head, value, pad]);
    }),
  );
}

function header(type: number, length: number, txId: Buffer) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(length, 2);
  h.writeUInt32BE(MAGIC_COOKIE, 4);
  txId.copy(h, 8);
  return h;
}

function allocateRequest(attrs: Attr[], integrityKey?: Buffer) {
  const txId = randomBytes(12);
  const body = encodeAttrs([[ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])], ...attrs]);
  if (!integrityKey) return Buffer.concat([header(ALLOCATE_REQUEST, body.length, txId), body]);

  // The HMAC covers the message with its length already counting MESSAGE-INTEGRITY (4 + 20 bytes).
  const signed = Buffer.concat([header(ALLOCATE_REQUEST, body.length + 24, txId), body]);
  const mac = createHmac("sha1", integrityKey).update(signed).digest();
  return Buffer.concat([signed, encodeAttrs([[ATTR.MESSAGE_INTEGRITY, mac]])]);
}

function parse(msg: Buffer) {
  const type = msg.readUInt16BE(0);
  const attrs = new Map<number, Buffer>();
  for (let off = 20; off + 4 <= msg.length; ) {
    const t = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    attrs.set(t, msg.subarray(off + 4, off + 4 + len));
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  const err = attrs.get(ATTR.ERROR_CODE);
  const errorCode = err ? err[2] * 100 + err[3] : undefined;
  return { type, attrs, errorCode };
}

async function exchange(host: string, port: number, request: Buffer) {
  const socket = dgram.createSocket("udp4");
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("TURN server did not answer")), 3000);
      socket.once("message", msg => {
        clearTimeout(timer);
        resolve(msg);
      });
      socket.send(request, port, host);
    });
  } finally {
    socket.close();
  }
}

/** Tries to allocate a UDP relay; resolves to "allocated" or the TURN error code. */
export async function turnAllocate(turnUrl: string, username: string, password: string) {
  const m = turnUrl.match(/^turn:([^:?]+):(\d+)/);
  if (!m) throw new Error(`unsupported TURN url ${turnUrl}`);
  const { address } = await lookup(m[1], 4);
  const port = Number(m[2]);

  // The first, unauthenticated request is rejected with the realm and nonce to sign with.
  const challenge = parse(await exchange(address, port, allocateRequest([])));
  if (challenge.type !== ALLOCATE_ERROR || challenge.errorCode !== 401) {
    throw new Error(`expected a 401 challenge, got type ${challenge.type} code ${challenge.errorCode}`);
  }
  const realm = challenge.attrs.get(ATTR.REALM)!;
  const nonce = challenge.attrs.get(ATTR.NONCE)!;

  const key = createHash("md5").update(`${username}:${realm.toString()}:${password}`).digest();
  const answer = parse(
    await exchange(
      address,
      port,
      allocateRequest(
        [
          [ATTR.USERNAME, Buffer.from(username)],
          [ATTR.REALM, realm],
          [ATTR.NONCE, nonce],
        ],
        key,
      ),
    ),
  );
  if (answer.type === ALLOCATE_SUCCESS) return "allocated" as const;
  return answer.errorCode ?? answer.type;
}
