import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import crypto from 'node:crypto';
import { createSessionToken, verifySessionToken, encryptSecret, decryptSecret, makeIdentifier, newBatchId } from './security.js';
import { upbitRequest, publicRequest, marketCode, floorToTick, volumeForFunds } from './upbit.js';

const { Pool } = pg;
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be configured with a long random value.');
if (Buffer.from(process.env.ENCRYPTION_KEY || '', 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
if (isProd && process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' } }));

const USERS = {
  '오주': process.env.OZU_PASSWORD_HASH,
  '혜령': process.env.HYERYEONG_PASSWORD_HASH
};

async function initializeDatabase() {
  const schema = `
  CREATE TABLE IF NOT EXISTS exchange_credentials (
    user_id TEXT PRIMARY KEY CHECK (user_id IN ('오주','혜령')),
    access_key_ciphertext TEXT NOT NULL,
    secret_key_ciphertext TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS order_batches (
    id UUID PRIMARY KEY, requested_by TEXT NOT NULL CHECK (requested_by IN ('오주','혜령')),
    market TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('joint','solo')),
    status TEXT NOT NULL DEFAULT 'prepared', live BOOLEAN NOT NULL DEFAULT FALSE,
    request_json JSONB NOT NULL, result_json JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS order_records (
    id BIGSERIAL PRIMARY KEY, batch_id UUID NOT NULL REFERENCES order_batches(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL CHECK (user_id IN ('오주','혜령')), entry_no INTEGER NOT NULL,
    market TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('bid','ask')), order_uuid TEXT,
    identifier TEXT NOT NULL UNIQUE, price NUMERIC, volume NUMERIC, funds NUMERIC,
    state TEXT NOT NULL DEFAULT 'prepared', error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(batch_id, user_id, entry_no, side)
  );
  CREATE INDEX IF NOT EXISTS order_records_created_at_idx ON order_records(created_at DESC);
  CREATE INDEX IF NOT EXISTS order_records_batch_idx ON order_records(batch_id);`;
  await pool.query(schema);
}

function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function requireAuth(req, res, next) {
  try {
    const token = req.cookies.ozu_session;
    if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });
    req.user = verifySessionToken(token);
    next();
  } catch { res.clearCookie('ozu_session', cookieOptions()); return res.status(401).json({ error: '로그인이 만료되었습니다. 다시 로그인하세요.' }); }
}
function cookieOptions() { return { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 * 1000 }; }
function safeMessage(error) {
  if (error?.upbitError) return `업비트 오류(${error.upbitError}): ${error.message}`;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '업비트 응답 시간이 초과되었습니다. 주문이 접수됐는지 주문 내역을 먼저 확인하세요.';
  return error?.message || '서버 오류가 발생했습니다.';
}
async function credentialsFor(user) {
  const { rows } = await pool.query('SELECT access_key_ciphertext, secret_key_ciphertext FROM exchange_credentials WHERE user_id=$1', [user]);
  if (!rows[0]) throw new Error(`${user} 계정의 업비트 API 키가 등록되지 않았습니다.`);
  return { accessKey: decryptSecret(rows[0].access_key_ciphertext), secretKey: decryptSecret(rows[0].secret_key_ciphertext) };
}
async function getAccounts(user) { return upbitRequest(await credentialsFor(user), 'GET', '/v1/accounts'); }
function parseAmount(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} 값이 올바르지 않습니다.`);
  return n;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'OZU TRADING', mode: process.env.LIVE_TRADING_ENABLED === 'true' ? 'live-enabled' : 'safe-disabled' }));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { user, password } = req.body || {};
  if (!['오주', '혜령'].includes(user) || typeof password !== 'string' || !USERS[user]) return res.status(401).json({ error: '계정 또는 비밀번호가 올바르지 않습니다.' });
  const valid = await bcrypt.compare(password, USERS[user]);
  if (!valid) return res.status(401).json({ error: '계정 또는 비밀번호가 올바르지 않습니다.' });
  res.cookie('ozu_session', createSessionToken(user), cookieOptions());
  res.json({ user, expiresIn: 28800 });
}));
app.post('/api/auth/logout', (_req, res) => { res.clearCookie('ozu_session', cookieOptions()); res.json({ ok: true }); });
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.get('/api/credentials/status', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT created_at, updated_at FROM exchange_credentials WHERE user_id=$1', [req.user]);
  res.json({ connected: Boolean(rows[0]), connectedAt: rows[0]?.created_at || null, updatedAt: rows[0]?.updated_at || null });
}));
app.post('/api/credentials/upbit', requireAuth, asyncRoute(async (req, res) => {
  const { accessKey, secretKey } = req.body || {};
  if (typeof accessKey !== 'string' || accessKey.length < 10 || accessKey.length > 200 || typeof secretKey !== 'string' || secretKey.length < 10 || secretKey.length > 200) return res.status(400).json({ error: 'Access Key와 Secret Key를 확인하세요.' });
  const creds = { accessKey: accessKey.trim(), secretKey: secretKey.trim() };
  // Verify key before saving. Account permission should exclude all withdrawal scopes.
  await upbitRequest(creds, 'GET', '/v1/accounts');
  await pool.query(`INSERT INTO exchange_credentials(user_id,access_key_ciphertext,secret_key_ciphertext)
    VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET access_key_ciphertext=EXCLUDED.access_key_ciphertext, secret_key_ciphertext=EXCLUDED.secret_key_ciphertext, updated_at=NOW()`,
    [req.user, encryptSecret(creds.accessKey), encryptSecret(creds.secretKey)]);
  res.json({ ok: true, connected: true, message: '업비트 API 키 연결을 확인했습니다. 비밀키는 암호화해 저장했습니다.' });
}));
app.delete('/api/credentials/upbit', requireAuth, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM exchange_credentials WHERE user_id=$1', [req.user]);
  res.json({ ok: true, connected: false });
}));

app.get('/api/market/prices', asyncRoute(async (req, res) => {
  const symbols = String(req.query.symbols || 'BTC,ETH').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  if (symbols.length > 20) return res.status(400).json({ error: '한 번에 조회할 수 있는 종목 수를 초과했습니다.' });
  const markets = [...new Set(symbols.map(marketCode))];
  const data = await publicRequest('/v1/ticker', { markets: markets.join(',') });
  res.json(data.map(x => ({ market: x.market, symbol: x.market.replace('KRW-', ''), price: Number(x.trade_price), changeRate: Number(x.signed_change_rate), timestamp: x.timestamp })));
}));
app.get('/api/upbit/accounts', requireAuth, asyncRoute(async (req, res) => {
  const accounts = await getAccounts(req.user);
  res.json(accounts.map(a => ({ currency: a.currency, balance: Number(a.balance), locked: Number(a.locked), avgBuyPrice: Number(a.avg_buy_price), unitCurrency: a.unit_currency })));
}));
app.get('/api/upbit/all-balances', requireAuth, asyncRoute(async (_req, res) => {
  const results = await Promise.all(['오주', '혜령'].map(async user => {
    try { return { user, connected: true, accounts: (await getAccounts(user)).map(a => ({ currency: a.currency, balance: Number(a.balance), locked: Number(a.locked), avgBuyPrice: Number(a.avg_buy_price), unitCurrency: a.unit_currency })) }; }
    catch (e) { return { user, connected: false, error: safeMessage(e), accounts: [] }; }
  }));
  res.json(results);
}));

app.get('/api/orders/history', requireAuth, asyncRoute(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const { rows } = await pool.query(`SELECT r.*, b.requested_by, b.mode, b.live FROM order_records r JOIN order_batches b ON b.id=r.batch_id ORDER BY r.created_at DESC LIMIT $1`, [limit]);
  res.json(rows.map(r => ({ id: r.id, batchId: r.batch_id, user: r.user_id, entryNo: r.entry_no, market: r.market, side: r.side, orderUuid: r.order_uuid, identifier: r.identifier, price: r.price === null ? null : Number(r.price), volume: r.volume === null ? null : Number(r.volume), funds: r.funds === null ? null : Number(r.funds), status: r.state, error: r.error_message, createdAt: r.created_at, mode: r.mode, live: r.live })));
}));

app.post('/api/pyramid/orders', requireAuth, asyncRoute(async (req, res) => {
  const liveEnabled = process.env.LIVE_TRADING_ENABLED === 'true';
  if (!liveEnabled) return res.status(423).json({ error: '실거래는 안전 잠금 상태입니다. API 키·잔고·주문 계산 검증을 마친 뒤 서버 설정에서 별도로 활성화해야 합니다.', code: 'LIVE_TRADING_LOCKED' });
  if (req.body?.confirmLive !== true) return res.status(400).json({ error: '실거래 확인 값이 필요합니다.' });
  const { symbol, entries, mode = 'joint', budgets } = req.body || {};
  const market = marketCode(String(symbol || '').toUpperCase());
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 10) return res.status(400).json({ error: '분할 주문은 1~10회로 지정하세요.' });
  if (!['joint', 'solo'].includes(mode)) return res.status(400).json({ error: '매수 모드가 올바르지 않습니다.' });
  const targets = mode === 'solo' ? [req.user] : ['오주', '혜령'];
  if (!budgets || targets.some(user => !Number.isFinite(Number(budgets[user])) || Number(budgets[user]) <= 0)) return res.status(400).json({ error: '각 계정의 투자금을 확인하세요.' });
  const normalized = entries.map((entry, index) => {
    const price = floorToTick(parseAmount(entry.price, `${index + 1}회차 가격`));
    const fundsOzu = targets.includes('오주') ? parseAmount(entry.funds?.['오주'] ?? 0, `${index + 1}회차 오주 금액`) : 0;
    const fundsHye = targets.includes('혜령') ? parseAmount(entry.funds?.['혜령'] ?? 0, `${index + 1}회차 혜령 금액`) : 0;
    if (price <= 0) throw new Error('호가 단위 반영 후 가격이 0 이하입니다.');
    for (const user of targets) {
      const funds = user === '오주' ? fundsOzu : fundsHye;
      if (funds < 5000) throw new Error(`${user} ${index + 1}회차 주문 금액이 최소 주문 금액(5,000원)보다 작습니다.`);
    }
    return { entryNo: index + 1, price, funds: { 오주: fundsOzu, 혜령: fundsHye } };
  });
  for (const user of targets) {
    const total = normalized.reduce((sum, e) => sum + e.funds[user], 0);
    const accounts = await getAccounts(user);
    const krw = Number(accounts.find(a => a.currency === 'KRW')?.balance || 0);
    if (total * 1.001 > krw) throw new Error(`${user} 계정의 사용 가능 원화가 부족합니다. 필요 금액과 수수료 여유를 확인하세요.`);
  }
  const batchId = newBatchId();
  await pool.query('INSERT INTO order_batches(id,requested_by,market,mode,status,live,request_json) VALUES($1,$2,$3,$4,$5,true,$6)', [batchId, req.user, market, mode, 'submitting', JSON.stringify({ symbol, entries: normalized, budgets })]);
  const submitted = [];
  let failure = null;
  outer: for (const user of targets) {
    const creds = await credentialsFor(user);
    for (const entry of normalized) {
      const funds = entry.funds[user];
      const volume = volumeForFunds(funds, entry.price);
      if (!Number.isFinite(volume) || volume <= 0) { failure = new Error(`${user} ${entry.entryNo}회차 주문 수량이 0입니다.`); break outer; }
      const identifier = makeIdentifier(batchId, user, entry.entryNo, 'bid');
      await pool.query(`INSERT INTO order_records(batch_id,user_id,entry_no,market,side,identifier,price,volume,funds,state)
        VALUES($1,$2,$3,$4,'bid',$5,$6,$7,$8,'submitting')`, [batchId, user, entry.entryNo, market, identifier, entry.price, volume, funds]);
      try {
        const order = await upbitRequest(creds, 'POST', '/v1/orders', { market, side: 'bid', volume: String(volume), price: String(entry.price), ord_type: 'limit', identifier });
        submitted.push({ user, entryNo: entry.entryNo, uuid: order.uuid, identifier, state: order.state });
        await pool.query(`UPDATE order_records SET order_uuid=$1,state=$2,updated_at=NOW() WHERE identifier=$3`, [order.uuid, order.state, identifier]);
      } catch (e) {
        failure = e;
        await pool.query(`UPDATE order_records SET state='failed',error_message=$1,updated_at=NOW() WHERE identifier=$2`, [safeMessage(e), identifier]);
        break outer;
      }
    }
  }
  let cancellations = [];
  if (failure) {
    // Best effort only: cancel open orders. Filled or partially filled quantities cannot be undone.
    for (const item of submitted) {
      try {
        const order = await upbitRequest(await credentialsFor(item.user), 'GET', '/v1/order', { uuid: item.uuid });
        if (['wait', 'watch'].includes(order.state)) {
          const cancelled = await upbitRequest(await credentialsFor(item.user), 'DELETE', '/v1/order', { uuid: item.uuid });
          cancellations.push({ user: item.user, uuid: item.uuid, result: 'cancel-requested', state: cancelled.state });
          await pool.query(`UPDATE order_records SET state=$1,updated_at=NOW() WHERE order_uuid=$2`, [cancelled.state || 'cancel-requested', item.uuid]);
        } else cancellations.push({ user: item.user, uuid: item.uuid, result: 'not-cancelled', state: order.state, note: '이미 체결된 주문은 취소할 수 없습니다.' });
      } catch (cancelError) { cancellations.push({ user: item.user, uuid: item.uuid, result: 'cancel-error', error: safeMessage(cancelError) }); }
    }
    const result = { submitted, cancellations, error: safeMessage(failure) };
    await pool.query('UPDATE order_batches SET status=$1,result_json=$2,finished_at=NOW() WHERE id=$3', ['partial_failure', JSON.stringify(result), batchId]);
    return res.status(502).json({ batchId, status: 'partial_failure', ...result });
  }
  const result = { submitted };
  await pool.query('UPDATE order_batches SET status=$1,result_json=$2,finished_at=NOW() WHERE id=$3', ['submitted', JSON.stringify(result), batchId]);
  res.json({ batchId, status: 'submitted', submitted, message: `${submitted.length}개 주문을 거래소에 전송했습니다. 체결 여부는 주문 상태에서 별도로 확인하세요.` });
}));

app.get('/api/upbit/open-orders', requireAuth, asyncRoute(async (req, res) => {
  const users = req.query.scope === 'mine' ? [req.user] : ['오주', '혜령'];
  const result = await Promise.all(users.map(async user => {
    try { const orders = await upbitRequest(await credentialsFor(user), 'GET', '/v1/orders/open', { state: 'wait', page: 1, limit: 100, order_by: 'desc' }); return { user, connected: true, orders }; }
    catch (e) { return { user, connected: false, error: safeMessage(e), orders: [] }; }
  }));
  res.json(result);
}));

app.post('/api/orders/cancel-open', requireAuth, asyncRoute(async (req, res) => {
  const users = req.body?.scope === 'mine' ? [req.user] : ['오주', '혜령'];
  const outcomes = [];
  for (const user of users) {
    try {
      const creds = await credentialsFor(user);
      const orders = await upbitRequest(creds, 'GET', '/v1/orders/open', { state: 'wait', page: 1, limit: 100, order_by: 'desc' });
      for (const order of orders) {
        try { const result = await upbitRequest(creds, 'DELETE', '/v1/order', { uuid: order.uuid }); outcomes.push({ user, uuid: order.uuid, result: 'cancel-requested', state: result.state }); }
        catch (e) { outcomes.push({ user, uuid: order.uuid, result: 'failed', error: safeMessage(e) }); }
      }
    } catch (e) { outcomes.push({ user, result: 'account-error', error: safeMessage(e) }); }
  }
  res.json({ outcomes });
}));

app.use('/api', (_req, res) => res.status(404).json({ error: '요청한 API를 찾을 수 없습니다.' }));
app.use(express.static('public', { extensions: ['html'] }));
app.use((err, _req, res, _next) => {
  const status = Number(err.status) || 400;
  if (isProd) console.error(`[${new Date().toISOString()}]`, err?.message || err);
  else console.error(err);
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: safeMessage(err) });
});

await initializeDatabase();
app.listen(PORT, () => console.log(`OZU TRADING server listening on ${PORT}; live trading ${process.env.LIVE_TRADING_ENABLED === 'true' ? 'ENABLED' : 'LOCKED'}`));
