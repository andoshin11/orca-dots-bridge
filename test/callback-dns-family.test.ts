import { expect, it, vi } from "vitest";
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
import { createPost, pinCallback } from "../src/events/webhook.js";
it("contrasts mixed-family and IPv4-only synthetic answers without a network request", async () => {
  const host = "receiver.example.com";
  const ipv4 = ["8.8.8.8", "1.1.1.1"];
  const all = ["2001:4860:4860::8888", "2606:4700:4700::1111", ...ipv4];
  await expect(pinCallback("https://" + host + "/", [host], async () => all)).rejects.toMatchObject(
    { code: "callback_rejected", reason: "address_rejected" },
  );
  await expect(pinCallback("https://" + host + "/", [host], async () => ipv4)).resolves.toEqual({
    hostname: host,
    address: ipv4[0],
    path: "/",
  });
});

it("uses the supported IPv4 family for a public dual-stack recipient", async () => {
  dns.lookup.mockImplementation(async (_host, options) =>
    options.family === 4
      ? [{ address: "8.8.8.8", family: 4 }]
      : [
          { address: "8.8.8.8", family: 4 },
          { address: "2606:4700:4700::1111", family: 6 },
        ],
  );
  const send = vi.fn(async () => ({ status: 200, body: "{}" }));
  const post = createPost(["receiver.example.com"], undefined, send);
  await expect(post("https://receiver.example.com/path", {}, "{}")).resolves.toMatchObject({
    status: 200,
  });
  expect(dns.lookup).toHaveBeenLastCalledWith("receiver.example.com", { all: true, family: 4 });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ address: "8.8.8.8", hostname: "receiver.example.com" }),
    {},
    "{}",
    expect.any(AbortSignal),
  );
});
it("does not fall back to IPv6 when the recipient has no usable IPv4 address", async () => {
  dns.lookup.mockRejectedValue(Object.assign(new Error("synthetic"), { code: "ENOTFOUND" }));
  const send = vi.fn();
  await expect(
    createPost(["receiver.example.com"], undefined, send)(
      "https://receiver.example.com/",
      {},
      "{}",
    ),
  ).rejects.toMatchObject({ code: "dns_failed" });
  expect(send).not.toHaveBeenCalled();
});
it("still refuses all IPv4 answers if one is non-public", async () => {
  dns.lookup.mockResolvedValue([
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  const send = vi.fn();
  await expect(
    createPost(["receiver.example.com"], undefined, send)(
      "https://receiver.example.com/",
      {},
      "{}",
    ),
  ).rejects.toMatchObject({ reason: "address_rejected" });
  expect(send).not.toHaveBeenCalled();
});
