import express from "express";
import { createServer } from "node:http";
import { publicPath } from "ultraviolet-static";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { join, normalize, extname, parse, sep } from "node:path";
import { hostname } from "node:os";
import wisp from "wisp-server-node"
import session from "express-session";
import crypto from 'crypto';
import config from "./config.js";
import bodyParser from "body-parser";
import { request as httpsRequest } from "node:https";
import { existsSync, createWriteStream, createReadStream, readFileSync } from "node:fs";
import { mkdir, rename, unlink, open } from "node:fs/promises";

const app = express();

const imageCacheDir = join(process.cwd(), "image-cache");
const downloadsInFlight = new Map();

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".jfif": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".mp4": "video/mp4"
};

function resolveImagePath(req) {
  const remotePath = req.originalUrl.slice(6);
  const rel = normalize(decodeURIComponent(remotePath.split("?")[0])).replace(/^[\\/]+/, "");
  const filePath = join(imageCacheDir, rel);
  if (filePath !== imageCacheDir && !filePath.startsWith(imageCacheDir + sep)) {
    throw new Error("Invalid image path");
  }
  return filePath;
}

async function getContentType(filePath) {
  const byExt = MIME_BY_EXT[extname(filePath).toLowerCase()];
  if (byExt) return byExt;
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(16);
    await handle.read(buf, 0, 16, 0);
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.subarray(0, 6).toString() === "GIF87a" || buf.subarray(0, 6).toString() === "GIF89a") return "image/gif";
    if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return "image/x-icon";
    if (buf.subarray(0, 4).toString().toLowerCase() === "<svg") return "image/svg+xml";
    return "application/octet-stream";
  } finally {
    await handle.close();
  }
}

async function downloadImage(remotePath, filePath) {
  await mkdir(parse(filePath).dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: "img.poki-cdn.com", path: remotePath, method: "GET" }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("upstream returned " + res.statusCode));
        return;
      }
      const out = createWriteStream(tmpPath);
      out.on("error", (err) => {
        unlink(tmpPath).catch(() => {});
        reject(err);
      });
      out.on("finish", () => {
        rename(tmpPath, filePath)
          .then(() => {
            console.log("[image-cache] cached " + filePath);
            resolve();
          })
          .catch((err) => {
            unlink(tmpPath).catch(() => {});
            reject(err);
          });
      });
      res.pipe(out);
    });
    req.setTimeout(20000, () => req.destroy(new Error("timeout")));
    req.on("error", (err) => {
      unlink(tmpPath).catch(() => {});
      reject(err);
    });
    req.end();
  });
}

// Proxies game image thumbnails from img.poki-cdn.com with a local disk cache,
// so each image is only downloaded from Poki once.
app.use("/image/", async (req, res) => {
  let filePath;
  try {
    filePath = resolveImagePath(req);
  } catch {
    res.status(400).send("Bad request");
    return;
  }
  try {
    if (!existsSync(filePath)) {
      let pending = downloadsInFlight.get(filePath);
      if (!pending) {
        pending = downloadImage(req.originalUrl.slice(6), filePath).finally(() => downloadsInFlight.delete(filePath));
        downloadsInFlight.set(filePath, pending);
      }
      await pending;
    }
    res.type(await getContentType(filePath));
    createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error("[image-cache] failed to load " + filePath + ": " + err.message);
    res.status(502).send("Unable to load image");
  }
});

app.use(session({
    cookie: { maxAge: 1000 * 60 * 60 },
    resave: false,
    secret: crypto.randomBytes(32).toString('hex')
}));

var jsonParser = bodyParser.json();

