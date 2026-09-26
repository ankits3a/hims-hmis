import { compileCidrs, DEFAULT_TRUSTED_PROXY_CIDRS, trustOneProxyHop, unmappedIp } from "./http-hardening";

/**
 * WASA M-05 — the `trust proxy` function, without a server. The e2e suite proves the wire
 * (`test/auth-audit.e2e.test.ts`); these legs pin the two properties that make the address worth
 * recording: only the socket peer is ever trusted, and only from inside the configured ranges.
 */
describe("trustOneProxyHop (WASA M-05)", () => {
  const trust = trustOneProxyHop(DEFAULT_TRUSTED_PROXY_CIDRS);

  it("trusts the Caddy hop on the compose network — today's subnet and the rest of Docker's pools", () => {
    for (const peer of ["172.20.0.5", "::ffff:172.20.0.5", "172.31.255.1", "192.168.16.3", "127.0.0.1", "::1"]) {
      expect([peer, trust(peer, 0)]).toEqual([peer, true]);
    }
  });

  it("does not trust a peer outside those ranges, however it arrived", () => {
    for (const peer of ["203.0.113.7", "::ffff:203.0.113.7", "10.0.0.1", "172.32.0.1", "2001:db8::1", "not-an-ip", ""]) {
      expect([peer, trust(peer, 0)]).toEqual([peer, false]);
    }
  });

  it("never trusts a SECOND hop, even a private one — that entry was written by the client", () => {
    expect(trust("172.20.0.5", 1)).toBe(false);
    expect(trust("127.0.0.1", 2)).toBe(false);
  });

  it("narrows to exactly what the operator configured", () => {
    const narrow = trustOneProxyHop(["172.20.0.0/16"]);
    expect([narrow("172.20.9.9", 0), narrow("172.21.0.1", 0), narrow("127.0.0.1", 0)]).toEqual([true, false, false]);
  });

  it("refuses a malformed TRUSTED_PROXY_CIDRS at boot rather than trusting something by accident", () => {
    for (const bad of ["172.20.0.0", "172.20.0.0/33", "::/129", "banana/8", "10.0.0.0/8/1", "*"]) {
      expect(() => compileCidrs([bad])).toThrow(/TRUSTED_PROXY_CIDRS/);
    }
  });

  it("unmaps an IPv4-mapped peer and leaves every other address alone", () => {
    expect([unmappedIp("::ffff:10.1.2.3"), unmappedIp("10.1.2.3"), unmappedIp("::1")]).toEqual(["10.1.2.3", "10.1.2.3", "::1"]);
  });
});
