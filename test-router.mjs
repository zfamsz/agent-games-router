// Local test for agent-games-router: stub backends + routing + header passthrough.
// Run: node test-router.mjs   (no network, no secrets)
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stub(name, replyStatus, replyBody, sigHeader) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const headers = { "content-type": "application/json" };
        if (sigHeader) headers["x-agent-games-signature"] = sigHeader;
        res.writeHead(replyStatus, headers);
        res.end(JSON.stringify({ ...replyBody, seenBody: JSON.parse(body || "{}") }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

function post(port, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-test-sig": "deadbeef", ...extraHeaders },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject);
  });
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const gk = await stub("gatekeeper", 200, { backend: "gatekeeper" }, "gk-sig-123");
const vfy = await stub("vfy", 200, { backend: "vfy" }, "vfy-sig-456");

const routerPort = 18081;
const child = spawn("node", ["server.js"], {
  cwd: __dirname,
  env: {
    ...process.env,
    PORT: String(routerPort),
    GK_URL: `http://127.0.0.1:${gk.port}`,
    VFY_URL: `http://127.0.0.1:${vfy.port}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let routerLog = "";
child.stdout.on("data", (d) => (routerLog += d));
child.stderr.on("data", (d) => (routerLog += d));
await new Promise((r) => setTimeout(r, 700));

try {
  const health = await get(routerPort, "/health");
  check("GET /health -> 200 ok", health.status === 200 && JSON.parse(health.body).ok === true);

  const preflight = await post(routerPort, {
    type: "agent-games.preflight.v1",
    agent_id: "6ee09e65-73af-498c-98bb-2395709d90fe",
    issued_at: new Date().toISOString(),
    nonce: "test-nonce",
  });
  const pf = JSON.parse(preflight.body);
  check("preflight routes to gatekeeper", pf.backend === "gatekeeper", `got ${pf.backend}`);
  check(
    "preflight preserves body + signature header",
    pf.seenBody.nonce === "test-nonce" && preflight.headers["x-agent-games-signature"] === "gk-sig-123"
  );

  const task = await post(routerPort, {
    type: "agent-games.task.v1",
    task_id: "task-1",
    amount: "100",
  });
  check("gatekeeper task routes to gatekeeper", JSON.parse(task.body).backend === "gatekeeper");

  const turn = await post(routerPort, {
    protocolVersion: "v1",
    eventId: "steal-the-vfy",
    matchId: "match-1",
    turn: 1,
    mode: "practice",
    state: { selfBalance: "1000", opponentBalance: "1000" },
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    strategyCommitment: { hash: "0xabc" },
  });
  const tv = JSON.parse(turn.body);
  check("vfy turn routes to vfy", tv.backend === "vfy", `got ${tv.backend}`);
  check("vfy response signature header relayed", turn.headers["x-agent-games-signature"] === "vfy-sig-456");

  const garbage = await post(routerPort, { notJson: true }, { "content-type": "text/plain" });
  check("unknown body defaults to gatekeeper", JSON.parse(garbage.body).backend === "gatekeeper");
} finally {
  child.kill();
  gk.srv.close();
  vfy.srv.close();
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log("\n--- router log ---\n" + routerLog);
  console.log(`\n${failed.length} FAILED`);
  process.exit(1);
}
console.log(`\nAll ${results.length} checks passed.`);
process.exit(0);
