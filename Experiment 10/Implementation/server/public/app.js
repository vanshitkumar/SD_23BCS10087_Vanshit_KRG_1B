// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  userId: null,
  seatId: null,       // currently locked seat
  lockExpiry: null,   // Date when lock expires
  lockInterval: null,
  queuePosition: null,
  rlUsed: 0,
  logCount: 0,
  seats: {},
  queued: [],
};

// ─── DOM Helpers ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const API = (path, opts = {}) => fetch(`/api${path}`, {
  headers: { "Content-Type": "application/json", "x-user-id": state.userId },
  ...opts,
});

// ─── User ID ──────────────────────────────────────────────────────────────────
function genUserId() {
  return "USR-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function initUser() {
  state.userId = genUserId();
  $("user-id-display").textContent = state.userId;
  state.seatId = null;
  state.lockExpiry = null;
  clearInterval(state.lockInterval);
  $("lock-timer").style.display = "none";
  $("confirm-card").style.display = "none";
  $("success-card").style.display = "none";
  $("qs-position").textContent = "—";
  $("qs-total").textContent = "";
  log("USER", `New session: ${state.userId}`, "info");
}

// ─── SSE – Real-time Stream ───────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource("/api/stream");
  es.onopen = () => {
    $("conn-status").textContent = "CONNECTED";
    $("conn-status").classList.add("connected");
  };
  es.onerror = () => {
    $("conn-status").textContent = "RECONNECTING…";
    $("conn-status").classList.remove("connected");
  };
  es.onmessage = (e) => {
    const { type, payload } = JSON.parse(e.data);
    handleSSE(type, payload);
  };
}

function handleSSE(type, payload) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const principleMap = {
    redis_op: null,
    seat_locked: "p-distlock",
    lock_fail: "p-distlock",
    rate_check: "p-ratelimit",
    queue_join: "p-queue",
    cache_hit: "p-cache",
    cache_miss: "p-cache",
    booking_confirmed: "p-atomic",
    seat_unlocked: "p-ttl",
  };

  // Flash the relevant principle card
  const principleId = principleMap[type];
  if (principleId) flashPrinciple(principleId, type);

  // Flash architecture nodes
  flashArch(type);

  switch (type) {
    case "redis_op":
      addLogEntry(ts, payload.cmd, payload.result, type);
      break;
    case "seat_locked":
      addLogEntry(ts, `SEAT_LOCKED ${payload.seatId}`, `user=…${payload.userId} ttl=${payload.ttl}s`, type);
      flashPattern("pt-lock");
      loadSeats();
      break;
    case "seat_unlocked":
      addLogEntry(ts, `SEAT_UNLOCKED ${payload.seatId}`, `user=…${payload.userId}`, type);
      flashPattern("pt-ttl");
      loadSeats();
      break;
    case "lock_fail":
      addLogEntry(ts, `LOCK_FAIL ${payload.seatId}`, `user=…${payload.userId} → CONFLICT`, type);
      break;
    case "rate_check":
      updateRLGauge(payload.count);
      addLogEntry(ts, `RATE_CHECK user=…${payload.userId}`, `${payload.count}/${payload.limit} req`, type);
      break;
    case "queue_join":
      addLogEntry(ts, `QUEUE_JOIN user=…${payload.userId}`, `pos=${payload.position}/${payload.total}`, type);
      flashPattern("pt-queue");
      loadQueue();
      break;
    case "cache_hit":
      addLogEntry(ts, `CACHE HIT ${payload.key}`, "→ served from cache", type);
      flashPattern("pt-cache");
      break;
    case "cache_miss":
      addLogEntry(ts, `CACHE MISS ${payload.key}`, "→ fetched from Redis", type);
      break;
    case "booking_confirmed":
      addLogEntry(ts, `BOOKING_CONFIRMED ${payload.seatId}`, `id=${payload.bookingId}`, type);
      flashPattern("pt-atomic");
      loadSeats();
      loadQueue();
      loadStats();
      break;
    case "seats_update":
      loadSeats();
      loadStats();
      break;
    case "reset":
      addLogEntry(ts, "SYSTEM_RESET", "all seats → available", "info");
      loadSeats();
      loadStats();
      loadQueue();
      break;
  }
}

// ─── Architecture Pulse ───────────────────────────────────────────────────────
const archFlashMap = {
  redis_op: ["arch-redis"],
  seat_locked: ["arch-client", "arch-api", "arch-redis"],
  lock_fail: ["arch-redis"],
  rate_check: ["arch-rate"],
  queue_join: ["arch-api", "arch-redis"],
  cache_hit: ["arch-redis"],
  cache_miss: ["arch-redis"],
  booking_confirmed: ["arch-client", "arch-api", "arch-redis"],
  seat_unlocked: ["arch-redis"],
};

function flashArch(type) {
  const nodes = archFlashMap[type] || [];
  nodes.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.classList.add("active");
    setTimeout(() => el.classList.remove("active"), 800);
  });
}

