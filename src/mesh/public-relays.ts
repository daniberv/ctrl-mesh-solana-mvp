import type { ClusterConfig, Consensus, Member } from "./consensus";

/** Public proxy addresses never change the pinned Raft membership. */
export function validatePublicRelays(config: ClusterConfig, members: Member[]) {
  if (
    members.length !== config.members.length ||
    new Set(members.map((m) => m.id)).size !== members.length ||
    new Set(members.map((m) => m.url)).size !== members.length
  )
    throw Error("Public relays must map each voter exactly once");
  for (const member of members) {
    const url = new URL(member.url);
    if (
      !config.members.some((m) => m.id === member.id) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname))
      )
    )
      throw Error("Public relays require HTTPS or loopback HTTP addresses");
    member.url = relayBaseURL(member.url);
  }
}

export function relayBaseURL(value: string) {
  const url = new URL(value);
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function publicRelayInfo(consensus?: Consensus, members?: Member[]) {
  if (!consensus) return undefined;
  const info = consensus.info();
  if (!members) return info;
  const leader = consensus.options.config.members.find(
    (m) => m.url === info.leader
  );
  return {
    ...info,
    members,
    leader: members.find((m) => m.id === leader?.id)?.url,
  };
}
