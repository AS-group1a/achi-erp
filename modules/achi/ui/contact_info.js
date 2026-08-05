(function () {
  'use strict';

  const isJwt = value => typeof value === 'string' && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value);

  function jwtPayload(token) {
    try {
      let payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (payload.length % 4) payload += '=';
      return JSON.parse(atob(payload));
    } catch (_error) {
      return null;
    }
  }

  const isAccessJwt = value => isJwt(value) && (jwtPayload(value) || {}).type !== 'refresh';

  function scanStorage(match) {
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const value = storage.getItem(storage.key(index));
        if (match(value)) return value;
        if (value && value[0] === '{') {
          try {
            const parsed = JSON.parse(value);
            const candidates = [
              parsed.access_token,
              parsed.refresh_token,
              parsed.token,
              parsed.state && parsed.state.access_token,
              parsed.state && parsed.state.refresh_token,
              parsed.state && parsed.state.token,
            ];
            for (const candidate of candidates) if (match(candidate)) return candidate;
          } catch (_error) {
            // Ignore unrelated storage entries.
          }
        }
      }
    }
    return null;
  }

  function getAccessToken() {
    const direct = localStorage.getItem('oe_access_token');
    return isAccessJwt(direct) ? direct : scanStorage(isAccessJwt);
  }

  function getRefreshToken() {
    const direct = localStorage.getItem('oe_refresh_token');
    if (isJwt(direct)) return direct;
    return scanStorage(value => isJwt(value) && (jwtPayload(value) || {}).type === 'refresh');
  }

  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value == null ? '' : value).replace(
    /[&<>"]/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]),
  );
  const PHONE_LABELS = ['Primary', 'Mobile', 'Office', 'Site', 'WhatsApp', 'Home', 'Other'];
  const EMAIL_LABELS = ['Primary', 'Work', 'Personal', 'Accounts', 'Sales', 'Other'];
  const SOCIAL_PLATFORMS = ['IG', 'FB', 'LinkedIn', 'TikTok', 'X'];
  const PREFIXES = ['Mr', 'Ms', 'Mrs', 'Dr', 'Eng', 'Arch'];
  const CONTACT_TAGS = ['Owner', 'Engineer', 'Contractor', 'Foreman', 'Site manager', 'Architect', 'Procurement'];
  const PREFIX_STORAGE_KEY = 'achi_prefixes';
  const TAG_STORAGE_KEY = 'achi_roles';
  const ADD_PREFIX = '__add_prefix__';
  const ADD_TAG = '__add_tag__';
  const DEFAULT_ISO = 'lb';
  const DEFAULT_DIAL = '+961';
  const COUNTRIES = [
    ['lb', 'Lebanon', '+961'], ['ae', 'United Arab Emirates', '+971'], ['sa', 'Saudi Arabia', '+966'], ['qa', 'Qatar', '+974'],
    ['kw', 'Kuwait', '+965'], ['bh', 'Bahrain', '+973'], ['om', 'Oman', '+968'], ['jo', 'Jordan', '+962'], ['sy', 'Syria', '+963'],
    ['iq', 'Iraq', '+964'], ['eg', 'Egypt', '+20'], ['tr', 'Turkey', '+90'], ['cy', 'Cyprus', '+357'], ['il', 'Israel', '+972'],
    ['ps', 'Palestine', '+970'], ['ir', 'Iran', '+98'], ['ye', 'Yemen', '+967'],
    ['gb', 'United Kingdom', '+44'], ['ie', 'Ireland', '+353'], ['fr', 'France', '+33'], ['de', 'Germany', '+49'],
    ['it', 'Italy', '+39'], ['es', 'Spain', '+34'], ['pt', 'Portugal', '+351'], ['nl', 'Netherlands', '+31'],
    ['be', 'Belgium', '+32'], ['ch', 'Switzerland', '+41'], ['at', 'Austria', '+43'], ['se', 'Sweden', '+46'],
    ['no', 'Norway', '+47'], ['dk', 'Denmark', '+45'], ['fi', 'Finland', '+358'], ['pl', 'Poland', '+48'],
    ['cz', 'Czechia', '+420'], ['gr', 'Greece', '+30'], ['ro', 'Romania', '+40'], ['bg', 'Bulgaria', '+359'],
    ['hu', 'Hungary', '+36'], ['hr', 'Croatia', '+385'], ['rs', 'Serbia', '+381'], ['ua', 'Ukraine', '+380'],
    ['ru', 'Russia', '+7'], ['us', 'United States', '+1'], ['ca', 'Canada', '+1'], ['mx', 'Mexico', '+52'],
    ['br', 'Brazil', '+55'], ['ar', 'Argentina', '+54'], ['cl', 'Chile', '+56'], ['co', 'Colombia', '+57'],
    ['au', 'Australia', '+61'], ['nz', 'New Zealand', '+64'], ['in', 'India', '+91'], ['pk', 'Pakistan', '+92'],
    ['bd', 'Bangladesh', '+880'], ['lk', 'Sri Lanka', '+94'], ['np', 'Nepal', '+977'], ['cn', 'China', '+86'],
    ['jp', 'Japan', '+81'], ['kr', 'South Korea', '+82'], ['sg', 'Singapore', '+65'], ['my', 'Malaysia', '+60'],
    ['id', 'Indonesia', '+62'], ['th', 'Thailand', '+66'], ['vn', 'Vietnam', '+84'], ['ph', 'Philippines', '+63'],
    ['hk', 'Hong Kong', '+852'], ['za', 'South Africa', '+27'], ['ng', 'Nigeria', '+234'], ['ke', 'Kenya', '+254'],
    ['gh', 'Ghana', '+233'], ['et', 'Ethiopia', '+251'], ['ma', 'Morocco', '+212'], ['dz', 'Algeria', '+213'],
    ['tn', 'Tunisia', '+216'], ['ly', 'Libya', '+218'], ['sd', 'Sudan', '+249'], ['am', 'Armenia', '+374'],
    ['ge', 'Georgia', '+995'], ['az', 'Azerbaijan', '+994'], ['kz', 'Kazakhstan', '+7'], ['af', 'Afghanistan', '+93'],
  ];

  let accessToken = getAccessToken();
  let refreshPromise = null;
  let toastTimer = null;
  let countryCodeMenu = null;
  let countryCodeButton = null;

  function storedViewMode() {
    try {
      return localStorage.getItem('achi_contact_view') === 'grid' ? 'grid' : 'list';
    } catch (_error) {
      return 'list';
    }
  }

  const state = {
    rawContacts: [],
    contacts: [],
    files: [],
    logs: [],
    projects: null,
    invoices: null,
    links: {},
    recordType: 'person',
    category: 'all',
    search: '',
    viewMode: storedViewMode(),
    activeContactId: null,
    drawerTab: 'overview',
    mapResolutions: {},
  };

  async function refreshAccessToken() {
    if (refreshPromise) return refreshPromise;
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;

    refreshPromise = fetch('/api/v1/users/auth/refresh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
      .then(response => (response.ok ? response.json() : null))
      .then(payload => {
        if (!payload || !payload.access_token) return false;
        accessToken = payload.access_token;
        localStorage.setItem('oe_access_token', accessToken);
        if (payload.refresh_token) localStorage.setItem('oe_refresh_token', payload.refresh_token);
        return true;
      })
      .catch(() => false)
      .finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function request(path, options = {}, retried = false) {
    const headers = { Authorization: `Bearer ${accessToken || ''}`, ...(options.headers || {}) };
    const init = { ...options, headers };
    if (init.body && typeof init.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }

    const response = await fetch(path, init);
    if (response.status === 401 && !retried && await refreshAccessToken()) {
      return request(path, options, true);
    }

    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = Array.isArray(body.detail)
        ? body.detail.map(item => item.msg || String(item)).join('; ')
        : body.detail;
      const error = new Error(detail || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function optionalRequest(path) {
    try {
      return await request(path);
    } catch (error) {
      if (![401, 403, 404].includes(error.status)) console.warn(`Optional request failed: ${path}`, error);
      return null;
    }
  }

  function showToast(message, isError = false) {
    const toast = $('toast');
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('is-error', isError);
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3500);
  }

  function titleCase(value) {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function storedChoices(key) {
    try {
      const values = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
    } catch (_error) {
      return [];
    }
  }

  function saveCustomChoice(key, value) {
    const choices = storedChoices(key);
    if (!choices.includes(value)) localStorage.setItem(key, JSON.stringify([...choices, value]));
  }

  function identityOptions(base, key, selected, sentinel, sentinelLabel) {
    const values = [...new Set([...base, ...storedChoices(key), selected].filter(Boolean))];
    return '<option value="">None</option>'
      + values.map(value => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(value)}</option>`).join('')
      + `<option value="${sentinel}">${sentinelLabel}</option>`;
  }

  function renderIdentityPicklists(prefix = '', tag = '') {
    $('contact-prefix').innerHTML = identityOptions(PREFIXES, PREFIX_STORAGE_KEY, prefix, ADD_PREFIX, '+ Add new');
    $('contact-role').innerHTML = identityOptions(CONTACT_TAGS, TAG_STORAGE_KEY, tag, ADD_TAG, '+ Add tag');
  }

  function addIdentityChoice(select, { key, sentinel, label, maxLength }) {
    if (select.value !== sentinel) return;
    const value = (window.prompt(`New ${label} (max ${maxLength} characters):`) || '').trim();
    if (!value) {
      select.value = '';
      return;
    }
    if (value.length > maxLength) {
      showToast(`${titleCase(label)} must be ${maxLength} characters or fewer.`, true);
      select.value = '';
      return;
    }
    saveCustomChoice(key, value);
    renderIdentityPicklists(
      select.id === 'contact-prefix' ? value : $('contact-prefix').value,
      select.id === 'contact-role' ? value : $('contact-role').value,
    );
  }

  function initials(contact) {
    const words = String(contact.displayName || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '--';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date);
  }

  function safeHref(value) {
    const href = String(value || '').trim();
    if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
    return '';
  }

  function socialHref(platform, handle) {
    const direct = safeHref(handle);
    if (direct) return direct;
    const value = String(handle || '').trim().replace(/^@/, '');
    if (!value) return '';
    const roots = {
      IG: 'https://instagram.com/',
      FB: 'https://facebook.com/',
      LinkedIn: 'https://linkedin.com/in/',
      TikTok: 'https://tiktok.com/@',
      X: 'https://x.com/',
    };
    return roots[platform] ? `${roots[platform]}${encodeURIComponent(value)}` : '';
  }

  function normalizeMapsUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const path = url.pathname.toLowerCase();
      const valid = /^maps\.google\./.test(host)
        || (host === 'google.com' && path.includes('/maps'))
        || (host.endsWith('.google.com') && path.includes('/maps'))
        || host === 'maps.app.goo.gl'
        || (host === 'goo.gl' && path.startsWith('/maps'));
      return ['http:', 'https:'].includes(url.protocol) && valid ? url.href : '';
    } catch (_error) {
      return '';
    }
  }

  function mapsCoords(value) {
    const patterns = [
      /@(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/,
      /\/maps\/search\/(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/,
      /[?&]q=(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/,
      /[?&]ll=(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/,
    ];
    for (const pattern of patterns) {
      const match = String(value || '').match(pattern);
      if (match) return { lat: Number(match[1]), lng: Number(match[2]) };
    }
    return null;
  }

  function contactMapHref(contact) {
    if (contact.mapsUrl) return contact.mapsUrl;
    if (!contact.location && !contact.city) return '';
    const query = [contact.location, contact.city, contact.country_code].filter(Boolean).join(', ');
    return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : '';
  }

  function mapIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-4.35 7-11a7 7 0 1 0-14 0c0 6.65 7 11 7 11Z"/><circle cx="12" cy="10" r="2"/></svg>';
  }

  function tileMap(lat, lng, width, height, zoom = 15) {
    const size = 2 ** zoom;
    const worldX = ((lng + 180) / 360) * size * 256;
    const sine = Math.sin(lat * Math.PI / 180);
    const worldY = (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size * 256;
    const topLeftX = worldX - width / 2;
    const topLeftY = worldY - height / 2;
    let tiles = '';
    for (let tileX = Math.floor(topLeftX / 256); tileX * 256 < topLeftX + width; tileX += 1) {
      for (let tileY = Math.floor(topLeftY / 256); tileY * 256 < topLeftY + height; tileY += 1) {
        if (tileY < 0 || tileY >= size) continue;
        const wrappedX = ((tileX % size) + size) % size;
        tiles += `<img class="map-tile" src="/api/v1/achi/tile/${zoom}/${wrappedX}/${tileY}" style="left:${Math.round(tileX * 256 - topLeftX)}px;top:${Math.round(tileY * 256 - topLeftY)}px" alt="" loading="lazy">`;
      }
    }
    return `${tiles}<span class="contact-map-pin">${mapIcon()}</span>`;
  }

  const flagSrc = iso => `/api/v1/achi/contact-info/flags/${iso}.png`;

  function phoneParts(value) {
    const raw = String(value || '').trim().replace(/^00/, '+');
    const country = [...COUNTRIES].sort((a, b) => b[2].length - a[2].length)
      .find(item => raw.startsWith(item[2]));
    return country
      ? { iso: country[0], dial: country[2], national: raw.slice(country[2].length).trim() }
      : { iso: DEFAULT_ISO, dial: DEFAULT_DIAL, national: raw };
  }

  function detectPhoneCountry(value) {
    const raw = String(value || '').trim().replace(/^00/, '+');
    if (!raw.startsWith('+')) return null;
    const parts = phoneParts(raw);
    return raw.startsWith(parts.dial) ? parts : null;
  }

  function countryButtonMarkup(parts, label = 'Choose country code') {
    return `<button class="phone-country-button" type="button" data-country-picker data-iso="${escapeHtml(parts.iso)}" data-dial="${escapeHtml(parts.dial)}" aria-label="${escapeHtml(label)}" title="Country code">
      <img src="${flagSrc(parts.iso)}" alt=""><span data-dial-label>${escapeHtml(parts.dial)}</span>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3"/></svg>
    </button>`;
  }

  function setCountryButton(button, iso, dial) {
    button.dataset.iso = iso;
    button.dataset.dial = dial;
    button.querySelector('img').src = flagSrc(iso);
    button.querySelector('[data-dial-label]').textContent = dial;
  }

  function renderCountryCodeOptions(query = '') {
    if (!countryCodeMenu) return;
    const normalized = query.trim().toLowerCase();
    const matches = COUNTRIES.filter(country => (
      !normalized
      || country[0] === normalized
      || country[1].toLowerCase().includes(normalized)
      || country[2].includes(normalized)
    ));
    countryCodeMenu.querySelector('.country-code-list').innerHTML = matches.length
      ? matches.map(country => `<button class="country-code-option" type="button" data-country-iso="${country[0]}" data-country-dial="${country[2]}">
          <img src="${flagSrc(country[0])}" alt=""><span>${escapeHtml(country[1])}</span><span class="dial-code">${escapeHtml(country[2])}</span>
        </button>`).join('')
      : '<div class="empty-state">No matching country code.</div>';
  }

  function ensureCountryCodeMenu() {
    if (countryCodeMenu) return;
    countryCodeMenu = document.createElement('div');
    countryCodeMenu.className = 'country-code-menu';
    countryCodeMenu.hidden = true;
    countryCodeMenu.innerHTML = '<input class="country-code-search" type="search" placeholder="Search country or code..." aria-label="Search country codes"><div class="country-code-list"></div>';
    document.body.appendChild(countryCodeMenu);
    countryCodeMenu.querySelector('.country-code-search').addEventListener('input', event => {
      renderCountryCodeOptions(event.target.value);
    });
    countryCodeMenu.addEventListener('click', event => {
      const option = event.target.closest('[data-country-iso]');
      if (!option || !countryCodeButton) return;
      setCountryButton(countryCodeButton, option.dataset.countryIso, option.dataset.countryDial);
      const input = countryCodeButton.closest('.tel-wrap').querySelector('input');
      closeCountryCodeMenu();
      input.focus();
    });
  }

  function openCountryCodeMenu(button) {
    ensureCountryCodeMenu();
    countryCodeButton = button;
    const search = countryCodeMenu.querySelector('.country-code-search');
    search.value = '';
    renderCountryCodeOptions();
    const rect = button.getBoundingClientRect();
    const menuWidth = Math.min(300, window.innerWidth - 24);
    const menuHeight = 318;
    countryCodeMenu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12))}px`;
    countryCodeMenu.style.top = `${rect.bottom + menuHeight > window.innerHeight ? Math.max(12, rect.top - menuHeight - 4) : rect.bottom + 4}px`;
    countryCodeMenu.hidden = false;
    search.focus();
  }

  function closeCountryCodeMenu() {
    if (countryCodeMenu) countryCodeMenu.hidden = true;
    countryCodeButton = null;
  }

  function normalizePhoneInput(input) {
    const parts = detectPhoneCountry(input.value);
    if (!parts) return;
    setCountryButton(input.closest('.tel-wrap').querySelector('[data-country-picker]'), parts.iso, parts.dial);
    input.value = parts.national;
  }

  function fullPhoneNumber(row) {
    const input = row.querySelector('[data-phone-number], [data-related-phone]');
    const number = input.value.trim();
    if (!number) return '';
    const detected = detectPhoneCountry(number);
    if (detected) return `${detected.dial} ${detected.national}`.trim();
    const dial = row.querySelector('[data-country-picker]').dataset.dial || DEFAULT_DIAL;
    return `${dial} ${number}`.trim();
  }

  function phoneHref(value) {
    const phone = String(value || '').trim();
    return phone ? `tel:${phone.replace(/[^+\d]/g, '')}` : '';
  }

  function whatsappHref(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits ? `https://wa.me/${digits}` : '';
  }

  function filesForContact(contactId) {
    return state.files.filter(file => file.contact_id === contactId || file.company_contact_id === contactId);
  }

  function logsForContact(contactId) {
    const fileIds = new Set(filesForContact(contactId).map(file => file.id));
    return state.logs.filter(log => (
      log.contact_id === contactId
      || log.company_contact_id === contactId
      || fileIds.has(log.file_id)
    ));
  }

  function projectsForContact(contactId) {
    if (!Array.isArray(state.projects)) return [];
    const projectIds = new Set(
      filesForContact(contactId).map(file => String(file.project_id || '')).filter(Boolean),
    );
    return state.projects.filter(project => (
      String(project.client_id || '') === contactId || projectIds.has(String(project.id))
    ));
  }

  function invoicesForContact(contactId) {
    if (!Array.isArray(state.invoices)) return [];
    const projectIds = new Set(projectsForContact(contactId).map(project => String(project.id)));
    return state.invoices.filter(invoice => (
      String(invoice.contact_id || '') === contactId
      || projectIds.has(String(invoice.project_id || ''))
    ));
  }

  function fallbackCategory(raw, contactFiles) {
    const type = String(raw.contact_type || '').toLowerCase();
    if (type === 'customer') return 'client';
    if (type === 'consultant') return 'other';
    if (type === 'lead') {
      const newestFile = [...contactFiles].sort(
        (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
      )[0];
      return newestFile && newestFile.stage === 'prospect' ? 'prospect' : 'lead';
    }
    return ['client', 'supplier', 'subcontractor', 'internal'].includes(type) ? type : 'other';
  }

  function storedSocials(value) {
    let items = value;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch (_error) {
        return [];
      }
    }
    if (!Array.isArray(items)) return [];
    return items.map(item => ({
      platform: String(item && item.platform || ''),
      handle: String(item && item.handle || ''),
    })).filter(item => item.handle).slice(0, 12);
  }

  function storedEmails(value, fallback = '') {
    const items = Array.isArray(value) ? value : [];
    const emails = items.map(item => ({
      label: String(item && item.label || 'Other'),
      address: String(item && item.address || ''),
    })).filter(item => item.address).slice(0, 8);
    return emails.length || !fallback ? emails : [{ label: 'Primary', address: String(fallback) }];
  }

  function storedRelatedContacts(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => ({
      name: String(item && item.name || ''),
      tag: String(item && item.tag || ''),
      phone: String(item && item.phone || ''),
    })).filter(item => item.name || item.phone).slice(0, 8);
  }

  function normalizeContact(raw) {
    const id = String(raw.id);
    const bucket = raw.custom_properties && raw.custom_properties.achi_contact_info
      ? raw.custom_properties.achi_contact_info
      : {};
    const contactFiles = filesForContact(id);
    const contactLogs = logsForContact(id).sort(
      (a, b) => new Date(b.occurred_at || b.created_at || 0) - new Date(a.occurred_at || a.created_at || 0),
    );
    const inferredRecordType = (!raw.first_name && !raw.last_name && raw.company_name) ? 'company' : 'person';
    const recordType = ['person', 'company'].includes(bucket.record_type)
      ? bucket.record_type
      : inferredRecordType;
    const propertyBuckets = Object.values(raw.custom_properties || {}).filter(
      value => value && typeof value === 'object' && !Array.isArray(value),
    );
    const hasContactInfoField = field => Object.prototype.hasOwnProperty.call(bucket, field);
    const sharedPrefix = propertyBuckets.find(value => value.prefix)?.prefix || '';
    const loggedPrefix = contactLogs.find(log => log.prefix)?.prefix || '';
    const loggedRole = contactLogs.find(log => log.role)?.role || '';
    const loggedCompanyType = contactLogs.find(log => log.company_type)?.company_type || '';
    const loggedSocials = storedSocials(contactLogs.find(log => log.socials)?.socials);
    const prefix = hasContactInfoField('prefix') ? (bucket.prefix || '') : (sharedPrefix || loggedPrefix);
    const middleName = hasContactInfoField('middle_name') ? (bucket.middle_name || '') : '';
    const baseDisplayName = recordType === 'company'
      ? (raw.company_name || raw.legal_name || 'Unnamed company')
      : ([raw.first_name, middleName, raw.last_name].filter(Boolean).join(' ') || raw.company_name || 'Unnamed contact');
    const displayName = recordType === 'person' && prefix ? `${prefix} ${baseDisplayName}` : baseDisplayName;
    const bucketPhones = Array.isArray(bucket.phones) ? bucket.phones.filter(item => item && item.number) : [];
    const phones = bucketPhones.length
      ? bucketPhones
      : (raw.primary_phone ? [{ label: 'Mobile', number: raw.primary_phone }] : []);
    const address = raw.address && typeof raw.address === 'object' ? raw.address : {};
    const category = ['client', 'prospect', 'lead', 'supplier', 'subcontractor', 'internal', 'other']
      .includes(bucket.category)
      ? bucket.category
      : fallbackCategory(raw, contactFiles);
    const emails = storedEmails(bucket.emails, raw.primary_email);

    return {
      ...raw,
      id,
      recordType,
      category,
      displayName,
      prefix,
      middleName,
      role: hasContactInfoField('role') ? (bucket.role || '') : loggedRole,
      companyType: hasContactInfoField('company_type') ? (bucket.company_type || '') : loggedCompanyType,
      phones,
      emails,
      primary_email: emails[0] ? emails[0].address : (raw.primary_email || ''),
      relatedContacts: storedRelatedContacts(bucket.related_contacts),
      socials: hasContactInfoField('socials') ? storedSocials(bucket.socials) : loggedSocials,
      primaryPhone: phones[0] ? phones[0].number : (raw.primary_phone || ''),
      source: bucket.source || '',
      quickLinks: Array.isArray(bucket.quick_links) ? bucket.quick_links : [],
      city: address.city || address.locality || address.town || '',
      location: bucket.location || address.formatted || address.address_line_1 || address.street || '',
      mapsUrl: normalizeMapsUrl(bucket.maps_url),
      logCount: contactLogs.length,
      jobCount: projectsForContact(id).length,
      lastContact: contactLogs[0] ? (contactLogs[0].occurred_at || contactLogs[0].created_at) : null,
    };
  }

  function rebuildContacts() {
    state.contacts = state.rawContacts.map(normalizeContact);
  }

  function contactsForRecordType() {
    if (state.recordType === 'all') return state.contacts;
    return state.contacts.filter(contact => contact.recordType === state.recordType);
  }

  function visibleContacts() {
    const query = state.search.trim().toLowerCase();
    return contactsForRecordType().filter(contact => {
      if (state.category !== 'all' && contact.category !== state.category) return false;
      if (!query) return true;
      const haystack = [
        contact.displayName,
        contact.company_name,
        contact.primary_email,
        contact.city,
        contact.location,
        contact.source,
        contact.role,
        contact.companyType,
        ...contact.phones.map(phone => phone.number),
        ...contact.emails.flatMap(email => [email.label, email.address]),
        ...contact.relatedContacts.flatMap(related => [related.name, related.tag, related.phone]),
        ...contact.socials.flatMap(social => [social.platform, social.handle]),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  function renderSummary() {
    const contacts = contactsForRecordType();
    const categories = ['client', 'prospect', 'lead', 'supplier', 'subcontractor', 'internal', 'other'];
    $('all-count').textContent = contacts.length;
    for (const category of categories) {
      $(`${category}-count`).textContent = contacts.filter(contact => contact.category === category).length;
    }
  }

  function renderTable() {
    const contacts = visibleContacts();
    const noun = state.recordType === 'all'
      ? 'contacts'
      : (state.recordType === 'company' ? 'companies' : 'people');
    $('contact-total').textContent = `${contacts.length} ${noun}`;
    const body = $('contacts-table-body');
    const grid = $('grid-view');
    $('list-view').hidden = state.viewMode !== 'list';
    grid.hidden = state.viewMode !== 'grid';

    if (!contacts.length) {
      body.innerHTML = `<tr><td class="table-message" colspan="9">No ${escapeHtml(noun)} match this view.</td></tr>`;
      grid.innerHTML = `<div class="grid-message">No ${escapeHtml(noun)} match this view.</div>`;
      return;
    }

    body.innerHTML = contacts.map(contact => {
      const mapHref = contactMapHref(contact);
      const location = contact.location || contact.city || '-';
      return `
      <tr data-contact-id="${escapeHtml(contact.id)}">
        <td>
          <div class="contact-cell">
            <span class="avatar">${escapeHtml(initials(contact))}</span>
            <span class="truncate">
              <span class="contact-primary">${escapeHtml(contact.displayName)}</span>
              <span class="contact-secondary">${escapeHtml(contact.primary_email || 'No email')}</span>
            </span>
          </div>
        </td>
        <td><span class="truncate">${escapeHtml(contact.recordType === 'company' ? contact.legal_name || '-' : contact.company_name || '-')}</span></td>
        <td><span class="category-pill category-${escapeHtml(contact.category)}">${escapeHtml(titleCase(contact.category))}</span></td>
        <td><span class="truncate">${escapeHtml(contact.primaryPhone || '-')}</span></td>
        <td><span class="location-cell"><span class="truncate">${escapeHtml(location)}</span>${mapHref ? `<a class="map-link-icon" data-map-link href="${escapeHtml(mapHref)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(contact.displayName)} in Maps" title="Open in Maps">${mapIcon()}</a>` : ''}</span></td>
        <td>${escapeHtml(formatDate(contact.lastContact))}</td>
        <td class="number-cell">${contact.logCount}</td>
        <td class="number-cell">${contact.jobCount}</td>
        <td><button class="row-open" type="button" data-open-contact="${escapeHtml(contact.id)}" aria-label="Open ${escapeHtml(contact.displayName)}">&#8250;</button></td>
      </tr>
    `;
    }).join('');

    grid.innerHTML = contacts.map(contact => {
      const mapHref = contactMapHref(contact);
      return `
        <article class="contact-card">
          <button class="contact-card-main" type="button" data-open-contact="${escapeHtml(contact.id)}">
            <span class="contact-card-head">
              <span class="avatar avatar-card">${escapeHtml(initials(contact))}</span>
              <span class="contact-card-identity"><strong>${escapeHtml(contact.displayName)}</strong><small>${escapeHtml(contact.primary_email || 'No email')}</small></span>
              <span class="category-pill category-${escapeHtml(contact.category)}">${escapeHtml(titleCase(contact.category))}</span>
            </span>
            <span class="contact-card-company">${escapeHtml(contact.recordType === 'company' ? contact.legal_name || 'Company' : contact.company_name || 'Independent contact')}</span>
            <span class="contact-card-details">
              <span>${escapeHtml(contact.primaryPhone || 'No phone')}</span>
              <span>${escapeHtml(contact.location || contact.city || 'No location')}</span>
            </span>
            <span class="contact-card-stats"><span><strong>${contact.logCount}</strong> activities</span><span><strong>${contact.jobCount}</strong> jobs</span><span>Last ${escapeHtml(formatDate(contact.lastContact))}</span></span>
          </button>
          <div class="contact-card-actions">
            ${contact.primaryPhone ? `<a href="${escapeHtml(phoneHref(contact.primaryPhone))}">Call</a>` : ''}
            ${contact.primaryPhone ? `<a href="${escapeHtml(whatsappHref(contact.primaryPhone))}" target="_blank" rel="noopener noreferrer" aria-label="Open WhatsApp chat with ${escapeHtml(contact.displayName)}" title="Open WhatsApp">WA</a>` : ''}
            ${contact.primary_email ? `<a href="mailto:${escapeHtml(contact.primary_email)}">Email</a>` : ''}
            ${mapHref ? `<a data-map-link href="${escapeHtml(mapHref)}" target="_blank" rel="noopener noreferrer">${mapIcon()}Map</a>` : ''}
          </div>
        </article>`;
    }).join('');
  }

  function renderDirectory() {
    renderSummary();
    renderTable();
  }

  async function loadData({ silent = false } = {}) {
    if (!accessToken) {
      $('contacts-table-body').innerHTML = '<tr><td class="table-message" colspan="9">Open the main ERP, sign in, then reload this page.</td></tr>';
      $('contact-total').textContent = 'Not signed in';
      return;
    }

    if (!silent) {
      $('contacts-table-body').innerHTML = '<tr><td class="table-message" colspan="9">Loading...</td></tr>';
    }

    try {
      const [contactsResponse, files, logs, projects, invoicesResponse] = await Promise.all([
        request('/api/v1/contacts/?limit=500&sort_by=name&sort_order=asc'),
        request('/api/v1/achi/files/?limit=1000'),
        request('/api/v1/achi/logs/?limit=1000'),
        optionalRequest('/api/v1/projects/?limit=500&status=all'),
        optionalRequest('/api/v1/finance/?limit=100'),
      ]);
      state.rawContacts = Array.isArray(contactsResponse.items) ? contactsResponse.items : [];
      state.files = Array.isArray(files) ? files : [];
      state.logs = Array.isArray(logs) ? logs : [];
      state.projects = Array.isArray(projects) ? projects : null;
      state.invoices = invoicesResponse && Array.isArray(invoicesResponse.items) ? invoicesResponse.items : null;
      rebuildContacts();
      renderDirectory();
      if (state.activeContactId) renderDrawer();
    } catch (error) {
      $('contacts-table-body').innerHTML = `<tr><td class="table-message" colspan="9">${escapeHtml(error.message)}</td></tr>`;
      $('contact-total').textContent = 'Could not load contacts';
      showToast(error.message, true);
    }
  }

  function activeContact() {
    return state.contacts.find(contact => contact.id === state.activeContactId) || null;
  }

  function detailRow(label, value, href = '') {
    const content = href
      ? `<a href="${escapeHtml(href)}" target="${href.startsWith('http') ? '_blank' : '_self'}" rel="noopener noreferrer">${escapeHtml(value)}</a>`
      : escapeHtml(value || '-');
    return `<div class="detail-row"><dt>${escapeHtml(label)}</dt><dd>${content}</dd></div>`;
  }

  function renderDrawerActions(contact) {
    const actions = [];
    if (contact.primaryPhone) {
      actions.push(`<a class="drawer-action" href="${escapeHtml(phoneHref(contact.primaryPhone))}">Call</a>`);
      actions.push(`<a class="drawer-action" href="${escapeHtml(whatsappHref(contact.primaryPhone))}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`);
    }
    if (contact.primary_email) actions.push(`<a class="drawer-action" href="mailto:${escapeHtml(contact.primary_email)}">Email</a>`);
    const mapHref = contactMapHref(contact);
    if (mapHref) actions.push(`<a class="drawer-action" href="${escapeHtml(mapHref)}" target="_blank" rel="noopener noreferrer">${mapIcon()}Map</a>`);
    actions.push('<button class="drawer-action" type="button" id="drawer-add-log">Add activity</button>');
    actions.push('<button class="drawer-action" type="button" id="drawer-edit">Edit</button>');
    $('drawer-actions').innerHTML = actions.join('');
  }

  function renderOverview(contact) {
    const phoneRows = contact.phones.length
      ? contact.phones.map(phone => detailRow(phone.label || 'Phone', phone.number, phoneHref(phone.number))).join('')
      : detailRow('Phone', '-');
    const emailRows = contact.emails.length
      ? contact.emails.map(email => detailRow(email.label || 'Email', email.address, `mailto:${email.address}`)).join('')
      : detailRow('Email', '-');
    const relatedContactRows = contact.relatedContacts.map(related => detailRow(
      related.tag ? `${related.name} (${related.tag})` : related.name,
      related.phone || '-',
      related.phone ? phoneHref(related.phone) : '',
    )).join('');
    const website = safeHref(contact.website);
    const quickLinks = contact.quickLinks
      .map(link => ({ label: String(link.label || 'Link'), url: safeHref(link.url) }))
      .filter(link => link.url);
    const socials = contact.socials.map(social => ({
      platform: String(social.platform || 'Social'),
      handle: String(social.handle || ''),
      url: socialHref(social.platform, social.handle),
    })).filter(social => social.handle);
    const links = state.links[contact.id];
    const crmCount = links
      ? (links.crm_leads || []).length + (links.crm_opportunities || []).length
      : 0;
    const mapHref = contactMapHref(contact);

    $('drawer-overview').innerHTML = `
      <section class="detail-section">
        <h3>Contact details</h3>
        <dl class="detail-list">
          ${contact.recordType === 'person' ? detailRow('Prefix', contact.prefix || '-') : ''}
          ${contact.recordType === 'person' && contact.middleName ? detailRow('Middle name', contact.middleName) : ''}
          ${contact.recordType === 'person' ? detailRow('Tags', contact.role || '-') : ''}
          ${detailRow('Company type', contact.companyType || '-')}
          ${phoneRows}
          ${emailRows}
          ${detailRow('Website', contact.website || '-', website)}
          ${detailRow('Location', contact.location || '-')}
          ${detailRow('City', contact.city || '-')}
          ${detailRow('Country', contact.country_code || '-')}
          ${detailRow('Category', titleCase(contact.category))}
          ${detailRow('Source', contact.source || '-')}
        </dl>
      </section>
      <section class="detail-section">
        <h3>Additional contacts</h3>
        ${relatedContactRows ? `<dl class="detail-list">${relatedContactRows}</dl>` : '<div class="empty-state">No additional contacts saved.</div>'}
      </section>
      <section class="detail-section">
        <h3>Social handles</h3>
        ${socials.length ? `<div class="quick-links-list">${socials.map(social => (
          social.url
            ? `<a class="quick-link" href="${escapeHtml(social.url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(social.platform)} · ${escapeHtml(social.handle)}</span><span aria-hidden="true">&#8599;</span></a>`
            : `<div class="quick-link"><span>${escapeHtml(social.platform)} · ${escapeHtml(social.handle)}</span></div>`
        )).join('')}</div>` : '<div class="empty-state">No social handles saved.</div>'}
      </section>
      ${mapHref ? `<section class="detail-section">
        <h3>Map</h3>
        <div class="contact-map-preview" id="contact-map-preview">
          <div class="map-preview-status">${contact.mapsUrl ? 'Loading map preview...' : escapeHtml(contact.location || contact.city || 'Location saved')}</div>
        </div>
        <a class="open-map-link" href="${escapeHtml(mapHref)}" target="_blank" rel="noopener noreferrer">${mapIcon()}Open in Maps</a>
      </section>` : ''}
      <section class="detail-section">
        <h3>Quick links</h3>
        ${quickLinks.length ? `<div class="quick-links-list">${quickLinks.map(link => `
          <a class="quick-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">
            <span>${escapeHtml(link.label)}</span><span aria-hidden="true">&#8599;</span>
          </a>`).join('')}</div>` : '<div class="empty-state">No quick links saved.</div>'}
      </section>
      <section class="detail-section">
        <h3>Notes</h3>
        <div class="item-card"><p>${escapeHtml(contact.notes || 'No notes saved.')}</p></div>
      </section>
      <section class="detail-section">
        <h3>CRM links</h3>
        <div class="item-card"><p>${links ? `${crmCount} linked CRM record${crmCount === 1 ? '' : 's'}.` : 'Checking CRM links...'}</p></div>
      </section>
    `;
    if (contact.mapsUrl) hydrateContactMap(contact);
  }

  function drawContactMap(container, coordinates) {
    if (!container || !coordinates) return;
    const width = Math.max(280, Math.round(container.clientWidth || 410));
    container.innerHTML = tileMap(coordinates.lat, coordinates.lng, width, 200);
  }

  async function hydrateContactMap(contact) {
    const container = $('contact-map-preview');
    if (!container || state.activeContactId !== contact.id) return;
    let coordinates = mapsCoords(contact.mapsUrl) || state.mapResolutions[contact.mapsUrl];
    if (coordinates) {
      drawContactMap(container, coordinates);
      return;
    }
    try {
      coordinates = await request(`/api/v1/achi/resolve-maps?url=${encodeURIComponent(contact.mapsUrl)}`);
      state.mapResolutions[contact.mapsUrl] = coordinates;
      if (state.activeContactId === contact.id) drawContactMap($('contact-map-preview'), coordinates);
    } catch (_error) {
      if (state.activeContactId === contact.id && $('contact-map-preview')) {
        $('contact-map-preview').innerHTML = '<div class="map-preview-status">Preview unavailable. Use Open in Maps.</div>';
      }
    }
  }

  function renderActivity(contact) {
    const logs = logsForContact(contact.id).sort(
      (a, b) => new Date(b.occurred_at || b.created_at || 0) - new Date(a.occurred_at || a.created_at || 0),
    );
    $('drawer-activity').innerHTML = logs.length ? `
      <div class="item-list">${logs.map(log => `
        <article class="item-card">
          <div class="item-card-header">
            <h4>${escapeHtml(titleCase(log.log_type || 'Activity'))}</h4>
            <span class="muted">${escapeHtml(formatDateTime(log.occurred_at || log.created_at))}</span>
          </div>
          <p>${escapeHtml(log.description || log.updates || 'No notes')}</p>
          <p>${escapeHtml(log.file_number || '')}${log.category ? ` | ${escapeHtml(log.category)}` : ''}</p>
        </article>
      `).join('')}</div>
    ` : '<div class="empty-state">No activity has been logged for this contact.</div>';
  }

  function renderJobs(contact) {
    const projects = projectsForContact(contact.id);
    const files = filesForContact(contact.id);
    let html = '';

    if (state.projects === null) {
      html += '<div class="permission-note">Project details are unavailable for this account. ACHI files are still shown below.</div>';
    } else if (projects.length) {
      html += `<h3 class="list-heading">Projects</h3><div class="item-list">${projects.map(project => `
        <article class="item-card">
          <div class="item-card-header">
            <h4><a href="/projects/${escapeHtml(project.id)}">${escapeHtml(project.name)}</a></h4>
            <span class="status-pill category-lead">${escapeHtml(titleCase(project.status))}</span>
          </div>
          <p>${escapeHtml(project.project_code || project.project_type || 'Construction project')}</p>
        </article>
      `).join('')}</div>`;
    } else {
      html += '<div class="empty-state">No linked projects.</div>';
    }

    if (files.length) {
      html += `<h3 class="list-heading" style="margin-top:20px">ACHI files</h3><div class="item-list">${files.map(file => `
        <article class="item-card">
          <div class="item-card-header">
            <h4>${escapeHtml(file.file_number || 'Contact file')}</h4>
            <span class="status-pill category-${escapeHtml(file.stage === 'prospect' ? 'prospect' : 'lead')}">${escapeHtml(titleCase(file.status))}</span>
          </div>
          <p>${escapeHtml(file.subject || titleCase(file.stage))}</p>
        </article>
      `).join('')}</div>`;
    }

    $('drawer-jobs').innerHTML = html || '<div class="empty-state">No files or jobs are linked to this contact.</div>';
  }

  function renderInvoices(contact) {
    if (state.invoices === null) {
      $('drawer-invoices').innerHTML = '<div class="permission-note">Invoice details are unavailable for this account.</div>';
      return;
    }
    const invoices = invoicesForContact(contact.id);
    $('drawer-invoices').innerHTML = invoices.length ? `
      <div class="item-list">${invoices.map(invoice => `
        <article class="item-card">
          <div class="item-card-header">
            <h4><a href="/finance">${escapeHtml(invoice.invoice_number)}</a></h4>
            <span class="status-pill category-${escapeHtml(invoice.status === 'paid' ? 'client' : 'prospect')}">${escapeHtml(titleCase(invoice.status))}</span>
          </div>
          <p>${escapeHtml(invoice.invoice_direction ? titleCase(invoice.invoice_direction) : 'Invoice')} | ${escapeHtml(invoice.currency_code || '')} ${escapeHtml(invoice.amount_total || '0')}</p>
          <p>Issued ${escapeHtml(formatDate(invoice.invoice_date))}${invoice.due_date ? ` | Due ${escapeHtml(formatDate(invoice.due_date))}` : ''}</p>
        </article>
      `).join('')}</div>
    ` : '<div class="empty-state">No invoices are linked to this contact or their projects.</div>';
  }

  function renderDrawer() {
    const contact = activeContact();
    if (!contact) return;
    $('drawer-avatar').textContent = initials(contact);
    $('drawer-record-type').textContent = titleCase(contact.recordType);
    $('drawer-name').textContent = contact.displayName;
    $('drawer-company').textContent = contact.recordType === 'person' ? (contact.company_name || '') : (contact.legal_name || '');
    renderDrawerActions(contact);
    renderOverview(contact);
    renderActivity(contact);
    renderJobs(contact);
    renderInvoices(contact);
  }

  function setDrawerTab(tab) {
    state.drawerTab = tab;
    document.querySelectorAll('[data-drawer-tab]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.drawerTab === tab);
    });
    document.querySelectorAll('[data-drawer-panel]').forEach(panel => {
      panel.hidden = panel.dataset.drawerPanel !== tab;
    });
  }

  async function openDrawer(contactId) {
    state.activeContactId = contactId;
    setDrawerTab('overview');
    renderDrawer();
    $('contact-drawer').classList.add('is-open');
    $('contact-drawer').setAttribute('aria-hidden', 'false');
    $('drawer-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';

    if (!Object.prototype.hasOwnProperty.call(state.links, contactId)) {
      try {
        state.links[contactId] = await request(`/api/v1/achi/contacts/${encodeURIComponent(contactId)}/links`);
      } catch (_error) {
        state.links[contactId] = null;
      }
      if (state.activeContactId === contactId) renderDrawer();
    }
  }

  function closeDrawer() {
    $('contact-drawer').classList.remove('is-open');
    $('contact-drawer').setAttribute('aria-hidden', 'true');
    $('drawer-backdrop').hidden = true;
    $('quick-log-form').hidden = true;
    document.body.style.overflow = '';
    state.activeContactId = null;
  }

  function updateIdentityFields() {
    const isCompany = $('record-type').value === 'company';
    document.querySelectorAll('.person-field').forEach(field => { field.hidden = isCompany; });
    document.querySelector('.identity-fields').hidden = isCompany;
    $('company-name').closest('label').hidden = false;
    $('company-name').required = isCompany;
  }

  function repeatableRemoveIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  }

  function optionMarkup(values, selected) {
    const options = [...values];
    if (selected && !options.includes(selected)) options.push(selected);
    return options.map(value => (
      `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(value)}</option>`
    )).join('');
  }

  function phoneRowMarkup(phone = {}, defaultLabel = 'Mobile') {
    const label = String(phone.label || defaultLabel);
    const parts = phoneParts(phone.number || '');
    return `<div class="repeatable-row phone-row" data-phone-row>
      <select data-phone-label aria-label="Phone type">${optionMarkup(PHONE_LABELS, label)}</select>
      <span class="tel-wrap">
        ${countryButtonMarkup(parts)}
        <input type="tel" data-phone-number maxlength="50" inputmode="tel" autocomplete="tel-national" aria-label="Phone number" placeholder="70 123 456" value="${escapeHtml(parts.national)}">
      </span>
      <button class="repeatable-remove" type="button" data-remove-phone aria-label="Remove phone number" title="Remove phone">${repeatableRemoveIcon()}</button>
    </div>`;
  }

  function updatePhoneRows() {
    const rows = [...$('phone-list').querySelectorAll('[data-phone-row]')];
    $('add-phone').disabled = rows.length >= 8;
  }

  function renderPhoneRows(phones = []) {
    const rows = phones.length ? phones.slice(0, 8) : [{ label: 'Primary', number: '' }];
    $('phone-list').innerHTML = rows.map((phone, index) => phoneRowMarkup(phone, index ? 'Mobile' : 'Primary')).join('');
    updatePhoneRows();
  }

  function addPhoneRow() {
    const list = $('phone-list');
    if (list.querySelectorAll('[data-phone-row]').length >= 8) return;
    list.insertAdjacentHTML('beforeend', phoneRowMarkup());
    updatePhoneRows();
    list.lastElementChild.querySelector('[data-phone-number]').focus();
  }

  function readPhoneRows() {
    const rows = [...$('phone-list').querySelectorAll('[data-phone-row]')];
    const phones = rows.map(row => ({
      label: row.querySelector('[data-phone-label]').value.trim() || 'Other',
      number: fullPhoneNumber(row),
    })).filter(phone => phone.number).slice(0, 8);
    const primaryRow = rows.find(row => row.querySelector('[data-phone-number]').value.trim());
    return {
      phones,
      countryCode: primaryRow ? primaryRow.querySelector('[data-country-picker]').dataset.iso.toUpperCase() : null,
    };
  }

  function emailRowMarkup(email = {}, defaultLabel = 'Other') {
    const label = String(email.label || defaultLabel);
    return `<div class="repeatable-row email-row" data-email-row>
      <select data-email-label aria-label="Email type">${optionMarkup(EMAIL_LABELS, label)}</select>
      <input type="email" data-email-address maxlength="255" autocomplete="email" aria-label="Email address" placeholder="name@company.com" value="${escapeHtml(email.address || '')}">
      <button class="repeatable-remove" type="button" data-remove-email aria-label="Remove email address" title="Remove email">${repeatableRemoveIcon()}</button>
    </div>`;
  }

  function updateEmailRows() {
    $('add-email').disabled = $('email-list').querySelectorAll('[data-email-row]').length >= 8;
  }

  function renderEmailRows(emails = []) {
    const rows = emails.length ? emails.slice(0, 8) : [{ label: 'Primary', address: '' }];
    $('email-list').innerHTML = rows.map((email, index) => emailRowMarkup(email, index ? 'Other' : 'Primary')).join('');
    updateEmailRows();
  }

  function addEmailRow() {
    const list = $('email-list');
    if (list.querySelectorAll('[data-email-row]').length >= 8) return;
    list.insertAdjacentHTML('beforeend', emailRowMarkup());
    updateEmailRows();
    list.lastElementChild.querySelector('[data-email-address]').focus();
  }

  function readEmailRows() {
    return [...$('email-list').querySelectorAll('[data-email-row]')].map(row => ({
      label: row.querySelector('[data-email-label]').value.trim() || 'Other',
      address: row.querySelector('[data-email-address]').value.trim(),
    })).filter(email => email.address).slice(0, 8);
  }

  function relatedContactRowMarkup(contact = {}) {
    const parts = phoneParts(contact.phone || '');
    return `<div class="repeatable-row related-contact-row" data-related-contact-row>
      <input type="text" data-related-name maxlength="255" aria-label="Additional contact name" placeholder="Contact name" value="${escapeHtml(contact.name || '')}">
      <input type="text" data-related-tag maxlength="64" aria-label="Relationship or tag" placeholder="Relationship / tag" value="${escapeHtml(contact.tag || '')}">
      <span class="tel-wrap">
        ${countryButtonMarkup(parts, 'Choose additional contact country code')}
        <input type="tel" data-related-phone maxlength="50" inputmode="tel" autocomplete="tel-national" aria-label="Additional contact phone number" placeholder="70 123 456" value="${escapeHtml(parts.national)}">
      </span>
      <button class="repeatable-remove" type="button" data-remove-related-contact aria-label="Remove additional contact" title="Remove contact">${repeatableRemoveIcon()}</button>
    </div>`;
  }

  function updateRelatedContactRows() {
    $('add-related-contact').disabled = $('related-contact-list').querySelectorAll('[data-related-contact-row]').length >= 8;
  }

  function renderRelatedContactRows(contacts = []) {
    $('related-contact-list').innerHTML = contacts.slice(0, 8).map(relatedContactRowMarkup).join('');
    updateRelatedContactRows();
  }

  function addRelatedContactRow() {
    const list = $('related-contact-list');
    if (list.querySelectorAll('[data-related-contact-row]').length >= 8) return;
    list.insertAdjacentHTML('beforeend', relatedContactRowMarkup());
    updateRelatedContactRows();
    list.lastElementChild.querySelector('[data-related-name]').focus();
  }

  function readRelatedContactRows() {
    const contacts = [];
    for (const row of $('related-contact-list').querySelectorAll('[data-related-contact-row]')) {
      const name = row.querySelector('[data-related-name]').value.trim();
      const tag = row.querySelector('[data-related-tag]').value.trim();
      const phone = fullPhoneNumber(row);
      if (!name && !tag && !phone) continue;
      if (!name) throw new Error('Each additional contact needs a name.');
      if (!phone) throw new Error(`Enter a phone number for ${name}.`);
      contacts.push({ name, tag: tag || null, phone });
    }
    return contacts.slice(0, 8);
  }

  function socialRowMarkup(social = {}) {
    const platform = String(social.platform || 'IG');
    return `<div class="repeatable-row social-row" data-social-row>
      <select data-social-platform aria-label="Social platform">${optionMarkup(SOCIAL_PLATFORMS, platform)}</select>
      <input type="text" data-social-handle maxlength="128" aria-label="Social handle" placeholder="@handle" value="${escapeHtml(social.handle || '')}">
      <button class="repeatable-remove" type="button" data-remove-social aria-label="Remove social handle" title="Remove handle">${repeatableRemoveIcon()}</button>
    </div>`;
  }

  function updateSocialRows() {
    $('add-social').disabled = $('social-list').querySelectorAll('[data-social-row]').length >= 12;
  }

  function renderSocialRows(socials = []) {
    const rows = socials.length ? socials.slice(0, 12) : [{ platform: 'IG', handle: '' }];
    $('social-list').innerHTML = rows.map(socialRowMarkup).join('');
    updateSocialRows();
  }

  function addSocialRow() {
    const list = $('social-list');
    if (list.querySelectorAll('[data-social-row]').length >= 12) return;
    list.insertAdjacentHTML('beforeend', socialRowMarkup());
    updateSocialRows();
    list.lastElementChild.querySelector('[data-social-handle]').focus();
  }

  function readSocialRows() {
    return [...$('social-list').querySelectorAll('[data-social-row]')].map(row => ({
      platform: row.querySelector('[data-social-platform]').value.trim(),
      handle: row.querySelector('[data-social-handle]').value.trim(),
    })).filter(social => social.handle).slice(0, 12);
  }

  function setSelectValue(id, value) {
    const select = $(id);
    const normalized = String(value || '');
    if (normalized && ![...select.options].some(option => option.value === normalized)) {
      select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(normalized)}">${escapeHtml(normalized)}</option>`);
    }
    select.value = normalized;
  }

  function quickLinkRowMarkup(link = {}) {
    return `<div class="repeatable-row quick-link-row" data-quick-link-row>
      <input type="text" data-quick-link-label maxlength="64" aria-label="Link label" placeholder="Label" value="${escapeHtml(link.label || '')}">
      <input type="text" data-quick-link-url maxlength="2048" inputmode="url" aria-label="Link URL" placeholder="https://" value="${escapeHtml(link.url || '')}">
      <button class="repeatable-remove" type="button" data-remove-quick-link aria-label="Remove quick link" title="Remove link">${repeatableRemoveIcon()}</button>
    </div>`;
  }

  function updateQuickLinkRows() {
    $('add-quick-link').disabled = $('quick-link-list').querySelectorAll('[data-quick-link-row]').length >= 12;
  }

  function renderQuickLinkRows(links = []) {
    const rows = links.length ? links.slice(0, 12) : [{}];
    $('quick-link-list').innerHTML = rows.map(quickLinkRowMarkup).join('');
    updateQuickLinkRows();
  }

  function addQuickLinkRow() {
    const list = $('quick-link-list');
    if (list.querySelectorAll('[data-quick-link-row]').length >= 12) return;
    list.insertAdjacentHTML('beforeend', quickLinkRowMarkup());
    updateQuickLinkRows();
    list.lastElementChild.querySelector('[data-quick-link-label]').focus();
  }

  function readQuickLinkRows() {
    const links = [];
    for (const row of $('quick-link-list').querySelectorAll('[data-quick-link-row]')) {
      const label = row.querySelector('[data-quick-link-label]').value.trim();
      const rawUrl = row.querySelector('[data-quick-link-url]').value.trim();
      if (!label && !rawUrl) continue;
      const url = safeHref(rawUrl);
      if (!label || !url) {
        throw new Error('Each quick link needs a label and a valid URL.');
      }
      links.push({ label, url });
    }
    return links.slice(0, 12);
  }

  function openContactModal(contact = null) {
    $('contact-form').reset();
    $('form-error').textContent = '';
    $('contact-id').value = contact ? contact.id : '';
    $('contact-modal-title').textContent = contact ? 'Edit contact' : 'New contact';
    $('record-type').value = contact
      ? contact.recordType
      : (state.recordType === 'company' ? 'company' : 'person');
    $('contact-category').value = contact ? contact.category : 'prospect';
    renderIdentityPicklists(contact ? contact.prefix : '', contact ? contact.role : '');
    $('first-name').value = contact ? (contact.first_name || '') : '';
    $('last-name').value = contact ? (contact.last_name || '') : '';
    $('middle-name').value = contact ? (contact.middleName || '') : '';
    $('company-name').value = contact ? (contact.company_name || '') : '';
    setSelectValue('company-type', contact ? contact.companyType : '');
    renderPhoneRows(contact ? contact.phones : []);
    renderEmailRows(contact ? contact.emails : []);
    renderRelatedContactRows(contact ? contact.relatedContacts : []);
    renderSocialRows(contact ? contact.socials : []);
    renderQuickLinkRows(contact ? contact.quickLinks : []);
    $('website').value = contact ? (contact.website || '') : '';
    $('contact-source').value = contact ? (contact.source || '') : '';
    $('city').value = contact ? (contact.city || '') : '';
    $('contact-location').value = contact ? (contact.location || '') : '';
    $('maps-url').value = contact ? (contact.mapsUrl || '') : '';
    $('map-field-status').textContent = '';
    $('contact-notes').value = contact ? (contact.notes || '') : '';
    updateIdentityFields();
    $('contact-modal').hidden = false;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => (
      $('record-type').value === 'person' ? $('contact-prefix') : $('company-name')
    ).focus(), 0);
  }

  function closeContactModal() {
    closeCountryCodeMenu();
    $('contact-modal').hidden = true;
    if (!$('contact-drawer').classList.contains('is-open')) document.body.style.overflow = '';
  }

  async function useCurrentLocation() {
    const button = $('use-current-location');
    const statusNode = $('map-field-status');
    if (!navigator.geolocation) {
      statusNode.textContent = 'Location is not available in this browser.';
      return;
    }

    const originalContent = button.innerHTML;
    button.disabled = true;
    button.textContent = 'Locating...';
    statusNode.textContent = 'Waiting for location permission...';
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 30000,
        });
      });
      const lat = Number(position.coords.latitude).toFixed(7);
      const lng = Number(position.coords.longitude).toFixed(7);
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
      $('maps-url').value = mapsUrl;
      statusNode.textContent = 'Location captured. Looking up the address...';
      try {
        const resolved = await request(`/api/v1/achi/resolve-maps?url=${encodeURIComponent(mapsUrl)}`);
        const address = [resolved.street, resolved.city, resolved.district, resolved.country].filter(Boolean).join(', ');
        if (address) $('contact-location').value = address;
        if (!$('city').value.trim() && resolved.city) $('city').value = resolved.city;
        statusNode.textContent = address ? 'Location and address added.' : 'Map location added.';
      } catch (_error) {
        statusNode.textContent = 'Map location added. Enter the address manually if needed.';
      }
    } catch (error) {
      statusNode.textContent = error && error.code === 1
        ? 'Location permission was denied.'
        : 'Could not get your current location.';
    } finally {
      button.disabled = false;
      button.innerHTML = originalContent;
    }
  }

  async function saveContact(event) {
    event.preventDefault();
    $('form-error').textContent = '';
    const recordType = $('record-type').value;
    const firstName = $('first-name').value.trim();
    const lastName = $('last-name').value.trim();
    const companyName = $('company-name').value.trim();

    if (recordType === 'person' && !firstName && !lastName) {
      $('form-error').textContent = 'Enter a first name or last name.';
      return;
    }
    if (recordType === 'company' && !companyName) {
      $('form-error').textContent = 'Enter the company name.';
      return;
    }

    let quickLinks;
    let relatedContacts;
    try {
      quickLinks = readQuickLinkRows();
      relatedContacts = readRelatedContactRows();
    } catch (error) {
      $('form-error').textContent = error.message;
      return;
    }

    const rawMapsUrl = $('maps-url').value.trim();
    const mapsUrl = normalizeMapsUrl(rawMapsUrl);
    if (rawMapsUrl && !mapsUrl) {
      $('form-error').textContent = 'Map location must be a Google Maps link.';
      return;
    }

    const phoneData = readPhoneRows();
    const emails = readEmailRows();
    const payload = {
      record_type: recordType,
      category: $('contact-category').value,
      first_name: firstName || null,
      last_name: lastName || null,
      middle_name: recordType === 'person' ? ($('middle-name').value.trim() || null) : null,
      prefix: recordType === 'person' ? ($('contact-prefix').value || null) : null,
      role: recordType === 'person' ? ($('contact-role').value || null) : null,
      company_name: companyName || null,
      company_type: $('company-type').value || null,
      primary_email: emails[0] ? emails[0].address : null,
      emails,
      phones: phoneData.phones,
      related_contacts: relatedContacts,
      socials: readSocialRows(),
      website: $('website').value.trim() || null,
      country_code: phoneData.countryCode,
      city: $('city').value.trim() || null,
      location: $('contact-location').value.trim() || null,
      maps_url: mapsUrl || null,
      source: $('contact-source').value.trim() || null,
      quick_links: quickLinks,
      notes: $('contact-notes').value.trim() || null,
    };

    const contactId = $('contact-id').value;
    const saveButton = $('contact-save');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';
    try {
      const result = await request(
        contactId
          ? `/api/v1/achi/contact-info/contacts/${encodeURIComponent(contactId)}`
          : '/api/v1/achi/contact-info/contacts',
        { method: contactId ? 'PUT' : 'POST', body: payload },
      );
      state.recordType = recordType;
      document.querySelectorAll('[data-record-type]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.recordType === state.recordType);
      });
      closeContactModal();
      await loadData({ silent: true });
      showToast(contactId ? 'Contact updated.' : 'Contact created.');
      if (contactId && state.activeContactId === contactId) renderDrawer();
      if (!contactId && result && result.id) openDrawer(result.id);
    } catch (error) {
      $('form-error').textContent = error.message;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save contact';
    }
  }

  async function saveQuickLog(event) {
    event.preventDefault();
    const contact = activeContact();
    if (!contact) return;
    const notes = $('quick-log-notes').value.trim();
    if (!notes) return;

    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      let file = filesForContact(contact.id)
        .filter(item => item.status !== 'done' && item.status !== 'cancelled')
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
      if (!file) {
        file = await request('/api/v1/achi/files/', {
          method: 'POST',
          body: {
            contact_id: contact.id,
            subject: 'Contact activity',
            stage: contact.category === 'prospect' ? 'prospect' : 'lead',
            status: 'open',
          },
        });
      }
      await request(`/api/v1/achi/files/${encodeURIComponent(file.id)}/logs/`, {
        method: 'POST',
        body: {
          log_type: $('quick-log-type').value,
          category: 'Contact',
          occurred_at: new Date().toISOString(),
          description: notes,
        },
      });
      $('quick-log-form').reset();
      $('quick-log-form').hidden = true;
      await loadData({ silent: true });
      setDrawerTab('activity');
      showToast('Activity saved.');
    } catch (error) {
      showToast(error.message, true);
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (character === '"' && source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }
      } else if (character === '"') {
        if (field) throw new Error('CSV contains an unexpected quote.');
        quoted = true;
      } else if (character === ',') {
        row.push(field);
        field = '';
      } else if (character === '\n') {
        row.push(field);
        if (row.some(value => value.trim())) rows.push(row);
        row = [];
        field = '';
      } else if (character !== '\r') {
        field += character;
      }
    }

    if (quoted) throw new Error('CSV contains an unclosed quoted value.');
    row.push(field);
    if (row.some(value => value.trim())) rows.push(row);
    return rows;
  }

  function csvHeaderKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function csvRecord(headers, row) {
    return headers.reduce((record, header, index) => {
      if (header) record[header] = String(row[index] || '').trim();
      return record;
    }, {});
  }

  function csvValue(record, ...keys) {
    for (const key of keys) {
      if (record[key]) return record[key];
    }
    return '';
  }

  function importedPhones(value) {
    return String(value || '').split(';').map(item => {
      const entry = item.trim();
      if (!entry) return null;
      const separator = entry.includes('|') ? entry.indexOf('|') : entry.indexOf(':');
      const label = separator >= 0 ? entry.slice(0, separator).trim() : 'Mobile';
      const number = separator >= 0 ? entry.slice(separator + 1).trim() : entry;
      return number ? { label: label || 'Mobile', number } : null;
    }).filter(Boolean).slice(0, 8);
  }

  function importedEmails(value) {
    return String(value || '').split(';').map(item => {
      const entry = item.trim();
      if (!entry) return null;
      const separator = entry.includes('|') ? entry.indexOf('|') : entry.indexOf(':');
      const label = separator >= 0 ? entry.slice(0, separator).trim() : 'Primary';
      const address = separator >= 0 ? entry.slice(separator + 1).trim() : entry;
      return address ? { label: label || 'Other', address } : null;
    }).filter(Boolean).slice(0, 8);
  }

  function importedRelatedContacts(value) {
    return String(value || '').split(';').map(item => {
      const parts = item.split('|').map(part => part.trim());
      if (!parts.some(Boolean)) return null;
      return { name: parts[0] || '', tag: parts[1] || null, phone: parts[2] || '' };
    }).filter(item => item && item.name && item.phone).slice(0, 8);
  }

  function importedSocials(value) {
    return String(value || '').split(';').map(item => {
      const entry = item.trim();
      if (!entry) return null;
      const separator = entry.includes('|') ? entry.indexOf('|') : entry.indexOf(':');
      const platform = separator >= 0 ? entry.slice(0, separator).trim() : 'LinkedIn';
      const handle = separator >= 0 ? entry.slice(separator + 1).trim() : entry;
      return handle ? { platform: platform || 'LinkedIn', handle } : null;
    }).filter(Boolean).slice(0, 12);
  }

  function importCategory(value) {
    const normalized = String(value || 'prospect').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const aliases = {
      customer: 'client',
      vendor: 'supplier',
      sub_contractor: 'subcontractor',
      consultant: 'other',
    };
    const category = aliases[normalized] || normalized;
    const allowed = ['client', 'prospect', 'lead', 'supplier', 'subcontractor', 'internal', 'other'];
    if (!allowed.includes(category)) throw new Error(`Unsupported category: ${value}`);
    return category;
  }

  function contactPayloadFromCsv(headers, row) {
    const record = csvRecord(headers, row);
    const name = csvValue(record, 'name', 'contactname');
    const company = csvValue(record, 'company', 'companyname', 'legalname');
    const explicitFirstName = csvValue(record, 'firstname', 'givenname');
    const explicitLastName = csvValue(record, 'lastname', 'surname', 'familyname');
    const middleName = csvValue(record, 'middlename', 'additionalname');
    const rawRecordType = csvValue(record, 'recordtype', 'type').toLowerCase();
    let recordType;

    if (['company', 'business', 'organisation', 'organization'].includes(rawRecordType)) {
      recordType = 'company';
    } else if (['person', 'individual', 'contact'].includes(rawRecordType)) {
      recordType = 'person';
    } else {
      recordType = company && !name && !explicitFirstName && !explicitLastName ? 'company' : 'person';
    }

    let firstName = explicitFirstName;
    let lastName = explicitLastName;
    let companyName = company;
    if (recordType === 'company') {
      companyName = company || name;
      if (!companyName) throw new Error('Company name is required.');
      firstName = '';
      lastName = '';
    } else if (!firstName && !lastName) {
      const parts = name.split(/\s+/).filter(Boolean);
      firstName = parts.shift() || '';
      lastName = parts.join(' ');
      if (!firstName && !lastName) throw new Error('Person name is required.');
    }

    const countryCode = csvValue(record, 'country', 'countrycode').toUpperCase();
    if (countryCode.length > 2) throw new Error(`Country must be a two-letter code: ${countryCode}`);
    const phones = importedPhones(csvValue(record, 'phones', 'phone', 'primaryphone', 'mobile'));
    const primaryEmail = csvValue(record, 'email', 'primaryemail');
    const emails = importedEmails(csvValue(record, 'emails'));
    if (!emails.length && primaryEmail) emails.push({ label: 'Primary', address: primaryEmail });
    const rawMapsUrl = csvValue(record, 'mapsurl', 'maplink', 'googlemaps');
    const mapsUrl = normalizeMapsUrl(rawMapsUrl);
    if (rawMapsUrl && !mapsUrl) throw new Error('Map URL must be a Google Maps link.');

    return {
      record_type: recordType,
      category: importCategory(csvValue(record, 'category', 'contactcategory')),
      first_name: firstName || null,
      last_name: lastName || null,
      middle_name: recordType === 'person' ? (middleName || null) : null,
      prefix: recordType === 'person' ? (csvValue(record, 'prefix', 'title', 'salutation') || null) : null,
      role: recordType === 'person' ? (csvValue(record, 'tags', 'tag', 'role', 'jobtitle', 'position') || null) : null,
      company_name: companyName || null,
      company_type: csvValue(record, 'companytype', 'organisationtype', 'organizationtype') || null,
      primary_email: emails[0] ? emails[0].address : null,
      emails,
      phones,
      related_contacts: importedRelatedContacts(csvValue(record, 'additionalcontacts', 'relatedcontacts')),
      socials: importedSocials(csvValue(record, 'socials', 'socialhandles', 'socialmedia')),
      website: csvValue(record, 'website', 'url') || null,
      country_code: countryCode || null,
      city: csvValue(record, 'city', 'locality', 'town') || null,
      location: csvValue(record, 'location', 'address', 'street') || null,
      maps_url: mapsUrl || null,
      source: csvValue(record, 'source', 'leadsource') || null,
      quick_links: [],
      notes: csvValue(record, 'notes', 'note') || null,
    };
  }

  function importIdentityKeys(payload) {
    const keys = [];
    const email = String(payload.primary_email || '').trim().toLowerCase();
    if (email) keys.push(`email:${email}`);
    if (payload.record_type === 'company') {
      keys.push(`company:${String(payload.company_name || '').trim().toLowerCase()}`);
    } else {
      const name = [payload.first_name, payload.last_name].filter(Boolean).join(' ').trim().toLowerCase();
      const phone = payload.phones[0] ? payload.phones[0].number.replace(/\D/g, '') : '';
      if (name) keys.push(`person:${name}:${phone}`);
    }
    return keys.filter(key => !key.endsWith(':'));
  }

  function existingImportKeys() {
    const keys = new Set();
    for (const contact of state.contacts) {
      const payload = {
        record_type: contact.recordType,
        first_name: contact.first_name,
        last_name: contact.last_name,
        company_name: contact.company_name,
        primary_email: contact.primary_email,
        phones: contact.phones,
      };
      for (const key of importIdentityKeys(payload)) keys.add(key);
    }
    return keys;
  }

  async function importCsv(file) {
    const input = $('import-input');
    const button = $('import-button');
    const originalLabel = button.textContent;
    let imported = 0;
    let skipped = 0;
    const errors = [];

    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) throw new Error('CSV must contain a header and at least one contact.');
      if (rows.length > 501) throw new Error('Import is limited to 500 contacts at a time.');
      const headers = rows.shift().map(csvHeaderKey);
      if (!headers.some(header => ['name', 'contactname', 'firstname', 'company', 'companyname'].includes(header))) {
        throw new Error('CSV needs a Name, First name, or Company column.');
      }

      const contacts = [];
      rows.forEach((row, index) => {
        try {
          contacts.push({ rowNumber: index + 2, payload: contactPayloadFromCsv(headers, row) });
        } catch (error) {
          skipped += 1;
          errors.push(`Row ${index + 2}: ${error.message}`);
        }
      });
      if (!contacts.length) throw new Error(errors[0] || 'CSV contains no importable contacts.');
      const confirmation = `Import ${contacts.length} contact${contacts.length === 1 ? '' : 's'}?`
        + (skipped ? ` ${skipped} invalid row${skipped === 1 ? '' : 's'} will be skipped.` : '');
      if (!window.confirm(confirmation)) return;

      button.disabled = true;
      input.disabled = true;
      const knownKeys = existingImportKeys();
      for (let index = 0; index < contacts.length; index += 1) {
        const contact = contacts[index];
        button.textContent = `Importing ${index + 1}/${contacts.length}`;
        const identityKeys = importIdentityKeys(contact.payload);
        if (identityKeys.some(key => knownKeys.has(key))) {
          skipped += 1;
          errors.push(`Row ${contact.rowNumber}: contact already exists.`);
          continue;
        }
        try {
          await request('/api/v1/achi/contact-info/contacts', { method: 'POST', body: contact.payload });
          imported += 1;
          identityKeys.forEach(key => knownKeys.add(key));
        } catch (error) {
          skipped += 1;
          errors.push(`Row ${contact.rowNumber}: ${error.message}`);
        }
      }

      if (imported) await loadData({ silent: true });
      if (errors.length) console.warn('CSV import skipped rows:', errors);
      const summary = `${imported} imported${skipped ? `, ${skipped} skipped` : ''}.`;
      showToast(summary, imported === 0);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
      input.disabled = false;
      button.textContent = originalLabel;
      input.value = '';
    }
  }

  function csvCell(value) {
    let text = String(value == null ? '' : value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const contacts = visibleContacts();
    const rows = [
      ['Record type', 'Prefix', 'First name', 'Last name', 'Middle name', 'Tags', 'Company', 'Company type', 'Category', 'Emails', 'Phones', 'Additional contacts', 'Social handles', 'Location', 'Maps URL', 'City', 'Country', 'Source', 'Logs', 'Jobs'],
      ...contacts.map(contact => [
        contact.recordType,
        contact.prefix,
        contact.recordType === 'company' ? '' : (contact.first_name || ''),
        contact.recordType === 'company' ? '' : (contact.last_name || ''),
        contact.middleName,
        contact.role,
        contact.company_name || '',
        contact.companyType,
        contact.category,
        contact.emails.map(email => `${email.label}: ${email.address}`).join('; '),
        contact.phones.map(phone => `${phone.label}: ${phone.number}`).join('; '),
        contact.relatedContacts.map(related => [related.name, related.tag, related.phone].filter(Boolean).join('|')).join('; '),
        contact.socials.map(social => `${social.platform}: ${social.handle}`).join('; '),
        contact.location,
        contact.mapsUrl,
        contact.city,
        contact.country_code || '',
        contact.source,
        contact.logCount,
        contact.jobCount,
      ]),
    ];
    const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `achi-${state.recordType}-contacts.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function bindEvents() {
    document.querySelectorAll('[data-view-mode]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.viewMode === state.viewMode);
      button.addEventListener('click', () => {
        state.viewMode = button.dataset.viewMode === 'grid' ? 'grid' : 'list';
        try {
          localStorage.setItem('achi_contact_view', state.viewMode);
        } catch (_error) {
          // The selected view still works when browser storage is unavailable.
        }
        document.querySelectorAll('[data-view-mode]').forEach(item => {
          item.classList.toggle('is-active', item.dataset.viewMode === state.viewMode);
        });
        renderTable();
      });
    });

    document.querySelectorAll('[data-record-type]').forEach(button => {
      button.addEventListener('click', () => {
        state.recordType = button.dataset.recordType;
        state.category = 'all';
        document.querySelectorAll('[data-record-type]').forEach(item => item.classList.toggle('is-active', item === button));
        document.querySelectorAll('[data-category]').forEach(item => item.classList.toggle('is-active', item.dataset.category === 'all'));
        renderDirectory();
      });
    });

    document.querySelectorAll('[data-category]').forEach(button => {
      button.addEventListener('click', () => {
        state.category = button.dataset.category;
        document.querySelectorAll('[data-category]').forEach(item => item.classList.toggle('is-active', item === button));
        renderTable();
      });
    });

    $('contact-search').addEventListener('input', event => {
      state.search = event.target.value;
      renderTable();
    });

    $('contacts-table-body').addEventListener('click', event => {
      if (event.target.closest('[data-map-link]')) return;
      const target = event.target.closest('[data-contact-id], [data-open-contact]');
      if (!target) return;
      openDrawer(target.dataset.contactId || target.dataset.openContact);
    });

    $('grid-view').addEventListener('click', event => {
      if (event.target.closest('[data-map-link]')) return;
      const target = event.target.closest('[data-open-contact]');
      if (target) openDrawer(target.dataset.openContact);
    });

    $('new-contact-button').addEventListener('click', () => openContactModal());
    $('import-button').addEventListener('click', () => $('import-input').click());
    $('import-input').addEventListener('change', event => {
      const file = event.target.files && event.target.files[0];
      if (file) importCsv(file);
    });
    $('export-button').addEventListener('click', exportCsv);
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer-backdrop').addEventListener('click', closeDrawer);

    document.querySelectorAll('[data-drawer-tab]').forEach(button => {
      button.addEventListener('click', () => setDrawerTab(button.dataset.drawerTab));
    });

    $('drawer-actions').addEventListener('click', event => {
      if (event.target.closest('#drawer-edit')) openContactModal(activeContact());
      if (event.target.closest('#drawer-add-log')) {
        setDrawerTab('activity');
        $('quick-log-form').hidden = false;
        $('quick-log-notes').focus();
      }
    });

    $('quick-log-form').addEventListener('submit', saveQuickLog);
    $('quick-log-cancel').addEventListener('click', () => { $('quick-log-form').hidden = true; });
    $('record-type').addEventListener('change', updateIdentityFields);
    $('contact-prefix').addEventListener('change', event => addIdentityChoice(event.target, {
      key: PREFIX_STORAGE_KEY, sentinel: ADD_PREFIX, label: 'prefix', maxLength: 16,
    }));
    $('contact-role').addEventListener('change', event => addIdentityChoice(event.target, {
      key: TAG_STORAGE_KEY, sentinel: ADD_TAG, label: 'tag', maxLength: 64,
    }));
    $('add-phone').addEventListener('click', addPhoneRow);
    $('phone-list').addEventListener('click', event => {
      const remove = event.target.closest('[data-remove-phone]');
      if (!remove) return;
      remove.closest('[data-phone-row]').remove();
      updatePhoneRows();
    });
    $('add-email').addEventListener('click', addEmailRow);
    $('email-list').addEventListener('click', event => {
      const remove = event.target.closest('[data-remove-email]');
      if (!remove) return;
      remove.closest('[data-email-row]').remove();
      updateEmailRows();
    });
    $('add-related-contact').addEventListener('click', addRelatedContactRow);
    $('related-contact-list').addEventListener('click', event => {
      const remove = event.target.closest('[data-remove-related-contact]');
      if (!remove) return;
      remove.closest('[data-related-contact-row]').remove();
      updateRelatedContactRows();
    });
    $('add-social').addEventListener('click', addSocialRow);
    $('social-list').addEventListener('click', event => {
      const remove = event.target.closest('[data-remove-social]');
      if (!remove) return;
      remove.closest('[data-social-row]').remove();
      if (!$('social-list').children.length) renderSocialRows();
      else updateSocialRows();
    });
    $('add-quick-link').addEventListener('click', addQuickLinkRow);
    $('quick-link-list').addEventListener('click', event => {
      const remove = event.target.closest('[data-remove-quick-link]');
      if (!remove) return;
      remove.closest('[data-quick-link-row]').remove();
      if (!$('quick-link-list').children.length) renderQuickLinkRows();
      else updateQuickLinkRows();
    });
    $('use-current-location').addEventListener('click', useCurrentLocation);
    $('contact-form').addEventListener('submit', saveContact);
    $('contact-form').addEventListener('click', event => {
      const button = event.target.closest('[data-country-picker]');
      if (button) openCountryCodeMenu(button);
    });
    $('contact-form').addEventListener('paste', event => {
      if (!event.target.matches('[data-phone-number], [data-related-phone]')) return;
      window.setTimeout(() => normalizePhoneInput(event.target), 0);
    });
    $('contact-form').addEventListener('focusout', event => {
      if (event.target.matches('[data-phone-number], [data-related-phone]')) normalizePhoneInput(event.target);
    });
    $('modal-close').addEventListener('click', closeContactModal);
    $('modal-cancel').addEventListener('click', closeContactModal);
    $('contact-modal').addEventListener('click', event => {
      if (event.target === $('contact-modal')) closeContactModal();
    });
    document.addEventListener('mousedown', event => {
      if (!countryCodeMenu || countryCodeMenu.hidden) return;
      if (!countryCodeMenu.contains(event.target) && !event.target.closest('[data-country-picker]')) closeCountryCodeMenu();
    });

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!$('contact-modal').hidden) closeContactModal();
      else if ($('contact-drawer').classList.contains('is-open')) closeDrawer();
    });
  }

  bindEvents();
  loadData();
}());
