import test from "node:test";
import assert from "node:assert/strict";

let sequence = 0;
async function fixture(handler, initial = new Map()) {
  const values = new Map(initial);
  values.set("fxweb.auth.v1", JSON.stringify({ username: "alice", token: "secret-token" }));
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const call = { url, ...options, json: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    return handler(call, values);
  };
  const cloud = await import(`../cloud.mjs?receipt-test=${++sequence}`);
  return { cloud, calls, values };
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});
const protocol = extra => ({ receiptProtocolVersion: 1, serverTime: Date.now(),
  retention: { maxReceipts: 128, bounded: true }, ...extra });
const receiptKey = "fxweb.receipts.v1:alice";

test("persists complete wire body before fetch; partial close and success", async () => {
  const { cloud, values } = await fixture((call, storage) => {
    const [saved] = JSON.parse(storage.get(receiptKey));
    assert.equal(saved.status, "pending");
    assert.equal(saved.id, call.json.requestId);
    assert.deepEqual(saved.body, call.json);
    assert.equal(call.url.endsWith("/api/game/close"), true);
    assert.equal(storage.get(receiptKey).includes("secret-token"), false);
    return json({ result: { closed: 2 } });
  });
  await cloud.game.partialClose(2, 0.5, 13);
  assert.equal(cloud.listReceipts()[0].status, "confirmed");
  assert.deepEqual(cloud.listReceipts()[0].body, { id: 2, fraction: 0.5, since: 13,
    requestId: cloud.listReceipts()[0].id });
  assert.equal(JSON.parse(values.get(receiptKey)).length, 1);
});

test("unknown blocks mutations, permits polling, reload retains original ID/body", async () => {
  const { cloud, values, calls } = await fixture(call => {
    if (call.method === "GET") return json({ account: {} });
    throw new TypeError("offline");
  });
  await assert.rejects(cloud.game.open({ pair: "EUR/USD", margin: 100 }, 5), { status: 0 });
  const [saved] = cloud.listReceipts();
  assert.equal(saved.status, "unknown");
  await assert.rejects(cloud.game.reset(6), e => e.body.error === "receipt_pending");
  await cloud.game.state(6);
  assert.equal(calls.length, 2);
  const reloaded = await fixture(() => json(protocol({ status: "unknown" })), values);
  assert.equal(reloaded.cloud.listReceipts()[0].id, saved.id);
  await assert.rejects(reloaded.cloud.retryReceipt(saved.id), e => e.body.error === "receipt_unknown");
  assert.equal(reloaded.calls[0].method, "GET");
  assert.equal(reloaded.calls[0].url.endsWith("requestId=" + saved.id), true);
  assert.deepEqual(reloaded.cloud.listReceipts()[0].body, saved.body);
  assert.equal(reloaded.cloud.listReceipts()[0].status, "unknown");
});

test("bounded server retry checks same ID and returns confirmed original result, never POSTs", async () => {
  let confirm = false;
  const result = { account: { balance: 123 }, result: { borrowed: 10 } };
  const { cloud, calls } = await fixture(call => {
    if (call.method === "POST") throw new Error("timeout");
    return json(protocol(confirm ? { status: "confirmed", result } : { status: "unknown" }));
  });
  await assert.rejects(cloud.game.borrow(10, 4));
  const [receipt] = cloud.listReceipts();
  await assert.rejects(cloud.retryReceipt(receipt.id));
  confirm = true;
  assert.deepEqual(await cloud.retryReceipt(receipt.id), result);
  assert.equal(cloud.listReceipts()[0].status, "confirmed");
  assert.equal(calls.filter(c => c.method === "POST").length, 1);
  assert.equal(calls[1].url, calls[2].url);
});

test("JSON business failures reject; 5xx, status0, HTML, invalid JSON remain unknown", async () => {
  const responses = [
    [() => json({ error: "insufficient_funds", message: "不足" }, 400), "rejected"],
    [() => json({ error: "internal_error" }, 500), "unknown"],
    [() => { throw new Error("offline"); }, "unknown"],
    [() => new Response("bad gateway", { status: 502 }), "unknown"],
    [() => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }), "unknown"],
    [() => json({ error: "rate_limited" }, 429), "unknown"],
    [() => new Response("bad", { status: 400 }), "unknown"],
  ];
  for (const [response, expected] of responses) {
    const { cloud } = await fixture(response);
    await assert.rejects(cloud.game.repay(10, 1));
    assert.equal(cloud.listReceipts()[0].status, expected);
  }
});

test("account isolation across login and logout; explicit acknowledgement unlocks only account", async () => {
  const { cloud, values } = await fixture(call => {
    if (call.url.endsWith("/api/login")) return json({ token: "bob-secret", user: { username: call.json.username } });
    if (call.url.endsWith("/api/logout")) return json({ ok: true });
    throw new Error("offline");
  });
  await assert.rejects(cloud.game.reset(0));
  const alice = cloud.listReceipts()[0];
  await cloud.login("bob", "password");
  assert.deepEqual(cloud.listReceipts(), []);
  await assert.rejects(cloud.retryReceipt(alice.id), e => e.body.error === "receipt_missing");
  await assert.rejects(cloud.game.borrow(1, 0));
  assert.notEqual(cloud.listReceipts()[0].id, alice.id);
  await cloud.logout();
  assert.deepEqual(cloud.listReceipts(), []);
  await cloud.login("alice", "password");
  assert.equal(cloud.listReceipts()[0].id, alice.id);
  cloud.acknowledgeReceipt(alice.id);
  assert.equal(cloud.listReceipts()[0].status, "acknowledged");
  await assert.rejects(cloud.game.reset(1));
  assert.equal(cloud.listReceipts().length, 2);
  assert.equal(values.get(receiptKey).includes("password"), false);
  assert.equal(values.get(receiptKey).includes("bob-secret"), false);
});

