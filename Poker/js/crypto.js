// 全部基于 WebCrypto：浏览器与 Node 19+ 都直接可用，无需后端或第三方库。

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ROOM_SALT = "riverguard-room-v1|";
const ROOM_ITERATIONS = 150000;

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomHex(byteLength) {
  return toHex(randomBytes(byteLength));
}

export function toHex(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : typeof input === "string"
      ? encoder.encode(input)
      : new Uint8Array(input);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex) {
  const clean = String(hex).replace(/[^0-9a-f]/gi, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hexadecimal length.");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function toB64(input) {
  const bytes = typeof input === "string" ? encoder.encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromB64(value) {
  const binary = atob(String(value));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8(text) {
  return encoder.encode(text);
}

export function fromUtf8(bytes) {
  return decoder.decode(bytes);
}

export async function sha256Hex(input) {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function hmacSha256(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, messageBytes));
}

/** 由 6 位房间码派生频道密钥，用于混淆公共 Broker 上的报文内容。 */
export async function deriveRoomKey(roomCode) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(roomCode), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode(`${ROOM_SALT}${roomCode}`), iterations: ROOM_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function generateEcdhKeyPair() {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
}

export async function exportPublicKey(publicKey) {
  return toB64(await crypto.subtle.exportKey("raw", publicKey));
}

export async function importPublicKey(publicKeyB64) {
  return crypto.subtle.importKey("raw", fromB64(publicKeyB64), { name: "ECDH", namedCurve: "P-256" }, true, []);
}

export async function deriveSharedKey(privateKey, peerPublicKeyB64) {
  const peer = await importPublicKey(peerPublicKeyB64);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: peer },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptJson(key, value) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(value)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJson(key, box) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return JSON.parse(decoder.decode(plain));
}

/** 玩家身份：私钥永不出本机，playerId 只是私钥的散列值。 */
export async function createPlayerIdentity() {
  const secret = randomBytes(32);
  const keyPair = await generateEcdhKeyPair();
  return {
    playerId: (await sha256Hex(secret)).slice(0, 16),
    keyPair,
    publicKey: await exportPublicKey(keyPair.publicKey)
  };
}
