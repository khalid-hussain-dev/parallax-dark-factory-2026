'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const domain = require('../domain/reservations');
const time = require('../domain/time');
const policyDomain = require('../domain/policies');

function emptyState() {
  return { users: [], restaurants: [], reservations: [], tokens: [], receipts: [], series: [], closures: [], replans: [] };
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
  const userIds = new Set(fixture.users.map(user => user.id));
  for (const restaurant of fixture.restaurants) {
    if (!object(restaurant)) apiError(400, 'malformed_request');
    const fields = { id: 'string', name: 'string', timezone: 'string', slot_minutes: 'number', reservation_duration_minutes: 'number', cancellation_cutoff_minutes: 'number', opening_hours: 'array', tables: 'array' };
    for (const [field, type] of Object.entries(fields)) {
      if (!Object.hasOwn(restaurant, field)) apiError(422, 'validation_failed');
      const matches = type === 'array' ? Array.isArray(restaurant[field]) : typeof restaurant[field] === type;
      if (!matches) apiError(400, 'malformed_request');
    }
    if (!validId(restaurant.id) || !Number.isInteger(restaurant.slot_minutes) || restaurant.slot_minutes <= 0 || !Number.isInteger(restaurant.reservation_duration_minutes) || restaurant.reservation_duration_minutes <= 0 || !Number.isInteger(restaurant.cancellation_cutoff_minutes) || restaurant.cancellation_cutoff_minutes < 0 || restaurantIds.has(restaurant.id)) apiError(422, 'validation_failed');
    if (Object.hasOwn(restaurant, 'manager_user_ids')) {
      if (!Array.isArray(restaurant.manager_user_ids)) apiError(400, 'malformed_request');
      if (restaurant.manager_user_ids.some(id => typeof id !== 'string')) apiError(400, 'malformed_request');
      if (new Set(restaurant.manager_user_ids).size !== restaurant.manager_user_ids.length || restaurant.manager_user_ids.some(id => !validId(id) || !userIds.has(id))) apiError(422, 'validation_failed');
    }
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
  state.restaurants = structuredClone(fixture.restaurants).map(restaurant => ({ ...restaurant, combinable: restaurant.combinable || [], manager_user_ids: restaurant.manager_user_ids || [], policies: [], revision: 0 }));
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

function validateReceiptReservation(value, receiptUserId, state, allowCancelled = false) {
  const allowedFields = new Set(['reservation_id', 'reference', 'restaurant_id', 'table_id', 'table_ids', 'party_size', 'status', 'starts_at_local', 'starts_at', 'ends_at', 'created_at', 'revision', 'accepted_terms']);
  if (!object(value) || Object.keys(value).some(field => !allowedFields.has(field))) return false;
  if (!object(value) || !validId(value.reservation_id) || !validReference(value.reference) ||
      !validId(value.restaurant_id) || !Number.isInteger(value.party_size) || value.party_size < 1 ||
      (value.status !== 'confirmed' && !(allowCancelled && value.status === 'cancelled')) || typeof value.starts_at_local !== 'string' ||
      !validRfc3339(value.starts_at) || !validRfc3339(value.ends_at) || !validRfc3339(value.created_at)) return false;
  const saved = state.reservations.find(r => r.reservation_id === value.reservation_id &&
    r.reference === value.reference && r.user_id === receiptUserId && r.restaurant_id === value.restaurant_id);
  const restaurant = state.restaurants.find(r => r.id === value.restaurant_id);
  if (!saved || !restaurant || value.created_at !== saved.created_at ||
      (Object.hasOwn(value, 'revision') !== Object.hasOwn(value, 'accepted_terms')) ||
      (Object.hasOwn(value, 'revision') && (!Number.isInteger(value.revision) || value.revision < 1))) return false;
  const tableIds = Array.isArray(value.table_ids) ? value.table_ids :
    (typeof value.table_id === 'string' ? [value.table_id] : null);
  if (!tableIds || (Object.hasOwn(value, 'table_id') &&
      (tableIds.length !== 1 || value.table_id !== tableIds[0]))) return false;
  const policyCandidates = [];
  if (value.accepted_terms) {
    try {
      const accepted = policyDomain.validateTerms(restaurant, value.accepted_terms);
      const expected = accepted.policy_version === 0 ? policyDomain.baseline(restaurant) :
        policyDomain.snapshot(restaurant.policies.find(policy => policy.policy_version === accepted.policy_version));
      if (!expected || stable(accepted) !== stable(expected)) return false;
      const historical = historySnapshot(saved, value.revision, restaurant);
      if (!historical || historical.status !== value.status || historical.starts_at_local !== value.starts_at_local ||
          historical.party_size !== value.party_size || stable(historical.table_ids) !== stable(tableIds) ||
          stable(historical.accepted_terms) !== stable(accepted)) return false;
      policyCandidates.push(accepted);
    } catch { return false; }
  } else {
    policyCandidates.push(policyDomain.baseline(restaurant));
    const localDate = value.starts_at_local.slice(0, 10);
    for (const policy of restaurant.policies || []) if (policy.effective_from <= localDate) policyCandidates.push(policyDomain.snapshot(policy));
  }
  return policyCandidates.some(policy => {
    try {
      const effectiveRestaurant = policyDomain.asRestaurant(restaurant, policy);
      const selection = domain.selectTables(effectiveRestaurant, { table_ids: tableIds });
      if (selection.ids.length !== tableIds.length || selection.ids.some((id, index) => id !== tableIds[index]) ||
          value.party_size > selection.tables.reduce((sum, table) => sum + table.capacity, 0)) return false;
      const startsAt = time.validateWindow(effectiveRestaurant, value.starts_at_local);
      return value.starts_at === time.timestamp(startsAt, restaurant.timezone) &&
        value.ends_at === time.timestamp(startsAt + policy.reservation_duration_minutes * 60000, restaurant.timezone);
    } catch { return false; }
  });
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

function samePolicyValues(a, b) {
  if (!object(a) || !object(b)) return false;
  const fields = ['effective_from', 'slot_minutes', 'reservation_duration_minutes', 'cancellation_cutoff_minutes'];
  if (fields.some(field => a[field] !== b[field])) return false;
  if (stable(a.opening_hours) !== stable(b.opening_hours) || stable(a.capacities) !== stable(b.capacities)) return false;
  return true;
}

function historySnapshot(reservation, revision, restaurant) {
  if (!Array.isArray(reservation.history) || !Number.isInteger(revision) || revision < 1 || revision > reservation.history.length) return null;
  let tableIds = null, startsAtLocal = null, partySize = null, status = 'confirmed', terms = null;
  for (const entry of reservation.history.slice(0, revision)) {
    for (const change of entry.changes) {
      if (change.field === 'table_id') tableIds = [change.to];
      else if (change.field === 'table_ids') tableIds = change.to.slice();
      else if (change.field === 'starts_at_local') startsAtLocal = change.to;
      else if (change.field === 'party_size') partySize = change.to;
    }
    if (entry.event === 'cancelled') status = 'cancelled';
    terms = entry.accepted_terms;
  }
  if (!tableIds || !startsAtLocal || !Number.isInteger(partySize)) return null;
  try { tableIds = domain.selectTables(restaurant, { table_ids: tableIds }).ids; } catch { return null; }
  return { table_ids: tableIds, starts_at_local: startsAtLocal, party_size: partySize, status, accepted_terms: terms };
}

function validateSeriesReceipt(receipt, state) {
  const { body, response, user_id: userId } = receipt;
  if (Object.keys(response).some(field => !['series_id', 'revision', 'interval_weeks', 'occurrences'].includes(field)) ||
      !validReference(body.anchor_reference) || !Number.isInteger(body.count) || body.count < 2 || body.count > 12 ||
      !Number.isInteger(body.interval_weeks) || body.interval_weeks < 1 || body.interval_weeks > 4 ||
      !validId(response.series_id) || response.revision !== 1 || response.interval_weeks !== body.interval_weeks ||
      !Array.isArray(response.occurrences) || response.occurrences.length !== body.count) return false;
  const anchor = state.reservations.find(item => item.reference === body.anchor_reference && item.user_id === userId);
  const series = state.series.find(item => item.series_id === response.series_id);
  if (!anchor || !series || !Array.isArray(series.occurrences) || series.user_id !== userId || series.restaurant_id !== anchor.restaurant_id ||
      series.interval_weeks !== body.interval_weeks || series.occurrences.length !== body.count ||
      !object(response.occurrences[0]) || response.occurrences[0].reference !== body.anchor_reference) return false;
  const anchorResponse = response.occurrences[0].reservation;
  if (!object(anchorResponse)) return false;
  const anchorLocal = anchorResponse.starts_at_local;
  if (typeof anchorLocal !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(anchorLocal)) return false;
  const anchorDate = anchorLocal.slice(0, 10), clock = anchorLocal.slice(10);
  return response.occurrences.every((occurrence, index) => {
    if (!object(occurrence) || Object.keys(occurrence).some(field => !['index', 'reference', 'exception', 'reservation'].includes(field)) ||
        occurrence.index !== index || occurrence.exception !== false ||
        !validReference(occurrence.reference) || !object(occurrence.reservation) ||
        occurrence.reservation.reference !== occurrence.reference ||
        series.occurrences[index]?.index !== index || series.occurrences[index]?.reference !== occurrence.reference ||
        !validateReceiptReservation(occurrence.reservation, userId, state)) return false;
    const saved = state.reservations.find(item => item.reference === occurrence.reference && item.user_id === userId);
    const date = new Date(`${anchorDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index * body.interval_weeks * 7);
    const expectedDate = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    return !!saved && saved.restaurant_id === anchor.restaurant_id && saved.series_id === response.series_id &&
      occurrence.reservation.starts_at_local === `${expectedDate}${clock}` &&
      occurrence.reservation.party_size === anchorResponse.party_size &&
      sameReservationTables(anchorResponse, occurrence.reservation);
  });
}

function validatePolicyReceipt(receipt, state) {
  const match = receipt.path.match(/^\/restaurants\/([^/]+)\/policies$/);
  if (!match) return false;
  let restaurantId;
  try { restaurantId = decodeURIComponent(match[1]); } catch { return false; }
  const restaurant = state.restaurants.find(item => item.id === restaurantId);
  const response = receipt.response;
  if (!restaurant || !(restaurant.manager_user_ids || []).includes(receipt.user_id) ||
      Object.keys(response).some(field => !['effective_from', 'slot_minutes', 'reservation_duration_minutes', 'cancellation_cutoff_minutes', 'opening_hours', 'capacities', 'policy_version'].includes(field)) ||
      !Number.isInteger(response.policy_version) || response.policy_version < 1) return false;
  let requested;
  try { requested = policyDomain.validatePolicy(restaurant, receipt.body); } catch { return false; }
  const saved = restaurant.policies.find(policy => policy.policy_version === response.policy_version);
  return !!saved && samePolicyValues(requested, saved) && samePolicyValues(saved, response);
}

function validateReservationHistory(reservation, restaurant) {
  const history = reservation.history;
  if (!Array.isArray(history) || !history.length || history.some(entry => !object(entry)) || history[0].event !== 'created' ||
      history.filter(entry => entry.event === 'created').length !== 1 ||
      history.some((entry, index) => entry.seq !== index + 1 || entry.revision !== index + 1 ||
        !validRfc3339(entry.at) || (index > 0 && Date.parse(entry.at) < Date.parse(history[index - 1].at)))) return false;
  const terminalCancellation = history[history.length - 1].event === 'cancelled';
  if (history.some((entry, index) => entry.event === 'cancelled' && index !== history.length - 1) ||
      (reservation.status === 'cancelled') !== terminalCancellation || reservation.revision !== history.length) return false;

  let tableIds = null, startsAtLocal = null, partySize = null;
  for (let index = 0; index < history.length; index++) {
    const entry = history[index];
    if (entry.changes.some(change => !object(change))) return false;
    if (index === 0) {
      if (entry.changes.length !== 3 || entry.changes[0].from !== null || entry.changes[1].field !== 'starts_at_local' || entry.changes[1].from !== null ||
          entry.changes[2].field !== 'party_size' || entry.changes[2].from !== null || Date.parse(entry.at) !== Date.parse(reservation.created_at)) return false;
    } else if (entry.event === 'cancelled') {
      if (entry.changes.length !== 0 || index !== history.length - 1) return false;
      continue;
    } else if (entry.event === 'reassigned') {
      if (!validId(entry.plan_id) || entry.changes.length !== 1 || entry.changes[0].field !== 'table_ids' ||
          stable(entry.accepted_terms) !== stable(history[index - 1]?.accepted_terms)) return false;
    } else if (entry.event !== 'changed' || entry.changes.length < 1) return false;

    let previousRank = -1;
    const seen = new Set();
    for (const change of entry.changes) {
      if (!object(change) || !['table_id', 'table_ids', 'starts_at_local', 'party_size'].includes(change.field) || seen.has(change.field)) return false;
      seen.add(change.field);
      const rank = change.field === 'table_id' || change.field === 'table_ids' ? 0 : change.field === 'starts_at_local' ? 1 : 2;
      if (rank <= previousRank) return false;
      previousRank = rank;
      if (change.field === 'table_id' || change.field === 'table_ids') {
        if (index === 0 && change !== entry.changes[0]) return false;
        const current = tableIds;
        const next = change.field === 'table_id' ? (typeof change.to === 'string' ? [change.to] : null) :
          (Array.isArray(change.to) ? change.to : null);
        const pairChange = (current?.length || 0) > 1 || (next?.length || 0) > 1;
        const expectedFrom = current === null ? null : (pairChange || entry.event === 'reassigned') ? current.slice() : current[0];
        if (stable(change.from) !== stable(expectedFrom)) return false;
        if (!next || next.length < 1 || next.length > 2 || new Set(next).size !== next.length ||
            (change.field === 'table_id' && (next.length !== 1 || pairChange)) ||
            (change.field === 'table_ids' && !pairChange && entry.event !== 'reassigned') ||
            (index === 0 && change.field !== (next.length > 1 ? 'table_ids' : 'table_id'))) return false;
        let selection;
        try { selection = domain.selectTables(restaurant, { table_ids: next }); } catch { return false; }
        if (stable(selection.ids) !== stable(next) || (index > 0 && stable(next) === stable(current))) return false;
        tableIds = next;
      } else if (change.field === 'starts_at_local') {
        if (change.from !== startsAtLocal || typeof change.to !== 'string' || (index > 0 && change.to === startsAtLocal)) return false;
        startsAtLocal = change.to;
      } else {
        if (change.from !== partySize || !Number.isInteger(change.to) || change.to < 1 || (index > 0 && change.to === partySize)) return false;
        partySize = change.to;
      }
    }
    if (index === 0 && (entry.event !== 'created' || !['table_id', 'table_ids'].includes(entry.changes[0].field))) return false;
    if (entry.event !== 'cancelled') {
      if (!tableIds || !startsAtLocal || !Number.isInteger(partySize)) return false;
      try {
        const acceptedRestaurant = policyDomain.asRestaurant(restaurant, entry.accepted_terms);
        const selected = domain.selectTables(acceptedRestaurant, { table_ids: tableIds });
        if (partySize > selected.tables.reduce((sum, table) => sum + table.capacity, 0)) return false;
        time.validateWindow(acceptedRestaurant, startsAtLocal);
      } catch { return false; }
    }
  }
  const normalizedTables = domain.reservationTableIds(reservation);
  return stable(tableIds) === stable(normalizedTables) && startsAtLocal === reservation.starts_at_local && partySize === reservation.party_size &&
    stable(history[history.length - 1].accepted_terms) === stable(reservation.accepted_terms);
}

function validStage4Records(state, users, restaurantIds) {
  const planById = new Map();
  const closureByPlan = new Map();
  for (const closure of state.closures) {
    if (!object(closure) || !validId(closure.plan_id) || closureByPlan.has(closure.plan_id) ||
        !restaurantIds.has(closure.restaurant_id) || typeof closure.table_id !== 'string' ||
        typeof closure.from !== 'string' || typeof closure.to !== 'string' ||
        !validRfc3339(closure.from) || !validRfc3339(closure.to) ||
        !Number.isFinite(closure.from_ms) || !Number.isFinite(closure.to_ms) ||
        Date.parse(closure.from) !== closure.from_ms || Date.parse(closure.to) !== closure.to_ms ||
        closure.from_ms >= closure.to_ms) return false;
    const restaurant = state.restaurants.find(item => item.id === closure.restaurant_id);
    if (!restaurant?.tables.some(table => table.id === closure.table_id)) return false;
    closureByPlan.set(closure.plan_id, closure);
  }

  for (const plan of state.replans) {
    if (!object(plan) || !validId(plan.plan_id) || planById.has(plan.plan_id) ||
        !restaurantIds.has(plan.restaurant_id) || !Number.isInteger(plan.restaurant_revision) ||
        plan.restaurant_revision < 0 || typeof plan.applied !== 'boolean' ||
        !Number.isFinite(plan.created_at_ms) || !object(plan.closure) ||
        typeof plan.closure.table_id !== 'string' || typeof plan.closure.from !== 'string' || typeof plan.closure.to !== 'string' ||
        !validRfc3339(plan.closure.from) || !validRfc3339(plan.closure.to) ||
        !Number.isFinite(plan.closure.from_ms) || !Number.isFinite(plan.closure.to_ms) ||
        Date.parse(plan.closure.from) !== plan.closure.from_ms || Date.parse(plan.closure.to) !== plan.closure.to_ms ||
        plan.closure.from_ms >= plan.closure.to_ms || !Array.isArray(plan.assignments) ||
        plan.assignments.length > 6 || !Array.isArray(plan.considered_snapshot) ||
        plan.considered_snapshot.length !== plan.assignments.length ||
        !Number.isInteger(plan.moved_count) || plan.moved_count < 0 || plan.moved_count > plan.assignments.length ||
        !Number.isInteger(plan.unused_seats) || plan.unused_seats < 0) return false;
    planById.set(plan.plan_id, plan);
    const restaurant = state.restaurants.find(item => item.id === plan.restaurant_id);
    if (!restaurant?.tables.some(table => table.id === plan.closure.table_id) ||
        plan.restaurant_revision > restaurant.revision) return false;
    const assignments = plan.assignments, snapshots = plan.considered_snapshot;
    if (assignments.some((item, index) => !object(item) || !validReference(item.reference) ||
        typeof item.changed !== 'boolean' || !Array.isArray(item.table_ids) ||
        item.table_ids.length < 1 || item.table_ids.length > 2 ||
        (index > 0 && assignments[index - 1].reference >= item.reference))) return false;
    let moved = 0, unused = 0;
    for (let index = 0; index < assignments.length; index++) {
      const assignment = assignments[index], snapshot = snapshots[index];
      if (!object(snapshot) || assignment.reference !== snapshot.reference ||
          !validId(snapshot.owner_id) || !users.has(snapshot.owner_id) ||
          !validId(snapshot.reservation_id) || !Number.isInteger(snapshot.revision) || snapshot.revision < 1 ||
          !Number.isInteger(snapshot.party_size) || snapshot.party_size < 1 ||
          typeof snapshot.starts_at_local !== 'string' ||
          !Number.isFinite(snapshot.starts_at_ms) || !Number.isFinite(snapshot.ends_at_ms) ||
          snapshot.starts_at_ms >= snapshot.ends_at_ms || !Array.isArray(snapshot.table_ids) ||
          !object(snapshot.accepted_terms)) return false;
      const current = state.reservations.find(item => item.reference === snapshot.reference &&
        item.restaurant_id === plan.restaurant_id && item.user_id === snapshot.owner_id);
      if (!current) return false;
      if (current.reservation_id !== snapshot.reservation_id) return false;
      let oldSelection, newSelection, terms;
      try {
        oldSelection = domain.selectTables(restaurant, { table_ids: snapshot.table_ids });
        newSelection = domain.selectTables(restaurant, { table_ids: assignment.table_ids });
        terms = policyDomain.validateTerms(restaurant, snapshot.accepted_terms);
      } catch { return false; }
      let historical, historicalStart;
      try {
        historical = historySnapshot(current, snapshot.revision, restaurant);
        historicalStart = time.validateWindow(policyDomain.asRestaurant(restaurant, terms), snapshot.starts_at_local);
      } catch { return false; }
      if (!historical || historical.status !== 'confirmed' || historical.starts_at_local !== snapshot.starts_at_local ||
          historical.party_size !== snapshot.party_size || stable(historical.table_ids) !== stable(snapshot.table_ids) ||
          stable(historical.accepted_terms) !== stable(snapshot.accepted_terms)) return false;
      if (stable(oldSelection.ids) !== stable(snapshot.table_ids) ||
          stable(newSelection.ids) !== stable(assignment.table_ids) ||
          stable(terms) !== stable(snapshot.accepted_terms) ||
          terms.reservation_duration_minutes * 60000 !== snapshot.ends_at_ms - snapshot.starts_at_ms ||
          historicalStart !== snapshot.starts_at_ms ||
          snapshot.party_size > snapshot.table_ids.reduce((sum, id) => sum + terms.capacities[id], 0) ||
          snapshot.party_size > assignment.table_ids.reduce((sum, id) => sum + terms.capacities[id], 0) ||
          !(snapshot.starts_at_ms < plan.closure.to_ms && plan.closure.from_ms < snapshot.ends_at_ms) ||
          (assignment.table_ids.includes(plan.closure.table_id) && snapshot.starts_at_ms < plan.closure.to_ms && plan.closure.from_ms < snapshot.ends_at_ms)) return false;
      const changed = stable(snapshot.table_ids) !== stable(assignment.table_ids);
      if (assignment.changed !== changed) return false;
      if (changed) moved++;
      unused += assignment.table_ids.reduce((sum, id) => sum + terms.capacities[id], 0) - snapshot.party_size;
    }
    if (moved !== plan.moved_count || unused !== plan.unused_seats) return false;
    const appliedClosure = closureByPlan.get(plan.plan_id);
    if (plan.applied !== !!appliedClosure ||
        (appliedClosure && (appliedClosure.restaurant_id !== plan.restaurant_id ||
          stable({ table_id: appliedClosure.table_id, from: appliedClosure.from, to: appliedClosure.to }) !==
          stable({ table_id: plan.closure.table_id, from: plan.closure.from, to: plan.closure.to })))) return false;
    if (plan.applied) {
      const result = plan.applied_response;
      if (!object(result) || Object.keys(result).some(field => !['plan_id', 'restaurant_revision', 'reservations'].includes(field)) ||
          result.plan_id !== plan.plan_id || result.restaurant_revision !== plan.restaurant_revision + 1 ||
          !Number.isFinite(plan.applied_at_ms) ||
          !Array.isArray(result.reservations) || result.reservations.length !== assignments.length) return false;
      for (let index = 0; index < assignments.length; index++) {
        const response = result.reservations[index], assignment = assignments[index], snapshot = snapshots[index];
        const saved = state.reservations.find(item => item.reference === assignment.reference &&
          item.restaurant_id === plan.restaurant_id && item.user_id === snapshot.owner_id);
        const historical = saved && historySnapshot(saved, response?.revision, restaurant);
        if (!validateReceiptReservation(response, snapshot.owner_id, state) ||
            response.reference !== assignment.reference ||
            !sameReservationTables(response, { table_ids: assignment.table_ids }) ||
            response.party_size !== snapshot.party_size || !historical ||
            historical.starts_at_local !== response.starts_at_local || historical.status !== response.status ||
            historical.party_size !== response.party_size ||
            stable(historical.table_ids) !== stable(assignment.table_ids) ||
            stable(historical.accepted_terms) !== stable(response.accepted_terms)) return false;
      }
    } else if (Object.hasOwn(plan, 'applied_response') || Object.hasOwn(plan, 'applied_at_ms')) return false;
  }
  for (const [planId] of closureByPlan) if (!planById.has(planId)) return false;

  for (const reservation of state.reservations) {
    for (const entry of reservation.history || []) {
      if (entry.event === 'reassigned') {
        const plan = planById.get(entry.plan_id);
        if (!plan || !plan.applied || plan.restaurant_id !== reservation.restaurant_id ||
            !plan.assignments.some(item => item.reference === reservation.reference && item.changed)) return false;
      }
    }
    if (reservation.status !== 'confirmed') continue;
    for (const closure of state.closures) {
      if (closure.restaurant_id === reservation.restaurant_id &&
          domain.reservationTableIds(reservation).includes(closure.table_id) &&
          reservation.starts_at_ms < closure.to_ms && closure.from_ms < reservation.ends_at_ms) return false;
    }
  }
  return true;
}

function validateStage4Receipt(receipt, state) {
  const { body, response, user_id: userId, path } = receipt;
  const replanMatch = path.match(/^\/restaurants\/([^/]+)\/replans$/);
  if (replanMatch) {
    let restaurantId;
    try { restaurantId = decodeURIComponent(replanMatch[1]); } catch { return false; }
    const plan = state.replans.find(item => item.plan_id === response.plan_id && item.restaurant_id === restaurantId);
    const restaurant = state.restaurants.find(item => item.id === restaurantId);
    return !!plan && !!restaurant && (restaurant.manager_user_ids || []).includes(userId) &&
      body.table_id === plan.closure.table_id && body.from === plan.closure.from && body.to === plan.closure.to &&
      stable(planViewForImport(plan)) === stable(response);
  }
  const applyMatch = path.match(/^\/restaurants\/([^/]+)\/replans\/([^/]+)\/apply$/);
  if (applyMatch) {
    let restaurantId, planId;
    try { restaurantId = decodeURIComponent(applyMatch[1]); planId = decodeURIComponent(applyMatch[2]); } catch { return false; }
    const plan = state.replans.find(item => item.plan_id === planId && item.restaurant_id === restaurantId);
    const restaurant = state.restaurants.find(item => item.id === restaurantId);
    return !!plan && plan.applied && !!plan.applied_response && !!restaurant &&
      (restaurant.manager_user_ids || []).includes(userId) && stable(plan.applied_response) === stable(response);
  }
  const amendMatch = path.match(/^\/series\/([^/]+)\/amend$/);
  if (amendMatch) {
    let seriesId;
    try { seriesId = decodeURIComponent(amendMatch[1]); } catch { return false; }
    const series = state.series.find(item => item.series_id === seriesId && item.user_id === userId);
    if (!series || Object.keys(response).some(field => !['series_id', 'revision', 'interval_weeks', 'occurrences'].includes(field)) ||
        !validId(response.series_id) || response.series_id !== seriesId ||
        !Number.isInteger(response.revision) || response.revision < 1 || response.revision > series.revision ||
        response.interval_weeks !== series.interval_weeks || !Array.isArray(response.occurrences) ||
        response.occurrences.length !== series.occurrences.length ||
        !Number.isInteger(body.expected_revision) || body.expected_revision < 1 ||
        !Number.isInteger(body.from_index) || body.from_index < 0 || body.from_index >= series.occurrences.length ||
        typeof body.local_time !== 'string' || !/^\d{2}:\d{2}$/.test(body.local_time) ||
        Number(body.local_time.slice(0, 2)) > 23 || Number(body.local_time.slice(3)) > 59 ||
        ![response.revision, response.revision - 1].includes(body.expected_revision)) return false;
    return response.occurrences.every((item, index) => {
      const savedOccurrence = series.occurrences[index];
      const reservationAtResponse = object(item?.reservation) &&
        state.reservations.find(record => record.reference === item.reference && record.user_id === userId);
      if (!object(item) || Object.keys(item).some(field => !['index', 'reference', 'exception', 'reservation'].includes(field)) ||
          item.index !== index || item.reference !== savedOccurrence.reference || typeof item.exception !== 'boolean' ||
          !object(item.reservation) || item.reservation.reference !== item.reference ||
          reservationAtResponse?.series_id !== seriesId || !validateReceiptReservation(item.reservation, userId, state, true)) return false;
      const historical = historySnapshot(reservationAtResponse, item.reservation.revision,
        state.restaurants.find(restaurant => restaurant.id === series.restaurant_id));
      if (!historical) return false;
      const eligible = index >= body.from_index && !item.exception && historical.status === 'confirmed';
      if (eligible && item.reservation.starts_at_local !== `${savedOccurrence.scheduled_date}T${body.local_time}`) return false;
      return true;
    });
  }
  return false;
}

function planViewForImport(plan) {
  return {
    plan_id: plan.plan_id,
    restaurant_revision: plan.restaurant_revision,
    closure: { table_id: plan.closure.table_id, from: plan.closure.from, to: plan.closure.to },
    assignments: plan.assignments.map(item => ({ reference: item.reference, table_ids: item.table_ids.slice(), changed: item.changed })),
    moved_count: plan.moved_count,
    unused_seats: plan.unused_seats,
  };
}


function validateImportedState(value) {
  if (!object(value) || !Array.isArray(value.users) || !Array.isArray(value.restaurants) || !Array.isArray(value.reservations) || !Array.isArray(value.tokens) || !Array.isArray(value.receipts)) apiError(422, 'validation_failed');
  const state = structuredClone(value);
  if (!Object.hasOwn(state, 'series')) state.series = [];
  if (!Array.isArray(state.series)) apiError(422, 'validation_failed');
  if (!Object.hasOwn(state, 'closures')) state.closures = [];
  if (!Object.hasOwn(state, 'replans')) state.replans = [];
  if (!Array.isArray(state.closures) || !Array.isArray(state.replans)) apiError(422, 'validation_failed');
  for (const restaurant of state.restaurants) {
    if (object(restaurant) && !Object.hasOwn(restaurant, 'combinable')) restaurant.combinable = [];
    if (object(restaurant) && !Object.hasOwn(restaurant, 'manager_user_ids')) restaurant.manager_user_ids = [];
    if (object(restaurant) && !Object.hasOwn(restaurant, 'policies')) restaurant.policies = [];
    if (object(restaurant) && !Object.hasOwn(restaurant, 'revision')) restaurant.revision = 0;
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
      validateFixtureShape({ users: state.users.map(user => ({ id: user.user_id, email: user.email, password: 'migration', display_name: user.display_name })), restaurants: [restaurant], reservations: [] });
      if (restaurantIds.has(restaurant.id)) apiError(422, 'validation_failed');
      restaurantIds.add(restaurant.id);
      if (!Array.isArray(restaurant.policies) || !Array.isArray(restaurant.manager_user_ids) || restaurant.manager_user_ids.some(id => !users.has(id)) || !Number.isInteger(restaurant.revision) || restaurant.revision < 0) apiError(422, 'validation_failed');
      const versions = new Set();
      restaurant.policies.forEach((policy, index) => {
        const normalized = policyDomain.validatePolicy(restaurant, policy);
        if (!Number.isInteger(policy.policy_version) || policy.policy_version !== index + 1 || versions.has(policy.policy_version)) apiError(422, 'validation_failed');
        versions.add(policy.policy_version);
        restaurant.policies[index] = { ...normalized, policy_version: policy.policy_version };
      });
    }
  } catch { apiError(422, 'validation_failed'); }
  for (const r of state.reservations) {
    if (!object(r)) apiError(422, 'validation_failed');
    if (!Object.hasOwn(r, 'table_ids') && Object.hasOwn(r, 'table_id')) r.table_ids = [r.table_id];
    if (!Array.isArray(r.table_ids) || r.table_ids.some(id => typeof id !== 'string') || (Object.hasOwn(r, 'table_id') && (r.table_ids.length !== 1 || r.table_id !== r.table_ids[0]))) apiError(422, 'validation_failed');
    const restaurant = state.restaurants.find(x => x.id === r.restaurant_id);
    if (!validId(r.reservation_id) || !validReference(r.reference) || !users.has(r.user_id) || !restaurant || !Number.isInteger(r.party_size) || r.party_size < 1 || !['confirmed', 'cancelled'].includes(r.status) || typeof r.starts_at_local !== 'string' || typeof r.starts_at !== 'string' || typeof r.ends_at !== 'string' || !validRfc3339(r.created_at) || !Number.isFinite(r.starts_at_ms) || !Number.isFinite(r.ends_at_ms) || ids.has(r.reservation_id) || refs.has(r.reference)) apiError(422, 'validation_failed');
    const needsLegacyHistory = !Object.hasOwn(r, 'history');
    if (!Object.hasOwn(r, 'revision')) r.revision = 1;
    if (!Number.isInteger(r.revision) || r.revision < 1) apiError(422, 'validation_failed');
    if (!Object.hasOwn(r, 'accepted_terms')) r.accepted_terms = policyDomain.baseline(restaurant);
    if (!Object.hasOwn(r, 'history')) {
      if (r.revision !== 1) apiError(422, 'validation_failed');
      const tableIds = r.table_ids;
      r.history = [{ seq: 1, at: r.created_at, event: 'created', changes: [
        { field: tableIds.length > 1 ? 'table_ids' : 'table_id', from: null, to: tableIds.length > 1 ? tableIds.slice() : tableIds[0] },
        { field: 'starts_at_local', from: null, to: r.starts_at_local },
        { field: 'party_size', from: null, to: r.party_size },
      ], revision: 1, accepted_terms: structuredClone(r.accepted_terms) }];
      if (r.status === 'cancelled') {
        r.revision = 2;
        r.history.push({ seq: 2, at: r.created_at, event: 'cancelled', changes: [], revision: 2, accepted_terms: structuredClone(r.accepted_terms) });
      }
    }
    try {
      r.accepted_terms = policyDomain.validateTerms(restaurant, r.accepted_terms);
      const expected = r.accepted_terms.policy_version === 0 ? policyDomain.baseline(restaurant) :
        policyDomain.snapshot(restaurant.policies.find(policy => policy.policy_version === r.accepted_terms.policy_version));
      if (!expected || stable(r.accepted_terms) !== stable(expected)) apiError(422, 'validation_failed');
    }
    catch { apiError(422, 'validation_failed'); }
    if (!Array.isArray(r.history) || !r.history.length || r.history.some((entry, index) => !object(entry) || entry.seq !== index + 1 || !validRfc3339(entry.at) || !['created', 'changed', 'cancelled', 'reassigned'].includes(entry.event) || !Array.isArray(entry.changes) || !Number.isInteger(entry.revision) || entry.revision < 1 || entry.revision > r.revision || !object(entry.accepted_terms))) apiError(422, 'validation_failed');
    for (const entry of r.history) {
      try {
        entry.accepted_terms = policyDomain.validateTerms(restaurant, entry.accepted_terms);
        const expected = entry.accepted_terms.policy_version === 0 ? policyDomain.baseline(restaurant) :
          policyDomain.snapshot(restaurant.policies.find(policy => policy.policy_version === entry.accepted_terms.policy_version));
        if (!expected || stable(entry.accepted_terms) !== stable(expected)) apiError(422, 'validation_failed');
      }
      catch { apiError(422, 'validation_failed'); }
    }
    let selection;
    try { selection = domain.selectTables(restaurant, { table_ids: r.table_ids }); }
    catch { apiError(422, 'validation_failed'); }
    // Combination membership is unordered; normalize accepted pairs to the restaurant's declared order.
    r.table_ids = selection.ids;
    const acceptedRestaurant = policyDomain.asRestaurant(restaurant, r.accepted_terms);
    const acceptedSelection = domain.selectTables(acceptedRestaurant, { table_ids: r.table_ids });
    if (r.party_size > acceptedSelection.tables.reduce((sum, table) => sum + table.capacity, 0) || r.ends_at_ms - r.starts_at_ms !== r.accepted_terms.reservation_duration_minutes * 60000) apiError(422, 'validation_failed');
    if (r.table_ids.length === 1) r.table_id = r.table_ids[0];
    else if (Object.hasOwn(r, 'table_id')) apiError(422, 'validation_failed');
    try {
      const start = time.validateWindow(acceptedRestaurant, r.starts_at_local);
      if (start !== r.starts_at_ms || r.starts_at !== time.timestamp(start, restaurant.timezone) || r.ends_at !== time.timestamp(r.ends_at_ms, restaurant.timezone) || !Number.isFinite(Date.parse(r.created_at))) apiError(422, 'validation_failed');
    } catch { apiError(422, 'validation_failed'); }
    if (needsLegacyHistory && r.status === 'confirmed' && r.revision !== 1) apiError(422, 'validation_failed');
    if (!validateReservationHistory(r, restaurant)) apiError(422, 'validation_failed');
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
  const seriesIds = new Set();
  const seriesReferences = new Set();
  for (const series of state.series) {
    if (!object(series) || !validId(series.series_id) || seriesIds.has(series.series_id) || !users.has(series.user_id) ||
        !restaurantIds.has(series.restaurant_id) || !Number.isInteger(series.revision) || series.revision < 1 ||
        !Number.isInteger(series.interval_weeks) || series.interval_weeks < 1 || series.interval_weeks > 4 ||
        !Array.isArray(series.occurrences) || series.occurrences.length < 2 || series.occurrences.length > 12) apiError(422, 'validation_failed');
    seriesIds.add(series.series_id);
    const firstOccurrence = series.occurrences.find(item => item.index === 0);
    const createReceipt = state.receipts.find(receipt => receipt.user_id === series.user_id && receipt.path === '/series' &&
      receipt.response?.series_id === series.series_id);
    const originalLocal = createReceipt?.response?.occurrences?.[0]?.reservation?.starts_at_local;
    const anchorDate = typeof originalLocal === 'string' ? originalLocal.slice(0, 10) : null;
      try {
        if (!anchorDate || time.parseLocal(`${anchorDate}T00:00`).date !== anchorDate) apiError(422, 'validation_failed');
      } catch { apiError(422, 'validation_failed'); }
    for (let index = 0; index < series.occurrences.length; index++) {
      const occurrence = series.occurrences[index];
      const reservation = object(occurrence) && state.reservations.find(item => item.reference === occurrence.reference);
      if (!object(occurrence) || occurrence.index !== index || !validReference(occurrence.reference) ||
          typeof occurrence.exception !== 'boolean' || seriesReferences.has(occurrence.reference) || !reservation ||
          reservation.user_id !== series.user_id || reservation.restaurant_id !== series.restaurant_id || reservation.series_id !== series.series_id) apiError(422, 'validation_failed');
      seriesReferences.add(occurrence.reference);
      const d = new Date(`${anchorDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + index * series.interval_weeks * 7);
      const scheduledDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      if (Object.hasOwn(occurrence, 'scheduled_date') && occurrence.scheduled_date !== scheduledDate) apiError(422, 'validation_failed');
      occurrence.scheduled_date = scheduledDate;
    }
  }
  for (const reservation of state.reservations) {
    if (Object.hasOwn(reservation, 'series_id') && (!seriesIds.has(reservation.series_id) || !seriesReferences.has(reservation.reference))) apiError(422, 'validation_failed');
    if (!Object.hasOwn(reservation, 'series_id') && seriesReferences.has(reservation.reference)) apiError(422, 'validation_failed');
  }
  if (!validStage4Records(state, users, restaurantIds)) apiError(422, 'validation_failed');
  const receiptKeys = new Set();
  for (const receipt of state.receipts) {
    if (!object(receipt) || !users.has(receipt.user_id) || typeof receipt.key !== 'string' || receipt.key.length < 1 || receipt.key.length > 255 || receipt.method !== 'POST' || typeof receipt.path !== 'string' || !object(receipt.body) || receipt.status !== 201 || !object(receipt.response)) apiError(422, 'validation_failed');
    if (receipt.path === '/reservations') {
      const response = receipt.response;
      if (!validateReceiptReservation(response, receipt.user_id, state) ||
          receipt.body.restaurant_id !== response.restaurant_id || receipt.body.party_size !== response.party_size ||
          receipt.body.starts_at_local !== response.starts_at_local ||
          Object.hasOwn(receipt.body, 'table_id') === Object.hasOwn(receipt.body, 'table_ids') ||
          !sameReservationTables(receipt.body, response)) apiError(422, 'validation_failed');
    } else if (receipt.path === '/reservation-moves') {
      const moves = receipt.body.moves;
      const responses = receipt.response.reservations;
      if (Object.keys(receipt.response).some(field => field !== 'reservations') || !Array.isArray(moves) || moves.length < 1 || moves.length > 8 || !Array.isArray(responses) || responses.length !== moves.length ||
          moves.some((move, index) => !object(move) || typeof move.reference !== 'string' ||
            responses[index]?.reference !== move.reference || !validateReceiptReservation(responses[index], receipt.user_id, state)) ||
          new Set(moves.map(move => move.reference)).size !== moves.length) apiError(422, 'validation_failed');
      for (let i = 0; i < moves.length; i++) {
        const move = moves[i]; const response = responses[i];
        if ((Object.hasOwn(move, 'table_id') && Object.hasOwn(move, 'table_ids')) ||
            ((Object.hasOwn(move, 'table_id') || Object.hasOwn(move, 'table_ids')) && !sameReservationTables(move, response)) ||
            (Object.hasOwn(move, 'starts_at_local') && move.starts_at_local !== response.starts_at_local) ||
            (Object.hasOwn(move, 'party_size') && move.party_size !== response.party_size) ||
            (Number.isInteger(response.revision) && Object.hasOwn(move, 'expected_revision') &&
              (!Number.isInteger(move.expected_revision) || move.expected_revision < 1 || ![response.revision, response.revision - 1].includes(move.expected_revision)))) apiError(422, 'validation_failed');
      }
    } else if (receipt.path === '/series') {
      if (!validateSeriesReceipt(receipt, state)) apiError(422, 'validation_failed');
    } else if (/^\/restaurants\/[^/]+\/policies$/.test(receipt.path)) {
      if (!validatePolicyReceipt(receipt, state)) apiError(422, 'validation_failed');
    } else if (/^\/restaurants\/[^/]+\/replans$/.test(receipt.path) ||
        /^\/restaurants\/[^/]+\/replans\/[^/]+\/apply$/.test(receipt.path) ||
        /^\/series\/[^/]+\/amend$/.test(receipt.path)) {
      if (!validateStage4Receipt(receipt, state)) apiError(422, 'validation_failed');
    } else apiError(422, 'validation_failed');
    const unique = `${receipt.user_id}\0${receipt.key}\0${receipt.method}\0${receipt.path}`;
    if (receiptKeys.has(unique)) apiError(422, 'validation_failed');
    receiptKeys.add(unique);
  }
  return state;
}

module.exports = { emptyState, apiError, object, validId, hashPassword, verifyPassword, fixtureState, validateImportedState };
