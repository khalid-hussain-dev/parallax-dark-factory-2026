(() => {
  'use strict';

  const app = document.getElementById('app');
  const tokenKey = 'tablelight-token';
  const nameKey = 'tablelight-name';
  const spinnerClasses = { amber: 'spinner--amber', sage: 'spinner--sage', coral: 'spinner--coral' };
  let actionStatusId = 0;
  let restaurants = [];
  const restaurantDetails = new Map();
  let selectedSeat = null;
  let pendingBooking = null;
  let completedBooking = null;
  let searchSequence = 0;
  let lastSearch = null;
  const searchRequests = new Map();
  let searchButtonOriginal = null;
  let searchButtonStatus = null;
  function updateSearchPending(button) {
    if (!button?.isConnected) return;
    const pendingLabel = Array.from(searchRequests.values()).at(-1);
    if (pendingLabel) {
      button.dataset.pending = 'true';
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-label', pendingLabel);
      if (searchButtonStatus) {
        button.setAttribute('aria-describedby', searchButtonStatus.id);
        searchButtonStatus.textContent = pendingLabel;
      }
      button.innerHTML = `<span class="spinner spinner--amber" aria-hidden="true"></span><span>${esc(pendingLabel)}</span>`;
      return;
    }
    if (!searchButtonOriginal) return;
    button.innerHTML = searchButtonOriginal.html;
    delete button.dataset.pending;
    button.removeAttribute('aria-busy');
    if (searchButtonOriginal.label === null) button.removeAttribute('aria-label');
    else button.setAttribute('aria-label', searchButtonOriginal.label);
    if (searchButtonOriginal.describedBy === null) button.removeAttribute('aria-describedby');
    else button.setAttribute('aria-describedby', searchButtonOriginal.describedBy);
    if (searchButtonStatus) searchButtonStatus.textContent = '';
    searchButtonOriginal = null;
  }
  function beginSearchPending(button, requestId, label) {
    if (!button) return () => {};
    if (!searchButtonOriginal) {
      searchButtonOriginal = { html: button.innerHTML, label: button.getAttribute('aria-label'), describedBy: button.getAttribute('aria-describedby') };
      searchButtonStatus = button.parentElement?.querySelector('.search-live-status') || null;
      if (!searchButtonStatus && button.parentElement) {
        searchButtonStatus = document.createElement('span');
        searchButtonStatus.className = 'search-live-status sr-only';
        searchButtonStatus.id = 'search-action-status';
        searchButtonStatus.setAttribute('role', 'status');
        searchButtonStatus.setAttribute('aria-live', 'polite');
        searchButtonStatus.setAttribute('aria-atomic', 'true');
        button.insertAdjacentElement('afterend', searchButtonStatus);
      }
    }
    searchRequests.set(requestId, label);
    updateSearchPending(button);
    return () => {
      searchRequests.delete(requestId);
      updateSearchPending(button);
    };
  }

  class ApiError extends Error {
    constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
  }

  const token = () => localStorage.getItem(tokenKey);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const slugPair = ids => ids.join('+');
  const keyForIds = ids => ids.join('\u0000');
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  const newKey = () => globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const todayLocal = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  };
  const nameForIds = (restaurant, ids) => ids.map(id => restaurant.tables.find(table => table.id === id)?.label || id).join(' + ');
  function beginPending(button, kind, pendingLabel, disable = true) {
    if (!button) return () => {};
    const original = button.innerHTML;
    const originalLabel = button.getAttribute('aria-label');
    const wasDisabled = button.disabled;
    let status = button.parentElement?.querySelector('.action-live-status');
    if (!status && button.parentElement) {
      status = document.createElement('span');
      status.className = 'action-live-status sr-only';
      status.id = `action-status-${++actionStatusId}`;
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      button.insertAdjacentElement('afterend', status);
    }
    const originalDescribedBy = button.getAttribute('aria-describedby');
    button.dataset.pending = 'true';
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-label', pendingLabel);
    if (status) button.setAttribute('aria-describedby', status.id);
    if (disable) button.disabled = true;
    button.innerHTML = `<span class="spinner ${spinnerClasses[kind]}" aria-hidden="true"></span><span>${esc(pendingLabel)}</span>`;
    if (status) status.textContent = pendingLabel;
    return () => {
      if (!button.isConnected) return;
      button.innerHTML = original;
      delete button.dataset.pending;
      button.removeAttribute('aria-busy');
      if (originalLabel === null) button.removeAttribute('aria-label');
      else button.setAttribute('aria-label', originalLabel);
      button.disabled = wasDisabled;
      if (status) status.textContent = '';
      if (originalDescribedBy === null) button.removeAttribute('aria-describedby');
      else button.setAttribute('aria-describedby', originalDescribedBy);
    };
  }
  function capacitiesForDate(venue, policyResponse, date) {
    const policy = (policyResponse.policies || []).filter(item => item.effective_from <= date)
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.policy_version - a.policy_version)[0];
    return policy?.capacities || Object.fromEntries(venue.tables.map(table => [table.id, table.capacity]));
  }

  async function restaurantDetail(id) {
    if (restaurantDetails.has(id)) return restaurantDetails.get(id);
    const detail = await request(`/restaurants/${encodeURIComponent(id)}`);
    restaurantDetails.set(id, detail);
    return detail;
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (token()) headers.set('Authorization', `Bearer ${token()}`);
    const response = await fetch(path, { ...options, headers });
    if (response.status === 204) return null;
    let body;
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok) throw new ApiError(response.status, body?.error?.code || 'request_failed', body?.error?.message || 'The request could not be completed.');
    return body;
  }

  function shell(content) {
    const userName = localStorage.getItem(nameKey);
    const signedIn = Boolean(token());
    app.innerHTML = `
      <header class="site-header">
        <a class="brand" href="/" aria-label="Tablelight home"><img class="brand-lockup" src="/assets/brand/tablelight-lockup.png" alt="Tablelight"></a>
        <nav class="nav" aria-label="Main navigation">
          ${signedIn ? '<a href="/">Find a table</a><a href="/lookup">My booking</a>' : '<a href="/">Explore</a><a href="/lookup">Lookup</a>'}
          ${signedIn ? `<span class="user-chip" data-testid="current-user">${esc(userName || 'Guest')}</span><button class="link-button" id="logout" data-testid="logout-button">Log out</button>` : '<a href="/login">Log in</a><a href="/signup">Join</a>'}
        </nav>
      </header>
      <main>${content}</main>
      <footer class="footer">A good table makes room for a good evening.</footer>`;
    document.getElementById('logout')?.addEventListener('click', () => {
      localStorage.removeItem(tokenKey); localStorage.removeItem(nameKey); location.href = '/';
    });
  }

  function message(testId, kind, text) { return `<p class="message ${kind}" data-testid="${testId}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(text)}</p>`; }

  async function renderAuth(kind) {
    const signup = kind === 'signup';
    shell(`<section class="auth-wrap"><div class="panel auth-card">
      <p class="eyebrow">Tablelight</p>
      <h1>${signup ? 'Make it a night.' : 'Welcome back.'}</h1>
      <p class="hero-copy">${signup ? 'Create your diner account to reserve a seat at the restaurants you love.' : 'Sign in to manage a booking or save your next favourite table.'}</p>
      <div id="auth-message"></div>
      <form class="auth-form" id="auth-form">
        ${signup ? '<div class="field"><label for="display-name">Your name</label><input id="display-name" data-testid="signup-display-name" name="display_name" autocomplete="name" required></div>' : ''}
        <div class="field"><label for="email">Email address</label><input id="email" data-testid="${signup ? 'signup-email' : 'login-email'}" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="password">Password</label><input id="password" data-testid="${signup ? 'signup-password' : 'login-password'}" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="${signup ? '8' : '1'}" required></div>
        <button class="button auth-action" type="submit" data-testid="${signup ? 'signup-submit' : 'login-submit'}">${signup ? 'Create account' : 'Log in'}</button>
      </form>
      <p class="form-foot">${signup ? 'Already have an account? <a href="/login">Log in</a>' : 'New to Tablelight? <a href="/signup">Create an account</a>'}</p>
    </div></section>`);
    const form = document.getElementById('auth-form');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const button = form.querySelector('button');
      const stopPending = beginPending(button, 'sage', signup ? 'Creating account…' : 'Signing in…');
      try {
        const result = await request(`/auth/${signup ? 'signup' : 'login'}`, { method: 'POST', body: JSON.stringify(data) });
        localStorage.setItem(tokenKey, result.token); localStorage.setItem(nameKey, result.display_name);
        location.href = '/';
      } catch (error) {
        document.getElementById('auth-message').innerHTML = message('auth-error', 'error', error.message || 'Please check your details and try again.');
      } finally { stopPending(); }
    });
  }

  function renderLookup() {
    shell(`<section class="lookup-card panel">
      <p class="eyebrow">Your reservation</p><h1 style="font-size:clamp(36px,5vw,54px)">Find your table.</h1>
      <p class="hero-copy">Enter the confirmation reference from your booking. Sign in with the account used to make it.</p>
      <form class="lookup-form" id="lookup-form">
        <div class="field"><label for="lookup-reference">Confirmation reference</label><input id="lookup-reference" data-testid="lookup-reference-input" autocomplete="off" required maxlength="12" placeholder="e.g. K3P7QW"></div>
        <button class="button" data-testid="lookup-submit">Look up</button>
      </form>
      <div id="lookup-result" aria-live="polite"></div>
    </section>`);
    document.getElementById('lookup-form').addEventListener('submit', async event => {
      event.preventDefault();
      const ref = document.getElementById('lookup-reference').value.trim();
      const result = document.getElementById('lookup-result');
      result.innerHTML = '';
      const stopPending = beginPending(document.querySelector('[data-testid="lookup-submit"]'), 'amber', 'Looking up booking…');
      try { await showReservation(await request(`/reservations/${encodeURIComponent(ref)}`), result); }
      catch (error) { result.innerHTML = message('reservation-error', 'error', error.status === 401 ? 'Log in to find your booking.' : error.status === 404 ? 'We could not find that booking for this account.' : error.message); }
      finally { stopPending(); }
    });
  }

  async function showReservation(reservation, target) {
    const restaurant = await restaurantDetail(reservation.restaurant_id);
    const restaurantName = restaurant.name || reservation.restaurant_id;
    const ids = reservation.table_ids || [reservation.table_id];
    const labels = nameForIds(restaurant, ids);
    target.innerHTML = `<article class="reservation-card" data-testid="reservation-detail">
      <div class="reservation-top"><div><p class="eyebrow">Booking ${esc(reservation.reference)}</p><h2>${esc(restaurantName)}</h2></div><span class="status" data-testid="reservation-status">${esc(reservation.status)}</span></div>
      <p class="reservation-info"><span data-testid="reservation-tables">${esc(labels)}</span><br>${esc(reservation.starts_at_local.replace('T', ' · '))} · Party of ${esc(reservation.party_size)}</p>
      ${reservation.status === 'confirmed' ? '<button class="button secondary" data-testid="reservation-cancel-button" id="cancel-booking">Cancel reservation</button>' : ''}
    </article>`;
    document.getElementById('cancel-booking')?.addEventListener('click', async event => {
      const stopPending = beginPending(event.currentTarget, 'coral', 'Cancelling reservation…');
      try { await showReservation(await request(`/reservations/${encodeURIComponent(reservation.reference)}/cancel`, { method: 'POST', body: '{}' }), target); }
      catch (error) { target.insertAdjacentHTML('beforeend', message('reservation-error', 'error', error.message || 'This reservation could not be cancelled.')); }
      finally { stopPending(); }
    });
  }

  async function renderHome() {
    shell(`<section class="hero">
      <div><p class="eyebrow">Thoughtful tables, memorable nights</p><h1>Make room for <em style="color:var(--green);font-weight:500">something lovely.</em></h1><p class="hero-copy">Find your place at the table. Explore open seats, choose a time and we’ll take care of the details.</p></div>
      <aside class="hero-note">From an intimate corner for two to a little more room for the whole table, find the right seat for tonight.</aside>
    </section>
    <section class="panel search-panel" aria-label="Search availability">
      <div class="field"><label for="restaurant">Restaurant</label><select id="restaurant" data-testid="restaurant-select"><option value="">Choose a restaurant</option></select></div>
      <div class="field"><label for="date">Date</label><input id="date" type="date" data-testid="date-input" value="${todayLocal()}"></div>
      <div class="field"><label for="party">Party size</label><input id="party" type="number" min="1" max="20" value="2" data-testid="party-size-input"></div>
      <button class="button" id="search" data-testid="search-button">Find availability</button>
    </section>
    <section id="results" aria-live="polite"></section>
    <section id="booking-host"></section>`);
    const select = document.getElementById('restaurant');
    const results = document.getElementById('results');
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = '<div class="empty-state" role="status"><span class="spinner spinner--amber" aria-hidden="true"></span> Loading restaurants…</div>';
    try {
      restaurants = (await request('/restaurants')).restaurants;
      if (!restaurants.length) {
        results.innerHTML = '<div class="empty-state"><strong>No restaurants are taking bookings yet</strong>Please check back soon.</div>';
      } else {
        select.innerHTML = '<option value="">Choose a restaurant</option>' + restaurants.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
        results.innerHTML = '';
      }
    } catch (error) {
      results.innerHTML = message('search-error', 'error', 'We could not load restaurants. Please refresh and try again.');
    } finally { results.removeAttribute('aria-busy'); }
    document.getElementById('search').addEventListener('click', () => {
      const query = { restaurant_id: select.value, date: document.getElementById('date').value, party_size: document.getElementById('party').value };
      selectedSeat = null; pendingBooking = null; completedBooking = null;
      document.getElementById('booking-host').innerHTML = '';
      runSearch(query);
    });
  }

  async function runSearch(query, preserveBooking = false) {
    const sequence = ++searchSequence;
    const results = document.getElementById('results');
    if (!preserveBooking) results.innerHTML = '<div class="empty-state"><strong>Looking for a lovely table…</strong>Checking the latest availability.</div>';
    const party = Number(query.party_size);
    if (!query.restaurant_id || !query.date || !/^\d+$/.test(String(query.party_size)) || party < 1) {
      if (sequence === searchSequence) results.innerHTML = message('search-error', 'error', 'Choose a restaurant, date and party size to search.');
      return;
    }
    const stopPending = beginSearchPending(document.getElementById('search'), sequence, preserveBooking ? 'Refreshing availability…' : 'Searching availability…');
    results.setAttribute('aria-busy', 'true');
    try {
      const [venue, availability, policyResponse] = await Promise.all([
        request(`/restaurants/${encodeURIComponent(query.restaurant_id)}`),
        request(`/availability?restaurant_id=${encodeURIComponent(query.restaurant_id)}&date=${encodeURIComponent(query.date)}&party_size=${encodeURIComponent(query.party_size)}&explain=true`),
        request(`/restaurants/${encodeURIComponent(query.restaurant_id)}/policies`),
      ]);
      if (sequence !== searchSequence) return;
      restaurantDetails.set(venue.id, venue);
      lastSearch = { ...query };
      renderAvailability(venue, availability, preserveBooking, party, capacitiesForDate(venue, policyResponse, query.date));
    } catch (error) {
      if (sequence !== searchSequence) return;
      results.innerHTML = message('search-error', 'error', error.message || 'Availability could not be loaded.');
    } finally {
      stopPending();
      if (sequence === searchSequence) {
        results.removeAttribute('aria-busy');
      }
    }
  }

  function renderAvailability(venue, availability, preserveBooking, partySize, capacities) {
    const results = document.getElementById('results');
    if (!availability.slots.length) {
      results.innerHTML = `<div class="section-heading"><div><p class="eyebrow">${esc(venue.name)}</p><h2>Availability</h2></div><p>${esc(availability.date)}</p></div><div class="empty-state" data-testid="no-slots"><strong>No sittings that day</strong>This restaurant is closed on the selected date.</div>`;
      return;
    }
    const pairList = venue.combinable || [];
    const rows = availability.slots.map(slot => {
      const availableSingles = new Set(slot.available_table_ids || []);
      const options = new Set((slot.available_options || []).map(option => keyForIds(option.table_ids)));
      const explanations = new Map((slot.explain || []).map(item => [item.table_id, item]));
      const time = slot.starts_at_local.slice(-5);
      const cells = venue.tables.map(table => {
        const capacity = capacities[table.id];
        const explanation = explanations.get(table.id);
        const reason = explanation?.rules.filter(rule => !rule.holds).map(rule => rule.rule === 'capacity' ? 'Too small for this party' : 'Already booked').join(' · ');
        return seatButton([table.id], table.label, capacity, availableSingles.has(table.id), time, slot.starts_at_local, reason);
      });
      for (const pair of pairList) {
        const tables = pair.map(id => venue.tables.find(table => table.id === id));
        if (tables.some(table => !table)) continue;
        const ids = pair.slice();
        const capacity = ids.reduce((sum, id) => sum + capacities[id], 0);
        if (capacity < partySize) continue;
        const available = options.has(keyForIds(ids));
        const occupied = ids.some(id => explanations.get(id)?.rules.some(rule => rule.rule === 'no_overlap' && !rule.holds));
        cells.push(seatButton(ids, tables.map(table => table.label).join(' + '), capacity, available, time, slot.starts_at_local, available ? '' : (occupied ? 'One table is already booked' : 'Unavailable')));
      }
      return `<div class="slot-row"><div class="slot-time"><small>Local time</small>${esc(time)}</div><div class="slot-options">${cells.join('')}</div></div>`;
    }).join('');
    results.innerHTML = `<div class="section-heading"><div><p class="eyebrow">${esc(venue.name)}</p><h2>Choose your table</h2><p>Availability for ${esc(availability.date)} · ${esc(availability.timezone)}</p></div><p>Choose an open seat to continue</p></div><div class="availability-grid" data-testid="availability-grid">${rows}</div>`;
    results.querySelectorAll('button.seat.available').forEach(button => button.addEventListener('click', () => {
      if (!token()) { location.href = '/login'; return; }
      results.querySelectorAll('button.seat').forEach(cell => {
        cell.classList.remove('selected');
        cell.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('selected');
      button.setAttribute('aria-pressed', 'true');
      const ids = JSON.parse(button.dataset.ids);
      selectedSeat = { restaurant_id: venue.id, restaurant_name: venue.name, table_ids: ids, table_labels: nameForIds(venue, ids), starts_at_local: button.dataset.start, initial_party_size: document.getElementById('party').value };
      pendingBooking = null; completedBooking = null;
      renderBooking();
    }));
    if (!preserveBooking && selectedSeat) document.getElementById('booking-host').innerHTML = '';
  }

  function seatButton(ids, label, capacity, available, time, start, reason = '') {
    const testid = `slot-${slugPair(ids)}-${time}`;
    const status = available ? 'Available' : (reason || 'Unavailable');
    return `<button type="button" class="seat ${available ? 'available' : 'unavailable'}" data-testid="${esc(testid)}" data-available="${available ? 'true' : 'false'}" aria-pressed="false" ${available ? '' : 'disabled'} data-ids="${esc(JSON.stringify(ids))}" data-start="${esc(start)}" aria-label="${esc(status)}: ${esc(label)}, up to ${capacity} guests at ${time}"><span class="seat-name">${esc(label)}</span><span class="seat-meta">Up to ${capacity} guests · ${esc(status)}</span></button>`;
  }

  function renderBooking() {
    if (!selectedSeat) return;
    const host = document.getElementById('booking-host');
    if (!host) return;
    host.innerHTML = `<div class="booking-layout">
      <section class="panel booking-card"><p class="eyebrow">Your table</p><h2>Make it yours</h2>
        <p class="booking-summary" data-testid="booking-summary">${esc(selectedSeat.table_labels)} · ${esc(selectedSeat.starts_at_local.replace('T', ' at '))} · ${esc(selectedSeat.restaurant_name)}</p>
        <form id="booking-form" data-testid="booking-form" class="booking-form-grid">
          <div class="field"><label for="booking-party-size">Party size</label><input id="booking-party-size" type="number" min="1" max="20" value="${esc(selectedSeat.initial_party_size)}" data-testid="booking-party-size" required></div>
          <button class="button" type="submit" data-testid="booking-submit">Reserve this table</button>
        </form><div id="booking-messages" aria-live="polite"></div>
      </section><section id="confirmation-host"></section>
    </div>`;
    document.getElementById('booking-form').addEventListener('input', () => {
      document.getElementById('booking-messages').innerHTML = '';
      if (completedBooking) { completedBooking = null; document.getElementById('confirmation-host').innerHTML = ''; }
    });
    document.getElementById('booking-form').addEventListener('submit', submitBooking);
  }

  async function submitBooking(event) {
    event.preventDefault();
    const partyInput = document.getElementById('booking-party-size');
    const body = { restaurant_id: selectedSeat.restaurant_id, table_ids: selectedSeat.table_ids.slice(), starts_at_local: selectedSeat.starts_at_local, party_size: Number(partyInput.value) };
    const bodyKey = canonical(body);
    if (completedBooking && completedBooking.bodyKey === bodyKey) { showConfirmation(completedBooking.response); return; }
    if (!pendingBooking || pendingBooking.bodyKey !== bodyKey) pendingBooking = { body, bodyKey, key: newKey() };
    const messages = document.getElementById('booking-messages');
    messages.innerHTML = '';
    const button = document.querySelector('[data-testid="booking-submit"]');
    const stopPending = beginPending(button, 'amber', 'Confirming reservation…');
    try {
      const response = await request('/reservations', { method: 'POST', headers: { 'Idempotency-Key': pendingBooking.key }, body: JSON.stringify(pendingBooking.body) });
      pendingBooking = null;
      completedBooking = { bodyKey, response };
      messages.innerHTML = '';
      showConfirmation(response);
    } catch (error) {
      if (!error.status || error.status >= 500) {
        messages.innerHTML = message('booking-uncertain', 'uncertain', 'We could not confirm whether your reservation completed. Retry this unchanged form to safely check the original request.');
      } else {
        pendingBooking = null;
        messages.innerHTML = message('booking-error', 'error', error.code === 'table_unavailable' ? 'That table was just taken. Your choices are still here; choose another available seat.' : error.message || 'We could not complete this reservation.');
        if (error.code === 'table_unavailable' && lastSearch) runSearch(lastSearch, true);
      }
    } finally {
      stopPending();
    }
  }

  function showConfirmation(reservation) {
    const host = document.getElementById('confirmation-host');
    if (!host || !selectedSeat) return;
    const ids = reservation.table_ids || selectedSeat.table_ids;
    const labels = selectedSeat.table_labels || nameForIds(restaurantDetails.get(selectedSeat.restaurant_id) || { tables: [] }, ids);
    host.innerHTML = `<section class="panel confirmation-card" data-testid="confirmation"><span class="confirmation-badge">Reservation confirmed</span><h2>We’ll save you a seat.</h2><span class="reference" data-testid="confirmation-reference">${esc(reservation.reference)}</span><p class="confirmation-details" data-testid="confirmation-details">${esc(selectedSeat.restaurant_name)} · ${esc(labels)} · ${esc(reservation.starts_at_local.replace('T', ' at '))}</p><p class="confirmation-details"><strong>Tables:</strong> <span data-testid="confirmation-tables">${esc(labels)}</span></p><p class="confirmation-details">Keep this reference handy if you need to look up your booking.</p></section>`;
  }

  async function boot() {
    const path = location.pathname;
    if (path === '/signup') return renderAuth('signup');
    if (path === '/login') return renderAuth('login');
    if (path === '/lookup') return renderLookup();
    return renderHome();
  }

  boot();
})();
