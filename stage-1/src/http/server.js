'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const stateFns = require('../state/state');
const D = require('../domain/reservations');

let state = stateFns.emptyState();
let mutation = Promise.resolve();
function serialized(fn) {
  const run = mutation.then(fn, fn);
  mutation = run.then(() => undefined, () => undefined);
  return run;
}

function send(res, status, value) {
  res.statusCode = status;
  if (status === 204) return res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}
function fail(status, code) { const e = new Error(code); e.status = status; e.code = code; throw e; }
function errorBody(error) { return { error: { code: error.code || 'internal_error', message: error.message || 'Request failed' } }; }

async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'malformed_request'); }
}
function requireObject(value) { if (!stateFns.object(value)) fail(400, 'malformed_request'); }
function fieldType(body, key, type) { if (Object.hasOwn(body, key) && typeof body[key] !== type) fail(400, 'malformed_request'); }
function pathId(value) { try { return decodeURIComponent(value); } catch { fail(404, 'not_found'); } }
function validateCreate(body) {
  for (const key of ['restaurant_id', 'table_id', 'starts_at_local']) {
    if (!Object.hasOwn(body, key)) fail(422, 'validation_failed');
    fieldType(body, key, 'string');
  }
  if (!Object.hasOwn(body, 'party_size')) fail(422, 'validation_failed');
}
function auth(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || !header.slice(7)) fail(401, 'unauthenticated');
  const token = state.tokens.find(t => t.token === header.slice(7));
  if (!token) fail(401, 'unauthenticated');
  return token.user_id;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function responseReservation(reservation) { return reservation; }
function requireIdempotency(req) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0) fail(400, 'missing_idempotency_key');
  if (key.length > 255) fail(422, 'validation_failed');
  return key;
}
function idempotent(userId, key, method, path, body, action) {
  return serialized(async () => {
    const receipts = state.receipts.filter(r => r.user_id === userId && r.key === key);
    const bodyValue = canonical(body);
    const receipt = receipts.find(r => r.method === method && r.path === path);
    if (receipt) {
      if (canonical(receipt.body) !== bodyValue) fail(409, 'idempotency_key_reuse');
      return { status: 200, body: structuredClone(receipt.response) };
    }
    if (receipts.some(r => canonical(r.body) !== bodyValue)) fail(409, 'idempotency_key_reuse');
    const result = await action();
    const response = structuredClone(result.body);
    state.receipts.push({ user_id: userId, key, method, path, body: structuredClone(body), status: result.status, response });
    return result;
  });
}

