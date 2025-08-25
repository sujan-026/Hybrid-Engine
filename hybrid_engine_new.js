
/**
 * hybrid_engine.js – Deployment‑ready Hybrid AMM ↔ CDA engine
 * -----------------------------------------------------------
 * 1. Pure in‑memory maths for ultra‑low latency.
 * 2. All Strapi DB touches are marked  ▶▶ DB: …  – replace with your
 *    own Strapi SDK / knex / prisma calls (inside a tx where noted).
 *
 *   $ npm i express decimal.js uuid
 *   $ node hybrid_engine.js
 *
 *   (docker‑compose / pm2 highly recommended for prod ops)
 * -----------------------------------------------------------
 *  Strapi collections touched:
 *    • Market  • Outcome  • AMM State  • Order Book
 *    • Trade   • Position • Market Analytics • User
 * -----------------------------------------------------------
 */

const express = require('express');
const Decimal = require('decimal.js');
const { v4: uuid } = require('uuid');
const cors = require('cors');

const app  = express();
app.use(express.json());
app.use(cors()); // Allow cross-origin requests for frontend integration

// ─────────────── Config / constants ───────────────
const B_PARAM_DEFAULT  = new Decimal(10);          // LMSR liquidity
const USER_THRESHOLD   = 250;                       // switch criterion
const MAX_PRICE_IMPACT = 0.10;                      // 10 %
const MAX_CDA_MOVE     = 0.05;                      // 5 %
const MIN_CDA_LIQ      = new Decimal(1_000);        // qty before CDA
const PRICE_SCALE      = 100;                       // price 0‑100

let   COLLATERAL_BUCKET = new Decimal(1_000_000);   // stable‑coin pool

// ───────────────────────── AMM (LMSR) ─────────────────────────
class AMMState {
  constructor (marketId, outcomes, b = B_PARAM_DEFAULT) {
    this.marketId = marketId;
    this.b        = new Decimal(b);
    this.q        = outcomes.map(() => new Decimal(0)); // shares
    this.volume   = new Decimal(0);
    this.trades   = 0;
    this.active   = new Set();
  }

  _cost (qArr) {                    // C(q) = b ln Σ e^{q_i/b}
    const sumExp = qArr
      .map(q => Decimal.exp(q.div(this.b)))
      .reduce((a, b) => a.add(b), new Decimal(0));
    return this.b.mul(Decimal.ln(sumExp));
  }

  prices () {
    const exp = this.q.map(q => Decimal.exp(q.div(this.b)));
    const tot = exp.reduce((a, b) => a.add(b), new Decimal(0));
    return exp.map(e => e.div(tot).mul(PRICE_SCALE).toNumber());
  }

  _priceImpact (i, dQ) {
    const pNow = this.prices()[i];
    const qNew = this.q.map((q, idx) => idx === i ? q.add(dQ) : q);
    const pNew = (() => {
      const exp = qNew.map(q => Decimal.exp(q.div(this.b)));
      const tot = exp.reduce((a, b) => a.add(b), new Decimal(0));
      return exp[i].div(tot).mul(PRICE_SCALE).toNumber();
    })();
    return Math.abs(pNew - pNow) / pNow;
  }

  buy (userId, outcomeIdx, shares) {
    const dQ = new Decimal(shares);
    if (this._priceImpact(outcomeIdx, dQ) > MAX_PRICE_IMPACT) {
      throw new Error('Trade exceeds max price impact');
    }

    const newQ = this.q.map((q, idx) => idx === outcomeIdx ? q.add(dQ) : q);
    const cost = this._cost(newQ).minus(this._cost(this.q));

    // Collateral guard
    if (COLLATERAL_BUCKET.lessThan(cost)) {
      throw new Error('Insufficient collateral in vault');
    }

    this.q        = newQ;
    this.volume   = this.volume.add(cost);
    this.trades  += 1;
    this.active.add(userId);
    COLLATERAL_BUCKET = COLLATERAL_BUCKET.minus(cost);

    return cost.toNumber();        // ₹
  }
}

