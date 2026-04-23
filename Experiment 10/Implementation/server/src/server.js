const express = require("express");
const { createClient } = require("redis");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "../public")));

// ─── Redis Client ─────────────────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
redis.on("error", (e) => console.error("[Redis Error]", e));

// ─── SSE Broadcast ────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(type, payload) {
  const msg = `data: ${JSON.stringify({ type, payload, ts: Date.now() })}\n\n`;
  sseClients.forEach((res) => res.write(msg));
}

// Monkey-patch redis calls to broadcast ops for the live log
const originalSendCommand = redis.sendCommand.bind(redis);
redis.sendCommand = async function (...args) {
  const result = await originalSendCommand(...args);
  const cmd = Array.isArray(args[0]) ? args[0].join(" ") : String(args[0]);
  if (!cmd.startsWith("PING") && !cmd.startsWith("CLIENT")) {
    broadcast("redis_op", { cmd: cmd.substring(0, 120), result: truncate(result) });
  }
  return result;
};

function truncate(v) {
  if (v === null || v === undefined) return "nil";
  const s = Array.isArray(v) ? `[${v.slice(0, 3).join(", ")}${v.length > 3 ? "…" : ""}]` : String(v);
  return s.length > 60 ? s.substring(0, 60) + "…" : s;
}

// ─── Seed Data ────────────────────────────────────────────────────────────────
const EVENT_ID = "evt_001";
const TOTAL_SEATS = 48;
const LOCK_TTL = 120; // seconds

async function seedEvent() {
  const exists = await redis.exists(`event:${EVENT_ID}:meta`);
  if (exists) return;

  await redis.hSet(`event:${EVENT_ID}:meta`, {
    id: EVENT_ID,
    name: "Coldplay: Music of the Spheres",
    venue: "DY Patil Stadium, Mumbai",
    date: "2025-08-15T19:30:00",
    totalSeats: TOTAL_SEATS,
    price: 4999,
    category: "CONCERT",
  });

  for (let i = 1; i <= TOTAL_SEATS; i++) {
    await redis.hSet(`event:${EVENT_ID}:seats`, `S${String(i).padStart(2, "0")}`, "available");
  }

  await redis.set(`event:${EVENT_ID}:booked_count`, 0);
  await redis.set(`event:${EVENT_ID}:locked_count`, 0);

  console.log("[Seed] Event and seats initialized in Redis");
}

// ─── Middleware: Rate Limiter (Sliding Window via Redis ZSET) ─────────────────
//   PRINCIPLE: Each user can make at most MAX_REQ requests per WINDOW_MS
//              The sorted set stores timestamps; old entries are pruned each call.
const MAX_REQ = 10;
const WINDOW_MS = 10000; // 10s window

async function rateLimiter(req, res, next) {
  const userId = req.headers["x-user-id"] || req.ip;
  const key = `rate:${userId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const multi = redis.multi();
  multi.zRemRangeByScore(key, "-inf", windowStart); // prune old
  multi.zAdd(key, { score: now, value: `${now}` }); // add current
  multi.zCard(key); // count
  multi.expire(key, Math.ceil(WINDOW_MS / 1000));
  const [, , count] = await multi.exec();

  res.setHeader("X-RateLimit-Limit", MAX_REQ);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, MAX_REQ - count));
  broadcast("rate_check", { userId: userId.slice(-6), count, limit: MAX_REQ });

  if (count > MAX_REQ) {
    return res.status(429).json({ error: "Rate limit exceeded. Slow down!", count, limit: MAX_REQ });
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// SSE endpoint for real-time push to frontend
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// GET /api/event — with Redis caching (30s TTL)
//   PRINCIPLE: Avoid hitting primary store on every request; serve from cache
app.get("/api/event", rateLimiter, async (req, res) => {
  const cacheKey = `cache:event:${EVENT_ID}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    broadcast("cache_hit", { key: cacheKey });
    return res.json({ ...JSON.parse(cached), cached: true });
  }

  const meta = await redis.hGetAll(`event:${EVENT_ID}:meta`);
  const data = { ...meta, price: Number(meta.price), totalSeats: Number(meta.totalSeats) };
  await redis.setEx(cacheKey, 30, JSON.stringify(data));
  broadcast("cache_miss", { key: cacheKey });
  res.json({ ...data, cached: false });
});

// GET /api/seats — live seat map from Redis Hash
app.get("/api/seats", rateLimiter, async (req, res) => {
  const seats = await redis.hGetAll(`event:${EVENT_ID}:seats`);
  const stats = {
    available: 0, locked: 0, booked: 0,
  };
  Object.values(seats).forEach((s) => { if (stats[s] !== undefined) stats[s]++; });
  res.json({ seats, stats });
});

// GET /api/stats — aggregate stats
app.get("/api/stats", async (req, res) => {
  const seats = await redis.hGetAll(`event:${EVENT_ID}:seats`);
  const queueLen = await redis.zCard(`queue:${EVENT_ID}`);
  let available = 0, locked = 0, booked = 0;
  Object.values(seats).forEach((s) => {
    if (s === "available") available++;
    else if (s === "locked") locked++;
    else if (s === "booked") booked++;
  });
  res.json({ available, locked, booked, queueLen, total: TOTAL_SEATS });
});

