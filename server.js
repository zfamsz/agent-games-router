// agent-games-router — single public endpoint for the "zfamsz" Agent Games agent.
//
// The dashboard allows exactly ONE endpoint per agent, but the agent is
// entered in TWO event tracks (Proof Gatekeeper + Steal the VFY), each
// served by its own backend service. This router receives every request
// from the platform and forwards it, byte-identical, to the right backend:
//
//   - body has eventId === "steal-the-vfy"  -> VFY service
//   - anything else (preflight, Gatekeeper tasks) -> Gatekeeper service
//
// It never inspects, verifies, or re-signs anything: the raw request body
// and all headers (including the platform's HMAC signature) are forwarded
// unchanged, and the backend's status, headers (including its response
// signature) and body are relayed unchanged. The backends do all auth.
//
// Env:
//   PORT                listen port (Railway sets this; default 3000)
//   GK_URL              Gatekeeper backend base URL (no trailing slash)
//   VFY_URL             Steal-the-VFY backend base URL (no trailing slash)
//   UPSTREAM_TIMEOUT_MS per-request upstream timeout (default 60000)
//
// No dependencies. Node >= 18.
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const GK_URL = (process.env.GK_URL || "").replace(/\/+$/, "");
const VFY_URL = (process.env.VFY_URL || "").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);
const MAX_BODY_BYTES = 1024 * 1024;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Decide the backend from the request body. VFY turns carry eventId. */
function routeTarget(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (parsed && parsed.eventId === "steal-the-vfy") {
      return { name: "vfy", base: VFY_URL };
    }
  } catch {
    // Unparseable body: let the Gatekeeper backend answer (it 400s/401s).
  }
  return { name: "gatekeeper", base: GK_URL };
}

function forward(target, inHeaders, reqBody, clientRes) {
  const started = Date.now();
  const u = new URL(target.base + "/");
  const lib = u.protocol === "https:" ? https : http;
  const headers = {};
  for (const [k, v] of Object.entries(inHeaders)) headers[k] = v;
  headers["content-length"] = String(Buffer.byteLength(reqBody));
  delete headers.host;

  const up = lib.request(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: "/",
      method: "POST",
      headers,
      timeout: TIMEOUT_MS,
    },
    (upRes) => {
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        const out = Buffer.concat(chunks);
        const outHeaders = { ...upRes.headers };
        delete outHeaders["transfer-encoding"];
        clientRes.writeHead(upRes.statusCode, outHeaders);
        clientRes.end(out);
        log(`route=${target.name} status=${upRes.statusCode} ms=${Date.now() - started}`);
      });
    }
  );
  up.on("timeout", () => up.destroy(new Error("upstream timeout")));
  up.on("error", (err) => {
    log(`route=${target.name} UPSTREAM ERROR: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" });
    }
    try {
      clientRes.end(JSON.stringify({ error: "upstream error" }));
    } catch {
      /* already ended */
    }
  });
  up.end(reqBody);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "agent-games-router" }));
    return;
  }
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "agent-games-router" }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      tooBig = true;
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (tooBig) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "body too large" }));
      return;
    }
    const body = Buffer.concat(chunks);
    const target = routeTarget(body);
    if (!target.base) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no upstream configured for ${target.name}` }));
      return;
    }
    forward(target, req.headers, body, res);
  });
  req.on("error", () => {
    if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
    try {
      res.end(JSON.stringify({ error: "bad request" }));
    } catch {
      /* already ended */
    }
  });
});

server.listen(PORT, () => {
  log(`agent-games-router listening on :${PORT}`);
  log(`gatekeeper -> ${GK_URL || "(unset)"}`);
  log(`vfy        -> ${VFY_URL || "(unset)"}`);
});
