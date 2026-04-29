"use strict";
(() => {
  // tournament/protocol/messages.ts
  var PROTOCOL_VERSION = 0;

  // src/pages/challenge.ts
  var WS_PROTO = location.protocol === "https:" ? "wss:" : "ws:";
  var WS_URL = `${WS_PROTO}//${location.host}`;
  var myNametag = localStorage.getItem("boxyrun-nametag");
  var ws = null;
  var bots = [];
  var humans = [];
  var wsLastMessageAt = 0;
  var wsWatchdog = null;
  var wsIntentionalClose = false;
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
  function $(id) {
    return document.getElementById(id);
  }
  if (myNametag) {
    $("id-disconnected").style.display = "none";
    $("id-connected").style.display = "flex";
    $("my-name").textContent = myNametag;
    enableChat();
  }
  setInterval(() => {
    const w = window.SphereWallet;
    const ready = !!(w && w.isConnected && w.identity?.nametag);
    if (ready) {
      const liveTag = w.identity.nametag;
      if (myNametag !== liveTag) {
        if (ws) try {
          ws.close();
        } catch {
        }
        ws = null;
        myNametag = liveTag;
        localStorage.setItem("boxyrun-nametag", myNametag);
        $("id-disconnected").style.display = "none";
        $("id-connected").style.display = "flex";
        $("my-name").textContent = myNametag;
        enableChat();
      }
      if (!ws && w.authSession) {
        connectWS();
      }
    }
  }, 500);
  function connectWS() {
    if (!myNametag) return;
    ws = new WebSocket(WS_URL);
    wsLastMessageAt = Date.now();
    ws.onopen = async () => {
      wsLastMessageAt = Date.now();
      const wallet = window.SphereWallet;
      let sessionId = wallet?.authSession ?? null;
      if (!sessionId && typeof wallet?.ensureAuthSession === "function") {
        try {
          sessionId = await wallet.ensureAuthSession();
        } catch (err) {
          console.error("[challenge] auth handshake failed", err);
        }
      }
      if (!sessionId) {
        console.warn("[challenge] no auth session \u2014 closing without register");
        wsIntentionalClose = true;
        try {
          ws.close();
        } catch {
        }
        return;
      }
      wsSend({ type: "register", identity: { nametag: myNametag }, sessionId });
      $("ws-dot").classList.add("on");
      updateNetStatus();
    };
    ws.onmessage = (e) => {
      wsLastMessageAt = Date.now();
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "heartbeat") return;
        handleMsg(msg);
      } catch {
      }
    };
    ws.onclose = () => {
      if (wsWatchdog) {
        clearInterval(wsWatchdog);
        wsWatchdog = null;
      }
      $("ws-dot").classList.remove("on");
      updateNetStatus();
      if (wsIntentionalClose) {
        wsIntentionalClose = false;
        ws = null;
        return;
      }
      setTimeout(connectWS, 3e3);
    };
    ws.onerror = () => {
    };
    wsWatchdog = setInterval(() => {
      if (ws && ws.readyState === 1 && Date.now() - wsLastMessageAt > 25e3) {
        try {
          ws.close();
        } catch {
        }
      }
    }, 5e3);
  }
  function wsSend(msg) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION }));
    }
  }
  function handleMsg(msg) {
    switch (msg.type) {
      case "challenge-received":
        pollIncomingChallenges();
        break;
      case "challenge-declined":
        clearBotPending();
        if (msg.by) {
          showStatus(`${esc(msg.by)} declined.`, "rgba(218,54,51,0.1)", "var(--red)");
        } else {
          showStatus("Challenge expired.", "rgba(218,54,51,0.1)", "var(--red)");
        }
        break;
      case "chat":
        if (msg.from && msg.from !== myNametag) {
          addChatMessage(msg.from, msg.message, false);
        }
        break;
      case "challenge-start": {
        clearBotPending();
        clearLinkUI();
        redirecting = true;
        const p = new URLSearchParams({
          tournament: "1",
          matchId: msg.matchId,
          seed: msg.seed,
          side: msg.youAre,
          opponent: msg.opponent,
          startsAt: String(msg.startsAt),
          name: myNametag,
          tid: msg.tournamentId,
          bestOf: String(msg.bestOf || 1),
          wager: String(msg.wager || 0)
        });
        location.href = "dev.html?" + p;
        break;
      }
    }
  }
  var pendingBot = null;
  function renderBots() {
    const el = $("bot-list");
    if (!bots.length) {
      el.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px 0">Bots are starting up...</div>';
      return;
    }
    const skillColor = { god: "#e879f9", expert: "#ff5e5e", medium: "#ff9534", beginner: "#4ade80" };
    el.innerHTML = bots.map((b) => {
      const disabled = pendingBot || b.busy;
      const sColor = skillColor[b.skill] || "var(--text3)";
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(95,234,255,0.08)">
			<div style="display:flex;align-items:center;gap:10px">
				<span style="color:${b.busy ? "var(--text3)" : "var(--cyan)"};font-weight:600">${esc(b.name)}</span>
				<span style="font-size:9px;font-family:var(--display);letter-spacing:.1em;text-transform:uppercase;color:${sColor};padding:2px 8px;border:1px solid ${sColor};border-radius:99px">${esc(b.skill)}</span>
				${b.busy ? '<span style="font-size:10px;color:var(--text3)">\u2694 in match</span>' : ""}
			</div>
			<button class="btn btn-primary" style="padding:6px 16px;font-size:10px" onclick="challengeBot('${esc(b.name)}')" ${disabled ? "disabled" : ""}>${pendingBot === b.name ? "Starting..." : "Play"}</button>
		</div>`;
    }).join("");
  }
  async function challengeBot(name) {
    if (!myNametag || pendingBot) return;
    pendingBot = name;
    renderBots();
    try {
      const r = await fetch("/api/challenges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: myNametag, opponent: name, wager: 0, bestOf: 3 })
      });
      const data = await r.json();
      if (!r.ok) {
        clearBotPending();
        showStatus(data.message || "Challenge failed", "rgba(218,54,51,0.1)", "var(--red)");
        return;
      }
      setTimeout(() => {
        if (pendingBot) {
          clearBotPending();
          showStatus("Bot didn't respond \u2014 try again.", "rgba(218,54,51,0.1)", "var(--red)");
        }
      }, 1e4);
    } catch {
      clearBotPending();
      showStatus("Network error", "rgba(218,54,51,0.1)", "var(--red)");
    }
  }
  function clearBotPending() {
    pendingBot = null;
    renderBots();
  }
  var lastIncomingIds = "";
  async function pollIncomingChallenges() {
    if (!myNametag) return;
    try {
      const r = await fetch(`/api/challenges/pending?nametag=${encodeURIComponent(myNametag)}`);
      if (!r.ok) return;
      const data = await r.json();
      renderIncomingChallenges(data.challenges || []);
    } catch {
    }
  }
  function renderIncomingChallenges(challenges) {
    const box = $("incoming-challenges");
    const ids = challenges.map((c) => c.id).join(",");
    if (ids === lastIncomingIds) return;
    lastIncomingIds = ids;
    if (!challenges.length) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = challenges.map((ch) => {
      const wagerText = ch.wager > 0 ? ` for <strong style="color:var(--orange)">${ch.wager} UCT</strong>` : "";
      const boText = ch.bestOf > 1 ? ` (best of ${ch.bestOf})` : "";
      const isLink = ch.to === null;
      const label = isLink ? `<strong style="color:var(--cyan)">${esc(ch.from)}</strong> has an open challenge${wagerText}${boText}` : `<strong style="color:var(--cyan)">${esc(ch.from)}</strong> challenges you${wagerText}${boText}`;
      return `<div class="challenge-incoming" data-id="${ch.id}">
			<span>${label}</span>
			<span>
				<button class="btn btn-primary" style="padding:8px 16px;font-size:10px" onclick="acceptChallenge('${ch.id}',this)">Accept</button>
				${!isLink ? `<button class="btn btn-ghost" style="padding:8px 16px;font-size:10px;margin-left:4px" onclick="declineChallenge('${ch.id}',this)">Decline</button>` : ""}
			</span>
		</div>`;
    }).join("");
  }
  var redirecting = false;
  var incomingPollInterval = setInterval(() => {
    if (!redirecting) pollIncomingChallenges();
  }, 2e3);
  if (myNametag) pollIncomingChallenges();
  async function acceptChallenge(id, btn) {
    btn.closest(".challenge-incoming")?.remove();
    showStatus("Starting match...", "var(--cyan-dim)", "var(--cyan)");
    try {
      const r = await fetch(`/api/challenges/${encodeURIComponent(id)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ by: myNametag })
      });
      const data = await r.json();
      if (!r.ok) {
        showStatus(data.message || "Accept failed", "rgba(218,54,51,0.1)", "var(--red)");
        return;
      }
      redirecting = true;
      const p = new URLSearchParams({
        tournament: "1",
        matchId: data.matchId,
        seed: data.seed || "0",
        side: data.youAre,
        opponent: data.opponent,
        name: myNametag,
        tid: data.tournamentId,
        bestOf: String(data.bestOf || 1),
        startsAt: String(Date.now() + 3e3)
      });
      location.href = "dev.html?" + p;
    } catch {
      showStatus("Network error", "rgba(218,54,51,0.1)", "var(--red)");
    }
  }
  async function declineChallenge(id, btn) {
    btn.closest(".challenge-incoming")?.remove();
    try {
      await fetch(`/api/challenges/${encodeURIComponent(id)}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ by: myNametag })
      });
    } catch {
    }
  }
  var joinCode = new URLSearchParams(location.search).get("join");
  if (joinCode) showJoinUI(joinCode);
  async function showJoinUI(code) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "20px";
    card.innerHTML = `
		<div class="card-head"><h2>Challenge Invite</h2></div>
		<div class="card-body" id="join-body">
			<div style="text-align:center;color:var(--text3);font-size:13px">Loading...</div>
		</div>`;
    const firstCard = document.querySelector(".card");
    if (firstCard) firstCard.parentNode.insertBefore(card, firstCard);
    else document.querySelector(".page").appendChild(card);
    try {
      const r = await fetch(`/api/challenge-links/${encodeURIComponent(code)}`);
      if (!r.ok) {
        $("join-body").innerHTML = `<div style="text-align:center;color:var(--red);font-size:14px">This challenge link has expired or doesn't exist.</div>`;
        return;
      }
      const data = await r.json();
      if (data.accepted) {
        $("join-body").innerHTML = '<div style="text-align:center;color:var(--text3);font-size:14px">This challenge has already been accepted.</div>';
        return;
      }
      const wagerText = data.wager > 0 ? ` for <strong style="color:var(--orange)">${data.wager} UCT</strong>` : "";
      const boText = data.bestOf > 1 ? ` (Best of ${data.bestOf})` : "";
      $("join-body").innerHTML = `
			<div style="text-align:center">
				<div style="font-size:16px;margin-bottom:12px">
					<strong style="color:var(--cyan)">${esc(data.from)}</strong> challenges you${wagerText}${boText}
				</div>
				${myNametag ? `<button class="btn btn-primary" id="join-accept" style="padding:14px 32px;font-size:13px">Accept Challenge</button>` : `<div style="color:var(--text3);font-size:13px">Connect your wallet on the <a href="index.html" style="color:var(--cyan)">home page</a> first.</div>`}
			</div>`;
      document.getElementById("join-accept")?.addEventListener("click", () => {
        const btn = document.getElementById("join-accept");
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Starting...";
        }
        fetch(`/api/challenge-links/${encodeURIComponent(code)}/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ by: myNametag })
        }).then((r2) => r2.json().then((d) => ({ ok: r2.ok, data: d }))).then(({ ok, data: data2 }) => {
          if (!ok) {
            $("join-body").innerHTML = `<div style="text-align:center;color:var(--red);font-size:14px">${esc(data2.message || "Failed")}</div>`;
            return;
          }
          redirecting = true;
          const p = new URLSearchParams({
            tournament: "1",
            matchId: data2.matchId,
            seed: data2.seed || "0",
            side: data2.youAre,
            opponent: data2.opponent,
            name: myNametag,
            tid: data2.tournamentId,
            bestOf: String(data2.bestOf || 1),
            startsAt: String(Date.now() + 3e3)
          });
          location.href = "dev.html?" + p;
        }).catch(() => {
          $("join-body").innerHTML = '<div style="text-align:center;color:var(--red);font-size:14px">Network error \u2014 try again.</div>';
        });
      });
    } catch {
      $("join-body").innerHTML = '<div style="text-align:center;color:var(--red);font-size:14px">Could not load challenge info.</div>';
    }
  }
  var linkPollTimer = null;
  function clearLinkUI() {
    if (linkPollTimer) {
      clearInterval(linkPollTimer);
      linkPollTimer = null;
    }
    const area = document.getElementById("link-area");
    if (area) {
      area.style.display = "none";
      area.innerHTML = "";
    }
  }
  async function createLink() {
    if (!myNametag) return;
    const wagerInput = document.getElementById("wager-input");
    const bestofInput = document.getElementById("bestof-input");
    const wager = parseInt(wagerInput?.value || "0", 10);
    const bestOf = parseInt(bestofInput?.value || "1", 10);
    const linkArea = $("link-area");
    linkArea.style.display = "block";
    linkArea.innerHTML = '<div style="color:var(--text3);font-size:13px">Creating link...</div>';
    try {
      const r = await fetch("/api/challenge-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: myNametag, bestOf, wager: Math.max(0, wager) })
      });
      const data = await r.json();
      if (!r.ok) {
        linkArea.innerHTML = `<div style="color:var(--red);font-size:13px">${esc(data.message || "Failed")}</div>`;
        return;
      }
      const url = `${location.origin}/challenge.html?join=${data.code}`;
      linkArea.innerHTML = `
			<div style="font-size:12px;color:var(--text3);margin-bottom:8px;font-family:var(--display);letter-spacing:.1em">SHARE THIS LINK</div>
			<div style="display:flex;gap:8px;align-items:center">
				<input type="text" value="${esc(url)}" readonly id="link-url" style="flex:1;padding:10px 12px;background:rgba(0,0,0,0.3);border:1px solid var(--border-hi);border-radius:var(--r);color:var(--cyan);font-family:var(--body);font-size:12px;outline:none">
				<button class="btn btn-primary" id="copy-link" style="padding:10px 16px;font-size:10px;white-space:nowrap">Copy</button>
			</div>
			<div style="font-size:12px;color:var(--text3);margin-top:8px" id="link-status">Waiting for someone to join... <span id="link-countdown">5:00</span></div>`;
      document.getElementById("copy-link").addEventListener("click", () => {
        navigator.clipboard.writeText(url).then(() => {
          const el = document.getElementById("copy-link");
          if (el) {
            el.textContent = "Copied!";
            setTimeout(() => {
              if (el) el.textContent = "Copy";
            }, 2e3);
          }
        });
      });
      document.getElementById("link-url").addEventListener("click", function() {
        this.select();
      });
      const linkStart = Date.now();
      if (linkPollTimer) clearInterval(linkPollTimer);
      linkPollTimer = setInterval(async () => {
        const elapsed = Date.now() - linkStart;
        if (elapsed > 5 * 6e4) {
          clearLinkUI();
          showStatus("Challenge link expired.", "rgba(218,54,51,0.1)", "var(--red)");
          return;
        }
        const remaining = Math.max(0, 300 - Math.floor(elapsed / 1e3));
        const cdEl = document.getElementById("link-countdown");
        if (cdEl) cdEl.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
        try {
          const r2 = await fetch(`/api/challenge-links/${data.code}`);
          if (!r2.ok) return;
          const info = await r2.json();
          if (info.accepted) {
            clearLinkUI();
            showStatus(`${esc(info.acceptedBy || "Someone")} accepted! Starting match...`, "rgba(46,160,67,0.1)", "var(--green)", false);
          }
        } catch {
        }
      }, 2e3);
    } catch {
      linkArea.innerHTML = '<div style="color:var(--red);font-size:13px">Network error.</div>';
    }
  }
  function showStatus(text, bg, color, autoHide = true) {
    const el = $("challenge-status");
    el.style.display = "block";
    el.style.background = bg;
    el.style.color = color;
    el.innerHTML = text;
    if (autoHide) setTimeout(() => {
      el.style.display = "none";
    }, 5e3);
  }
  function enableChat() {
    const inp = document.getElementById("chat-input");
    const btn = document.getElementById("chat-send");
    if (inp) inp.disabled = false;
    if (btn) btn.disabled = false;
  }
  function addChatMessage(from, text, isMe) {
    const el = document.getElementById("chat-messages");
    if (!el) return;
    const div = document.createElement("div");
    div.style.marginBottom = "4px";
    div.innerHTML = `<strong style="color:${isMe ? "var(--cyan)" : "var(--orange)"}">${esc(from)}</strong> ${esc(text)}`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }
  function sendChat() {
    const inp = document.getElementById("chat-input");
    const text = inp?.value.trim();
    if (!text || !myNametag) return;
    wsSend({ type: "chat", message: text });
    addChatMessage(myNametag, text, true);
    if (inp) inp.value = "";
  }
  document.getElementById("chat-send")?.addEventListener("click", sendChat);
  document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  var lastRestOk = false;
  function updateNetStatus() {
    const dot = document.getElementById("net-dot");
    const text = document.getElementById("net-text");
    if (!dot || !text) return;
    const wsOk = ws?.readyState === 1;
    if (wsOk && lastRestOk) {
      dot.style.background = "#2ea043";
      dot.style.boxShadow = "0 0 6px rgba(46,160,67,0.5)";
      text.style.color = "#2ea043";
      text.textContent = `Connected as ${myNametag || "?"}`;
    } else {
      dot.style.background = "#c1121f";
      dot.style.boxShadow = "0 0 6px rgba(193,18,31,0.5)";
      text.style.color = "#c1121f";
      text.textContent = "Reconnecting\u2026";
    }
  }
  updateNetStatus();
  window.challengeBot = challengeBot;
  window.acceptChallenge = acceptChallenge;
  window.declineChallenge = declineChallenge;
  window.createLink = createLink;
  async function pollOnline() {
    if (!myNametag) return;
    try {
      const r = await fetch("/api/online");
      lastRestOk = r.ok;
      if (!r.ok) return;
      const data = await r.json();
      bots = data.bots || [];
      humans = data.humans || [];
      renderBots();
      $("humans-count").textContent = `${humans.length} online`;
      updateNetStatus();
    } catch {
      if (!redirecting) {
        lastRestOk = false;
        updateNetStatus();
      }
    }
  }
  setInterval(pollOnline, 3e3);
  pollOnline();
})();
