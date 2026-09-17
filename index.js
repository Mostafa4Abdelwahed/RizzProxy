import express from "express";
import { createServer } from "node:http";
import { publicPath } from "ultraviolet-static";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
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
import { existsSync, createWriteStream, createReadStream } from "node:fs";
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
    const req = httpsRequest({ host: "images.crazygames.com", path: remotePath, method: "GET" }, (res) => {
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

// Proxies game image thumbnails from images.crazygames.com with a local disk cache,
// so each image is only downloaded from CrazyGames once.
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
// Load vendor files last.
// The vendor's uv.config.js won't conflict with our uv.config.js inside the publicPath directory.
app.use("/uv/", express.static(uvPath));
app.use("/epoxy/", express.static(epoxyPath));
app.use("/baremux/", express.static(baremuxPath));

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
