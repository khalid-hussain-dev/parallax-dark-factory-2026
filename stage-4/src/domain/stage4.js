'use strict';

const crypto = require('node:crypto');
const T = require('./time');
const R = require('./reservations');
const S3 = require('./stage3');

function error(status, code) { T.fail(status, code); }

function explicitInstant(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  if (!match || !Number.isFinite(Date.parse(value))) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1] ? Date.parse(value) : null;
}

function publicClosure(closure) {
  return { table_id: closure.table_id, from: closure.from, to: closure.to };
}

function planView(plan) {
  return {
    plan_id: plan.plan_id,
    restaurant_revision: plan.restaurant_revision,
    closure: publicClosure(plan.closure),
    assignments: plan.assignments.map(item => ({ reference: item.reference, table_ids: item.table_ids.slice(), changed: item.changed })),
    moved_count: plan.moved_count,
    unused_seats: plan.unused_seats,
  };
}

function optionCatalog(restaurant) {
  const options = restaurant.tables.map((table, rank) => ({ table_ids: [table.id], rank }));
  for (const pair of restaurant.combinable || []) options.push({ table_ids: pair.slice(), rank: options.length });
  return options;
}

function capacityFor(terms, tableIds) {
  if (!terms || !terms.capacities) return null;
  let total = 0;
  for (const id of tableIds) {
    const capacity = terms.capacities[id];
    if (!Number.isInteger(capacity) || capacity < 1) return null;
    total += capacity;
  }
  return total;
}

function overlaps(a, b) {
  return T.intervalsOverlap(a.starts_at_ms, a.ends_at_ms, b.starts_at_ms, b.ends_at_ms);
}

function sameSet(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function previewReplan(state, restaurantId, input, nowMs = Date.now()) {
  const restaurant = state.restaurants.find(item => item.id === restaurantId);
  if (!restaurant) error(404, 'not_found');
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.table_id !== 'string' || typeof input.from !== 'string' || typeof input.to !== 'string') error(422, 'validation_failed');
  const fromMs = explicitInstant(input.from), toMs = explicitInstant(input.to);
  if (fromMs === null || toMs === null || fromMs >= toMs) error(422, 'validation_failed');
  if (input.table_id.length > 64) error(422, 'validation_failed');
  if (typeof input.table_id !== 'string' || !restaurant.tables.some(table => table.id === input.table_id)) error(404, 'not_found');

  const considered = (state.reservations || []).filter(reservation =>
    reservation.restaurant_id === restaurantId && reservation.status === 'confirmed' &&
    T.intervalsOverlap(fromMs, toMs, reservation.starts_at_ms, reservation.ends_at_ms))
    .sort((a, b) => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0);
  const pairs = restaurant.combinable || [];
  if (restaurant.tables.length > 6 || pairs.length > 4 || considered.length > 6) error(422, 'planning_limit');

  const catalog = optionCatalog(restaurant);
  const consideredRefs = new Set(considered.map(reservation => reservation.reference));
  const choices = considered.map(reservation => catalog.filter(option => {
    if (capacityFor(reservation.accepted_terms, option.table_ids) < reservation.party_size) return false;
    if (option.table_ids.includes(input.table_id) && T.intervalsOverlap(fromMs, toMs, reservation.starts_at_ms, reservation.ends_at_ms)) return false;
    return !R.conflicts(state, restaurantId, option.table_ids, reservation.starts_at_ms, reservation.ends_at_ms, consideredRefs);
  }));
  if (choices.some(options => options.length === 0)) error(409, 'no_feasible_plan');

  let best = null;
  const assigned = [];
  function better(candidate, incumbent) {
    if (!incumbent) return true;
    if (candidate.changed !== incumbent.changed) return candidate.changed < incumbent.changed;
    if (candidate.unused !== incumbent.unused) return candidate.unused < incumbent.unused;
    for (let index = 0; index < candidate.ranks.length; index++) {
      if (candidate.ranks[index] !== incumbent.ranks[index]) return candidate.ranks[index] < incumbent.ranks[index];
    }
    return false;
  }
  function search(index, changed, unused, ranks) {
    if (best && changed > best.changed) return;
    if (index === considered.length) {
      const candidate = { changed, unused, ranks: ranks.slice(), assignments: assigned.slice() };
      if (better(candidate, best)) best = candidate;
      return;
    }
    const reservation = considered[index];
    const originalIds = R.reservationTableIds(reservation);
    for (const option of choices[index]) {
      if (assigned.some(previous => previous.reservation.restaurant_id === restaurantId &&
        previous.option.table_ids.some(id => option.table_ids.includes(id)) && overlaps(previous.reservation, reservation))) continue;
      const changedHere = sameSet(option.table_ids, originalIds) ? 0 : 1;
      const capacity = capacityFor(reservation.accepted_terms, option.table_ids);
      assigned.push({ reservation, option });
      search(index + 1, changed + changedHere, unused + capacity - reservation.party_size, [...ranks, option.rank]);
      assigned.pop();
    }
  }
  search(0, 0, 0, []);
  if (!best) error(409, 'no_feasible_plan');

  const assignments = best.assignments.map(({ reservation, option }) => ({
    reference: reservation.reference,
    table_ids: option.table_ids.slice(),
    changed: !sameSet(option.table_ids, R.reservationTableIds(reservation)),
  }));
  const plan = {
    plan_id: `plan_${crypto.randomBytes(12).toString('hex')}`,
    restaurant_id: restaurantId,
    restaurant_revision: restaurant.revision || 0,
    closure: { table_id: input.table_id, from: input.from, to: input.to, from_ms: fromMs, to_ms: toMs },
    considered_snapshot: considered.map(reservation => ({
      reference: reservation.reference,
      table_ids: R.reservationTableIds(reservation).slice(),
      owner_id: reservation.user_id,
      reservation_id: reservation.reservation_id,
      revision: reservation.revision,
      party_size: reservation.party_size,
      starts_at_local: reservation.starts_at_local,
      starts_at_ms: reservation.starts_at_ms,
      ends_at_ms: reservation.ends_at_ms,
      accepted_terms: structuredClone(reservation.accepted_terms),
    })),
    assignments,
    moved_count: best.changed,
    unused_seats: best.unused,
    applied: false,
    created_at_ms: nowMs,
  };
  state.replans.push(plan);
  return planView(plan);
}

