import "dotenv/config";
import { RingApi } from "ring-client-api";

process.on("unhandledRejection", (err) => {
    console.error("UNHANDLED REJECTION");
    dumpErr(err);
    process.exit(1);
});

function dumpErr(err) {
    // got HTTPError objects often have response + request info attached
    console.error("name:", err?.name);
    console.error("message:", err?.message);

    const res = err?.response;
    if (res) {
        console.error("statusCode:", res.statusCode);
        console.error("statusMessage:", res.statusMessage);
        console.error("response url:", res.url || res.request?.requestUrl || res.request?.options?.url);

        const body = res.body;
        if (typeof body === "string") {
            console.error("body (first 500 chars):", body.slice(0, 500));
        } else if (body) {
            try {
                console.error("body (json):", JSON.stringify(body).slice(0, 500));
            } catch {
                console.error("body (non-string/non-json):", body);
            }
        }
    }

    // fallback: got sometimes stores request URL differently
    console.error("request url fallback:", err?.options?.url);
}

const ringApi = new RingApi({
    refreshToken: process.env.RING_REFRESH_TOKEN,
});

try {
    const cameras = await ringApi.getCameras();
    console.log(
        cameras.map((c) => ({
            id: c.id,
            description: c.description,
            model: c.model,
        }))
    );
} catch (err) {
    dumpErr(err);
    process.exit(1);
}