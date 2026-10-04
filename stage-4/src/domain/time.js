const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function fail(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  throw error;
}

function localParts(epoch, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epoch));
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function parseLocal(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) fail(422, 'validation_failed');
  const [date, clock] = value.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = clock.split(':').map(Number);
  const stamp = Date.UTC(year, month - 1, day, hour, minute);
  const d = new Date(stamp);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day || hour > 23 || minute > 59) fail(422, 'validation_failed');
  return { year, month, day, hour, minute, date, clock, stamp, value };
}

function candidates(value, zone) {
  const p = parseLocal(value);
  const offsets = new Set();
  for (let delta = -36 * 60; delta <= 36 * 60; delta += 30) {
    const t = p.stamp + delta * 60000;
    const q = localParts(t, zone);
    const asUtc = Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute, +q.second);
    offsets.add(asUtc - Math.floor(t / 1000) * 1000);
  }
  const result = [];
  for (const offset of offsets) {
    const t = p.stamp - offset;
    const q = localParts(t, zone);
    if (+q.year === p.year && +q.month === p.month && +q.day === p.day && +q.hour === p.hour && +q.minute === p.minute) result.push(t);
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

function resolveLocal(value, zone) {
  const found = candidates(value, zone);
  if (!found.length) fail(422, 'invalid_local_time');
  return found[0];
}

function offsetText(epoch, zone) {
  const q = localParts(epoch, zone);
  const localAsUtc = Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute, +q.second);
  const offset = Math.round((localAsUtc - Math.floor(epoch / 1000) * 1000) / 60000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function localString(epoch, zone) {
  const q = localParts(epoch, zone);
  return `${q.year}-${q.month}-${q.day}T${q.hour}:${q.minute}`;
}

function timestamp(epoch, zone) {
  return `${localString(epoch, zone)}:${String(localParts(epoch, zone).second).padStart(2, '0')}${offsetText(epoch, zone)}`;
}

function weekday(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function hoursFor(restaurant, date) {
  return restaurant.opening_hours.find(h => h.weekday === weekday(date));
}

function minuteOfDay(value) {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function validateWindow(restaurant, local) {
  const p = parseLocal(local);
  // Resolve first so a nonexistent wall time always has the DST-specific error,
  // even when that wall time would also miss the slot grid or opening window.
  const resolved = resolveLocal(local, restaurant.timezone);
  const hours = hoursFor(restaurant, p.date);
  if (!hours) fail(422, 'outside_opening_hours');
  const start = p.hour * 60 + p.minute;
  const open = minuteOfDay(hours.opens), close = minuteOfDay(hours.closes);
  if (start < open || start + restaurant.reservation_duration_minutes > close) fail(422, 'outside_opening_hours');
  if ((start - open) % restaurant.slot_minutes !== 0) fail(422, 'not_on_slot_grid');
  return resolved;
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

module.exports = { fail, parseLocal, candidates, resolveLocal, localString, timestamp, weekday, hoursFor, minuteOfDay, validateWindow, intervalsOverlap };
