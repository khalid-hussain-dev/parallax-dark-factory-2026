'use strict';

const crypto = require('node:crypto');
const T = require('./time');
const P = require('./policies');
const R = require('./reservations');

function restaurantFor(state, id) {
  const restaurant = state.restaurants.find(item => item.id === id);
  if (!restaurant) T.fail(404, 'not_found');
  return restaurant;
}

function listPolicies(state, restaurantId) {
  const restaurant = restaurantFor(state, restaurantId);
  return { policies: (restaurant.policies || []).slice().sort((a, b) => a.policy_version - b.policy_version).map(P.publicPolicy) };
}

function publishPolicy(state, restaurantId, input) {
  const restaurant = restaurantFor(state, restaurantId);
  const policy = P.validatePolicy(restaurant, input);
  if (!Array.isArray(restaurant.policies)) restaurant.policies = [];
  policy.policy_version = restaurant.policies.reduce((max, item) => Math.max(max, item.policy_version), 0) + 1;
  restaurant.policies.push(policy);
  restaurant.revision = (restaurant.revision || 0) + 1;
  return P.publicPolicy(policy);
}

function historyFor(state, userId, reference) {
  const reservation = state.reservations.find(item => item.reference === reference && item.user_id === userId);
  if (!reservation) T.fail(404, 'not_found');
  return { reference, entries: structuredClone(reservation.history || []) };
}

function decisionFor(state, userId, reference) {
  const reservation = state.reservations.find(item => item.reference === reference && item.user_id === userId);
  if (!reservation) T.fail(404, 'not_found');
  return { reference, revision: reservation.revision, accepted_terms: structuredClone(reservation.accepted_terms) };
}

function localDatePlusWeeks(value, weeks) {
  const parsed = T.parseLocal(value);
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + weeks * 7));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function seriesView(state, series) {
  return {
    series_id: series.series_id,
    revision: series.revision,
    interval_weeks: series.interval_weeks,
    occurrences: series.occurrences.map(occurrence => {
      const reservation = state.reservations.find(item => item.reference === occurrence.reference);
      if (!reservation) T.fail(422, 'validation_failed');
      return { index: occurrence.index, reference: occurrence.reference, exception: occurrence.exception, reservation: R.publicReservation(reservation) };
    }),
  };
}

function createSeries(state, userId, input, nowMs = Date.now()) {
  if (typeof input.anchor_reference !== 'string') T.fail(422, 'validation_failed');
  if (!Number.isInteger(input.count) || input.count < 2 || input.count > 12 || !Number.isInteger(input.interval_weeks) || input.interval_weeks < 1 || input.interval_weeks > 4) T.fail(422, 'validation_failed');
  const anchor = state.reservations.find(item => item.reference === input.anchor_reference && item.user_id === userId);
  if (!anchor) T.fail(404, 'not_found');
  if (anchor.status === 'cancelled') T.fail(409, 'reservation_cancelled');
  if (anchor.series_id || state.series.some(series => series.occurrences.some(item => item.reference === anchor.reference))) T.fail(409, 'already_in_series');
  const restaurant = restaurantFor(state, anchor.restaurant_id);
  const cutoff = anchor.accepted_terms?.cancellation_cutoff_minutes ?? restaurant.cancellation_cutoff_minutes;
  if (nowMs >= anchor.starts_at_ms - cutoff * 60000) T.fail(409, 'cutoff_passed');

  // Work on a private clone so a later invalid occurrence cannot leak reservations, histories or counters.
  const draft = structuredClone(state);
  const draftAnchor = draft.reservations.find(item => item.reference === anchor.reference);
  const occurrences = [{ index: 0, reference: draftAnchor.reference, exception: false,
    scheduled_date: draftAnchor.starts_at_local.slice(0, 10) }];
  const datePart = draftAnchor.starts_at_local.slice(0, 10), clockPart = draftAnchor.starts_at_local.slice(10);
  const tableIds = R.reservationTableIds(draftAnchor);
  for (let index = 1; index < input.count; index++) {
    const startsAtLocal = `${localDatePlusWeeks(`${datePart}T${clockPart.slice(1)}`, input.interval_weeks * index)}${clockPart}`;
    const created = R.createReservation(draft, userId, {
      restaurant_id: draftAnchor.restaurant_id,
      table_ids: tableIds,
      starts_at_local: startsAtLocal,
      party_size: draftAnchor.party_size,
    }, nowMs);
    const record = draft.reservations.find(item => item.reference === created.reference);
    occurrences.push({ index, reference: record.reference, exception: false,
      scheduled_date: startsAtLocal.slice(0, 10) });
  }
  const seriesId = `series_${crypto.randomBytes(12).toString('hex')}`;
  const series = { series_id: seriesId, user_id: userId, restaurant_id: draftAnchor.restaurant_id, revision: 1,
    interval_weeks: input.interval_weeks, occurrences };
  draft.series.push(series);
  for (const occurrence of occurrences) {
    const reservation = draft.reservations.find(item => item.reference === occurrence.reference);
    reservation.series_id = seriesId;
  }
  const draftRestaurant = restaurantFor(draft, draftAnchor.restaurant_id);
  draftRestaurant.revision = (draftRestaurant.revision || 0) + 1;
  state.reservations = draft.reservations;
  state.series = draft.series;
  state.restaurants = draft.restaurants;
  return seriesView(state, series);
}

function getSeries(state, userId, seriesId) {
  const series = state.series.find(item => item.series_id === seriesId && item.user_id === userId);
  if (!series) T.fail(404, 'not_found');
  return seriesView(state, series);
}

module.exports = { listPolicies, publishPolicy, historyFor, decisionFor, createSeries, getSeries, seriesView };
