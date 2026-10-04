'use strict';

const crypto = require('node:crypto');
const T = require('./time');

function restaurantFor(state, id) {
  const restaurant = state.restaurants.find(r => r.id === id);
  if (!restaurant) T.fail(404, 'not_found');
  return restaurant;
}

function reservationTableIds(reservation) {
  return Array.isArray(reservation.table_ids) ? reservation.table_ids : [reservation.table_id];
}

function publicReservation(r) {
  const tableIds = reservationTableIds(r);
  const result = {
    reservation_id: r.reservation_id,
    reference: r.reference,
    restaurant_id: r.restaurant_id,
    table_ids: tableIds.slice(),
    party_size: r.party_size,
    status: r.status,
    starts_at_local: r.starts_at_local,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    created_at: r.created_at,
  };
  if (tableIds.length === 1) result.table_id = tableIds[0];
  return result;
}

function validateParty(value) {
  if (!Number.isInteger(value) || value < 1) T.fail(422, 'validation_failed');
}

function tableFor(restaurant, id) {
  const table = restaurant.tables.find(t => t.id === id);
  if (!table) T.fail(404, 'not_found');
  return table;
}

function selectTables(restaurant, input) {
  const hasSingle = Object.hasOwn(input, 'table_id');
  const hasSet = Object.hasOwn(input, 'table_ids');
  if (hasSingle && hasSet) T.fail(422, 'validation_failed');
  if (!hasSingle && !hasSet) T.fail(422, 'validation_failed');
  let ids = hasSet ? input.table_ids : [input.table_id];
  if (!Array.isArray(ids)) T.fail(422, 'validation_failed');
  if (ids.length > 2) T.fail(422, 'combination_not_allowed');
  if (ids.length < 1) T.fail(422, 'validation_failed');
  if (new Set(ids).size !== ids.length) T.fail(422, 'validation_failed');
  const tables = ids.map(id => tableFor(restaurant, id));
  if (ids.length === 1) return { ids: [tables[0].id], tables };
  const pair = (restaurant.combinable || []).find(candidate => candidate.length === 2 &&
    candidate.includes(ids[0]) && candidate.includes(ids[1]));
  if (!pair) T.fail(422, 'combination_not_allowed');
  const ordered = pair.slice();
  return { ids: ordered, tables: ordered.map(id => tableFor(restaurant, id)) };
}

function endpointFor(restaurant, startsLocal, partySize, input) {
  validateParty(partySize);
  const selection = selectTables(restaurant, input);
  const capacity = selection.tables.reduce((sum, table) => sum + table.capacity, 0);
  if (partySize > capacity) T.fail(422, 'party_exceeds_capacity');
  const start = T.validateWindow(restaurant, startsLocal);
  return { ...selection, start, end: start + restaurant.reservation_duration_minutes * 60000 };
}

function conflicts(state, restaurantId, tableIds, start, end, excluded = new Set()) {
  const selected = new Set(tableIds);
  return state.reservations.some(r => r.status === 'confirmed' && r.restaurant_id === restaurantId &&
    !excluded.has(r.reference) && reservationTableIds(r).some(id => selected.has(id)) &&
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

function buildRecord(state, userId, restaurant, tableInput, startsLocal, partySize, nowMs, stable = {}, status = 'confirmed') {
  const { ids, start, end } = endpointFor(restaurant, startsLocal, partySize, tableInput);
  const record = {
    reservation_id: stable.reservation_id || createId(state),
    reference: stable.reference || createReference(state),
    user_id: userId,
    restaurant_id: restaurant.id,
    table_ids: ids,
    party_size: partySize,
    status,
    starts_at_local: startsLocal,
    starts_at_ms: start,
    ends_at_ms: end,
    starts_at: T.timestamp(start, restaurant.timezone),
    ends_at: T.timestamp(end, restaurant.timezone),
    created_at: stable.created_at || T.timestamp(nowMs, 'UTC'),
  };
  if (ids.length === 1) record.table_id = ids[0];
  return record;
}

function availability(state, query) {
  const restaurant = restaurantFor(state, query.restaurant_id);
  const party = Number(query.party_size);
  if (!Number.isInteger(party) || party < 1) T.fail(422, 'validation_failed');
  if (typeof query.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) T.fail(422, 'validation_failed');
  const check = T.parseLocal(`${query.date}T00:00`);
  if (check.date !== query.date) T.fail(422, 'validation_failed');
  const slots = [];
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
        !conflicts(state, restaurant.id, [table.id], start, end)).map(table => table.id);
      const options = available.map(id => ({ table_ids: [id], capacity: restaurant.tables.find(t => t.id === id).capacity }));
      for (const pair of restaurant.combinable || []) {
        const tables = pair.map(id => restaurant.tables.find(t => t.id === id));
        if (tables.length === 2 && tables.every(Boolean)) {
          const capacity = tables[0].capacity + tables[1].capacity;
          if (capacity >= party && !conflicts(state, restaurant.id, pair, start, end)) {
            options.push({ table_ids: pair.slice(), capacity });
          }
        }
      }
      slots.push({ starts_at_local: startsLocal, starts_at: T.timestamp(start, restaurant.timezone), available_table_ids: available, available_options: options });
    }
  }
  return { restaurant_id: restaurant.id, date: query.date, timezone: restaurant.timezone, slots };
}