function publicRestaurant(r) {
  return { id: r.id, name: r.name, timezone: r.timezone, slot_minutes: r.slot_minutes,
    reservation_duration_minutes: r.reservation_duration_minutes,
    cancellation_cutoff_minutes: r.cancellation_cutoff_minutes,
    opening_hours: structuredClone(r.opening_hours), tables: structuredClone(r.tables) };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok' });
  if (req.method === 'POST' && path === '/_test/reset') {
    const fixture = await bodyOf(req);
    const replacement = await stateFns.fixtureState(fixture);
    await serialized(() => { state = replacement; });
    return send(res, 204);
  }
  if (req.method === 'GET' && path === '/_test/export') {
    await mutation;
    return send(res, 200, { track: 'tablekeeper', format_version: 1, state: structuredClone(state) });
  }
  if (req.method === 'POST' && path === '/_test/import') {
    const packet = await bodyOf(req); requireObject(packet);
    if (packet.track !== 'tablekeeper' || packet.format_version !== 1 || !Object.hasOwn(packet, 'state')) fail(422, 'validation_failed');
    const replacement = stateFns.validateImportedState(packet.state);
    await serialized(() => { state = replacement; });
    return send(res, 204);
  }
  if (req.method === 'POST' && (path === '/auth/signup' || path === '/auth/login')) {
    const data = await bodyOf(req); requireObject(data);
    for (const k of ['email', 'password']) fieldType(data, k, 'string');
    if (path.endsWith('signup')) fieldType(data, 'display_name', 'string');
    if (typeof data.email !== 'string' || typeof data.password !== 'string' || (path.endsWith('signup') && typeof data.display_name !== 'string')) fail(422, 'validation_failed');
    const email = data.email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) fail(422, 'validation_failed');
    if (path.endsWith('signup')) {
      if (data.password.length < 8) fail(422, 'validation_failed');
      const result = await serialized(async () => {
        if (state.users.some(u => u.email === email)) fail(409, 'email_taken');
        const user = { user_id: `u_${crypto.randomBytes(12).toString('hex')}`, email, display_name: data.display_name, password_hash: await stateFns.hashPassword(data.password) };
        const token = crypto.randomBytes(32).toString('base64url');
        state.users.push(user); state.tokens.push({ user_id: user.user_id, token });
        return { user_id: user.user_id, display_name: user.display_name, token };
      });
      return send(res, 201, result);
    }
    const result = await serialized(async () => {
      const user = state.users.find(u => u.email === email);
      if (!user || !(await stateFns.verifyPassword(data.password, user.password_hash))) fail(401, 'unauthenticated');
      const token = crypto.randomBytes(32).toString('base64url'); state.tokens.push({ user_id: user.user_id, token });
      return { user_id: user.user_id, display_name: user.display_name, token };
    });
    return send(res, 200, result);
  }
  if (req.method === 'GET' && path === '/restaurants') return send(res, 200, { restaurants: state.restaurants.map(r => ({ id: r.id, name: r.name, timezone: r.timezone })) });
  const restaurantMatch = path.match(/^\/restaurants\/([^/]+)$/);
  if (req.method === 'GET' && restaurantMatch) {
    const restaurant = state.restaurants.find(r => r.id === pathId(restaurantMatch[1]));
    if (!restaurant) fail(404, 'not_found');
    return send(res, 200, publicRestaurant(restaurant));
  }
  if (req.method === 'GET' && path === '/availability') {
    for (const k of ['restaurant_id', 'date', 'party_size']) if (!url.searchParams.has(k)) fail(422, 'validation_failed');
    const party = url.searchParams.get('party_size');
    if (!/^\d+$/.test(party)) fail(422, 'validation_failed');
    return send(res, 200, D.availability(state, { restaurant_id: url.searchParams.get('restaurant_id'), date: url.searchParams.get('date'), party_size: Number(party) }));
  }

  const userId = auth(req);
  if (req.method === 'GET' && path === '/reservations') return send(res, 200, D.listReservations(state, userId));
  const detailMatch = path.match(/^\/reservations\/([^/]+)$/);
  const cancelMatch = path.match(/^\/reservations\/([^/]+)\/cancel$/);
  if (req.method === 'GET' && detailMatch) return send(res, 200, D.getReservation(state, userId, pathId(detailMatch[1])));
  if (req.method === 'POST' && path === '/reservations') {
    const data = await bodyOf(req); requireObject(data); const key = requireIdempotency(req);
    const outcome = await idempotent(userId, key, req.method, path, data, async () => {
      validateCreate(data);
      return { status: 201, body: responseReservation(D.createReservation(state, userId, data)) };
    });
    return send(res, outcome.status, outcome.body);
  }
  if (req.method === 'POST' && cancelMatch) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length > 0) { let data; try { data = JSON.parse(raw); } catch { fail(400, 'malformed_request'); } requireObject(data); }
    const result = await serialized(() => D.cancelReservation(state, userId, pathId(cancelMatch[1])));
    return send(res, 200, result);
  }
  if (req.method === 'PATCH' && detailMatch) {
    const data = await bodyOf(req); requireObject(data);
    for (const k of ['table_id', 'starts_at_local']) fieldType(data, k, 'string');
    const result = await serialized(() => D.amendReservation(state, userId, pathId(detailMatch[1]), data));
    return send(res, 200, result);
  }
  if (req.method === 'POST' && path === '/reservation-moves') {
    const data = await bodyOf(req); requireObject(data); const key = requireIdempotency(req);
    const outcome = await idempotent(userId, key, req.method, path, data, async () => ({ status: 201, body: D.moveReservations(state, userId, data.moves) }));
    return send(res, outcome.status, outcome.body);
  }
  fail(404, 'not_found');
}

const server = http.createServer((req, res) => {
  Promise.resolve(route(req, res)).catch(error => {
    if (res.headersSent) return res.destroy();
    const status = Number.isInteger(error.status) ? error.status : 500;
    send(res, status, errorBody(error));
  });
});
const port = Number.parseInt(process.env.PORT || '8080', 10);
server.listen(port, '0.0.0.0');
