import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import Redis from "ioredis";
import { Pool } from "pg";
import crypto from "crypto";
import "dotenv/config";

const PORT = 4000;
// Prefer env, but fall back to provided key for local/dev if not set
const MORALIS_API_KEY =
  process.env.MORALIS_API_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjdiMmI3NDljLWM5MzctNDczMi05MDlhLTMxZDBhYTg1MmRiZCIsIm9yZ0lkIjoiNDMyMjM4IiwidXNlcklkIjoiNDQ0NjE5IiwidHlwZUlkIjoiMjdmZTdmYmMtNTY2NS00YWZjLWJlNTctODIwOWQwZjhlNGRhIiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3Mzk4NzQxMzAsImV4cCI6NDg5NTYzNDEzMH0.VaTcj5x_esHxnOQwiA5gGQ7-Sk-3zIyl0bW0ZP_GT2o";

const app = express();
app.use(
  cors({
    origin: true, // reflect request origin
    credentials: true,
  })
);
app.use(express.json());
const server = http.createServer(app);

const redis = new Redis(process.env.REDIS_URL);
const subscriber = new Redis(process.env.REDIS_URL);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Client connected to WebSocket");
  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      // 1 means OPEN
      client.send(data);
    }
  });
}

subscriber.subscribe("new_contracts", (err) => {
  if (err) {
    console.error("Failed to subscribe to Redis channel:", err);
  } else {
    console.log("Subscribed to new_contracts channel on Redis.");
  }
});

subscriber.on("message", (channel, message) => {
  console.log(`Received message from ${channel}: ${message}`);
  broadcast(message);
});

app.get("/contracts", async (req, res) => {
  try {
    // Prefer sorted order by recency using a Redis list of events.
    // Fallback to unsorted hash merge if list is not available.
    const events = await redis.lrange("contract_events", 0, -1);
    if (events && events.length > 0) {
      // Support new labels (basic/premium) and gracefully map legacy (calls/nitro)
      const allowed = new Set(["basic", "premium", "calls", "nitro"]);
      const seen = new Set();
      const result = [];
      for (const item of events) {
        try {
          const { address, channelName } = JSON.parse(item);
          let ch = (channelName || "basic").toString().toLowerCase();
          if (!allowed.has(ch)) continue;
          // Normalize legacy values to new ones in the response array
          if (ch === "calls") ch = "basic";
          if (ch === "nitro") ch = "premium";
          if (seen.has(address)) continue;
          seen.add(address);
          result.push([address, ch]);
        } catch (_) {}
      }
      // Newest-first already (we LPUSH in the bot)
      res.json(result);
      return;
    }

    // Fallback: merge hashes (order unspecified)
    // Prefer new keys if present, but still include legacy
    const basic = await redis.hgetall("contract_origins:basic");
    const premium = await redis.hgetall("contract_origins:premium");
    const calls = await redis.hgetall("contract_origins:calls");
    const nitro = await redis.hgetall("contract_origins:nitro");
    const legacy = await redis.hgetall("contract_origins");
    const combined = { ...(legacy || {}) };
    // Merge new labels first
    Object.entries(basic || {}).forEach(([addr, channel]) => {
      combined[addr] = "basic";
    });
    Object.entries(premium || {}).forEach(([addr, channel]) => {
      combined[addr] = "premium";
    });
    // Merge legacy and normalize to new labels
    Object.entries(calls || {}).forEach(([addr, channel]) => {
      combined[addr] = "basic";
    });
    Object.entries(nitro || {}).forEach(([addr, channel]) => {
      combined[addr] = "premium";
    });
    res.json(combined);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch contracts from Redis" });
  }
});