// ───────────────────────── CDA order‑book ─────────────────────────
class Order {
  constructor ({ userId, side, price, qty }) {
    if (!['buy', 'sell'].includes(side)) {
      throw new Error('side must be buy|sell');
    }
    this.id       = uuid();
    this.userId   = userId;
    this.side     = side;
    this.price    = new Decimal(price);
    this.qtyTotal = new Decimal(qty);
    this.qtyLeft  = new Decimal(qty);
    this.ts       = Date.now();
  }
}

class CDAOrderBook {
  constructor () {
    this.bids   = [];   // sorted desc price, asc ts
    this.asks   = [];   // sorted asc  price, asc ts
    this.trades = [];
    this.active = new Set();
    this.last   = null;
    this.totalLiq = new Decimal(0);
  }

  _insert (arr, order, reverse = false) {
    arr.push(order);
    arr.sort((a, b) => {
      if (a.price.equals(b.price)) return a.ts - b.ts;
      return reverse ? b.price.minus(a.price) : a.price.minus(b.price);
    });
  }

  place (order) {
    this.totalLiq = this.totalLiq.add(order.qtyLeft);
    if (this.totalLiq.lessThan(MIN_CDA_LIQ)) {
      throw new Error('CDA not live – insufficient liquidity');
    }
    this.active.add(order.userId);

    if (order.side === 'buy') {
      this._insert(this.bids, order, true);
    } else {
      this._insert(this.asks, order);
    }
    this._match();
    return order.id;
  }

  _clamp (price) {
    if (!this.last) return price;
    const maxMove = this.last.mul(MAX_CDA_MOVE);
    return Decimal.max(
      new Decimal(0.1),
      Decimal.min(price, this.last.add(maxMove))
    );
  }

  _match () {
    while (this.bids.length && this.asks.length &&
           this.bids[0].price.greaterThanOrEqualTo(this.asks[0].price)) {

      const buy  = this.bids[0];
      const sell = this.asks[0];
      const qty  = Decimal.min(buy.qtyLeft, sell.qtyLeft);
      const px   = this._clamp(buy.price.add(sell.price).div(2));

      // ▶▶ DB: INSERT Trade (buyUserId, sellUserId, qty, price, ts, marketId)
      // ▶▶ DB: UPDATE UserBalances & Positions (atomic transaction)

      buy.qtyLeft  = buy.qtyLeft.minus(qty);
      sell.qtyLeft = sell.qtyLeft.minus(qty);
      this.last    = px;
      this.trades.push({ buy: buy.userId,
                         sell: sell.userId,
                         qty: qty.toNumber(),
                         price: px.toNumber(),
                         ts: Date.now() });

      if (buy.qtyLeft.isZero())  this.bids.shift();
      if (sell.qtyLeft.isZero()) this.asks.shift();
    }
  }
}

// ─────────────────────── In‑memory registry ───────────────────────
const MARKETS = new Map();   // marketId → { amm, ob, mode }

/** Load (or bootstrap) a market */
function loadMarket (marketId) {
  if (MARKETS.has(marketId)) return MARKETS.get(marketId);

  // ▶▶ DB: find Market by ID – throw 404 if absent
  const outcomes = ['Yes', 'No'];  // ▶▶ DB: Outcome.find({ market: marketId })

  const meta = {
    amm  : new AMMState(marketId, outcomes),
    ob   : new CDAOrderBook(),
    mode : 'AMM'
  };
  MARKETS.set(marketId, meta);
  return meta;
}

function maybeSwitch (meta) {
  const uniq = new Set([...meta.amm.active, ...meta.ob.active]).size;
  if (meta.mode === 'AMM' && uniq >= USER_THRESHOLD) meta.mode = 'CDA';
  if (meta.mode === 'CDA' && uniq < USER_THRESHOLD)  meta.mode = 'AMM';
}

// ───────────────────────── API routes ─────────────────────────
// Create a new market (for each event)
app.post('/markets', (req, res) => {
  const { marketId, outcomes } = req.body;
  if (!marketId || !Array.isArray(outcomes) || outcomes.length < 2) {
    return res.status(400).json({ error: 'marketId and at least 2 outcomes required' });
  }
  if (MARKETS.has(marketId)) {
    return res.status(409).json({ error: 'Market already exists' });
  }
  const meta = {
    amm  : new AMMState(marketId, outcomes),
    ob   : new CDAOrderBook(),
    mode : 'AMM'
  };
  MARKETS.set(marketId, meta);
  res.json({ marketId, outcomes });
});