function applyReplan(state, restaurantId, planId, nowMs = Date.now()) {
  const draft = structuredClone(state);
  const plan = (draft.replans || []).find(item => item.plan_id === planId && item.restaurant_id === restaurantId);
  if (!plan) error(404, 'not_found');
  if (plan.applied) error(409, 'plan_already_applied');
  const restaurant = draft.restaurants.find(item => item.id === restaurantId);
  if (!restaurant) error(404, 'not_found');
  if ((restaurant.revision || 0) !== plan.restaurant_revision) error(409, 'stale_plan');

  const reservations = [];
  const seriesIds = new Set();
  for (const assignment of plan.assignments) {
    const reservation = draft.reservations.find(item => item.reference === assignment.reference && item.restaurant_id === restaurantId && item.status === 'confirmed');
    if (!reservation) error(409, 'stale_plan');
    reservations.push(reservation);
  }
  for (let index = 0; index < plan.assignments.length; index++) {
    const assignment = plan.assignments[index];
    const reservation = reservations[index];
    if (assignment.changed && !R.applyReassignment(draft, reservation, assignment.table_ids, plan.plan_id, nowMs)) error(409, 'stale_plan');
    if (assignment.changed && reservation.series_id) seriesIds.add(reservation.series_id);
  }
  draft.closures.push({ restaurant_id: restaurantId, ...structuredClone(plan.closure), plan_id: plan.plan_id });
  restaurant.revision = (restaurant.revision || 0) + 1;
  for (const seriesId of seriesIds) {
    const series = draft.series.find(item => item.series_id === seriesId);
    if (series) series.revision += 1;
  }
  plan.applied = true;
  plan.applied_at_ms = nowMs;
  const response = {
    plan_id: plan.plan_id,
    restaurant_revision: restaurant.revision,
    reservations: reservations.map(R.publicReservation),
  };
  plan.applied_response = structuredClone(response);
  Object.assign(state, draft);
  return response;
}

