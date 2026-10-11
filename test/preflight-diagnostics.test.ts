import { afterEach, expect, it } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPreflightDiagnostics,
  diagnosticStages,
} from "../src/events/preflight-diagnostics.js";
import { createLoopbackServer } from "../src/events/loopback-server.js";
import { request as httpRequest } from "node:http";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-diagnostics-"));
  directories.push(directory);
  chmodSync(directory, 0o700);
  const path = join(directory, "preflight-diagnostics.json");
  const diagnostic = createPreflightDiagnostics(path);
  const snapshot = () => JSON.parse(readFileSync(path, "utf8"));
  return { directory, path, diagnostic, snapshot };
}
it("persists fixed-only counters atomically, rejects overwrites, symlinks and non-private storage", () => {
  const f = fixture();
  f.diagnostic("running");
  f.diagnostic("method_subscribe");
  f.diagnostic("stopped");
  const saved = f.snapshot();
  expect(Object.keys(saved).sort()).toEqual(["counts", "lastStage", "sequence", "version"]);
  expect(saved.counts.method_subscribe).toBe(1);
  expect(saved.lastStage).toBe("stopped");
  expect(Object.keys(saved.counts)).toEqual([...diagnosticStages]);
  expect(lstatSync(f.path).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.directory)).toEqual(["preflight-diagnostics.json"]);
  expect(() => createPreflightDiagnostics(f.path)).toThrow("diagnostics_unavailable");
  const link = join(f.directory, "link.json");
  symlinkSync(f.path, link);
  expect(() => createPreflightDiagnostics(link)).toThrow("diagnostics_unavailable");
  chmodSync(f.directory, 0o755);
  expect(() => createPreflightDiagnostics(join(f.directory, "another.json"))).toThrow(
    "diagnostics_unavailable",
  );
});
it("fails closed if the diagnostic file is replaced", () => {
  const f = fixture();
  rmSync(f.path);
  writeFileSync(f.path, "private-replacement");
  chmodSync(f.path, 0o644);
  expect(() => f.diagnostic("running")).toThrow("diagnostics_unavailable");
  expect(readFileSync(f.path, "utf8")).toBe("private-replacement");
});

it("distinguishes HTTP boundary, route, size, unavailable endpoint and internal errors while remaining live", async () => {
  const f = fixture();
  let endpoint: { fetch: (request: Request) => Promise<Response> } | undefined;
  const server = createLoopbackServer(0, () => endpoint, f.diagnostic);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  async function send(path = "/mcp", method = "POST", headers = {}, body = "{}") {
    return new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          agent: false,
          port: address && typeof address !== "string" ? address.port : 0,
          path,
          method,
          headers: { host: "127.0.0.1:0", ...headers },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.once("error", reject);
      request.end(body);
    });
  }
  try {
    expect(await send("/mcp", "POST", { origin: "https://private-never-record.example" })).toBe(
      403,
    );
    expect(await send("/mcp", "POST", { host: "private-never-record.example" })).toBe(403);
    expect(await send("/.well-known/oauth-protected-resource", "GET")).toBe(404);
    expect(await send("/private-never-record")).toBe(403);
    // Node can close the over-limit request stream before the 413 reaches the client.
    await send("/mcp", "POST", {}, "x".repeat(262145)).then(
      (status) => expect(status).toBe(413),
      (error) => expect(error.code).toBe("ECONNRESET"),
    );
    expect(await send()).toBe(503);
    endpoint = {
      fetch: async () => {
        throw new Error("private-never-record");
      },
    };
    expect(await send()).toBe(500);
    endpoint = { fetch: async () => new Response("ok") };
    expect(await send()).toBe(200);
    const counts = f.snapshot().counts;
    expect(counts.http_arrived).toBe(8);
    expect(counts.http_boundary_rejected).toBe(2);
    for (const stage of [
      "oauth_metadata_absent",
      "http_route_rejected",
      "http_body_limit",
      "endpoint_unavailable",
      "http_exception",
    ])
      expect(counts[stage]).toBe(1);
    expect(readFileSync(f.path, "utf8")).not.toContain("private-never-record");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