// POST /api/queue/join — join the virtual waiting queue (Redis Sorted Set by timestamp)
//   PRINCIPLE: ZADD with timestamp score ensures FIFO ordering; ZRANK gives position
app.post("/api/queue/join", rateLimiter, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const qKey = `queue:${EVENT_ID}`;
  const existing = await redis.zRank(qKey, userId);
  if (existing !== null) {
    const total = await redis.zCard(qKey);
    return res.json({ position: existing + 1, total, alreadyInQueue: true });
  }

  await redis.zAdd(qKey, { score: Date.now(), value: userId });
  const position = (await redis.zRank(qKey, userId)) + 1;
  const total = await redis.zCard(qKey);
  broadcast("queue_join", { userId: userId.slice(-6), position, total });
  res.json({ position, total, alreadyInQueue: false });
});

// GET /api/queue/position
app.get("/api/queue/position", rateLimiter, async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const rank = await redis.zRank(`queue:${EVENT_ID}`, userId);
  const total = await redis.zCard(`queue:${EVENT_ID}`);
  res.json({ position: rank !== null ? rank + 1 : null, total, inQueue: rank !== null });
});

// POST /api/seats/lock — Distributed Lock using SET NX EX
//   PRINCIPLE: Atomic "set if not exists" prevents two users locking the same seat.
//              Lock expires after LOCK_TTL seconds (no deadlock risk).
app.post("/api/seats/lock", rateLimiter, async (req, res) => {
  const { userId, seatId } = req.body;
  if (!userId || !seatId) return res.status(400).json({ error: "userId and seatId required" });

  // Check queue — user must be near the front
  const rank = await redis.zRank(`queue:${EVENT_ID}`, userId);
  if (rank === null) return res.status(403).json({ error: "Not in queue. Join the queue first." });
  if (rank > 5) return res.status(403).json({ error: `Queue position ${rank + 1}. Must be in top 6 to book.` });

  // Check seat is available
  const status = await redis.hGet(`event:${EVENT_ID}:seats`, seatId);
  if (status !== "available") return res.status(409).json({ error: `Seat ${seatId} is ${status}` });

  // Attempt distributed lock — SET NX EX (atomic)
  const lockKey = `lock:${EVENT_ID}:${seatId}`;
  const acquired = await redis.set(lockKey, userId, { NX: true, EX: LOCK_TTL });

  if (!acquired) {
    broadcast("lock_fail", { seatId, userId: userId.slice(-6) });
    return res.status(409).json({ error: `Seat ${seatId} is being locked by another user` });
  }

  // Update seat status in Hash
  await redis.hSet(`event:${EVENT_ID}:seats`, seatId, "locked");
  await redis.incr(`event:${EVENT_ID}:locked_count`);

  broadcast("seat_locked", { seatId, userId: userId.slice(-6), ttl: LOCK_TTL });
  broadcast("seats_update", {});

  res.json({ success: true, seatId, lockTTL: LOCK_TTL, message: `Seat ${seatId} locked for ${LOCK_TTL}s` });
});

// POST /api/seats/unlock — Release a lock (user abandoned)
app.post("/api/seats/unlock", async (req, res) => {
  const { userId, seatId } = req.body;
  const lockKey = `lock:${EVENT_ID}:${seatId}`;
  const owner = await redis.get(lockKey);
  if (owner !== userId) return res.status(403).json({ error: "Not your lock" });

  await redis.del(lockKey);
  await redis.hSet(`event:${EVENT_ID}:seats`, seatId, "available");
  broadcast("seat_unlocked", { seatId, userId: userId.slice(-6) });
  broadcast("seats_update", {});
  res.json({ success: true });
});

// POST /api/booking/confirm — Confirm booking with atomic MULTI/EXEC
//   PRINCIPLE: MULTI/EXEC ensures seat status flip + count increment are atomic;
//              user is removed from queue and lock is deleted in same transaction.
app.post("/api/booking/confirm", rateLimiter, async (req, res) => {
  const { userId, seatId } = req.body;
  if (!userId || !seatId) return res.status(400).json({ error: "userId and seatId required" });

  const lockKey = `lock:${EVENT_ID}:${seatId}`;
  const owner = await redis.get(lockKey);
  if (owner !== userId) return res.status(403).json({ error: "Lock not held by this user or expired" });

  // ATOMIC transaction: mark seat booked + remove lock + update counter + remove from queue
  const multi = redis.multi();
  multi.hSet(`event:${EVENT_ID}:seats`, seatId, "booked");
  multi.del(lockKey);
  multi.incr(`event:${EVENT_ID}:booked_count`);
  multi.zRem(`queue:${EVENT_ID}`, userId);
  multi.del(`cache:event:${EVENT_ID}`); // invalidate cache
  await multi.exec();

  const bookingId = `BK-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  broadcast("booking_confirmed", { seatId, userId: userId.slice(-6), bookingId });
  broadcast("seats_update", {});

  res.json({ success: true, bookingId, seatId, message: "Booking confirmed!" });
});

// POST /api/reset — dev helper to reset all seats
app.post("/api/reset", async (req, res) => {
  const multi = redis.multi();
  for (let i = 1; i <= TOTAL_SEATS; i++) {
    const id = `S${String(i).padStart(2, "0")}`;
    multi.hSet(`event:${EVENT_ID}:seats`, id, "available");
    multi.del(`lock:${EVENT_ID}:${id}`);
  }
  multi.del(`queue:${EVENT_ID}`);
  multi.del(`cache:event:${EVENT_ID}`);
  multi.set(`event:${EVENT_ID}:booked_count`, 0);
  multi.set(`event:${EVENT_ID}:locked_count`, 0);
  await multi.exec();
  broadcast("reset", {});
  res.json({ success: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  await redis.connect();
  await seedEvent();
  app.listen(3000, () => console.log("[Server] Running on http://localhost:3000"));
})();
