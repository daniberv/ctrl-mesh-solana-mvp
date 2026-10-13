import { strict as assert } from "assert";
import type { IncomingMessage } from "http";
import {
  publicRelayInfo,
  relayBaseURL,
  validatePublicRelays,
} from "../src/mesh/public-relays";
import { requestIP } from "../src/mesh/request-ip";

describe("production proxy addresses", () => {
  const config: any = {
    members: ["a", "b", "c"].map((id, i) => ({
      id,
      url: `http://127.0.0.1:${4173 + i}`,
    })),
  };
  const members = () =>
    ["a", "b", "c"].map((id) => ({
      id,
      url: `https://1mesh.xyz/relays/${id}`,
    }));
  it("advertises per-voter paths and leader without changing pinned membership", () => {
    const before = JSON.stringify(config),
      publicMembers = members();
    validatePublicRelays(config, publicMembers);
    const consensus: any = {
      options: { config },
      info: () => ({
        members: config.members,
        leader: config.members[2].url,
        writable: true,
      }),
    };
    const result = publicRelayInfo(consensus, publicMembers)!;
    assert.equal(result.leader, "https://1mesh.xyz/relays/c");
    assert.deepEqual(result.members, publicMembers);
    assert.equal(JSON.stringify(config), before);
    assert.equal(
      relayBaseURL("https://1mesh.xyz/relays/a/"),
      "https://1mesh.xyz/relays/a"
    );
    assert.equal(
      relayBaseURL("http://127.0.0.1:4173/"),
      "http://127.0.0.1:4173"
    );
  });
  it("rejects missing, duplicate, unknown, insecure and credentialed proxy mappings", () => {
    for (const invalid of [
      members().slice(0, 2),
      [members()[0], members()[0], members()[2]],
      members().map((m) => ({ ...m, url: "https://1mesh.xyz" })),
      members().map((m) => ({ ...m, id: "unknown" })),
      members().map((m) => ({ ...m, url: m.url.replace("https:", "http:") })),
      members().map((m) => ({
        ...m,
        url: m.url.replace("1mesh", "user:secret@1mesh"),
      })),
    ])
      assert.throws(() => validatePublicRelays(config, invalid));
  });
  it("only accepts proxy IPs when explicitly enabled on a loopback socket", () => {
    const req = (peer: string, ip: string) =>
      ({
        socket: { remoteAddress: peer },
        headers: { "x-real-ip": ip },
      } as unknown as IncomingMessage);
    assert.equal(requestIP(req("127.0.0.1", "192.0.2.1"), true), "192.0.2.1");
    assert.equal(requestIP(req("127.0.0.1", "192.0.2.1")), "127.0.0.1");
    assert.equal(requestIP(req("192.0.2.2", "192.0.2.1"), true), "192.0.2.2");
    assert.equal(requestIP(req("127.0.0.1", "invalid"), true), "127.0.0.1");
  });
});