function createReservation(state, userId, input, nowMs = Date.now()) {
  const restaurant = restaurantFor(state, input.restaurant_id);
  const record = buildRecord(state, userId, restaurant, input, input.starts_at_local, input.party_size, nowMs);
  if (conflicts(state, restaurant.id, record.table_ids, record.starts_at_ms, record.ends_at_ms)) T.fail(409, 'table_unavailable');
  state.reservations.push(record);
  return publicReservation(record);
}

function seedReservation(state, seed, nowMs = Date.now()) {
  if (typeof seed.reference !== 'string' || !/^[A-Z0-9]{6,12}$/.test(seed.reference)) T.fail(422, 'validation_failed');
  const restaurant = restaurantFor(state, seed.restaurant_id);
  const stable = { reservation_id: seed.id, reference: seed.reference };
  const status = seed.status === undefined ? 'confirmed' : seed.status;
  if (!['confirmed', 'cancelled'].includes(status)) T.fail(422, 'validation_failed');
  const record = buildRecord(state, seed.user_id, restaurant, seed, seed.starts_at_local, seed.party_size, nowMs, stable, status);
  if (status === 'confirmed' && conflicts(state, restaurant.id, record.table_ids, record.starts_at_ms, record.ends_at_ms)) T.fail(422, 'validation_failed');
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
  const tableInput = Object.hasOwn(patch, 'table_id') || Object.hasOwn(patch, 'table_ids') ? patch : { table_ids: reservationTableIds(original) };
  const startsLocal = Object.hasOwn(patch, 'starts_at_local') ? patch.starts_at_local : original.starts_at_local;
  const partySize = Object.hasOwn(patch, 'party_size') ? patch.party_size : original.party_size;
  const candidate = buildRecord(state, original.user_id, restaurant, tableInput, startsLocal, partySize, nowMs, original, original.status);
  return candidate;
}

function applyCandidate(original, candidate) {
  Object.assign(original, candidate);
  if (candidate.table_ids.length === 1) original.table_id = candidate.table_ids[0];
  else delete original.table_id;
}

function amendReservation(state, userId, reference, patch, nowMs = Date.now()) {
  const original = state.reservations.find(x => x.reference === reference && x.user_id === userId);
  if (!original) T.fail(404, 'not_found');
  const candidate = prepareAmendment(state, original, patch, nowMs);
  if (conflicts(state, original.restaurant_id, candidate.table_ids, candidate.starts_at_ms, candidate.ends_at_ms, new Set([reference]))) T.fail(409, 'table_unavailable');
  applyCandidate(original, candidate);
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
    if (conflicts(state, a.restaurant_id, a.table_ids, a.starts_at_ms, a.ends_at_ms, excluded)) T.fail(409, 'table_unavailable');
    for (let j = 0; j < i; j++) {
      const b = candidates[j];
      if (a.status === 'confirmed' && b.status === 'confirmed' && a.restaurant_id === b.restaurant_id &&
        a.table_ids.some(id => b.table_ids.includes(id)) && T.intervalsOverlap(a.starts_at_ms, a.ends_at_ms, b.starts_at_ms, b.ends_at_ms)) T.fail(409, 'table_unavailable');
    }
  }
  candidates.forEach((candidate, i) => applyCandidate(originals[i], candidate));
  return { reservations: originals.map(publicReservation) };
}

module.exports = { publicReservation, availability, createReservation, seedReservation, listReservations, getReservation, cancelReservation, amendReservation, moveReservations, reservationTableIds, selectTables };
