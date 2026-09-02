import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { NavChannel } = require("../lib/channel.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor 超时");
    await sleep(10);
  }
};

test("NavChannel:SSE 长连接 + 广播 + 断开清理", async (t) => {
  let handler;
  const server = createServer((req, res) => {
    if (handler) handler(req, res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const register = (route) => {
    handler = route.handler;
    return () => { handler = undefined; };
  };

  const ch = new NavChannel("/events", register);
  assert.equal(ch.open, false);

  const url = "http://127.0.0.1:" + port + "/events";
  let buf = "";
  let status = 0;
  let clientRes;

  await new Promise((resolve) => {
    get(url, (res) => {
      clientRes = res;
      status = res.statusCode;
      res.on("data", (c) => {
        buf += c.toString("utf8");
        resolve();
      });
    }).on("error", () => resolve());
  });

  await waitFor(() => buf.includes("retry: 2000"));
  assert.equal(status, 200, "SSE 200");
  assert.equal(ch.open, true, "连接建立后 open=true");
  assert.equal(ch.size, 1);

  // 广播
  ch.broadcast({ type: "navigate", sessionId: "abc" });
  await waitFor(() => buf.includes('"sessionId":"abc"'));
  assert.match(buf, /data: {"type":"navigate","sessionId":"abc"}/, "广播载荷正确");

  // 客户端断开 → 服务端 res close → conns 清理
  clientRes.destroy();
  await waitFor(() => ch.open === false);
  assert.equal(ch.size, 0, "断开后连接数归零");

  // dispose 幂等
  ch.dispose();
  ch.dispose();
  assert.equal(ch.open, false);

  t.after(() => new Promise((r) => server.close(r)));
});
