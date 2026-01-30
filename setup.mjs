import fs from "fs";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
import { RingApi } from "ring-client-api";

const ENV_PATH = path.join(process.cwd(), ".env");

function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return "";
    return fs.readFileSync(ENV_PATH, "utf8");
}

function writeEnvFile(contents) {
    fs.writeFileSync(ENV_PATH, contents, "utf8");
}

function setEnvVar(contents, key, value) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");

    if (re.test(contents)) {
        return contents.replace(re, line);
    }

    if (contents.length && !contents.endsWith("\n")) contents += "\n";
    return contents + line + "\n";
}

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) =>
        rl.question(question, (ans) => {
            rl.close();
            resolve(ans);
        })
    );
}

async function runRingAuthCli() {
    return await new Promise((resolve, reject) => {
        // Runs: npx -p ring-client-api ring-auth-cli
        // Interactive prompts (email/password/2FA) go through stdio: inherit
        const child = spawn("npx", ["-p", "ring-client-api", "ring-auth-cli"], {
            stdio: ["inherit", "pipe", "inherit"],
        });

        let out = "";
        child.stdout.on("data", (d) => {
            const s = d.toString();
            out += s;
            process.stdout.write(s);
        });

        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) return reject(new Error(`ring-auth-cli exited with code ${code}`));

            // Extract refreshToken from ring-auth-cli output
            // Example output line: "refreshToken": "eyJydCI6ImV5...="
            const m = out.match(/"refreshToken"\s*:\s*"([^"]+)"/);
            if (!m) return reject(new Error("Could not find refresh token in ring-auth-cli output."));
            resolve(m[1]);
        });
    });
}

async function chooseCamera(cameras) {
    console.log("\nCameras found:");
    cameras.forEach((c, i) => {
        console.log(`  [${i + 1}] id=${c.id}  ${c.description || ""}  (${c.model || ""})`);
    });

    while (true) {
        const ans = await prompt("\nChoose a camera number: ");
        const idx = Number(ans) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < cameras.length) return cameras[idx];
        console.log("Invalid choice. Try again.");
    }
}

async function main() {
    // Require a .env file so we don't accidentally create a new one without the user's intent
    if (!fs.existsSync(ENV_PATH)) {
        console.error("Missing .env file.");
        console.error("Create it with: cp .env.example .env");
        process.exit(1);
    }

    console.log("Step 1/3: Running Ring auth CLI (enter email/password/2FA when prompted)...");
    const refreshToken = await runRingAuthCli();

    let env = readEnvFile();
    env = setEnvVar(env, "RING_REFRESH_TOKEN", refreshToken);
    writeEnvFile(env);
    console.log("\nSaved RING_REFRESH_TOKEN to .env");

    console.log("\nStep 2/3: Fetching cameras from Ring...");
    const api = new RingApi({ refreshToken });
    const cams = await api.getCameras();

    if (!cams.length) {
        console.error("No cameras found on this Ring account.");
        process.exit(1);
    }

    console.log("\nStep 3/3: Select camera to use...");
    const chosen = await chooseCamera(cams);

    env = readEnvFile();
    env = setEnvVar(env, "RING_CAMERA_ID", String(chosen.id));
    writeEnvFile(env);

    console.log(`\nSaved RING_CAMERA_ID=${chosen.id} to .env`);

    console.log("\nDone.");
    console.log("\nNext steps:");
    console.log("  1) (If you have not built the image yet) Build:");
    console.log("     docker build -t ring-snapshot-proxy .");
    console.log("\n  2) Run the service (recommended: persist refresh tokens):");
    console.log("     mkdir -p data");
    console.log("     docker run -d --name ring-snapshot-proxy \\");
    console.log("       --restart unless-stopped \\");
    console.log("       -p 3000:3000 \\");
    console.log("       --env-file .env \\");
    console.log("       -v \"$(pwd)/data:/data\" \\");
    console.log("       ring-snapshot-proxy npm start");
    console.log("\n  3) Health check:");
    console.log("     curl http://localhost:3000/health");

    // Ensure we exit cleanly even if any handles (e.g., stdio) remain open.
    process.exit(0);
}

main().catch((e) => {
    console.error("\nSETUP ERROR:", e?.message || e);
    process.exit(1);
});