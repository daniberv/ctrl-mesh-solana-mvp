const $ = (id) => document.getElementById(id);
const short = (value) => value ? `${value.slice(0, 12)}…${value.slice(-8)}` : "—";
const toast = (message, error = false) => {
  const el = $("toast"); el.textContent = message; el.className = `toast show${error ? " error" : ""}`;
  setTimeout(() => el.classList.remove("show"), 4600);
};
function render(s) {
  $("network").textContent = s.network.toUpperCase();
  $("stage").textContent = s.stage.toUpperCase();
  $("create").disabled = s.stage !== "ready";
  $("submit").disabled = s.stage !== "open";
  $("accept").disabled = s.stage !== "submitted";
  $("tamper").disabled = !s.packageHash || s.tamperRejected;
  $("replay").disabled = s.stage !== "accepted" || s.replayRejected;
  for (const [step, active] of [["create", s.stage !== "ready"], ["submit", ["submitted", "accepted"].includes(s.stage)], ["accept", s.stage === "accepted"]]) {
    $(`step-${step}`).classList.toggle("done", active);
  }
  for (const [key, value] of Object.entries(s.transactions)) {
    if ($(key)) $(key).textContent = `TX ${short(value)}`;
  }
  $("artifact").textContent = s.artifact;
  $("file-hash").textContent = short(s.fileHash);
  $("package-hash").textContent = short(s.packageHash);
  $("verified").textContent = s.verified ? "ED25519 VERIFIED" : "PENDING";
  $("verified").classList.toggle("positive", s.verified);
  $("task").textContent = short(s.task);
  $("onchain-hash").textContent = short(s.onchainHash);
  $("approver").textContent = short(s.approver);
  $("payout").textContent = s.payoutLamports ? "0.01 SOL · PAID" : "0.01 SOL · PENDING";
  $("payout").classList.toggle("positive", !!s.payoutLamports);
  $("chain-state").textContent = { ready: "NOT CREATED", open: "FUNDED", submitted: "AWAITING ACCEPTANCE", accepted: "ACCEPTED & PAID" }[s.stage];
  $("tamper-icon").textContent = s.tamperRejected ? "✓" : "○";
  $("replay-icon").textContent = s.replayRejected ? "✓" : "○";
  $("tamper-icon").classList.toggle("positive", s.tamperRejected);
  $("replay-icon").classList.toggle("positive", s.replayRejected);
}
async function run(name, button) {
  button.disabled = true;
  button.classList.add("busy");
  try {
    const response = await fetch(`/api/${name}`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Transaction failed");
    render(data);
    toast({ create: "Escrow funded on localnet", submit: "Signed package submitted", accept: "Accepted and paid in one transaction", tamper: "Changed file rejected", replay: "Duplicate payout rejected" }[name]);
  } catch (error) {
    toast(String(error), true);
    const response = await fetch("/api/state");
    render(await response.json());
  } finally { button.classList.remove("busy"); }
}
for (const name of ["create", "submit", "accept", "tamper", "replay"]) {
  $(name).addEventListener("click", (event) => run(name, event.currentTarget));
}
fetch("/api/state").then((res) => res.json()).then(render).catch((error) => toast(String(error), true));
