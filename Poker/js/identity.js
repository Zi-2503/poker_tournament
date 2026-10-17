// 玩家身份管理：每个标签页一份独立身份，刷新后保持不变，复制标签页自动换新。
//
// 只用 localStorage 存身份会让同一浏览器的两个窗口共用同一个 playerId，
// 于是双方都会把对方的消息当成“自己发的”而忽略，表现为加入房间超时。

import { exportPublicKey, generateEcdhKeyPair, randomHex } from "./crypto.js";

const TAB_ID_KEY = "riverguard:tabId";
const HEARTBEAT_PREFIX = "riverguard:tab:";
const IDENTITY_PREFIX = "riverguard:identity:";
const HEARTBEAT_INTERVAL_MS = 2000;
const STALE_MS = 6000;

const storage = (name) => {
  try {
    return globalThis[name] || null;
  } catch {
    return null;
  }
};

function read(store, key) {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

function write(store, key, value) {
  try {
    store?.setItem(key, value);
  } catch { /* 隐私模式下可能失败 */ }
}

function drop(store, key) {
  try {
    store?.removeItem(key);
  } catch { /* 忽略 */ }
}

/** 该标签页的存活心跳是否还很新；复制出来的标签页会立刻看到旧页面的心跳。 */
export function isTabAlive(tabId, now = Date.now()) {
  const stamp = Number(read(storage("localStorage"), HEARTBEAT_PREFIX + tabId) || 0);
  return stamp > 0 && now - stamp < STALE_MS;
}

export function startHeartbeat(tabId) {
  const local = storage("localStorage");
  const beat = () => write(local, HEARTBEAT_PREFIX + tabId, String(Date.now()));
  beat();
  if (typeof setInterval === "function") {
    const handle = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    handle?.unref?.(); // Node 环境下不阻塞测试进程
  }
  if (typeof addEventListener === "function") {
    addEventListener("pagehide", () => drop(local, HEARTBEAT_PREFIX + tabId));
  }
}

/**
 * 取得本标签页的 id：
 * - 刷新：sessionStorage 里已有 id，且旧心跳已过期，继续沿用同一个 id。
 * - 复制标签页：sessionStorage 被一起复制，但原标签页心跳仍然新鲜，于是分配新 id。
 */
export function claimTabId() {
  const session = storage("sessionStorage");
  const existing = read(session, TAB_ID_KEY);
  if (existing && !isTabAlive(existing)) {
    startHeartbeat(existing);
    return existing;
  }
  const tabId = randomHex(6);
  write(session, TAB_ID_KEY, tabId);
  startHeartbeat(tabId);
  return tabId;
}

async function restoreIdentity(saved) {
  const privateKey = await crypto.subtle.importKey(
    "jwk", saved.privateJwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk", saved.publicJwk, { name: "ECDH", namedCurve: "P-256" }, true, []
  );
  return {
    playerId: saved.playerId,
    privateKey,
    publicKey,
    publicKeyB64: saved.publicKeyB64,
    tabId: saved.tabId
  };
}

async function createIdentity(tabId) {
  const keyPair = await generateEcdhKeyPair();
  const identity = {
    tabId,
    playerId: randomHex(8),
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyB64: await exportPublicKey(keyPair.publicKey)
  };
  write(storage("sessionStorage"), IDENTITY_PREFIX + tabId, JSON.stringify({
    tabId,
    playerId: identity.playerId,
    privateJwk: await crypto.subtle.exportKey("jwk", keyPair.privateKey),
    publicJwk: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
    publicKeyB64: identity.publicKeyB64
  }));
  return identity;
}

export async function loadIdentity() {
  const tabId = claimTabId();
  const session = storage("sessionStorage");
  const raw = read(session, IDENTITY_PREFIX + tabId);
  if (raw) {
    try {
      return await restoreIdentity(JSON.parse(raw));
    } catch {
      drop(session, IDENTITY_PREFIX + tabId);
    }
  }
  return createIdentity(tabId);
}
