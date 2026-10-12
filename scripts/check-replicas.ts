async function main() {
  const urls = process.argv.slice(2);
  if (!urls.length) urls.push("http://127.0.0.1:4173", "http://127.0.0.1:4174");
  const peers = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url + "/api/federation/info", {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Error("Relay unavailable: " + url);
      return { url, ...((await response.json()) as any) };
    })
  );
  const first = peers[0];
  const same = peers.every(
    (p) =>
      p.stream === first.stream &&
      p.genesis === first.genesis &&
      p.program === first.program &&
      p.head === first.head &&
      p.hash === first.hash &&
      !p.error
  );
  console.log(JSON.stringify({ synchronized: same, peers }, null, 2));
  if (!same) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
