'use strict';

const T = require('./time');

function baseline(restaurant) {
  return {
    policy_version: 0,
    slot_minutes: restaurant.slot_minutes,
    reservation_duration_minutes: restaurant.reservation_duration_minutes,
    cancellation_cutoff_minutes: restaurant.cancellation_cutoff_minutes,
    opening_hours: structuredClone(restaurant.opening_hours),
    capacities: Object.fromEntries(restaurant.tables.map(table => [table.id, table.capacity])),
  };
}

function snapshot(policy) {
  return {
    policy_version: policy.policy_version,
    slot_minutes: policy.slot_minutes,
    reservation_duration_minutes: policy.reservation_duration_minutes,
    cancellation_cutoff_minutes: policy.cancellation_cutoff_minutes,
    opening_hours: structuredClone(policy.opening_hours),
    capacities: structuredClone(policy.capacities),
  };
}

function policyFor(restaurant, date) {
  const candidates = (restaurant.policies || []).filter(policy => policy.effective_from <= date);
  if (!candidates.length) return baseline(restaurant);
  candidates.sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.policy_version - a.policy_version);
  return snapshot(candidates[0]);
}

function asRestaurant(restaurant, policy) {
  return {
    ...restaurant,
    slot_minutes: policy.slot_minutes,
    reservation_duration_minutes: policy.reservation_duration_minutes,
    cancellation_cutoff_minutes: policy.cancellation_cutoff_minutes,
    opening_hours: structuredClone(policy.opening_hours),
    tables: restaurant.tables.map(table => ({ ...table, capacity: policy.capacities[table.id] })),
  };
}

function actualDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return T.parseLocal(`${value}T00:00`).date === value; } catch { return false; }
}

function validatePolicy(restaurant, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) T.fail(422, 'validation_failed');
  if (!actualDate(value.effective_from) || !Number.isInteger(value.slot_minutes) || value.slot_minutes < 1 || value.slot_minutes > 1440 ||
      !Number.isInteger(value.reservation_duration_minutes) || value.reservation_duration_minutes < 1 || value.reservation_duration_minutes > 1440 ||
      !Number.isInteger(value.cancellation_cutoff_minutes) || value.cancellation_cutoff_minutes < 0 || value.cancellation_cutoff_minutes > 10080 ||
      !Array.isArray(value.opening_hours) || !value.capacities || typeof value.capacities !== 'object' || Array.isArray(value.capacities)) T.fail(422, 'validation_failed');
  const weekdays = new Set();
  for (const row of value.opening_hours) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.weekday !== 'string' || typeof row.opens !== 'string' || typeof row.closes !== 'string' ||
        !['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(row.weekday) || weekdays.has(row.weekday) ||
        !/^\d{2}:\d{2}$/.test(row.opens) || !/^\d{2}:\d{2}$/.test(row.closes)) T.fail(422, 'validation_failed');
    const open = T.minuteOfDay(row.opens), close = T.minuteOfDay(row.closes);
    if (open > 1439 || close > 1439 || close <= open) T.fail(422, 'validation_failed');
    weekdays.add(row.weekday);
  }
  const tableIds = restaurant.tables.map(table => table.id);
  const capacityKeys = Object.keys(value.capacities);
  if (capacityKeys.length !== tableIds.length || tableIds.some(id => !Object.hasOwn(value.capacities, id)) ||
      capacityKeys.some(id => !Number.isInteger(value.capacities[id]) || value.capacities[id] < 1 || value.capacities[id] > 100)) T.fail(422, 'validation_failed');
  return {
    effective_from: value.effective_from,
    slot_minutes: value.slot_minutes,
    reservation_duration_minutes: value.reservation_duration_minutes,
    cancellation_cutoff_minutes: value.cancellation_cutoff_minutes,
    opening_hours: structuredClone(value.opening_hours.map(({ weekday, opens, closes }) => ({ weekday, opens, closes }))),
    capacities: Object.fromEntries(tableIds.map(id => [id, value.capacities[id]])),
  };
}

function validateTerms(restaurant, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isInteger(value.policy_version) || value.policy_version < 0 ||
      !Number.isInteger(value.slot_minutes) || value.slot_minutes < 1 || value.slot_minutes > 1440 ||
      !Number.isInteger(value.reservation_duration_minutes) || value.reservation_duration_minutes < 1 || value.reservation_duration_minutes > 1440 ||
      !Number.isInteger(value.cancellation_cutoff_minutes) || value.cancellation_cutoff_minutes < 0 || value.cancellation_cutoff_minutes > 10080 ||
      !Array.isArray(value.opening_hours) || !value.capacities || typeof value.capacities !== 'object' || Array.isArray(value.capacities)) T.fail(422, 'validation_failed');
  const capacityKeys = Object.keys(value.capacities);
  const tableIds = restaurant.tables.map(table => table.id);
  if (capacityKeys.length !== tableIds.length || tableIds.some(id => !Object.hasOwn(value.capacities, id)) || capacityKeys.some(id => !Number.isInteger(value.capacities[id]) || value.capacities[id] < 1 || value.capacities[id] > 100)) T.fail(422, 'validation_failed');
  const weekdays = new Set();
  for (const row of value.opening_hours) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(row.weekday) || weekdays.has(row.weekday) || typeof row.opens !== 'string' || typeof row.closes !== 'string' || !/^\d{2}:\d{2}$/.test(row.opens) || !/^\d{2}:\d{2}$/.test(row.closes)) T.fail(422, 'validation_failed');
    const open = T.minuteOfDay(row.opens), close = T.minuteOfDay(row.closes);
    if (open > 1439 || close > 1439 || close <= open) T.fail(422, 'validation_failed');
    weekdays.add(row.weekday);
  }
  if (value.policy_version > 0 && !(restaurant.policies || []).some(policy => policy.policy_version === value.policy_version)) T.fail(422, 'validation_failed');
  return snapshot(value);
}

function publicPolicy(policy) {
  return { ...structuredClone(policy), policy_version: policy.policy_version };
}

module.exports = { baseline, snapshot, policyFor, asRestaurant, actualDate, validatePolicy, validateTerms, publicPolicy };
