'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const domain = require('../domain/reservations');

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
  if (!object(fixture) || !Array.isArray(fixture.users) || !Array.isArray(fixture.restaurants) || !Array.isArray(fixture.reservations)) apiError(422, 'validation_failed');
  const ids = new Set(); const emails = new Set();
  for (const user of fixture.users) {
    if (!object(user) || !validId(user.id) || typeof user.email !== 'string' || typeof user.password !== 'string' || typeof user.display_name !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(user.email) || ids.has(user.id) || emails.has(user.email.toLowerCase())) apiError(422, 'validation_failed');
    ids.add(user.id);
    emails.add(user.email.toLowerCase());
  }
  const restaurantIds = new Set();
  for (const restaurant of fixture.restaurants) {
    if (!object(restaurant) || !validId(restaurant.id) || typeof restaurant.name !== 'string' || typeof restaurant.timezone !== 'string' || !Number.isInteger(restaurant.slot_minutes) || restaurant.slot_minutes <= 0 || !Number.isInteger(restaurant.reservation_duration_minutes) || restaurant.reservation_duration_minutes <= 0 || !Number.isInteger(restaurant.cancellation_cutoff_minutes) || restaurant.cancellation_cutoff_minutes < 0 || !Array.isArray(restaurant.opening_hours) || !Array.isArray(restaurant.tables) || restaurantIds.has(restaurant.id)) apiError(422, 'validation_failed');
    try { new Intl.DateTimeFormat('en', { timeZone: restaurant.timezone }); } catch { apiError(422, 'validation_failed'); }
    restaurantIds.add(restaurant.id);
    const tableIds = new Set();
    const weekdays = new Set();
    for (const hours of restaurant.opening_hours) {
      if (!object(hours) || !['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(hours.weekday) || typeof hours.opens !== 'string' || typeof hours.closes !== 'string' || !/^\d{2}:\d{2}$/.test(hours.opens) || !/^\d{2}:\d{2}$/.test(hours.closes) || weekdays.has(hours.weekday)) apiError(422, 'validation_failed');
      const minute = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
      if (Number(hours.opens.slice(0, 2)) > 23 || Number(hours.opens.slice(3)) > 59 || Number(hours.closes.slice(0, 2)) > 23 || Number(hours.closes.slice(3)) > 59 || minute(hours.closes) <= minute(hours.opens)) apiError(422, 'validation_failed');
      weekdays.add(hours.weekday);
    }
    for (const table of restaurant.tables) {
      if (!object(table) || !validId(table.id) || typeof table.label !== 'string' || !Number.isInteger(table.capacity) || table.capacity < 1 || tableIds.has(table.id)) apiError(422, 'validation_failed');
      tableIds.add(table.id);
    }
  }
}

async function fixtureState(fixture) {
  validateFixtureShape(fixture);
  const state = emptyState();
  for (const u of fixture.users) state.users.push({ user_id: u.id, email: u.email.toLowerCase(), display_name: u.display_name, password_hash: await hashPassword(u.password) });
  state.restaurants = structuredClone(fixture.restaurants);
  for (const seed of fixture.reservations) {
    if (!object(seed) || !validId(seed.id) || !validId(seed.reference) || !validId(seed.user_id) || !state.users.some(u => u.user_id === seed.user_id) || typeof seed.restaurant_id !== 'string' || typeof seed.table_id !== 'string' || typeof seed.starts_at_local !== 'string' || !Number.isInteger(seed.party_size) || seed.party_size < 1) apiError(422, 'validation_failed');
    if (state.reservations.some(r => r.reservation_id === seed.id || r.reference === seed.reference)) apiError(422, 'validation_failed');
    try { domain.createReservation(state, seed.user_id, seed, Date.now()); }
    catch { apiError(422, 'validation_failed'); }
    const record = state.reservations[state.reservations.length - 1];
    record.reservation_id = seed.id;
    record.reference = seed.reference;
  }
  return state;
}

function validateImportedState(value) {
  if (!object(value) || !Array.isArray(value.users) || !Array.isArray(value.restaurants) || !Array.isArray(value.reservations) || !Array.isArray(value.tokens) || !Array.isArray(value.receipts)) apiError(422, 'validation_failed');
  const state = structuredClone(value);
  for (const user of state.users) if (!object(user)) apiError(422, 'validation_failed');
  const users = new Set(state.users.map(u => u.user_id));
  const emails = new Set();
  const refs = new Set(); const ids = new Set();
  if (users.size !== state.users.length) apiError(422, 'validation_failed');
  for (const user of state.users) {
    if (!object(user) || !validId(user.user_id) || typeof user.email !== 'string' || typeof user.display_name !== 'string' || typeof user.password_hash !== 'string' || !/^scrypt\$[a-f\d]{32}\$[a-f\d]{128}$/i.test(user.password_hash) || emails.has(user.email.toLowerCase())) apiError(422, 'validation_failed');
    emails.add(user.email.toLowerCase());
  }
  const tokenSet = new Set();
  for (const token of state.tokens) {
    if (!object(token) || typeof token.token !== 'string' || !token.token || !users.has(token.user_id) || tokenSet.has(token.token)) apiError(422, 'validation_failed');
    tokenSet.add(token.token);
  }
  try {
    for (const restaurant of state.restaurants) validateFixtureShape({ users: [], restaurants: [restaurant], reservations: [] });
  } catch { apiError(422, 'validation_failed'); }
  for (const r of state.reservations) {
    if (!object(r)) apiError(422, 'validation_failed');
    const restaurant = state.restaurants.find(x => x.id === r.restaurant_id);
    if (!validId(r.reservation_id) || !validId(r.reference) || !users.has(r.user_id) || !restaurant || !restaurant.tables.some(t => t.id === r.table_id) || !Number.isInteger(r.party_size) || r.party_size < 1 || !['confirmed', 'cancelled'].includes(r.status) || typeof r.starts_at_local !== 'string' || typeof r.starts_at !== 'string' || typeof r.ends_at !== 'string' || typeof r.created_at !== 'string' || !Number.isFinite(r.starts_at_ms) || !Number.isFinite(r.ends_at_ms) || r.ends_at_ms <= r.starts_at_ms || ids.has(r.reservation_id) || refs.has(r.reference)) apiError(422, 'validation_failed');
    ids.add(r.reservation_id); refs.add(r.reference);
  }
  const receiptKeys = new Set();
  for (const receipt of state.receipts) {
    if (!object(receipt) || !users.has(receipt.user_id) || typeof receipt.key !== 'string' || receipt.key.length < 1 || receipt.key.length > 255 || typeof receipt.method !== 'string' || typeof receipt.path !== 'string' || !object(receipt.body) || receipt.status !== 201 || !object(receipt.response)) apiError(422, 'validation_failed');
    const unique = `${receipt.user_id}\0${receipt.key}`;
    if (receiptKeys.has(unique)) apiError(422, 'validation_failed');
    receiptKeys.add(unique);
  }
  return state;
}

module.exports = { emptyState, apiError, object, validId, hashPassword, verifyPassword, fixtureState, validateImportedState };