function plusDays(dateValue, days) {
  const [year, month, day] = dateValue.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function scheduledAnchorDate(state, series) {
  const first = series.occurrences.find(item => item.index === 0);
  const value = first?.scheduled_date;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  try { if (T.parseLocal(`${value}T00:00`).date !== value) return null; } catch { return null; }
  return value;
}

function amendSeries(state, userId, seriesId, input, nowMs = Date.now()) {
  const series = (state.series || []).find(item => item.series_id === seriesId && item.user_id === userId);
  if (!series) error(404, 'not_found');
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Number.isInteger(input.expected_revision) || input.expected_revision < 1 ||
      !Number.isInteger(input.from_index) || input.from_index < 0 || input.from_index >= series.occurrences.length ||
      typeof input.local_time !== 'string' || !/^\d{2}:\d{2}$/.test(input.local_time) ||
      Number(input.local_time.slice(0, 2)) > 23 || Number(input.local_time.slice(3, 5)) > 59) error(422, 'validation_failed');
  if (input.expected_revision !== series.revision) error(409, 'stale_revision');

  const draft = structuredClone(state);
  const draftSeries = draft.series.find(item => item.series_id === seriesId);
  const restaurant = draft.restaurants.find(item => item.id === series.restaurant_id);
  const anchorDate = scheduledAnchorDate(draft, draftSeries);
  if (!anchorDate) error(422, 'validation_failed');

  const candidates = [];
  for (const occurrence of draftSeries.occurrences) {
    if (occurrence.index < input.from_index || occurrence.exception) continue;
    const reservation = draft.reservations.find(item => item.reference === occurrence.reference && item.user_id === userId);
    if (!reservation) error(422, 'validation_failed');
    if (reservation.status === 'cancelled') continue;
    const scheduledDate = plusDays(anchorDate, occurrence.index * draftSeries.interval_weeks * 7);
    const startsAtLocal = `${scheduledDate}T${input.local_time}`;
    if (startsAtLocal === reservation.starts_at_local) continue;
    R.cutoffCheck(reservation, restaurant, nowMs);
    const inputTables = { table_ids: R.reservationTableIds(reservation) };
    const candidate = R.buildRecord(draft, userId, restaurant, inputTables, startsAtLocal, reservation.party_size, nowMs, reservation, reservation.status);
    candidates.push({ occurrence, reservation, candidate });
  }

  const movedRefs = new Set(candidates.map(item => item.reservation.reference));
  for (let index = 0; index < candidates.length; index++) {
    const item = candidates[index];
    if (R.conflicts(draft, restaurant.id, item.candidate.table_ids, item.candidate.starts_at_ms, item.candidate.ends_at_ms, movedRefs)) error(409, 'table_unavailable');
    for (let previous = 0; previous < index; previous++) {
      const other = candidates[previous].candidate;
      if (other.table_ids.some(id => item.candidate.table_ids.includes(id)) &&
          T.intervalsOverlap(other.starts_at_ms, other.ends_at_ms, item.candidate.starts_at_ms, item.candidate.ends_at_ms)) error(409, 'table_unavailable');
    }
  }

  if (candidates.length) {
    for (const item of candidates) {
      const changes = R.changesBetween(item.reservation, item.candidate);
      R.applyCandidate(item.reservation, item.candidate);
      item.reservation.revision += 1;
      R.appendHistory(item.reservation, restaurant, 'changed', changes, nowMs);
    }
    draftSeries.revision += 1;
    restaurant.revision = (restaurant.revision || 0) + 1;
    state.reservations = draft.reservations;
    state.series = draft.series;
    state.restaurants = draft.restaurants;
  }
  const resultSeries = state.series.find(item => item.series_id === seriesId) || series;
  return S3.seriesView(state, resultSeries);
}

module.exports = { previewReplan, applyReplan, amendSeries, planView, explicitInstant };
