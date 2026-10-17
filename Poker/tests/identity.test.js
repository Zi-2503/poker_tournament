import test from "node:test";
import assert from "node:assert/strict";

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    snapshot: () => Object.fromEntries(map)
  };
}

function stubGlobals({ session, local, listeners = [] }) {
  globalThis.sessionStorage = session;
  globalThis.localStorage = local;
  globalThis.addEventListener = (type, callback) => listeners.push({ type, callback });
  return listeners;
}

// 每个场景都用新的模块实例，避免相互污染
const loadModule = (tag) => import(`../js/identity.js?case=${tag}`);

test("同一个浏览器的两个标签页拿到不同身份", async () => {
  const sharedLocal = makeStorage();
  const listeners = [];
  stubGlobals({ session: makeStorage(), local: sharedLocal, listeners });
  const mod = await loadModule("two-tabs");

  const first = await mod.loadIdentity();
  // 第二个标签页：独立的 sessionStorage，但共享同一个 localStorage
  globalThis.sessionStorage = makeStorage();
  const second = await mod.loadIdentity();

  assert.notEqual(first.playerId, second.playerId);
  assert.notEqual(first.publicKeyB64, second.publicKeyB64);
});

test("同一标签页刷新后复用原身份", async () => {
  const local = makeStorage();
  const session = makeStorage();
  const listeners = [];
  stubGlobals({ session, local, listeners });
  const mod = await loadModule("reload");

  const first = await mod.loadIdentity();
  // 刷新会先触发 pagehide，旧心跳被清除
  listeners.filter((item) => item.type === "pagehide").forEach((item) => item.callback());
  globalThis.sessionStorage = makeStorage(session.snapshot());
  const second = await mod.loadIdentity();

  assert.equal(first.playerId, second.playerId);
  assert.equal(first.publicKeyB64, second.publicKeyB64);
});

test("复制标签页会分配新身份，避免与房主撞号", async () => {
  const local = makeStorage();
  const session = makeStorage();
  stubGlobals({ session, local, listeners: [] });
  const mod = await loadModule("duplicate");

  const original = await mod.loadIdentity();
  // 复制标签页：sessionStorage 被一起复制，而原标签页心跳仍然新鲜
  globalThis.sessionStorage = makeStorage(session.snapshot());
  const duplicate = await mod.loadIdentity();

  assert.notEqual(original.playerId, duplicate.playerId);
});

test("标签页心跳会在 localStorage 中定期更新", async () => {
  const local = makeStorage();
  const session = makeStorage();
  stubGlobals({ session, local, listeners: [] });
  const mod = await loadModule("heartbeat");

  const tabId = mod.claimTabId();
  assert.equal(mod.isTabAlive(tabId), true);
  assert.ok(Number(local.getItem(`riverguard:tab:${tabId}`)) > 0);
});
