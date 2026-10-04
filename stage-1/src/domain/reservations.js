const crypto = require('node:crypto');
const T = require('./time');

function restaurantFor(state, id) {
  const restaurant = state.restaurants.find(r => r.id === id);
  if (!restaurant) T.fail(404, 'not_found');
  return restaurant;
}

function publicReservation(r) {
  return {
    reservation_id: r.reservation_id,
    reference: r.reference,
    restaurant_id: r.restaurant_id,
    table_id: r.table_id,
    party_size: r.party_size,
    status: r.status,
    starts_at_local: r.starts_at_local,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    created_at: r.created_at,
  };
}

function validateParty(value) {
  if (!Number.isInteger(value) || value < 1) T.fail(422, 'validation_failed');
}

function tableFor(restaurant, id) {
  const table = restaurant.tables.find(t => t.id === id);
  if (!table) T.fail(404, 'not_found');
  return table;
}

function endpointFor(restaurant, startsLocal, partySize, tableId) {
  validateParty(partySize);
  const table = tableFor(restaurant, tableId);
  if (partySize > table.capacity) T.fail(422, 'party_exceeds_capacity');
  const start = T.validateWindow(restaurant, startsLocal);
  return { table, start, end: start + restaurant.reservation_duration_minutes * 60000 };
}

function conflicts(state, restaurantId, tableId, start, end, excluded = new Set()) {
  return state.reservations.some(r => r.status === 'confirmed' && r.restaurant_id === restaurantId &&
    r.table_id === tableId && !excluded.has(r.reference) &&
    T.intervalsOverlap(start, end, r.starts_at_ms, r.ends_at_ms));
}

function createId(state) {
  let id;
  do { id = `res_${crypto.randomBytes(12).toString('hex')}`; }
  while (state.reservations.some(r => r.reservation_id === id));
  return id;
}

function createReference(state) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let ref;
  do {
    ref = Array.from(crypto.randomBytes(8), b => alphabet[b % alphabet.length]).join('').slice(0, 8);
  } while (state.reservations.some(r => r.reference === ref));
  return ref;
}

function buildRecord(state, userId, restaurant, tableId, startsLocal, partySize, nowMs, stable = {}) {
  const { table, start, end } = endpointFor(restaurant, startsLocal, partySize, tableId);
  return {
    reservation_id: stable.reservation_id || createId(state),
    reference: stable.reference || createReference(state),
    user_id: userId,
    restaurant_id: restaurant.id,
    table_id: table.id,
    party_size: partySize,
    status: 'confirmed',
    starts_at_local: startsLocal,
    starts_at_ms: start,
    ends_at_ms: end,
    starts_at: T.timestamp(start, restaurant.timezone),
    ends_at: T.timestamp(end, restaurant.timezone),
    created_at: stable.created_at || T.timestamp(nowMs, 'UTC'),
  };
}

function availability(state, query) {
  const restaurant = restaurantFor(state, query.restaurant_id);
  const party = Number(query.party_size);
  if (!Number.isInteger(party) || party < 1) T.fail(422, 'validation_failed');
  if (typeof query.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) T.fail(422, 'validation_failed');
  const check = T.parseLocal(`${query.date}T00:00`);
  if (check.date !== query.date) T.fail(422, 'validation_failed');
  let slots = [];
  const hours = T.hoursFor(restaurant, query.date);
  if (hours) {
    const open = T.minuteOfDay(hours.opens), close = T.minuteOfDay(hours.closes);
    for (let minute = open; minute + restaurant.reservation_duration_minutes <= close; minute += restaurant.slot_minutes) {
      const hhmm = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      const startsLocal = `${query.date}T${hhmm}`;
      const candidates = T.candidates(startsLocal, restaurant.timezone);
      if (!candidates.length) continue;
      const start = candidates[0];
      const end = start + restaurant.reservation_duration_minutes * 60000;
      const available = restaurant.tables.filter(table => table.capacity >= party &&
        !conflicts(state, restaurant.id, table.id, start, end)).map(table => table.id);
      slots.push({ starts_at_local: startsLocal, starts_at: T.timestamp(start, restaurant.timezone), available_table_ids: available });
    }
  }
  return { restaurant_id: restaurant.id, date: query.date, timezone: restaurant.timezone, slots };
}

function createReservation(state, userId, input, nowMs = Date.now()) {
  const restaurant = restaurantFor(state, input.restaurant_id);
  const record = buildRecord(state, userId, restaurant, input.table_id, input.starts_at_local, input.party_size, nowMs);
  if (conflicts(state, restaurant.id, record.table_id, record.starts_at_ms, record.ends_at_ms)) T.fail(409, 'table_unavailable');
  state.reservations.push(record);
  return publicReservation(record);
}