function flashPrinciple(id, type) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 2000);
}

function flashPattern(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add("active");
  setTimeout(() => el.classList.remove("active"), 1500);
}

// ─── Log Terminal ─────────────────────────────────────────────────────────────
function addLogEntry(ts, cmd, result, type = "") {
  const terminal = $("log-terminal");
  state.logCount++;
  $("log-count").textContent = state.logCount;

  const entry = document.createElement("div");
  entry.className = `log-entry type-${type}`;
  entry.innerHTML = `<span class="log-ts">${ts}</span><span class="log-cmd">${escHtml(cmd)}</span><span class="log-result">→ ${escHtml(String(result))}</span>`;
  terminal.appendChild(entry);

  // Keep max 120 entries
  while (terminal.children.length > 120) terminal.removeChild(terminal.firstChild);
  terminal.scrollTop = terminal.scrollHeight;
}

function log(cmd, result, type = "") {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  addLogEntry(ts, cmd, result, type);
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Rate Limit Gauge ─────────────────────────────────────────────────────────
function updateRLGauge(used) {
  state.rlUsed = used;
  const pct = Math.min(100, (used / 10) * 100);
  $("rl-gauge").style.width = pct + "%";
  $("rl-used").textContent = used;
  const over = $("rl-429");
  over.style.display = used > 10 ? "block" : "none";
}

// ─── Load Event ───────────────────────────────────────────────────────────────
async function loadEvent() {
  const r = await API("/event");
  if (!r.ok) return;
  const d = await r.json();
  $("event-name").textContent = d.name;
  $("event-venue").textContent = d.venue;
  $("event-date").textContent = new Date(d.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  $("event-price").textContent = `₹${Number(d.price).toLocaleString("en-IN")}`;
  $("ci-event").textContent = d.name;
  $("ci-price").textContent = `₹${Number(d.price).toLocaleString("en-IN")}`;
}

// ─── Load Seats ───────────────────────────────────────────────────────────────
async function loadSeats() {
  const r = await API("/seats");
  if (!r.ok) return;
  const { seats } = await r.json();
  state.seats = seats;
  renderSeats(seats);
}

function renderSeats(seats) {
  const grid = $("seat-grid");
  grid.innerHTML = "";
  const seatIds = Object.keys(seats).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  seatIds.forEach((id) => {
    const status = seats[id];
    const isMe = id === state.seatId;
    const div = document.createElement("div");
    div.className = `seat ${isMe ? "mine" : status}`;
    div.title = `${id} — ${isMe ? "YOUR LOCK" : status.toUpperCase()}`;
    div.textContent = id.slice(1); // just the number

    if (status === "available") {
      div.addEventListener("click", () => lockSeat(id));
    }
    grid.appendChild(div);
  });
}

// ─── Load Stats ───────────────────────────────────────────────────────────────
async function loadStats() {
  const r = await API("/stats");
  if (!r.ok) return;
  const d = await r.json();
  const vals = document.querySelectorAll(".hstat-val");
  vals[0].textContent = d.available;
  vals[1].textContent = d.locked;
  vals[2].textContent = d.booked;
  vals[3].textContent = d.queueLen;
}

// ─── Load Queue ───────────────────────────────────────────────────────────────
async function loadQueue() {
  // We don't have a direct "list all" queue endpoint, so we just show a small visual
  // using position info and SSE data. For now we rebuild from periodic refresh.
  const r = await API(`/queue/position?userId=${encodeURIComponent(state.userId)}`);
  if (!r.ok) return;
  const d = await r.json();
  if (d.inQueue) {
    state.queuePosition = d.position;
    $("qs-position").textContent = `#${d.position}`;
    $("qs-total").textContent = `of ${d.total} in queue`;
    renderQueueList(d.position, d.total);
  } else {
    state.queuePosition = null;
    $("qs-position").textContent = "—";
    $("qs-total").textContent = "Not in queue";
    $("queue-list").innerHTML = `<div class="queue-empty">Queue is empty</div>`;
  }
}

function renderQueueList(myPos, total) {
  const list = $("queue-list");
  list.innerHTML = "";
  const show = Math.min(total, 8);
  for (let i = 1; i <= show; i++) {
    const item = document.createElement("div");
    const isMe = i === myPos;
    item.className = `queue-item${isMe ? " me" : ""}`;
    item.innerHTML = `
      <span class="qi-pos">#${i}</span>
      <span class="qi-id">${isMe ? state.userId : "USR-" + "×".repeat(6)}</span>
      ${i <= 6 ? `<span class="qi-badge">CAN BOOK</span>` : ""}
    `;
    list.appendChild(item);
  }
  if (total > show) {
    const more = document.createElement("div");
    more.className = "queue-empty";
    more.textContent = `+${total - show} more in queue`;
    list.appendChild(more);
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function joinQueue() {
  const r = await API("/queue/join", {
    method: "POST",
    body: JSON.stringify({ userId: state.userId }),
  });
  const d = await r.json();
  if (!r.ok) { showModal("ERROR", d.error); return; }
  log("QUEUE_JOIN", `pos=${d.position}/${d.total}`, "queue_join");
  await loadQueue();
}

async function lockSeat(seatId) {
  if (state.seatId) { showModal("ALREADY LOCKED", `You already have seat ${state.seatId} locked. Confirm or release it first.`); return; }
  if (!state.queuePosition) { showModal("NOT IN QUEUE", "You must join the queue before booking a seat."); return; }
  if (state.queuePosition > 6) { showModal("QUEUE POSITION", `Your position is #${state.queuePosition}. Must be in the top 6 to book.`); return; }

  const r = await API("/seats/lock", {
    method: "POST",
    body: JSON.stringify({ userId: state.userId, seatId }),
  });
  const d = await r.json();
  if (!r.ok) { showModal("LOCK FAILED", d.error); return; }

  state.seatId = seatId;
  state.lockExpiry = Date.now() + d.lockTTL * 1000;

  // Show timer
  $("lt-seat").textContent = seatId;
  $("lock-timer").style.display = "block";
  $("confirm-card").style.display = "block";
  $("ci-seat").textContent = seatId;
  $("ci-expiry").textContent = new Date(state.lockExpiry).toLocaleTimeString();

  startLockCountdown(d.lockTTL);
  renderSeats(state.seats);
  log("LOCK_ACQUIRED", `seat=${seatId} ttl=${d.lockTTL}s`, "seat_locked");
}

function startLockCountdown(seconds) {
  clearInterval(state.lockInterval);
  let remaining = seconds;
  state.lockInterval = setInterval(() => {
    remaining--;
    $("lt-countdown").textContent = remaining;
    if (remaining <= 0) {
      clearInterval(state.lockInterval);
      state.seatId = null;
      state.lockExpiry = null;
      $("lock-timer").style.display = "none";
      $("confirm-card").style.display = "none";
      loadSeats();
      showModal("LOCK EXPIRED", "Your seat lock expired. The seat has been released back to the pool.");
    }
  }, 1000);
}

async function releaseSeat() {
  if (!state.seatId) return;
  await API("/seats/unlock", {
    method: "POST",
    body: JSON.stringify({ userId: state.userId, seatId: state.seatId }),
  });
  clearInterval(state.lockInterval);
  $("lock-timer").style.display = "none";
  $("confirm-card").style.display = "none";
  state.seatId = null;
  loadSeats();
}

async function confirmBooking() {
  const r = await API("/booking/confirm", {
    method: "POST",
    body: JSON.stringify({ userId: state.userId, seatId: state.seatId }),
  });
  const d = await r.json();
  if (!r.ok) { showModal("BOOKING FAILED", d.error); return; }

  clearInterval(state.lockInterval);
  $("lock-timer").style.display = "none";
  $("confirm-card").style.display = "none";

  $("success-bid").textContent = d.bookingId;
  $("success-meta").textContent = `Seat ${d.seatId} · ${$("event-name").textContent}`;
  $("success-card").style.display = "block";

  state.seatId = null;
  log("BOOKING_CONFIRMED", d.bookingId, "booking_confirmed");
}

// ─── Simulate Traffic ─────────────────────────────────────────────────────────
async function simulateTraffic() {
  log("SIMULATE", "Injecting 15 rapid requests (triggers rate limiter)…", "info");
  for (let i = 0; i < 15; i++) {
    const fakeId = "USR-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    await API("/event", { headers: { "Content-Type": "application/json", "x-user-id": fakeId } });
    await API("/seats", { headers: { "Content-Type": "application/json", "x-user-id": fakeId } });
    await new Promise((r) => setTimeout(r, 80));
  }
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function showModal(title, body) {
  $("modal-title").textContent = title;
  $("modal-body").textContent = body;
  $("modal-overlay").style.display = "flex";
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
$("btn-new-user").addEventListener("click", () => {
  releaseSeat().then(initUser);
});
$("btn-join-queue").addEventListener("click", joinQueue);
$("btn-release").addEventListener("click", releaseSeat);
$("btn-confirm").addEventListener("click", confirmBooking);
$("btn-book-again").addEventListener("click", () => {
  $("success-card").style.display = "none";
  loadSeats();
});
$("btn-reset").addEventListener("click", async () => {
  clearInterval(state.lockInterval);
  state.seatId = null;
  $("lock-timer").style.display = "none";
  $("confirm-card").style.display = "none";
  await API("/reset", { method: "POST" });
  await loadSeats();
  await loadStats();
  await loadQueue();
});
$("btn-sim").addEventListener("click", simulateTraffic);

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  initUser();
  connectSSE();
  await loadEvent();
  await loadSeats();
  await loadStats();

  // Periodic refresh
  setInterval(loadStats, 3000);
  setInterval(loadQueue, 4000);
  setInterval(loadSeats, 6000);
})();
