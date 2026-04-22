"use strict";
(() => {
  // tournament/protocol/messages.ts
  var PROTOCOL_VERSION = 0;

  // src/pages/challenge.ts
  var WS_PROTO = location.protocol === "https:" ? "wss:" : "ws:";
  var WS_URL = `${WS_PROTO}//${location.host}`;
  var myNametag = localStorage.getItem("boxyrun-nametag");
  var ws = null;
  var onlinePlayers = [];
  var wsLastMessageAt = 0;
  var wsWatchdog = null;
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`element #${id} missing`);
    return el;
  }
  if (myNametag) {
    $("id-disconnected").style.display = "none";
    $("id-connected").style.display = "flex";
    $("my-name").textContent = myNametag;
    connectWS();
    enableChat();
  }
  setInterval(() => {
    const w = window.SphereWallet;
    if (!(w && w.isConnected && w.identity?.nametag)) return;
    const liveTag = w.identity.nametag;
    if (myNametag === liveTag) return;
    if (myNametag && myNametag !== liveTag) {
      console.warn("[challenge] wallet identity changed", myNametag, "\u2192", liveTag);
      if (ws) try {
        ws.close();
      } catch {
      }
      ws = null;
    }
    myNametag = liveTag;
    localStorage.setItem("boxyrun-nametag", myNametag);
    $("id-disconnected").style.display = "none";
    $("id-connected").style.display = "flex";
    $("my-name").textContent = myNametag;
    connectWS();
    enableChat();
  }, 500);
  function connectWS() {
    if (!myNametag) return;
    ws = new WebSocket(WS_URL);
    wsLastMessageAt = Date.now();
    ws.onopen = () => {
      wsLastMessageAt = Date.now();
      wsSend({ type: "register", identity: { nametag: myNametag } });
      $("ws-dot").classList.add("on");
      updateNetStatus();
    };
    ws.onmessage = (e) => {
      wsLastMessageAt = Date.now();
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "heartbeat") return;
        handleMsg(msg);
      } catch (err) {
        console.error("[ws] handleMsg error:", err);
      }
    };
    ws.onclose = () => {
      if (wsWatchdog) {
        clearInterval(wsWatchdog);
        wsWatchdog = null;
      }
      $("ws-dot").classList.remove("on");
      updateNetStatus();
      setTimeout(connectWS, 3e3);
    };
    ws.onerror = () => {
    };
    wsWatchdog = setInterval(() => {
      if (ws && ws.readyState === 1 && Date.now() - wsLastMessageAt > 25e3) {
        console.warn("[ws] idle >25s \u2014 forcing reconnect");
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
      case "registered":
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          console.warn(`[challenge] protocol mismatch: server=${msg.protocolVersion} client=${PROTOCOL_VERSION}`);
        }
        break;
      case "player-online":
        break;
      case "challenge-received":
        showIncoming(msg);
        break;
      case "challenge-sent":
        break;
      case "challenge-declined":
        clearPending();
        if (msg.by) {
          const fast = pendingStart > 0 && Date.now() - pendingStart < 3e3;
          const text = fast ? `${esc(msg.by)} is busy \u2014 try again shortly.` : `${esc(msg.by)} declined.`;
          showStatus(text, "rgba(218,54,51,0.1)", "var(--red)");
        } else {
          showStatus("Challenge expired \u2014 opponent didn\u2019t respond in time.", "rgba(218,54,51,0.1)", "var(--red)");
        }
        if (msg.challengeId) {
          const buttons = document.querySelectorAll(`.challenge-incoming button[onclick*="'${msg.challengeId}'"]`);
          buttons.forEach((b) => b.closest(".challenge-incoming")?.remove());
        }
        break;
      case "chat":
        if (msg.from && msg.from !== myNametag) {
          addChatMessage(msg.from, msg.message, false);
        }
        break;
      case "challenge-start": {
        clearPending();
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
  var savedWager = "0";
  var savedBestOf = "3";
  function render() {
    const el = $("online-list");
    const others = onlinePlayers.filter((n) => n !== myNametag);
    $("online-count").textContent = `${others.length} online`;
    const wagerEl = document.getElementById("wager-input");
    const bestofEl = document.getElementById("bestof-input");
    if (wagerEl) savedWager = wagerEl.value;
    if (bestofEl) savedBestOf = bestofEl.value;
    if (!others.length) {
      el.innerHTML = '<div class="empty">No other players online right now</div>';
      return;
    }
    el.innerHTML = `<div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
		<label style="font-size:12px;color:var(--text2)">Wager:</label>
		<input type="number" id="wager-input" value="${esc(savedWager)}" min="0" step="10" style="width:70px;padding:6px 8px;background:rgba(0,0,0,0.3);border:1px solid var(--border-hi);border-radius:var(--r);color:var(--text);font-size:13px;text-align:center">
		<span style="font-size:12px;color:var(--text3)">UCT</span>
		<label style="font-size:12px;color:var(--text2);margin-left:8px">Best of:</label>
		<select id="bestof-input" style="padding:6px 8px;background:rgba(0,0,0,0.3);border:1px solid var(--border-hi);border-radius:var(--r);color:var(--text);font-size:13px">
			<option value="1"${savedBestOf === "1" ? " selected" : ""}>1</option>
			<option value="3"${savedBestOf === "3" ? " selected" : ""}>3</option>
			<option value="5"${savedBestOf === "5" ? " selected" : ""}>5</option>
		</select>
	</div>` + others.map(
      (n) => `<button class="player-btn" onclick="challenge('${esc(n)}')"${pendingChallenge ? " disabled" : ""}>${esc(n)}</button>`
    ).join("");
  }
  var pendingChallenge = null;
  var pendingTimer = null;
  var pendingStart = 0;
  async function challenge(opponent) {
    if (pendingChallenge) return;
    pendingChallenge = "sending";
    render();
    const wagerInput = document.getElementById("wager-input");
    const bestofInput = document.getElementById("bestof-input");
    const wager = parseInt(wagerInput?.value || "0", 10);
    const bestOf = parseInt(bestofInput?.value || "1", 10);
    showStatus(`Sending challenge to ${esc(opponent)}...`, "var(--cyan-dim)", "var(--cyan)");
    try {
      const r = await fetch("/api/challenges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: myNametag, opponent, wager: Math.max(0, wager), bestOf })
      });
      const data = await r.json();
      if (!r.ok) {
        clearPending();
        showStatus(data.message || data.error || "Challenge failed", "rgba(218,54,51,0.1)", "var(--red)");
        return;
      }
      pendingChallenge = data.challengeId || "pending";
      pendingStart = Date.now();
      showPendingStatus(opponent);
      pendingTimer = setInterval(() => showPendingStatus(opponent), 1e3);
      setTimeout(() => {
        if (pendingChallenge) {
          clearPending();
          showStatus("Challenge expired \u2014 no response.", "rgba(218,54,51,0.1)", "var(--red)");
        }
      }, 32e3);
      render();
    } catch (err) {
      clearPending();
      showStatus("Could not reach server \u2014 check your connection", "rgba(218,54,51,0.1)", "var(--red)");
    }
  }
  function showPendingStatus(opponent) {
    const elapsed = Math.floor((Date.now() - pendingStart) / 1e3);
    const remaining = Math.max(0, 30 - elapsed);
    showStatus(
      `Challenge sent to ${esc(opponent)} \u2014 waiting for response (${remaining}s)`,
      "var(--cyan-dim)",
      "var(--cyan)",
      false
      // don't auto-hide
    );
  }
  function clearPending() {
    pendingChallenge = null;
    if (pendingTimer) {
      clearInterval(pendingTimer);
      pendingTimer = null;
    }
    render();
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
  var shownChallenges = /* @__PURE__ */ new Set();
  function showIncoming(msg) {
    const box = $("incoming-challenges");
    box.querySelectorAll(".challenge-incoming").forEach((el) => {
      if (el.getAttribute("data-from") === msg.from) el.remove();
    });
    if (shownChallenges.has(msg.challengeId)) return;
    shownChallenges.add(msg.challengeId);
    const div = document.createElement("div");
    div.className = "challenge-incoming";
    div.setAttribute("data-from", msg.from);
    const wagerText = msg.wager > 0 ? ` for <strong style="color:var(--orange)">${msg.wager} UCT</strong>` : "";
    const boText = msg.bestOf > 1 ? ` (best of ${msg.bestOf})` : "";
    div.innerHTML = `
		<span><strong>${esc(msg.from)}</strong> challenges you${wagerText}${boText}</span>
		<span>
			<button class="btn btn-primary" style="padding:8px 16px;font-size:10px" onclick="accept('${msg.challengeId}',this)">Accept</button>
			<button class="btn btn-ghost" style="padding:8px 16px;font-size:10px;margin-left:4px" onclick="decline('${msg.challengeId}',this)">Decline</button>
		</span>`;
    box.appendChild(div);
  }
  async function accept(id, btn) {
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
        showStatus(data.message || data.error || "Accept failed", "rgba(218,54,51,0.1)", "var(--red)");
        return;
      }
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
    } catch (err) {
      showStatus("Network error", "rgba(218,54,51,0.1)", "var(--red)");
    }
  }
  async function decline(id, btn) {
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
    const nameColor = isMe ? "var(--cyan)" : "var(--orange)";
    div.innerHTML = `<strong style="color:${nameColor}">${esc(from)}</strong> ${esc(text)}`;
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
      text.textContent = `Connected as ${myNametag || "?"} | ${onlinePlayers.length} online`;
    } else if (wsOk || lastRestOk) {
      dot.style.background = "#f97316";
      dot.style.boxShadow = "0 0 6px rgba(249,115,22,0.5)";
      text.style.color = "#f97316";
      text.textContent = wsOk ? "WS OK, REST issues" : "REST OK, WS reconnecting\u2026";
    } else {
      dot.style.background = "#c1121f";
      dot.style.boxShadow = "0 0 6px rgba(193,18,31,0.5)";
      text.style.color = "#c1121f";
      text.textContent = "Disconnected \u2014 reconnecting\u2026";
    }
  }
  var origPoll = setInterval(async () => {
    try {
      const r = await fetch("/api/online");
      lastRestOk = r.ok;
    } catch {
      lastRestOk = false;
    }
    updateNetStatus();
  }, 3e3);
  updateNetStatus();
  window.challenge = challenge;
  window.accept = accept;
  window.decline = decline;
  setInterval(async () => {
    if (!myNametag) return;
    try {
      const r = await fetch("/api/online");
      if (!r.ok) return;
      const { players } = await r.json();
      onlinePlayers = players || [];
      render();
    } catch {
    }
  }, 3e3);
  if (myNametag) fetch("/api/online").then((r) => r.json()).then((d) => {
    onlinePlayers = d.players || [];
    render();
  }).catch(() => {
  });
})();