if(config.requireLogin) {
app.use(jsonParser, function(req, res, next) {
  if (req.path == "/login") {
    if(req.body.password == config.password) {
      req.session.loggedin = true;
      res.status(200);
      res.send();
    } else {
      res.status(401);
      res.send();
    }
  } else if (req.session.loggedin) {
    next();
  } else {
    res.sendFile(join(publicPath, "login.html"));
  }
});
}
// Load our publicPath first and prioritize it over UV.
app.use(express.static(publicPath));
// Serve Scramjet's bundle with a small shim appended. Scramjet injects this file into
// every proxied page; the shim rewrites url(...) inside CSS that games inject at runtime
// via style.appendChild(document.createTextNode(css)), which Scramjet does not rewrite.
const POKI_CSS_SHIM = `
;(function () {
    if (typeof document === "undefined" || typeof Node === "undefined") return;
    try { window.__pokiCssShim = 1; } catch (e) {}
    function rw(u) {
        if (!u || /^(data:|blob:|#)/.test(u)) return u;
        try {
            var base = location.href;
            var marker = "/scramjet/";
            var idx = base.indexOf(marker);
            if (idx >= 0) {
                var enc = base.slice(idx + marker.length).split("#")[0];
                try { base = decodeURIComponent(enc); } catch (e) {}
            }
            return marker + encodeURIComponent(new URL(u, base).href);
        } catch (e) {
            return u;
        }
    }
    function rc(t) {
        if (typeof t !== "string" || t.indexOf("url(") < 0) return t;
        return t.replace(/url\\(([^)]*)\\)/g, function (m, x) {
            var q = "";
            x = x.trim();
            var c = x.charAt(0);
            if (c === '"' || c === "'") { q = c; x = x.slice(1, -1); }
            return "url(" + q + rw(x) + q + ")";
        });
    }
    try {
        var ap = Node.prototype.appendChild;
        Node.prototype.appendChild = function (ch) {
            try {
                if (this.tagName === "STYLE" && ch && ch.nodeType === 3) {
                    ch.textContent = rc(ch.textContent);
                }
            } catch (e) {}
            return ap.call(this, ch);
        };
    } catch (e) {}
})();
`;

let scramjetBundle = null;
app.get("/scram/scramjet.all.js", (req, res) => {
    if (scramjetBundle === null) {
        scramjetBundle = readFileSync(join(scramjetPath, "scramjet.all.js"), "utf8") + POKI_CSS_SHIM;
    }
    res.type("application/javascript").send(scramjetBundle);
});

// Load vendor files last.
// Scramjet's static bundle (scramjet.wasm.wasm, scramjet.sync.js, ...).
app.use("/scram/", express.static(scramjetPath));
app.use("/epoxy/", express.static(epoxyPath));
app.use("/baremux/", express.static(baremuxPath));

// Audit results (produced by `node other/audit.mjs`)
const auditDir = join(process.cwd(), "data", "audit");
app.get("/audit", (req, res) => {
  res.sendFile(join(publicPath, "audit.html"));
});
app.get("/audit/report.json", (req, res) => {
  res.sendFile(join(auditDir, "report.json"), (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "No audit report yet. Run: node other/audit.mjs --limit 10" });
    }
  });
});
app.get("/audit/screens/:file", (req, res) => {
  const file = normalize(req.params.file).replace(/^[\\/]+/, "");
  if (!file || file.includes("..")) return res.status(400).end();
  res.sendFile(join(auditDir, "screens", file), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Error for everything else
app.use((req, res) => {
  res.status(404);
  res.sendFile(join(publicPath, "404.html"));
});

const server = createServer();

server.on("request", (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  app(req, res);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url.endsWith("/wisp/"))
    wisp.routeRequest(req, socket, head);
  else
    socket.end();
});

let port = parseInt(process.env.PORT || "");

if (isNaN(port)) port = 8080;

server.on("listening", () => {
  const address = server.address();

  // by default we are listening on 0.0.0.0 (every interface)
  // we just need to list a few
  console.log("Listening on:");
  console.log(`\thttp://localhost:${address.port}`);
  console.log(`\thttp://${hostname()}:${address.port}`);
  console.log(
    `\thttp://${address.family === "IPv6" ? `[${address.address}]` : address.address
    }:${address.port}`
  );
});

// https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("SIGTERM signal received: closing HTTP server");
  server.close();
  process.exit(0);
}

server.listen(port, "0.0.0.0");