// Fetch token information from DexScreener API
app.get("/token-info/:address", async (req, res) => {
  try {
    const { address } = req.params;

    if (!address) {
      return res.status(400).json({ error: "Token address is required" });
    }

    // Check Redis cache first (cache for 5 minutes)
    const cacheKey = `token_info:${address}`;
    const cachedData = await redis.get(cacheKey);

    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }

    // First try DexScreener token profiles API for metadata
    const profileResponse = await fetch(
      `https://api.dexscreener.com/token-profiles/latest/v1`
    );

    let profileData = [];
    if (profileResponse.ok) {
      profileData = await profileResponse.json();
    }

    // Find profile for this token
    const tokenProfile = profileData.find(
      (profile) => profile.tokenAddress.toLowerCase() === address.toLowerCase()
    );

    // Also fetch from the trading pairs API for price/market data
    const pairsResponse = await fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${address}`
    );

    let pairsData = [];
    if (pairsResponse.ok) {
      pairsData = await pairsResponse.json();
    }

    // Extract useful information
    const tokenInfo = {
      address,
      pairs: pairsData || [],
      // Get the best pair (first one is usually the main pair)
      bestPair: pairsData?.[0] || null,
      profile: tokenProfile || null,
    };

    // Add profile info if available (name, symbol, icon)
    if (tokenProfile) {
      tokenInfo.name = tokenProfile.name;
      tokenInfo.symbol = tokenProfile.symbol;
      tokenInfo.icon = tokenProfile.icon;
      tokenInfo.description = tokenProfile.description;
      tokenInfo.links = tokenProfile.links;
    }

    // Add trading data if available
    if (tokenInfo.bestPair) {
      // Use profile data if available, otherwise fall back to trading data
      if (!tokenInfo.name) tokenInfo.name = tokenInfo.bestPair.baseToken?.name;
      if (!tokenInfo.symbol)
        tokenInfo.symbol = tokenInfo.bestPair.baseToken?.symbol;

      tokenInfo.price = tokenInfo.bestPair.priceUsd;
      tokenInfo.priceChange24h = tokenInfo.bestPair.priceChange?.h24;
      tokenInfo.volume24h = tokenInfo.bestPair.volume?.h24;
      tokenInfo.liquidity = tokenInfo.bestPair.liquidity?.usd;
      tokenInfo.marketCap =
        tokenInfo.bestPair.marketCap || tokenInfo.bestPair.fdv;
      tokenInfo.dexId = tokenInfo.bestPair.dexId;
      tokenInfo.chainId = tokenInfo.bestPair.chainId;
      tokenInfo.pairAddress = tokenInfo.bestPair.pairAddress; // This is what we need for the buy URL
    }

    // Prefer Moralis for icon (logo) when available
    try {
      const moralisAddress = tokenInfo?.bestPair?.baseToken?.address || address;
      console.log(
        `[Moralis] Requesting metadata for ${address} (envKey=${Boolean(
          process.env.MORALIS_API_KEY
        )}) using mint=${moralisAddress}`
      );
      const moralisResp = await fetch(
        `https://solana-gateway.moralis.io/token/mainnet/${moralisAddress}/metadata`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            "X-API-Key": MORALIS_API_KEY,
          },
        }
      );
      console.log(
        `[Moralis] Response status for ${moralisAddress}: ${moralisResp.status}`
      );
      if (!moralisResp.ok) {
        console.warn(
          `Moralis metadata fetch failed for ${moralisAddress}: HTTP ${moralisResp.status}`
        );
      } else {
        const moralisJson = await moralisResp.json();
        const moralisLogo = moralisJson?.logo;
        tokenInfo.moralis = {
          mint: moralisJson?.mint,
          name: moralisJson?.name,
          symbol: moralisJson?.symbol,
          logo: moralisLogo || null,
          tokenStandard: moralisJson?.tokenStandard,
        };
        if (moralisLogo) {
          tokenInfo.icon = moralisLogo;
          console.log(
            `[Moralis] Logo found for ${moralisAddress}: ${moralisLogo}`
          );
        } else {
          console.warn(`Moralis returned no logo for ${moralisAddress}`);
        }
      }
    } catch (e) {
      console.warn("Moralis logo fetch error", e?.message || e);
    }

    // Cache for 5 minutes
    await redis.setex(cacheKey, 300, JSON.stringify(tokenInfo));

    res.json(tokenInfo);
  } catch (error) {
    console.error("Token info fetch error:", error);
    res.status(500).json({
      error: "Failed to fetch token information",
      address: req.params.address,
    });
  }
});

server.listen(PORT, () => {
  console.log(`API Server listening on http://localhost:${PORT}`);
});

// ----------------------------
// Licensing: Postgres storage
// ----------------------------

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://neondb_owner:npg_0fUIGJYzwK3b@ep-misty-mouse-advrd4e3-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

const pgPool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureLicenseTable() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      license_key TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT false
    );
  `);
}

function generateLicenseKey() {
  const bytes = crypto.randomBytes(10).toString("hex").toUpperCase();
  // Make groups of 4: XXXX-XXXX-XXXX-XXXX-XXXX
  const groups = bytes.match(/.{1,4}/g).slice(0, 5);
  return `PLS-${groups.join("-")}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Call on boot
ensureLicenseTable().catch((e) => {
  console.error("Failed to ensure licenses table:", e);
});

// Purchase a license (free for now), returns a license key
// Body: { tier: "monthly" | "yearly" }
app.post("/license/purchase", async (req, res) => {
  try {
    const { tier } = req.body || {};
    if (!tier || !["monthly", "yearly"].includes(tier)) {
      return res.status(400).json({ error: "Invalid tier" });
    }

    const licenseKey = generateLicenseKey();
    const now = new Date();
    const expiresAt = tier === "yearly" ? addDays(now, 365) : addDays(now, 30);

    await pgPool.query(
      `INSERT INTO licenses (license_key, tier, created_at, expires_at, revoked)
       VALUES ($1, $2, now(), $3, false)`,
      [licenseKey, tier, expiresAt]
    );

    res.json({ licenseKey, tier, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    console.error("/license/purchase error", err);
    res.status(500).json({ error: "Failed to purchase license" });
  }
});

// Status: validates a license key if provided via query (?key=)
// Response: { active, tier?, expiresAt? }
app.get("/license/status", async (req, res) => {
  try {
    const key = (req.query.key || "").toString().trim();
    if (!key) {
      return res.json({ active: false });
    }
    const { rows } = await pgPool.query(
      `SELECT tier, expires_at, revoked FROM licenses WHERE license_key = $1`,
      [key]
    );
    if (!rows.length) return res.json({ active: false });
    const lic = rows[0];
    const now = new Date();
    const active = !lic.revoked && new Date(lic.expires_at) > now;
    res.json({
      active,
      tier: lic.tier,
      expiresAt: new Date(lic.expires_at).toISOString(),
    });
  } catch (err) {
    console.error("/license/status error", err);
    res.status(200).json({ active: false });
  }
});
