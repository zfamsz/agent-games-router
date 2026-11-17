// Live check: run the router locally against the REAL backends and compare
// its responses with direct calls to each backend (unsigned requests, so both
// sides answer 401 — the point is the router must return EXACTLY what the
// right backend returns).
// Env: GK_URL, VFY_URL must be set. Run: node live-check.mjs
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GK_URL = process.env.GK_URL;
const VFY_URL = process.env.VFY_URL;
if (!GK_URL || !VFY_URL) {
  console.error("Set GK_URL and VFY_URL first.");
  process.exit(2);
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: "/",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, sig: !!res.headers["x-agent-games-signature"], body: Buffer.concat(chunks).toString() })
        );
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

const routerPort = 18082;
const child = spawn("node", ["server.js"], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(routerPort), GK_URL, VFY_URL },
  stdio: ["ignore", "pipe", "pipe"],
});
let routerLog = "";
child.stdout.on("data", (d) => (routerLog += d));
child.stderr.on("data", (d) => (routerLog += d));
await new Promise((r) => setTimeout(r, 800));

const routerBase = `http://127.0.0.1:${routerPort}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

try {
  // 1. Preflight via router vs direct to GK.
  const preflight = {
    type: "agent-games.preflight.v1",
    agent_id: "6ee09e65-73af-498c-98bb-2395709d90fe",
    issued_at: new Date().toISOString(),
    nonce: "live-check-1",
  };
  const viaRouter = await postJson(routerBase, preflight);
  const direct = await postJson(GK_URL, preflight);
  check(
    "preflight: router == direct GK",
    viaRouter.status === direct.status && viaRouter.body === direct.body && viaRouter.sig === direct.sig,
    `router ${viaRouter.status} sig=${viaRouter.sig} | direct ${direct.status} sig=${direct.sig}`
  );

  // 2. VFY turn via router vs direct to VFY.
  const turn = {
    protocolVersion: "v1",
    eventId: "steal-the-vfy",
    matchId: "live-check-match",
    turn: 1,
    mode: "practice",
    state: { selfBalance: "1000", opponentBalance: "1000" },
    deadlineAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    strategyCommitment: { hash: "0x2cd68b26e2c7397b9fd3e614a7350b034eb82594203b5b1010ce28c7c563ca1c" },
  };
  const viaRouter2 = await postJson(routerBase, turn);
  const direct2 = await postJson(VFY_URL, turn);
  check(
    "vfy turn: router == direct VFY",
    viaRouter2.status === direct2.status && viaRouter2.body === direct2.body && viaRouter2.sig === direct2.sig,
    `router ${viaRouter2.status} sig=${viaRouter2.sig} | direct ${direct2.status} sig=${direct2.sig}`
  );

  // 3. Ordering note: an UNSIGNED VFY turn sent directly to GK answers 401,
  //    not 400 — GK checks the HMAC before the envelope. The 400 seen in the
  //    platform's practice diagnostic happens only after a VALID signature
  //    passes HMAC and the envelope check rejects the missing `type`.
  const wrongWay = await postJson(GK_URL, turn);
  check("sanity: unsigned vfy turn direct to GK is 401 (HMAC first)", wrongWay.status === 401, `got ${wrongWay.status}`);
} finally {
  child.kill();
}

if (results.some((ok) => !ok)) {
  console.log("\n--- router log ---\n" + routerLog);
  process.exit(1);
}
console.log("\nLive check passed: router relays exactly what the right backend returns.");
process.exit(0);
