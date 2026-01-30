import "dotenv/config";
import express from "express";
import { RingApi } from "ring-client-api";
import { spawn } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

const app = express();

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Optional Basic Auth for /ring/* endpoints (recommended when exposing publicly)
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS;

// Persist rotated Ring refresh tokens so the service can run long-term without re-auth.
// ring-client-api will emit updated refresh tokens (often ~hourly). We store the latest
// token to disk and reuse it on restart.
const RING_STATE_PATH = process.env.RING_STATE_PATH || "/data/ring-state.json";

async function readPersistedRefreshToken() {
    try {
        const raw = await fsp.readFile(RING_STATE_PATH, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed?.refreshToken && String(parsed.refreshToken).trim()) {
            return String(parsed.refreshToken).trim();
        }
    } catch {
        // ignore (file missing or invalid)
    }
    return null;
}

async function persistRefreshToken(newRefreshToken) {
    try {
        await fsp.mkdir(path.dirname(RING_STATE_PATH), { recursive: true });
        await fsp.writeFile(
            RING_STATE_PATH,
            JSON.stringify({ refreshToken: newRefreshToken, updatedAt: new Date().toISOString() }, null, 2) + "\n",
            "utf8"
        );
    } catch (e) {
        console.error("Failed to persist refresh token:", e?.message || e);
    }
}

function unauthorized(res) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Ring Snapshot Proxy"');
    res.status(401).send("Unauthorized");
}

function basicAuthMiddleware(req, res, next) {
    // If creds are not set, do not enforce auth
    if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) return next();

    const header = req.headers.authorization || "";
    if (!header.startsWith("Basic ")) return unauthorized(res);

    let decoded = "";
    try {
        decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    } catch {
        return unauthorized(res);
    }

    const idx = decoded.indexOf(":");
    if (idx < 0) return unauthorized(res);

    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);

    if (user !== BASIC_AUTH_USER || pass !== BASIC_AUTH_PASS) return unauthorized(res);
    return next();
}

const refreshTokenFromEnv = process.env.RING_REFRESH_TOKEN;
const refreshTokenFromDisk = await readPersistedRefreshToken();
const refreshToken = (refreshTokenFromDisk || refreshTokenFromEnv || "").trim();

if (!refreshToken) {
    console.error("Missing RING_REFRESH_TOKEN. Provide it in .env, or run setup to generate one.");
    process.exit(1);
}

process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
    console.error("UNHANDLED REJECTION:", err);
});

process.on("exit", (code) => {
    console.log("Process exiting with code", code);
});

process.on("SIGINT", () => {
    console.log("Received SIGINT (Ctrl+C). Shutting down.");
    process.exit(0);
});

const ringApi = new RingApi({
    refreshToken: refreshToken.trim(),
    avoidSnapshotBatteryDrain: true,
});

// Persist refresh token rotations so restarts keep working without re-auth.
// This avoids needing email/password/2FA again unless Ring revokes the token.
ringApi.onRefreshTokenUpdated?.subscribe?.(async ({ newRefreshToken, oldRefreshToken }) => {
    if (!newRefreshToken || !String(newRefreshToken).trim()) return;

    // Only persist when the library indicates a real rotation
    if (oldRefreshToken && oldRefreshToken !== newRefreshToken) {
        console.log("[auth] Refresh token rotated; persisting updated token");
    }

    await persistRefreshToken(String(newRefreshToken).trim());
});

const CAMERA_ID = process.env.RING_CAMERA_ID;
if (!CAMERA_ID || !CAMERA_ID.trim()) {
    console.error("Missing RING_CAMERA_ID in environment variables");
    process.exit(1);
}
let camerasCache = null;

async function getCamera() {
    if (!camerasCache) {
        camerasCache = await ringApi.getCameras();
    }
    const cam = camerasCache.find((c) => String(c.id) === String(CAMERA_ID));
    if (!cam) throw new Error(`Camera ${CAMERA_ID} not found`);
    return cam;
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await fsp.access(filePath, fs.constants.F_OK);
            return;
        } catch {
            // keep waiting
        }
        await sleep(150);
    }
    throw new Error(`Timed out waiting for ${filePath}`);
}

async function runFfmpegSingleFrame({ inputUrlOrPath, timeoutMs = 12000 }) {
    return await new Promise((resolve, reject) => {
        const args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            inputUrlOrPath,
            "-frames:v",
            "1",
            "-f",
            "image2",
            "-q:v",
            "2",
            "pipe:1",
        ];

        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

        const chunks = [];
        let stderr = "";

        const killer = setTimeout(() => {
            try {
                proc.kill("SIGKILL");
            } catch { }
            reject(new Error("ffmpeg timed out"));
        }, timeoutMs);

        proc.stdout.on("data", (d) => chunks.push(d));
        proc.stderr.on("data", (d) => (stderr += d.toString()));

        proc.on("error", (err) => {
            clearTimeout(killer);
            reject(err);
        });

        proc.on("close", (code) => {
            clearTimeout(killer);
            if (code === 0 && chunks.length) {
                resolve(Buffer.concat(chunks));
            } else {
                reject(new Error(`ffmpeg failed (code ${code}): ${stderr || "no stderr"}`));
            }
        });
    });
}

// In-memory cache for /ring/frame.jpg to avoid starting multiple streams on retries
const FRAME_CACHE_SECONDS = Number(process.env.FRAME_CACHE_SECONDS || "300"); // default 5 minutes
let lastFrameBuffer = null;
let lastFrameAtMs = 0;
let inFlightFramePromise = null;

function isFrameFresh() {
    if (!lastFrameBuffer) return false;
    return Date.now() - lastFrameAtMs < FRAME_CACHE_SECONDS * 1000;
}

app.get("/health", (req, res) => {
    res.status(200).json({ ok: true });
});

app.get("/ring/snapshot.jpg", basicAuthMiddleware, async (req, res) => {
    try {
        const cam = await getCamera();
        const img = await cam.getSnapshot();
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "no-store");
        res.status(200).send(img);
    } catch (e) {
        console.error("Snapshot error:", e?.message || e);
        res.status(502).send("Snapshot unavailable");
    }
});

// High-res still: start a live stream, grab 1 frame with ffmpeg, return as JPEG
// NOTE: This is heavier and slower than /ring/snapshot.jpg
app.get("/ring/frame.jpg", basicAuthMiddleware, async (req, res) => {
    let session;
    let tmpDir;

    try {
        // Serve cached frame if it's still fresh
        if (isFrameFresh()) {
            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("Cache-Control", "no-store");
            return res.status(200).send(lastFrameBuffer);
        }

        // If a frame generation is already in progress, wait for it (prevents concurrent streams)
        if (inFlightFramePromise) {
            const jpg = await inFlightFramePromise;
            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("Cache-Control", "no-store");
            return res.status(200).send(jpg);
        }

        inFlightFramePromise = (async () => {
            const cam = await getCamera();

            // Create a temp directory for HLS output
            tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ring-hls-"));
            const m3u8Path = path.join(tmpDir, "index.m3u8");

            // Start stream and write HLS playlist/segments into tmpDir
            session = await cam.streamVideo({
                output: [m3u8Path],
            });

            // Wait until the playlist exists before invoking ffmpeg
            await waitForFile(m3u8Path, 10000);

            // Extract a single JPEG frame from the stream
            const jpg = await runFfmpegSingleFrame({ inputUrlOrPath: m3u8Path, timeoutMs: 15000 });

            // Update cache
            lastFrameBuffer = jpg;
            lastFrameAtMs = Date.now();

            return jpg;
        })();

        const jpg = await inFlightFramePromise;

        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "no-store");
        res.status(200).send(jpg);
    } catch (e) {
        console.error("Frame error:", e?.message || e);
        res.status(502).send("Frame unavailable");
    } finally {
        // Stop the stream session if it started
        try {
            if (session?.stop) session.stop();
        } catch { }

        // Best-effort cleanup of temp dir
        try {
            if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
        } catch { }

        inFlightFramePromise = null;
    }
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Snapshot proxy listening on :${port}`));

server.on("error", (err) => {
    console.error("SERVER ERROR:", err);
});

server.on("close", () => {
    console.log("Server closed");
});