function seedReservation(state, seed, nowMs = Date.now()) {
  if (typeof seed.reference !== 'string' || !/^[A-Z0-9]{6,12}$/.test(seed.reference)) T.fail(422, 'validation_failed');
  const restaurant = restaurantFor(state, seed.restaurant_id);
  const stable = { reservation_id: seed.id, reference: seed.reference };
  const record = buildRecord(state, seed.user_id, restaurant, seed.table_id, seed.starts_at_local, seed.party_size, nowMs, stable);
  if (conflicts(state, restaurant.id, record.table_id, record.starts_at_ms, record.ends_at_ms)) T.fail(422, 'validation_failed');
  state.reservations.push(record);
  return publicReservation(record);
}

function listReservations(state, userId) {
  return { reservations: state.reservations.filter(r => r.user_id === userId)
    .slice().sort((a, b) => b.starts_at_ms - a.starts_at_ms).map(publicReservation) };
}

function getReservation(state, userId, reference) {
  const r = state.reservations.find(x => x.reference === reference && x.user_id === userId);
  if (!r) T.fail(404, 'not_found');
  return publicReservation(r);
}

function cutoffCheck(reservation, restaurant, nowMs) {
  if (nowMs >= reservation.starts_at_ms - restaurant.cancellation_cutoff_minutes * 60000) T.fail(409, 'cutoff_passed');
}

function cancelReservation(state, userId, reference, nowMs = Date.now()) {
  const r = state.reservations.find(x => x.reference === reference && x.user_id === userId);
  if (!r) T.fail(404, 'not_found');
  if (r.status === 'cancelled') return publicReservation(r);
  cutoffCheck(r, restaurantFor(state, r.restaurant_id), nowMs);
  r.status = 'cancelled';
  return publicReservation(r);
}

function prepareAmendment(state, original, patch, nowMs) {
  const restaurant = restaurantFor(state, original.restaurant_id);
  if (original.status === 'cancelled') T.fail(409, 'reservation_cancelled');
  cutoffCheck(original, restaurant, nowMs);
  const tableId = Object.hasOwn(patch, 'table_id') ? patch.table_id : original.table_id;
  const startsLocal = Object.hasOwn(patch, 'starts_at_local') ? patch.starts_at_local : original.starts_at_local;
  const partySize = Object.hasOwn(patch, 'party_size') ? patch.party_size : original.party_size;
  const candidate = buildRecord(state, original.user_id, restaurant, tableId, startsLocal, partySize, nowMs, original);
  candidate.status = original.status;
  return candidate;
}

function amendReservation(state, userId, reference, patch, nowMs = Date.now()) {
  const original = state.reservations.find(x => x.reference === reference && x.user_id === userId);
  if (!original) T.fail(404, 'not_found');
  const candidate = prepareAmendment(state, original, patch, nowMs);
  if (conflicts(state, original.restaurant_id, candidate.table_id, candidate.starts_at_ms, candidate.ends_at_ms, new Set([reference]))) T.fail(409, 'table_unavailable');
  Object.assign(original, candidate);
  return publicReservation(original);
}

function moveReservations(state, userId, moves, nowMs = Date.now()) {
  if (!Array.isArray(moves) || moves.length < 1 || moves.length > 8 || moves.some(m => !m || typeof m !== 'object' || Array.isArray(m) || typeof m.reference !== 'string') || new Set(moves.map(m => m.reference)).size !== moves.length) T.fail(422, 'validation_failed');
  const originals = [];
  let restaurantId;
  const candidates = [];
  for (const move of moves) {
    const original = state.reservations.find(r => r.reference === move.reference && r.user_id === userId);
    if (!original) T.fail(404, 'not_found');
    if (restaurantId !== undefined && original.restaurant_id !== restaurantId) T.fail(422, 'validation_failed');
    restaurantId = original.restaurant_id;
    originals.push(original);
    candidates.push(prepareAmendment(state, original, move, nowMs));
  }
  const excluded = new Set(originals.map(r => r.reference));
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (conflicts(state, a.restaurant_id, a.table_id, a.starts_at_ms, a.ends_at_ms, excluded)) T.fail(409, 'table_unavailable');
    for (let j = 0; j < i; j++) {
      const b = candidates[j];
      if (a.status === 'confirmed' && b.status === 'confirmed' && a.restaurant_id === b.restaurant_id && a.table_id === b.table_id && T.intervalsOverlap(a.starts_at_ms, a.ends_at_ms, b.starts_at_ms, b.ends_at_ms)) T.fail(409, 'table_unavailable');
    }
  }
  candidates.forEach((candidate, i) => Object.assign(originals[i], candidate));
  return { reservations: originals.map(publicReservation) };
}

module.exports = { publicReservation, availability, createReservation, seedReservation, listReservations, getReservation, cancelReservation, amendReservation, moveReservations };
