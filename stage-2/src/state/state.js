'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const domain = require('../domain/reservations');
const time = require('../domain/time');

function emptyState() {
  return { users: [], restaurants: [], reservations: [], tokens: [], receipts: [] };
}

function apiError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  throw error;
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 64; }
function validReference(value) { return typeof value === 'string' && /^[A-Z0-9]{6,12}$/.test(value); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function validRfc3339(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  const [algorithm, salt, digest] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !/^[a-f\d]{128}$/i.test(digest || '')) return false;
  const actual = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}

function validateFixtureShape(fixture) {
  if (!object(fixture)) apiError(400, 'malformed_request');
  for (const field of ['users', 'restaurants', 'reservations']) {
    if (!Object.hasOwn(fixture, field)) apiError(422, 'validation_failed');
    if (!Array.isArray(fixture[field])) apiError(400, 'malformed_request');
  }
  const ids = new Set(); const emails = new Set();
  for (const user of fixture.users) {
    if (!object(user)) apiError(400, 'malformed_request');
    for (const field of ['id', 'email', 'password', 'display_name']) {
      if (!Object.hasOwn(user, field)) apiError(422, 'validation_failed');
      if (typeof user[field] !== 'string') apiError(400, 'malformed_request');
    }
    if (!validId(user.id) || !/^[^\s@]+@[^\s@]+$/.test(user.email) || ids.has(user.id) || emails.has(user.email.toLowerCase())) apiError(422, 'validation_failed');
    ids.add(user.id);
    emails.add(user.email.toLowerCase());
  }
  const restaurantIds = new Set();
  for (const restaurant of fixture.restaurants) {
    if (!object(restaurant)) apiError(400, 'malformed_request');
    const fields = { id: 'string', name: 'string', timezone: 'string', slot_minutes: 'number', reservation_duration_minutes: 'number', cancellation_cutoff_minutes: 'number', opening_hours: 'array', tables: 'array' };
    for (const [field, type] of Object.entries(fields)) {
      if (!Object.hasOwn(restaurant, field)) apiError(422, 'validation_failed');
      const matches = type === 'array' ? Array.isArray(restaurant[field]) : typeof restaurant[field] === type;
      if (!matches) apiError(400, 'malformed_request');
    }
    if (!validId(restaurant.id) || !Number.isInteger(restaurant.slot_minutes) || restaurant.slot_minutes <= 0 || !Number.isInteger(restaurant.reservation_duration_minutes) || restaurant.reservation_duration_minutes <= 0 || !Number.isInteger(restaurant.cancellation_cutoff_minutes) || restaurant.cancellation_cutoff_minutes < 0 || restaurantIds.has(restaurant.id)) apiError(422, 'validation_failed');
    try { new Intl.DateTimeFormat('en', { timeZone: restaurant.timezone }); } catch { apiError(422, 'validation_failed'); }
    restaurantIds.add(restaurant.id);
    const tableIds = new Set();
    const weekdays = new Set();
    for (const hours of restaurant.opening_hours) {
      if (!object(hours)) apiError(400, 'malformed_request');
      for (const field of ['weekday', 'opens', 'closes']) {
        if (!Object.hasOwn(hours, field)) apiError(422, 'validation_failed');
        if (typeof hours[field] !== 'string') apiError(400, 'malformed_request');
      }
      if (!['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(hours.weekday) || !/^\d{2}:\d{2}$/.test(hours.opens) || !/^\d{2}:\d{2}$/.test(hours.closes) || weekdays.has(hours.weekday)) apiError(422, 'validation_failed');
      const minute = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
      if (Number(hours.opens.slice(0, 2)) > 23 || Number(hours.opens.slice(3)) > 59 || Number(hours.closes.slice(0, 2)) > 23 || Number(hours.closes.slice(3)) > 59 || minute(hours.closes) <= minute(hours.opens)) apiError(422, 'validation_failed');
      weekdays.add(hours.weekday);
    }
    for (const table of restaurant.tables) {
      if (!object(table)) apiError(400, 'malformed_request');
      for (const field of ['id', 'label', 'capacity']) {
        if (!Object.hasOwn(table, field)) apiError(422, 'validation_failed');
        if (typeof table[field] !== (field === 'capacity' ? 'number' : 'string')) apiError(400, 'malformed_request');
      }
      if (!validId(table.id) || !Number.isInteger(table.capacity) || table.capacity < 1 || tableIds.has(table.id)) apiError(422, 'validation_failed');
      tableIds.add(table.id);
    }
    if (Object.hasOwn(restaurant, 'combinable')) {
      if (!Array.isArray(restaurant.combinable)) apiError(400, 'malformed_request');
      const combinations = new Set();
      for (const pair of restaurant.combinable) {
        if (!Array.isArray(pair)) apiError(400, 'malformed_request');
        if (pair.some(id => typeof id !== 'string')) apiError(400, 'malformed_request');
        if (pair.length !== 2 || pair[0] === pair[1] || pair.some(id => !tableIds.has(id))) apiError(422, 'validation_failed');
        const key = pair.slice().sort().join('\0');
        if (combinations.has(key)) apiError(422, 'validation_failed');
        combinations.add(key);
      }
    }
  }
}

async function fixtureState(fixture) {
  validateFixtureShape(fixture);
  const state = emptyState();
  for (const u of fixture.users) state.users.push({ user_id: u.id, email: u.email.toLowerCase(), display_name: u.display_name, password_hash: await hashPassword(u.password) });
  state.restaurants = structuredClone(fixture.restaurants).map(restaurant => ({ ...restaurant, combinable: restaurant.combinable || [] }));
  for (const seed of fixture.reservations) {
    if (!object(seed)) apiError(400, 'malformed_request');
    for (const field of ['id', 'reference', 'user_id', 'restaurant_id', 'starts_at_local', 'party_size']) {
      if (!Object.hasOwn(seed, field)) apiError(422, 'validation_failed');
      if (field !== 'party_size' && typeof seed[field] !== 'string') apiError(400, 'malformed_request');
    }
    if (Object.hasOwn(seed, 'table_id') === Object.hasOwn(seed, 'table_ids')) apiError(422, 'validation_failed');
    if (Object.hasOwn(seed, 'table_id') && typeof seed.table_id !== 'string') apiError(400, 'malformed_request');
    if (Object.hasOwn(seed, 'table_ids')) {
      if (!Array.isArray(seed.table_ids)) apiError(400, 'malformed_request');
      if (seed.table_ids.some(id => typeof id !== 'string')) apiError(400, 'malformed_request');
    }
    if (Object.hasOwn(seed, 'status') && typeof seed.status !== 'string') apiError(400, 'malformed_request');
    if (!validId(seed.id) || !validReference(seed.reference) || !validId(seed.user_id) || !state.users.some(u => u.user_id === seed.user_id) || !Number.isInteger(seed.party_size) || seed.party_size < 1 || (seed.status !== undefined && !['confirmed', 'cancelled'].includes(seed.status))) apiError(422, 'validation_failed');
    if (state.reservations.some(r => r.reservation_id === seed.id || r.reference === seed.reference)) apiError(422, 'validation_failed');
    try { domain.seedReservation(state, seed, Date.now()); }
    catch { apiError(422, 'validation_failed'); }
  }
  return state;
}

function validateReceiptReservation(value, receiptUserId, state) {
  if (!object(value) || !validId(value.reservation_id) || !validReference(value.reference) ||
      !validId(value.restaurant_id) || !Number.isInteger(value.party_size) || value.party_size < 1 ||
      value.status !== 'confirmed' || typeof value.starts_at_local !== 'string' ||
      !validRfc3339(value.starts_at) || !validRfc3339(value.ends_at) || !validRfc3339(value.created_at)) return false;
  const saved = state.reservations.find(r => r.reservation_id === value.reservation_id &&
    r.reference === value.reference && r.user_id === receiptUserId && r.restaurant_id === value.restaurant_id);
  const restaurant = state.restaurants.find(r => r.id === value.restaurant_id);
  if (!saved || !restaurant) return false;
  const tableIds = Array.isArray(value.table_ids) ? value.table_ids :
    (typeof value.table_id === 'string' ? [value.table_id] : null);
  if (!tableIds || (Object.hasOwn(value, 'table_id') &&
      (tableIds.length !== 1 || value.table_id !== tableIds[0]))) return false;
  try {
    const selection = domain.selectTables(restaurant, { table_ids: tableIds });
    if (selection.ids.length !== tableIds.length || selection.ids.some((id, index) => id !== tableIds[index]) ||
        value.party_size > selection.tables.reduce((sum, table) => sum + table.capacity, 0)) return false;
    const startsAt = time.validateWindow(restaurant, value.starts_at_local);
    return value.starts_at === time.timestamp(startsAt, restaurant.timezone) &&
      value.ends_at === time.timestamp(startsAt + restaurant.reservation_duration_minutes * 60000, restaurant.timezone);
  } catch { return false; }
}

function sameReservationTables(requested, response) {
  const requestedIds = Array.isArray(requested.table_ids) ? requested.table_ids :
    (typeof requested.table_id === 'string' ? [requested.table_id] : null);
  const responseIds = Array.isArray(response.table_ids) ? response.table_ids :
    (typeof response.table_id === 'string' ? [response.table_id] : null);
  return !!requestedIds && !!responseIds && requestedIds.length === responseIds.length &&
    new Set(requestedIds).size === requestedIds.length &&
    requestedIds.every(id => typeof id === 'string' && responseIds.includes(id));
}

function validateImportedState(value) {
  if (!object(value) || !Array.isArray(value.users) || !Array.isArray(value.restaurants) || !Array.isArray(value.reservations) || !Array.isArray(value.tokens) || !Array.isArray(value.receipts)) apiError(422, 'validation_failed');
  const state = structuredClone(value);
  for (const restaurant of state.restaurants) {
    if (object(restaurant) && !Object.hasOwn(restaurant, 'combinable')) restaurant.combinable = [];
  }
  for (const user of state.users) if (!object(user)) apiError(422, 'validation_failed');
  const users = new Set(state.users.map(u => u.user_id));
  const emails = new Set();
  const refs = new Set(); const ids = new Set();
  if (users.size !== state.users.length) apiError(422, 'validation_failed');
  for (const user of state.users) {
    if (!object(user) || !validId(user.user_id) || typeof user.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(user.email) || typeof user.display_name !== 'string' || typeof user.password_hash !== 'string' || !/^scrypt\$[a-f\d]{32}\$[a-f\d]{128}$/i.test(user.password_hash) || emails.has(user.email.toLowerCase())) apiError(422, 'validation_failed');
    emails.add(user.email.toLowerCase());
  }
  const tokenSet = new Set();
  for (const token of state.tokens) {
    if (!object(token) || typeof token.token !== 'string' || !token.token || !users.has(token.user_id) || tokenSet.has(token.token)) apiError(422, 'validation_failed');
    tokenSet.add(token.token);
  }
  const restaurantIds = new Set();
  try {
    for (const restaurant of state.restaurants) {
      validateFixtureShape({ users: [], restaurants: [restaurant], reservations: [] });
      if (restaurantIds.has(restaurant.id)) apiError(422, 'validation_failed');
      restaurantIds.add(restaurant.id);
    }
  } catch { apiError(422, 'validation_failed'); }
  for (const r of state.reservations) {
    if (!object(r)) apiError(422, 'validation_failed');
    if (!Object.hasOwn(r, 'table_ids') && Object.hasOwn(r, 'table_id')) r.table_ids = [r.table_id];
    if (!Array.isArray(r.table_ids) || r.table_ids.some(id => typeof id !== 'string') || (Object.hasOwn(r, 'table_id') && (r.table_ids.length !== 1 || r.table_id !== r.table_ids[0]))) apiError(422, 'validation_failed');
    const restaurant = state.restaurants.find(x => x.id === r.restaurant_id);
    if (!validId(r.reservation_id) || !validReference(r.reference) || !users.has(r.user_id) || !restaurant || !Number.isInteger(r.party_size) || r.party_size < 1 || !['confirmed', 'cancelled'].includes(r.status) || typeof r.starts_at_local !== 'string' || typeof r.starts_at !== 'string' || typeof r.ends_at !== 'string' || !validRfc3339(r.created_at) || !Number.isFinite(r.starts_at_ms) || !Number.isFinite(r.ends_at_ms) || r.ends_at_ms - r.starts_at_ms !== restaurant.reservation_duration_minutes * 60000 || ids.has(r.reservation_id) || refs.has(r.reference)) apiError(422, 'validation_failed');
    let selection;
    try { selection = domain.selectTables(restaurant, { table_ids: r.table_ids }); }
    catch { apiError(422, 'validation_failed'); }
    // Combination membership is unordered; normalize accepted pairs to the restaurant's declared order.
    r.table_ids = selection.ids;
    if (r.party_size > selection.tables.reduce((sum, table) => sum + table.capacity, 0)) apiError(422, 'validation_failed');
    if (r.table_ids.length === 1) r.table_id = r.table_ids[0];
    else if (Object.hasOwn(r, 'table_id')) apiError(422, 'validation_failed');
    try {
      const start = time.validateWindow(restaurant, r.starts_at_local);
      if (start !== r.starts_at_ms || r.starts_at !== time.timestamp(start, restaurant.timezone) || r.ends_at !== time.timestamp(r.ends_at_ms, restaurant.timezone) || !Number.isFinite(Date.parse(r.created_at))) apiError(422, 'validation_failed');
    } catch { apiError(422, 'validation_failed'); }
    ids.add(r.reservation_id); refs.add(r.reference);
  }
  for (let i = 0; i < state.reservations.length; i++) {
    const a = state.reservations[i];
    if (a.status !== 'confirmed') continue;
    for (let j = 0; j < i; j++) {
      const b = state.reservations[j];
      if (b.status === 'confirmed' && a.restaurant_id === b.restaurant_id && domain.reservationTableIds(a).some(id => domain.reservationTableIds(b).includes(id)) && a.starts_at_ms < b.ends_at_ms && b.starts_at_ms < a.ends_at_ms) apiError(422, 'validation_failed');
    }
  }
  const receiptKeys = new Set(); const receiptBodies = new Map();
  for (const receipt of state.receipts) {
    if (!object(receipt) || !users.has(receipt.user_id) || typeof receipt.key !== 'string' || receipt.key.length < 1 || receipt.key.length > 255 || receipt.method !== 'POST' || !['/reservations', '/reservation-moves'].includes(receipt.path) || !object(receipt.body) || receipt.status !== 201 || !object(receipt.response)) apiError(422, 'validation_failed');
    if (receipt.path === '/reservations') {
      const response = receipt.response;
      if (!validateReceiptReservation(response, receipt.user_id, state) ||
          receipt.body.restaurant_id !== response.restaurant_id || receipt.body.party_size !== response.party_size ||
          receipt.body.starts_at_local !== response.starts_at_local ||
          Object.hasOwn(receipt.body, 'table_id') === Object.hasOwn(receipt.body, 'table_ids') ||
          !sameReservationTables(receipt.body, response)) apiError(422, 'validation_failed');
    } else {
      const moves = receipt.body.moves;
      const responses = receipt.response.reservations;
      if (!Array.isArray(moves) || moves.length < 1 || moves.length > 8 || !Array.isArray(responses) || responses.length !== moves.length ||
          moves.some((move, index) => !object(move) || typeof move.reference !== 'string' ||
            responses[index]?.reference !== move.reference || !validateReceiptReservation(responses[index], receipt.user_id, state)) ||
          new Set(moves.map(move => move.reference)).size !== moves.length) apiError(422, 'validation_failed');
      for (let i = 0; i < moves.length; i++) {
        const move = moves[i]; const response = responses[i];
        if ((Object.hasOwn(move, 'table_id') || Object.hasOwn(move, 'table_ids')) && !sameReservationTables(move, response) ||
            (Object.hasOwn(move, 'starts_at_local') && move.starts_at_local !== response.starts_at_local) ||
            (Object.hasOwn(move, 'party_size') && move.party_size !== response.party_size)) apiError(422, 'validation_failed');
      }
    }
    const unique = `${receipt.user_id}\0${receipt.key}\0${receipt.method}\0${receipt.path}`;
    if (receiptKeys.has(unique)) apiError(422, 'validation_failed');
    receiptKeys.add(unique);
    const scope = `${receipt.user_id}\0${receipt.key}`;
    const body = stable(receipt.body);
    if (receiptBodies.has(scope) && receiptBodies.get(scope) !== body) apiError(422, 'validation_failed');
    receiptBodies.set(scope, body);
  }
  return state;
}

module.exports = { emptyState, apiError, object, validId, hashPassword, verifyPassword, fixtureState, validateImportedState };
