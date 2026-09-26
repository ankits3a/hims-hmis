import { loggablePushUrl } from "./hip-client";

/**
 * WASA M-04, the other direction: another HIU's dataPushUrl may carry ITS credential (in the path or
 * the query). What we log of it keeps which HIU (the origin) and a digest to correlate retries — never
 * the path or the query.
 */
describe("loggablePushUrl — a peer's push URL never reaches our log with its secret", () => {
  it("keeps the origin and a digest, and drops a path token and a query token", () => {
    const pathForm = loggablePushUrl("https://hiu.example.org/api/push/SECRET-PATH-TOKEN-123");
    const queryForm = loggablePushUrl("https://hiu.example.org/api/push?pt=SECRET-QUERY-TOKEN-456&x=1");
    for (const logged of [pathForm, queryForm]) {
      expect(logged.startsWith("https://hiu.example.org/[redacted]#sha256:")).toBe(true);
      expect(logged).not.toMatch(/SECRET|api\/push|pt=/);
    }
    expect(pathForm).not.toBe(queryForm); // different URLs stay distinguishable for correlation
    expect(loggablePushUrl("https://hiu.example.org/api/push/SECRET-PATH-TOKEN-123")).toBe(pathForm); // and stable
  });

  it("an unparseable URL is still never logged verbatim", () => {
    const logged = loggablePushUrl("not a url SECRET-789");
    expect(logged).not.toContain("SECRET");
    expect(logged).toMatch(/^\(unparseable\)\/\[redacted\]#sha256:[0-9a-f]{16}$/);
  });
});
