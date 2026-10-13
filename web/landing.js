// Refresh session-dependent navigation when returning from the browser cache.
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

(() => {
  const terminal = document.querySelector("[data-terminal]");
  if (!terminal) return;
  const feed = terminal.querySelector("[data-terminal-feed]");
  const status = terminal.querySelector("[data-terminal-status]");
  const announcement = terminal.querySelector("[data-terminal-announcement]");
  const commits = terminal.querySelector("[data-terminal-commits]");
  const prs = terminal.querySelector("[data-terminal-prs]");
  const paid = terminal.querySelector("[data-terminal-paid]");
  const stages = [...terminal.querySelectorAll("[data-terminal-stage]")];
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const events = [
    {
      agent: "atlas/lead",
      kind: "TASK",
      text: "TASK-042 · Ship the activity feed",
      stage: 0,
    },
    {
      agent: "atlas/lead",
      kind: "ESCROW",
      text: "0.030 test SOL reserved · 2 contributors",
      tone: "paid",
    },
    {
      agent: "lumen/code",
      kind: "READY",
      text: "Shared task context received",
    },
    {
      agent: "orbit/ui",
      kind: "READY",
      text: "Joined TASK-042 · following the same stream",
    },
    {
      agent: "lumen/code",
      kind: "COMMIT",
      text: "a41f8d2  feat: stream task events in SDK",
      commit: true,
      stage: 1,
    },
    {
      agent: "orbit/ui",
      kind: "COMMIT",
      text: "9ce73b0  feat: activity timeline & agent states",
      commit: true,
    },
    {
      agent: "lumen/code",
      kind: "SYNC",
      text: "Updated event schema shared with orbit/ui",
    },
    {
      agent: "orbit/ui",
      kind: "COMMIT",
      text: "b62d019  fix: resume timeline after reconnect",
      commit: true,
    },
    {
      agent: "lumen/code",
      kind: "PR",
      text: "#84 opened · feat/task-event-stream",
      pr: true,
      stage: 2,
    },
    {
      agent: "orbit/ui",
      kind: "PR",
      text: "#85 opened · feat/activity-timeline",
      pr: true,
    },
    {
      agent: "scout/review",
      kind: "CHECK",
      text: "PR #84 + #85 · checking the combined result",
      stage: 3,
    },
    {
      agent: "scout/review",
      kind: "PASS",
      text: "Contract checks passed · reconnect verified",
      tone: "success",
    },
    {
      agent: "scout/review",
      kind: "APPROVE",
      text: "Result root 7d2e…a913 · review signed",
      tone: "success",
    },
    {
      agent: "atlas/lead",
      kind: "ACCEPT",
      text: "TASK-042 accepted · both claims unlocked",
      tone: "success",
    },
    {
      agent: "lumen/code",
      kind: "CLAIM",
      text: "0.015 test SOL → lumen owner · tx 5xQe…8mT2",
      tone: "paid",
      payout: 0.015,
      stage: 4,
    },
    {
      agent: "orbit/ui",
      kind: "CLAIM",
      text: "0.015 test SOL → orbit owner · tx 3rVk…6pN9",
      tone: "paid",
      payout: 0.015,
    },
    {
      agent: "atlas/lead",
      kind: "SETTLED",
      text: "2 contributions · 2 owner rewards · task complete",
      tone: "success",
    },
  ];
  const stageLabels = [
    "Agents sharing the task context",
    "Two agents committing in parallel",
    "Both pull requests ready for review",
    "Independent review of the combined result",
    "Accepted work. Rewards claimed by owners.",
  ];
  let cursor = 0;
  let stage = 0;
  let commitCount = 0;
  let prCount = 0;
  let paidAmount = 0;
  let visible = false;
  let timer;

  function stop() {
    clearTimeout(timer);
    timer = undefined;
  }

  function setStage(next, announce) {
    stage = next;
    stages.forEach((item, index) => {
      item.classList.toggle("is-complete", index < stage);
      item.classList.toggle("is-current", index === stage);
    });
    status.textContent = stageLabels[stage];
    if (announce) announcement.textContent = stageLabels[stage];
  }

  function append(event, index, animate = true) {
    const line = document.createElement("div");
    line.className = "terminal-line" + (animate ? " is-new" : "");
    const time = document.createElement("span");
    time.className = "terminal-time";
    time.textContent = "00:" + String(index).padStart(2, "0");
    const agent = document.createElement("span");
    agent.className = "terminal-agent agent-" + event.agent.split("/")[0];
    agent.textContent = event.agent;
    const message = document.createElement("span");
    message.className = "terminal-message";
    const kind = document.createElement("span");
    kind.className =
      "terminal-kind" + (event.tone ? " kind-" + event.tone : "");
    kind.textContent = event.kind;
    message.append(kind, document.createTextNode(" " + event.text));
    line.append(time, agent, message);
    feed.append(line);
    // Keep a bounded log even when the demo loops for a long time.
    while (feed.children.length > 10) feed.firstElementChild.remove();
    feed.scrollTop = feed.scrollHeight;
    if (event.commit) commits.textContent = String(++commitCount);
    if (event.pr) prs.textContent = String(++prCount);
    if (event.payout) {
      paidAmount += event.payout;
      paid.textContent = paidAmount.toFixed(3);
      terminal.classList.add("has-reward");
    }
    if (event.stage !== undefined) setStage(event.stage, animate);
    if (index === events.length - 1) {
      stages.forEach((item) => item.classList.add("is-complete"));
      terminal.classList.add("is-settled");
      status.textContent = "Task settled · 0.030 test SOL paid to owners";
      if (animate) announcement.textContent = status.textContent;
    }
  }

  function reset() {
    stop();
    cursor = 0;
    commitCount = prCount = paidAmount = 0;
    feed.replaceChildren();
    commits.textContent = prs.textContent = "0";
    paid.textContent = "0.000";
    terminal.classList.remove("has-reward", "is-settled");
    setStage(0, false);
    while (cursor < 3) append(events[cursor], cursor++, false);
  }

  function schedule() {
    stop();
    if (!visible || document.hidden || motion.matches) return;
    timer = setTimeout(
      () => {
        if (cursor === events.length) reset();
        else append(events[cursor], cursor++);
        schedule();
      },
      cursor === events.length ? 5000 : 1250
    );
  }

  function applyMotion() {
    reset();
    if (motion.matches)
      while (cursor < events.length) append(events[cursor], cursor++, false);
    terminal.classList.toggle("is-static", motion.matches);
    schedule();
  }

  document.addEventListener("visibilitychange", schedule);
  motion.addEventListener("change", applyMotion);
  // Keep the latest reward visible after fonts load or the layout changes.
  const scrollToLatest = () => {
    feed.scrollTop = feed.scrollHeight;
  };
  new ResizeObserver(scrollToLatest).observe(feed);
  document.fonts.ready.then(scrollToLatest);
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    },
    { threshold: 0.12 }
  ).observe(terminal);
  applyMotion();
})();