// put this near the bottom, BEFORE app.listen(...)
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, mode: MARKETS.size ? 'ready' : 'boot', ts: Date.now() });
});

// List all markets
app.get('/markets', (req, res) => {
  const all = Array.from(MARKETS.entries()).map(([id, meta]) => ({
    marketId: id,
    outcomes: meta.amm.q.length,
    mode: meta.mode
  }));
  res.json(all);
});

// Get market info
app.get('/markets/:id', (req, res) => {
  const { id } = req.params;
  if (!MARKETS.has(id)) {
    return res.status(404).json({ error: 'Market not found' });
  }
  const meta = MARKETS.get(id);
  res.json({
    marketId: id,
    mode: meta.mode,
    outcomes: meta.amm.q.length,
    activeUsers: new Set([...meta.amm.active, ...meta.ob.active]).size
  });
});

app.post('/markets/:id/amm/trade', (req, res) => {
  console.log('RAW Body', req.body);
  const { id } = req.params;
  const { userId, shares, outcome } = req.body;
  const meta = loadMarket(id);

  if (meta.mode !== 'AMM') {
    return res.status(409).json({ error: 'Market in CDA mode' });
  }

  try {
    const cost = meta.amm.buy(userId, outcome, shares);

    // ▶▶ DB: INSERT Trade  (side: 'Buy', qty: shares, price: meta.amm.prices()[outcome])
    // ▶▶ DB: UPSERT Position  (userId, marketId, shares, avgPrice)
    // ▶▶ DB: UPDATE AMM State  (q[], volume, trades, lastUpdated)

    res.json({
      mode          : meta.mode,
      cost_inr      : cost,
      newPrice      : meta.amm.prices()[outcome],
      allPrices     : meta.amm.prices(),
      collateralLeft: COLLATERAL_BUCKET.toNumber()
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/markets/:id/cda/order', (req, res) => {
  const { id } = req.params;
  const { userId, side, price, qty } = req.body;
  const meta = loadMarket(id);
  meta.mode = 'CDA';   // first order toggles mode

  try {
    const order = new Order({ userId, side, price, qty });
    const orderId = meta.ob.place(order);

    // ▶▶ DB: INSERT OrderBook (side, price, qtyLeft, status, ts, marketId, userId)
    // ▶▶ DB: For each newly matched trade in meta.ob.trades → INSERT Trade rows

    const bestBid = meta.ob.bids[0]?.price.toNumber() ?? null;
    const bestAsk = meta.ob.asks[0]?.price.toNumber() ?? null;

    res.json({
      mode     : meta.mode,
      orderId,
      lastPrice: meta.ob.last?.toNumber() ?? null,
      spread   : (bestBid !== null && bestAsk !== null)
                   ? bestAsk - bestBid
                   : null
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/markets/:id/quote', (req, res) => {
  const { id } = req.params;
  const meta = loadMarket(id);
  maybeSwitch(meta);

  if (meta.mode === 'AMM') {
    return res.json({ mode: 'AMM', prices: meta.amm.prices() });
  }
  const bid = meta.ob.bids[0]?.price.toNumber() ?? null;
  const ask = meta.ob.asks[0]?.price.toNumber() ?? null;
  res.json({ mode: 'CDA', bid, ask, last: meta.ob.last?.toNumber() ?? null });
});

// ─────────────────── analytics snapshot (daily) ───────────────────
function dailyAnalyticsSnapshot () {
  for (const [id, meta] of MARKETS) {
    const openInterest = meta.amm.q.reduce((a, b) => a.add(b), new Decimal(0))
                           .add(meta.ob.totalLiq);
    const traders      = new Set([...meta.amm.active, ...meta.ob.active]).size;

    // ▶▶ DB: UPSERT MarketAnalytics
    //     openInterest, activeTraders, windowStart, windowEnd
  }
}
setInterval(dailyAnalyticsSnapshot, 86_400_000); // 24 h

// ─────────────────────────── server up ────────────────────────────
const PORT = process.env.PORT || 8000;
app.listen(PORT, () =>
  console.log(`Hybrid engine live at http://localhost:${PORT}`)
);