test("storage errors stop send and mutable caller references cannot change persisted wire body", async () => {
  const { cloud, calls } = await fixture(() => json({ ok: true }));
  localStorage.setItem = () => { throw new Error("quota"); };
  await assert.rejects(cloud.game.reset(0), e => e.body.error === "receipt_storage");
  assert.equal(calls.length, 0);
  const setup = await fixture(() => json({ ok: true }));
  const order = { pair: "EUR/USD", nested: { x: 1 } };
  const pending = setup.cloud.game.open(order, 2);
  order.nested.x = 999;
  await pending;
  assert.equal(setup.cloud.listReceipts()[0].body.nested.x, 1);
  await assert.rejects(setup.cloud.game.open({ token: "forbidden" }, 3), e => e.body.error === "receipt_sensitive_body");
  assert.equal(setup.calls.length, 1);
});

test("unsupported protocol and old/evicted unknown receipt cannot authorize resend", async () => {
  const { cloud, calls } = await fixture(call => call.method === "POST"
    ? Promise.reject(new Error("timeout")) : json({ status: "unknown" }));
  await assert.rejects(cloud.game.reset(0));
  const id = cloud.listReceipts()[0].id;
  await assert.rejects(cloud.retryReceipt(id), e => e.body.error === "receipt_protocol");
  assert.equal(cloud.listReceipts()[0].status, "unknown");
  assert.equal(calls.filter(c => c.method === "POST").length, 1);
});


test("in-flight mutation blocks a second operation and cannot be acknowledged", async () => {
  let release;
  const { cloud, calls } = await fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = cloud.game.reset(1);
  const id = cloud.listReceipts()[0].id;
  assert.equal(cloud.listReceipts()[0].status, "pending");
  await assert.rejects(cloud.game.borrow(2, 1), e => e.body.error === "receipt_pending");
  assert.throws(() => cloud.acknowledgeReceipt(id), e => e.body.error === "receipt_pending");
  assert.equal(calls.length, 1);
  release(json({ account: {} }));
  await pending;
  assert.equal(cloud.listReceipts()[0].status, "confirmed");
});

test("retains at most 128 terminal records and never silently drops old unknowns", async () => {
  const { cloud, values, calls } = await fixture(() => json({ account: {} }));
  for (let i = 0; i < 130; i++) await cloud.game.reset(i);
  assert.equal(cloud.listReceipts().length, 128);
  const original = cloud.listReceipts()[0];
  const stale = { ...original, status: "pending", createdAt: 1, updatedAt: 1 };
  values.set(receiptKey, JSON.stringify([stale]));
  assert.equal(cloud.listReceipts()[0].status, "unknown");
  await assert.rejects(cloud.game.reset(999), e => e.body.error === "receipt_pending");
  assert.equal(calls.length, 130);
  globalThis.fetch = async () => json(protocol({ status: "unknown" }));
  await assert.rejects(cloud.retryReceipt(stale.id), e => e.body.error === "receipt_unknown");
  assert.equal(cloud.listReceipts()[0].id, original.id);
  assert.deepEqual(cloud.listReceipts()[0].body, original.body);
});


test("UI-safe receiptState fails closed for corrupted or unavailable storage", async () => {
  const { cloud, values, calls } = await fixture(() => json({ ok: true }));
  values.set(receiptKey, "broken JSON");
  assert.throws(() => cloud.listReceipts());
  assert.equal(cloud.receiptState().blocked, true);
  assert.equal(cloud.receiptState().error.code, "receipt_storage");
  await assert.rejects(cloud.game.reset(0), e => e.body.error === "receipt_storage");
  assert.equal(calls.length, 0);
});

test("Web Locks serialize two tab modules per account without queueing duplicate actions", async () => {
  const held = new Set();
  const requests = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    async request(name, options, callback) {
      requests.push({ name, options });
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); }
      finally { held.delete(name); }
    },
  } } });
  try {
    let release;
    const { cloud: first, calls } = await fixture(() => new Promise(resolve => { release = resolve; }));
    const second = await import(`../cloud.mjs?receipt-test=${++sequence}`);
    const operation = first.game.borrow(10, 0);
    await assert.rejects(second.game.borrow(10, 0), e => e.body.error === "receipt_pending");
    assert.equal(calls.length, 1);
    assert.equal(requests[0].name, "fxweb.game.mutate:alice");
    assert.equal(requests[1].options.ifAvailable, true);
    release(json({ account: {} }));
    await operation;
    assert.equal(second.listReceipts()[0].status, "confirmed");
    assert.equal(held.size, 0);
    const next = second.game.repay(1, 1);
    release(json({ account: {} }));
    await next;
    assert.equal(calls.length, 2);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
