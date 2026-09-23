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
  const CONTACTS_PATH = '/api/v1/achi/contact-info/contacts?limit=500';
  const CONTACT_REFRESH_MS = 15000;
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
    links: {},
    recordType: 'all',
    columnFilters: { role: '', company: '', city: '', source: '' },
    search: '',
    viewMode: storedViewMode(),
    activeContactId: null,
    panelWide: false,
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

  // <input type="datetime-local"> value ("YYYY-MM-DDTHH:MM") <-> ISO, in local time.
  function toDatetimeLocalValue(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  function datetimeLocalToISO(value) {
    if (!value) return null;
    const date = new Date(value);   // datetime-local has no zone -> parsed as local
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function refreshContactWhenLabel() {
    const raw = $('contact-datetime').value;
    $('contact-when-label').textContent = raw ? formatDateTime(raw) : '';
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

  // ── Site info: Country / District / City cascade (ported from the Add Log popup)
  // Predefined districts/cities for the countries ACHI works in. A country not in
  // GEO leaves District/City free; user-added ones come from /geo (DB-backed).
  const GEO = {
    'Lebanon': {
      'Beirut': ['Achrafieh', 'Hamra', 'Verdun', 'Mar Mikhael', 'Ras Beirut', 'Gemmayzeh', 'Badaro', 'Mazraa', 'Sodeco', 'Ain el Mreisseh', 'Ras el Nabaa', 'Zqaq el Blat', 'Bachoura', 'Msaytbeh', 'Ain el Tineh', 'Manara', 'Clemenceau', 'Kantari', 'Saifi', 'Rmeil'],
      'Mount Lebanon': ['Baabda', 'Jounieh', 'Jbeil', 'Aley', 'Broummana', 'Bhamdoun', 'Dbayeh', 'Zalka', 'Antelias', 'Beit Mery', 'Bikfaya', 'Beit Chabab', 'Bteghrine', 'Baabdat', 'Zouk Mosbeh', 'Zouk Mikael', 'Kaslik', 'Jal el Dib', 'Naccache', 'Rabieh', 'Mansourieh', 'Dekwaneh', 'Sin el Fil', 'Hazmieh', 'Furn el Chebbak', 'Chiyah', 'Hadath', 'Kfarshima', 'Bsalim', 'Ain Saadeh', 'Damour', 'Naameh', 'Choueifat', 'Sofar', 'Dhour Choueir', 'Bologna'],
      'North': ['Tripoli', 'Zgharta', 'Batroun', 'Koura', 'Bcharre', 'Amioun', 'Chekka', 'Mina', 'Qalamoun', 'Kousba', 'Enfeh', 'Deddeh', 'Bterram', 'Kfarhata', 'Ehden', 'Kfarsghab', 'Tannourine', 'Douma', 'Hasroun', 'Bziza'],
      'Akkar': ['Halba', 'Qoubaiyat', 'Bebnine', 'Chadra', 'Michmich', 'Fnaideq', 'Rahbeh', 'Bire', 'Aandqet', 'Tikrit', 'Cheikh Mohammad', 'Mounjez', 'Beino', 'Berqayel'],
      'Beqaa': ['Zahle', 'Chtaura', 'Anjar', 'Bar Elias', 'Rayak', 'Taalabaya', 'Saadnayel', 'Jdita', 'Kab Elias', 'Ferzol', 'Ablah', 'Qab Elias', 'Majdel Anjar', 'Riyaq', 'Mreijat'],
      'Baalbek-Hermel': ['Baalbek', 'Hermel', 'Deir el Ahmar', 'Ras Baalbek', 'Aarsal', 'Laboue', 'Nabi Chit', 'Douris', 'Chmistar', 'Britel', 'Younine', 'Fakiha'],
      'South': ['Sidon', 'Tyre', 'Jezzine', 'Sarafand', 'Ghazieh', 'Zahrani', 'Nabatieh', 'Qana', 'Maghdouche', 'Anqoun', 'Rmeileh', 'Aadloun', 'Bisariyeh', 'Kfar Hatta', 'Ain el Delb'],
      'Nabatieh': ['Nabatieh', 'Marjayoun', 'Hasbaya', 'Bint Jbeil', 'Kfar Roummane', 'Zawtar', 'Habbouch', 'Ansar', 'Doueir', 'Kfar Tibnit', 'Arnoun', 'Chaqra', 'Tebnine', 'Aitaroun', 'Ainata'],
    },
    'United Arab Emirates': {
      'Abu Dhabi': ['Abu Dhabi', 'Al Ain', 'Ruwais', 'Madinat Zayed'],
      'Dubai': ['Dubai', 'Jebel Ali', 'Hatta'],
      'Sharjah': ['Sharjah', 'Khor Fakkan', 'Kalba'],
      'Ajman': ['Ajman'], 'Umm Al Quwain': ['Umm Al Quwain'],
      'Ras Al Khaimah': ['Ras Al Khaimah'], 'Fujairah': ['Fujairah', 'Dibba'],
    },
    'Saudi Arabia': {
      'Riyadh': ['Riyadh', 'Al Kharj', 'Diriyah'],
      'Makkah': ['Mecca', 'Jeddah', 'Taif'],
      'Madinah': ['Medina', 'Yanbu'],
      'Eastern Province': ['Dammam', 'Khobar', 'Dhahran', 'Jubail', 'Al Ahsa'],
      'Asir': ['Abha', 'Khamis Mushait'], 'Tabuk': ['Tabuk'], 'Qassim': ['Buraidah', 'Unaizah'],
    },
    'Qatar': {
      'Doha': ['Doha'], 'Al Rayyan': ['Al Rayyan'], 'Al Wakrah': ['Al Wakrah'],
      'Al Khor': ['Al Khor'], 'Umm Salal': ['Umm Salal'], 'Al Daayen': ['Lusail'],
    },
    'Kuwait': {
      'Al Asimah': ['Kuwait City'], 'Hawalli': ['Hawalli', 'Salmiya'], 'Farwaniya': ['Farwaniya'],
      'Ahmadi': ['Ahmadi', 'Fahaheel'], 'Jahra': ['Jahra'], 'Mubarak Al-Kabeer': ['Mubarak Al-Kabeer'],
    },
    'Bahrain': {
      'Capital': ['Manama'], 'Muharraq': ['Muharraq'],
      'Northern': ['Hamad Town', 'Budaiya'], 'Southern': ['Riffa', 'Isa Town'],
    },
    'Oman': {
      'Muscat': ['Muscat', 'Seeb', 'Bawshar'], 'Dhofar': ['Salalah'],
      'Al Batinah North': ['Sohar'], 'Al Batinah South': ['Rustaq'],
      'Musandam': ['Khasab'], 'Al Dakhiliyah': ['Nizwa'],
    },
  };
  const COUNTRY_NAMES = ['Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda', 'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria', 'Burkina Faso', 'Burundi', 'Cambodia', 'Cameroon', 'Canada', 'Cape Verde', 'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros', 'Congo (Brazzaville)', 'Congo (Kinshasa)', 'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czechia', 'Denmark', 'Djibouti', 'Dominica', 'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti', 'Honduras', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Ivory Coast', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'Kosovo', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico', 'Micronesia', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria', 'North Korea', 'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau', 'Palestine', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines', 'Samoa', 'San Marino', 'Sao Tome and Principe', 'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa', 'South Korea', 'South Sudan', 'Spain', 'Sri Lanka', 'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand', 'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey', 'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe'];
  const DISTRICT_ADD = '__add_district__';
  const CITY_ADD = '__add_city__';
  const geoCustom = { districts: {}, cities: {} };
  const districtsFor = country => (GEO[country] ? Object.keys(GEO[country]) : null);
  const citiesFor = (country, district) => (GEO[country] && GEO[country][district] ? GEO[country][district] : null);
  const cityKey = (country, district) => `${country || ''}|${district || ''}`;
  const districtsMerged = country => [...new Set([...(districtsFor(country) || []), ...(geoCustom.districts[country] || [])])];
  const districtOptions = country => (country ? [...districtsMerged(country), DISTRICT_ADD] : []);
  const mergedCities = (country, district) => [...new Set([...(citiesFor(country, district) || []), ...(geoCustom.cities[cityKey(country, district)] || [])])];
  const cityOptions = (country, district) => (country && district ? [...mergedCities(country, district), CITY_ADD] : []);

  // User-added districts/cities live server-side (shared, not per-browser).
  async function loadGeoCustomLists() {
    try {
      const districts = await request('/api/v1/achi/geo/districts');
      geoCustom.districts = {};
      for (const row of districts) (geoCustom.districts[row.country] = geoCustom.districts[row.country] || []).push(row.district);
    } catch (_error) { /* predefined GEO districts still work */ }
    try {
      const cities = await request('/api/v1/achi/geo/cities');
      geoCustom.cities = {};
      for (const row of cities) {
        const key = cityKey(row.country, row.district);
        (geoCustom.cities[key] = geoCustom.cities[key] || []).push(row.city);
      }
    } catch (_error) { /* predefined GEO cities still work */ }
  }

  function geoOptionLabel(value) {
    if (value === DISTRICT_ADD) return '+ Add district';
    if (value === CITY_ADD) return '+ Add city';
    return value || '—';
  }

  // Value that never leaks the "+ Add" sentinels into saved data.
  function geoValue(id) {
    const value = $(id).value.trim();
    return (value === DISTRICT_ADD || value === CITY_ADD) ? '' : value;
  }

  function fillGeoSelect(id, list, selected) {
    const select = $(id);
    if (!select) return;
    const options = [...(list || [])];
    // Keep a saved value that isn't in the predefined list (e.g. legacy free text)
    // so editing a contact never silently drops its address.
    if (selected && !options.includes(selected)) options.splice(Math.max(0, options.length - 1), 0, selected);
    select.innerHTML = ['', ...options]
      .map(option => `<option value="${escapeHtml(option)}"${option === (selected || '') ? ' selected' : ''}>${escapeHtml(geoOptionLabel(option))}</option>`)
      .join('');
    select.value = selected || '';
  }

  // Country / District / City cascades. The contact form's IDs are the default;
  // the + Person popup passes its own address blocks.
  const CONTACT_GEO = { country: 'contact-country', district: 'contact-district', city: 'contact-city', error: 'form-error' };

  function refreshCountrySelect(selected, ids = CONTACT_GEO) { fillGeoSelect(ids.country, COUNTRY_NAMES, selected || ''); }
  function refreshDistrictSelect(selected, ids = CONTACT_GEO) { fillGeoSelect(ids.district, districtOptions($(ids.country).value), selected || ''); }
  function refreshCitySelect(selected, ids = CONTACT_GEO) { fillGeoSelect(ids.city, cityOptions($(ids.country).value, $(ids.district).value), selected || ''); }

  async function addDistrictAndSelect(ids = CONTACT_GEO) {
    const country = $(ids.country).value;
    if (!country) { refreshDistrictSelect('', ids); return; }
    const name = (window.prompt(`New district for ${country} (max 128 characters):`) || '').trim();
    if (!name) { refreshDistrictSelect('', ids); return; }
    if (name.length > 128) { $(ids.error).textContent = 'District must be 128 characters or fewer.'; refreshDistrictSelect('', ids); return; }
    try {
      const saved = await request('/api/v1/achi/geo/districts', { method: 'POST', body: { country, district: name } });
      const list = geoCustom.districts[country] = geoCustom.districts[country] || [];
      if (!list.includes(saved.district) && !(districtsFor(country) || []).includes(saved.district)) list.push(saved.district);
      refreshDistrictSelect(saved.district, ids);
      refreshCitySelect('', ids);
      $(ids.error).textContent = '';
    } catch (error) { $(ids.error).textContent = error.message; refreshDistrictSelect('', ids); }
  }

  async function addCityAndSelect(ids = CONTACT_GEO) {
    const country = $(ids.country).value;
    const district = $(ids.district).value;
    if (!country || !district) { refreshCitySelect('', ids); return; }
    const name = (window.prompt(`New city for ${district} (max 128 characters):`) || '').trim();
    if (!name) { refreshCitySelect('', ids); return; }
    if (name.length > 128) { $(ids.error).textContent = 'City must be 128 characters or fewer.'; refreshCitySelect('', ids); return; }
    try {
      const saved = await request('/api/v1/achi/geo/cities', { method: 'POST', body: { country, district, city: name } });
      const key = cityKey(country, district);
      const list = geoCustom.cities[key] = geoCustom.cities[key] || [];
      if (!list.includes(saved.city) && !(citiesFor(country, district) || []).includes(saved.city)) list.push(saved.city);
      refreshCitySelect(saved.city, ids);
      $(ids.error).textContent = '';
    } catch (error) { $(ids.error).textContent = error.message; refreshCitySelect('', ids); }
  }

  // Wires one cascade: changing country resets district/city; "+ Add" prompts.
  function bindGeoCascade(ids) {
    $(ids.country).addEventListener('change', () => { refreshDistrictSelect('', ids); refreshCitySelect('', ids); });
    $(ids.district).addEventListener('change', () => {
      if ($(ids.district).value === DISTRICT_ADD) addDistrictAndSelect(ids);
      else refreshCitySelect('', ids);
    });
    $(ids.city).addEventListener('change', () => {
      if ($(ids.city).value === CITY_ADD) addCityAndSelect(ids);
    });
  }

  // Snap a geocoded name onto an existing option instead of adding a near-duplicate.
  function geoNorm(value) {
    return String(value || '').toLowerCase()
      .replace(/\b(governorate|province|district|region|county|state)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function geoChoice(value, options) {
    if (!value) return '';
    const wanted = geoNorm(value);
    return (options || []).find(option => geoNorm(option) === wanted) || value;
  }

  function applyGeocodedAddress(data) {
    if (!data) return;
    if (data.country) {
      refreshCountrySelect(geoChoice(data.country, COUNTRY_NAMES));
      if (data.district) {
        refreshDistrictSelect(geoChoice(data.district, districtsMerged($('contact-country').value)));
        if (data.city) refreshCitySelect(geoChoice(data.city, mergedCities($('contact-country').value, $('contact-district').value)));
      } else {
        refreshDistrictSelect('');
        if (data.city) refreshCitySelect(data.city);
      }
    }
    if (data.street && !$('contact-street').value.trim()) $('contact-street').value = data.street;
  }

  // ── Live map preview under the Google-maps field (mirrors Add Log's rx-mapprev)
  let modalMapReq = 0;
  let modalMapTimer = null;

  function drawModalMap(box, url, coordinates) {
    if (!box || !coordinates) return;
    box.hidden = false;
    const width = Math.max(280, Math.round(box.clientWidth || 460));
    box.innerHTML = tileMap(coordinates.lat, coordinates.lng, width, 200)
      + `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>`;
  }

  // applyGeocode defaults true (the input listener passes a truthy Event). On
  // initial open we pass false so a saved contact's Country/District/City is not
  // silently overwritten by reverse-geocoding the stored link.
  function updateModalMapPreview(applyGeocode = true) {
    const box = $('contact-map-preview-modal');
    if (!box) return;
    const raw = ($('maps-url').value || '').trim();
    const url = raw ? normalizeMapsUrl(raw) : '';
    window.clearTimeout(modalMapTimer);
    const req = ++modalMapReq;   // newest input wins any in-flight resolve
    if (!url) { box.hidden = true; box.innerHTML = ''; return; }
    const inline = mapsCoords(url);   // full links carry coordinates — draw instantly
    if (inline) drawModalMap(box, url, inline);
    else { box.hidden = false; box.innerHTML = '<div class="map-load">Loading preview…</div>'; }
    modalMapTimer = window.setTimeout(async () => {
      try {
        const coordinates = await request(`/api/v1/achi/resolve-maps?url=${encodeURIComponent(url)}`);
        if (req !== modalMapReq) return;   // superseded — drop this result
        drawModalMap(box, url, coordinates);
        if (applyGeocode) applyGeocodedAddress(coordinates);
      } catch (_error) {
        if (req !== modalMapReq) return;
        box.hidden = false;
        box.innerHTML = `<div class="map-load">Preview not available — <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">open in Google Maps</a></div>`;
      }
    }, 450);
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
    return value.map(item => {
      const f = personFields(item);   // folds legacy {name,tag} into the card shape
      return { prefix: f.prefix, first_name: f.first, last_name: f.last, role: f.role, phone_label: f.phoneLabel, phone: f.phone, email: f.email, primary: f.primary };
    }).filter(item => item.first_name || item.last_name || item.phone || item.email).slice(0, 8);
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
      city: bucket.city || address.city || address.locality || address.town || '',
      location: bucket.location || address.formatted || address.address_line_1 || address.street || '',
      country: bucket.country || address.country || '',
      district: bucket.district || address.state || address.region || '',
      street: bucket.street || address.street || '',
      siteNumber: bucket.site_number || '',
      siteBuilding: bucket.site_building || '',
      siteFloor: bucket.site_floor || '',
      mapsUrl: normalizeMapsUrl(bucket.maps_url),
      latestFile: [...contactFiles].sort(
        (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
      )[0] || null,
      lastContact: contactLogs[0] ? (contactLogs[0].occurred_at || contactLogs[0].created_at) : null,
      contactDate: bucket.contact_date || raw.created_at || null,
      // Only shown when the backend stores them; nothing is inferred client-side.
      companyContactId: bucket.company_contact_id || '',
      industry: bucket.industry || '',
      activity: bucket.activity || '',
      companySize: bucket.company_size || '',
      photo: bucket.photo || null,
      aiNote: bucket.ai_note || '',
      aiSummary: bucket.ai_summary || '',
      aiSummaryWhen: bucket.ai_summary_at || null,
      duplicateOf: [],
    };
  }

  // Duplicate suspects: contacts sharing an email, a company name, or a person
  // name + phone — the same identity the directory already dedupes on.
  function contactIdentityKeys(contact) {
    const keys = [];
    const email = String(contact.primary_email || '').trim().toLowerCase();
    if (email) keys.push(`email:${email}`);
    if (contact.recordType === 'company') {
      keys.push(`company:${String(contact.company_name || '').trim().toLowerCase()}`);
    } else {
      const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim().toLowerCase();
      const phone = contact.phones[0] ? contact.phones[0].number.replace(/\D/g, '') : '';
      if (name) keys.push(`person:${name}:${phone}`);
    }
    return keys.filter(key => !key.endsWith(':'));
  }

  function markDuplicates(contacts) {
    const byKey = new Map();
    for (const contact of contacts) {
      for (const key of contactIdentityKeys(contact)) {
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(contact);
      }
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      for (const contact of group) {
        for (const other of group) {
          if (other !== contact && !contact.duplicateOf.includes(other)) contact.duplicateOf.push(other);
        }
      }
    }
  }

  function rebuildContacts() {
    state.contacts = state.rawContacts.map(normalizeContact);
    markDuplicates(state.contacts);
  }

  function contactsForRecordType() {
    if (state.recordType === 'all') return state.contacts;
    if (state.recordType === 'duplicates') return state.contacts.filter(contact => contact.duplicateOf.length);
    return state.contacts.filter(contact => contact.recordType === state.recordType);
  }

  // The value each column filter matches on.
  const COLUMN_VALUE = {
    role: contact => contactRole(contact),
    company: contact => contactCompany(contact),
    city: contact => contact.city,
    source: contact => contact.source,
  };

  function columnFiltered(contacts) {
    return Object.entries(state.columnFilters).reduce((rows, [column, wanted]) => (
      wanted ? rows.filter(contact => (COLUMN_VALUE[column](contact) || '') === wanted) : rows
    ), contacts);
  }

  // Each picker offers the values present in the current People/Companies set,
  // narrowed by the other pickers, so a combination can never show nothing.
  function renderColumnFilters() {
    const base = contactsForRecordType();
    for (const column of Object.keys(state.columnFilters)) {
      const others = { ...state.columnFilters, [column]: '' };
      const pool = Object.entries(others).reduce((rows, [other, wanted]) => (
        wanted ? rows.filter(contact => (COLUMN_VALUE[other](contact) || '') === wanted) : rows
      ), base);
      const values = [...new Set(pool.map(contact => COLUMN_VALUE[column](contact)).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
      const current = state.columnFilters[column];
      // A value filtered away elsewhere stays listed so it can be cleared.
      if (current && !values.includes(current)) values.push(current);
      const select = $(`hf-${column}`);
      select.innerHTML = '<option value="">All</option>'
        + values.map(value => `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(value)}</option>`).join('');
      select.value = current;
      select.classList.toggle('on', Boolean(current));
      const wrap = select.parentElement;
      wrap.classList.toggle('on', Boolean(current));
      wrap.title = current ? `Filtered: ${current}` : 'Filter';
    }
  }

  function visibleContacts() {
    const query = state.search.trim().toLowerCase();
    const rows = columnFiltered(contactsForRecordType());
    if (!query) return rows;
    return rows.filter(contact => [
      contact.displayName,
      contact.company_name,
      contact.legal_name,
      contact.role,
      contact.companyType,
      contact.primary_email,
      contact.city,
      ...contact.phones.map(phone => phone.number),
    ].filter(Boolean).join(' ').toLowerCase().includes(query));
  }

  // No preference is stored for contacts; it is predicted from what the
  // + Person popup saved, in priority order: a WhatsApp number, then any other
  // number (Mobile, Telephone, Fax…), then an email.
  const PREF_CLASS = { WhatsApp: 'pref-wa', Mobile: 'pref-call', Email: 'pref-email' };

  function contactPref(contact) {
    if (contact.phones.some(phone => phone.label === 'WhatsApp')) return 'WhatsApp';
    if (contact.phones.length) return 'Mobile';
    if (contact.emails.length || contact.primary_email) return 'Email';
    return '—';
  }

  function prefBadge(contact, placeholder = true) {
    const pref = contactPref(contact);
    if (!PREF_CLASS[pref] && !placeholder) return '';
    return `<span class="st ${PREF_CLASS[pref] || 'pref-none'}">${escapeHtml(pref)}</span>`;
  }

  function setKpi(id, value) {
    $(id).textContent = value == null ? '—' : value;
  }

  function renderSummary() {
    const all = state.contacts;
    setKpi('contact-total', all.length);
    setKpi('people-count', all.filter(contact => contact.recordType === 'person').length);
    setKpi('company-count', all.filter(contact => contact.recordType === 'company').length);
    setKpi('duplicate-count', all.filter(contact => contact.duplicateOf.length).length);
  }

  function setToggleGroup(selector, dataKey, value) {
    document.querySelectorAll(selector).forEach(button => {
      const isOn = button.dataset[dataKey] === value;
      button.classList.toggle('on', isOn);
      button.setAttribute('aria-pressed', String(isOn));
    });
  }

  function setRecordType(recordType) {
    state.recordType = recordType;
    setToggleGroup('[data-record-type]', 'recordType', recordType);
    const available = contactsForRecordType();
    for (const [column, wanted] of Object.entries(state.columnFilters)) {
      if (wanted && !available.some(contact => (COLUMN_VALUE[column](contact) || '') === wanted)) state.columnFilters[column] = '';
    }
    renderColumnFilters();
  }

  function setListMessage(message) {
    $('contacts-table-body').innerHTML = `<div class="empty-msg">${escapeHtml(message)}</div>`;
    $('contacts-cards').innerHTML = `<div class="empty-msg">${escapeHtml(message)}</div>`;
  }

  function duplicateFlag(contact) {
    if (!contact.duplicateOf.length) return '';
    const names = contact.duplicateOf.map(other => other.displayName).join(', ');
    return ` <span title="Possible duplicate of ${escapeHtml(names)}">&#9888;</span>`;
  }

  // Role column: a person's tag, or a company's company type.
  function contactRole(contact) {
    return contact.recordType === 'company' ? contact.companyType : contact.role;
  }

  // Company column: a person's company, or a company's legal name.
  function contactCompany(contact) {
    return contact.recordType === 'company' ? (contact.legal_name || '') : (contact.company_name || '');
  }

  function linkedCode(contact, placeholder = true) {
    if (!contact.latestFile || !contact.latestFile.file_number) return placeholder ? '<span class="mut">—</span>' : '';
    return `<span class="code" title="${escapeHtml(contact.latestFile.subject || '')}">${escapeHtml(contact.latestFile.file_number)}</span>`;
  }

  function whoMarkup(contact) {
    return `<span class="who${contact.recordType === 'company' ? ' co' : ''}">${escapeHtml(initials(contact))}</span>`;
  }

  function contactRowMarkup(contact) {
    const classes = ['row', contact.id === state.activeContactId ? 'sel' : '', contact.duplicateOf.length ? 'dup' : '']
      .filter(Boolean).join(' ');
    const mapHref = contact.city ? contactMapHref(contact) : '';
    const city = mapHref
      ? `<a class="city" data-map-link href="${escapeHtml(mapHref)}" target="_blank" rel="noopener noreferrer" title="Open in Google Maps">${mapIcon()}${escapeHtml(contact.city)}</a>`
      : '';
    return `<div class="${classes}" data-contact-id="${escapeHtml(contact.id)}">
        <div>${whoMarkup(contact)}</div>
        <div class="c-name">${escapeHtml(contact.displayName)}${duplicateFlag(contact)}</div>
        <div class="c-sm">${escapeHtml(contactRole(contact))}</div>
        <div class="c-sm">${escapeHtml(contactCompany(contact))}</div>
        <div class="mut c-sm c-num">${escapeHtml(contact.primaryPhone)}</div>
        <div class="mut c-sm">${city}</div>
        <div>${prefBadge(contact, false)}</div>
        <div class="mut c-sm">${escapeHtml(contact.source)}</div>
        <div>${linkedCode(contact, false)}</div>
        <div class="mut c-last">${escapeHtml(contact.lastContact ? formatDate(contact.lastContact) : '')}</div>
        <div class="aiN">${escapeHtml(contact.aiNote)}</div>
      </div>`;
  }

  function contactCardMarkup(contact) {
    const classes = ['ccd', contact.id === state.activeContactId ? 'sel' : '', contact.duplicateOf.length ? 'dup' : '']
      .filter(Boolean).join(' ');
    return `<div class="${classes}" data-open-contact="${escapeHtml(contact.id)}">
        <div class="ccd-head">
          ${whoMarkup(contact)}
          <div class="ccd-id">
            <div class="ccd-name">${escapeHtml(contact.displayName)}${duplicateFlag(contact)}</div>
            <div class="mut ccd-sub">${escapeHtml(contactRole(contact) || '—')} · ${escapeHtml(contactCompany(contact) || '—')}</div>
          </div>
          ${prefBadge(contact)}
        </div>
        <div class="ccd-line">
          <span class="mut c-num">${escapeHtml(contact.primaryPhone || '—')}</span>
          <span class="fill"></span>
          ${linkedCode(contact)}
        </div>
        <div class="aiN ccd-ai">${escapeHtml(contact.aiNote || '—')}</div>
        <div class="mut ccd-meta">last touch ${escapeHtml(contact.lastContact ? formatDate(contact.lastContact) : '—')} · via ${escapeHtml(contact.source || '—')}</div>
      </div>`;
  }

  function renderTable() {
    const contacts = visibleContacts();
    document.querySelectorAll('.js-shown-count').forEach(node => {
      node.textContent = `${contacts.length} shown of ${state.contacts.length}`;
    });
    $('list-view').hidden = state.viewMode !== 'list';
    $('grid-view').hidden = state.viewMode !== 'grid';

    if (!contacts.length) {
      setListMessage('No contacts found.');
      return;
    }
    // Only the visible view is rendered; switching views re-renders.
    if (state.viewMode === 'grid') {
      $('contacts-cards').innerHTML = contacts.map(contactCardMarkup).join('');
    } else {
      $('contacts-table-body').innerHTML = contacts.map(contactRowMarkup).join('');
    }
  }

  function updateSelection() {
    document.querySelectorAll('#contacts-table-body [data-contact-id], #contacts-cards [data-open-contact]').forEach(node => {
      const id = node.dataset.contactId || node.dataset.openContact;
      node.classList.toggle('sel', id === state.activeContactId);
    });
  }

  function renderDirectory() {
    renderSummary();
    renderColumnFilters();
    renderTable();
  }

  function applyContactResponse(response) {
    state.rawContacts = Array.isArray(response.items) ? response.items : [];
    rebuildContacts();
    renderDirectory();
    if (state.activeContactId) {
      if (activeContact()) renderDrawer();
      else closeDrawer();
    }
  }

  async function loadData({ silent = false } = {}) {
    if (!accessToken) {
      setListMessage('Open the main ERP, sign in, then reload this page.');
      setKpi('contact-total', null);
      return;
    }

    if (!silent) setListMessage('Loading...');

    try {
      const contactsPromise = request(CONTACTS_PATH);
      const enrichmentPromise = Promise.all([
        optionalRequest('/api/v1/achi/files/?limit=1000'),
        optionalRequest('/api/v1/achi/logs/?limit=1000'),
        optionalRequest('/api/v1/projects/?limit=500&status=all'),
      ]);

      applyContactResponse(await contactsPromise);

      const [files, logs, projects] = await enrichmentPromise;
      state.files = Array.isArray(files) ? files : [];
      state.logs = Array.isArray(logs) ? logs : (Array.isArray(logs?.items) ? logs.items : []);
      state.projects = Array.isArray(projects) ? projects : null;

      rebuildContacts();
      renderDirectory();
      if (state.activeContactId && activeContact()) renderDrawer();
    } catch (error) {
      setListMessage(error.message);
      setKpi('contact-total', null);
      showToast(error.message, true);
    }
  }

  let contactRefreshInFlight = false;

  async function refreshSharedContacts() {
    if (!accessToken || document.hidden || contactRefreshInFlight) return;
    contactRefreshInFlight = true;
    try {
      applyContactResponse(await request(CONTACTS_PATH));
    } catch (_error) {
      // Keep the current directory visible during a transient background failure.
    } finally {
      contactRefreshInFlight = false;
    }
  }

  function activeContact() {
    return state.contacts.find(contact => contact.id === state.activeContactId) || null;
  }

  // ── Detail panel ─────────────────────────────────────────────────────────

  function detailRow(label, value, href = '') {
    const content = value && href
      ? `<a href="${escapeHtml(href)}" target="${href.startsWith('http') ? '_blank' : '_self'}" rel="noopener noreferrer">${escapeHtml(value)}</a>`
      : escapeHtml(value || '—');
    return `<span class="k">${escapeHtml(label)}</span><span>${content}</span>`;
  }

  function emptyRow(message, colspan) {
    return `<tr><td class="mut" colspan="${colspan}">${escapeHtml(message)}</td></tr>`;
  }

  async function deleteContact(contact) {
    if (!contact || !window.confirm(`Delete ${contact.displayName}? It can be restored later by an administrator.`)) return;
    const button = $('drawer-delete');
    if (button) button.disabled = true;
    try {
      await request(`/api/v1/achi/contact-info/contacts/${encodeURIComponent(contact.id)}`, { method: 'DELETE' });
      closeDrawer();
      await loadData({ silent: true });
      showToast('Contact deleted.');
    } catch (error) {
      showToast(error.message, true);
      if (button) button.disabled = false;
    }
  }

  // AI summary section renders only when a summary is stored for the contact.
  function renderAiSummary(contact) {
    const section = $('drawer-ai');
    section.hidden = !contact.aiSummary;
    if (!contact.aiSummary) return;
    $('drawer-ai-when').textContent = contact.aiSummaryWhen ? ` · updated ${formatDateTime(contact.aiSummaryWhen)}` : '';
    $('drawer-ai-text').textContent = contact.aiSummary;
  }

  function renderOverview(contact) {
    const role = [contactRole(contact), contactCompany(contact)].filter(Boolean).join(' · ');
    $('drawer-overview').innerHTML = [
      detailRow('Role', role),
      detailRow('Mobile', contact.primaryPhone, phoneHref(contact.primaryPhone)),
      detailRow('WhatsApp', contact.primaryPhone, whatsappHref(contact.primaryPhone)),
      detailRow('Email', contact.primary_email, contact.primary_email ? `mailto:${contact.primary_email}` : ''),
      detailRow('Found us via', contact.source),
      detailRow('Address', contact.location || [contact.city, contact.country].filter(Boolean).join(', ')),
    ].join('');
  }

  function renderJobs(contact) {
    const links = state.links[contact.id];
    const rows = [
      ...filesForContact(contact.id).map(file => `<tr>
        <td><span class="code">${escapeHtml(file.file_number || 'File')}</span></td>
        <td class="mut t-wrap">${escapeHtml([file.subject || titleCase(file.stage), titleCase(file.status)].filter(Boolean).join(' · '))}</td>
      </tr>`),
      ...projectsForContact(contact.id).map(project => `<tr>
        <td><a class="code" href="/projects/${escapeHtml(project.id)}">${escapeHtml(project.project_code || 'Project')}</a></td>
        <td class="mut t-wrap">${escapeHtml([project.name, titleCase(project.status)].filter(Boolean).join(' · '))}</td>
      </tr>`),
      ...((links && links.crm_leads) || []).map(lead => `<tr>
        <td><a class="code" href="/api/v1/achi/crm/ui">CRM lead</a></td>
        <td class="mut t-wrap">${escapeHtml([lead.contact_name, titleCase(lead.status || '')].filter(Boolean).join(' · '))}</td>
      </tr>`),
      ...((links && links.crm_opportunities) || []).map(opportunity => `<tr>
        <td><a class="code" href="/api/v1/achi/crm/ui">CRM opp.</a></td>
        <td class="mut t-wrap">${escapeHtml([opportunity.name, titleCase(opportunity.stage || '')].filter(Boolean).join(' · '))}</td>
      </tr>`),
    ];
    $('drawer-jobs').innerHTML = rows.length
      ? rows.join('')
      : emptyRow(links === undefined ? 'Checking linked records...' : 'No linked records.', 2);
  }

  function renderActivity(contact) {
    const logs = logsForContact(contact.id).sort(
      (a, b) => new Date(b.occurred_at || b.created_at || 0) - new Date(a.occurred_at || a.created_at || 0),
    );
    $('drawer-activity').innerHTML = logs.length ? logs.map(log => `<tr>
        <td class="mut t-date">${escapeHtml(formatDate(log.occurred_at || log.created_at))}</td>
        <td>${escapeHtml(titleCase(log.log_type || 'Activity'))}</td>
        <td class="t-wrap">${escapeHtml(htmlToText(log.description || log.updates) || 'No notes')}</td>
      </tr>`).join('') : emptyRow('No logs yet.', 3);
  }

  function renderDrawer() {
    const contact = activeContact();
    if (!contact) return;
    $('drawer-name').textContent = contact.displayName;
    $('drawer-id').textContent = contact.id.slice(0, 8);
    $('drawer-id').title = contact.id;
    renderAiSummary(contact);
    renderOverview(contact);
    renderJobs(contact);
    renderActivity(contact);
  }

  function isDrawerOpen() {
    return !$('contact-drawer').hidden;
  }

  function setPanelWide(wide) {
    state.panelWide = wide;
    $('contact-drawer').classList.toggle('wide', wide);
  }

  async function openDrawer(contactId) {
    if (state.activeContactId !== contactId) {
      $('quick-log-form').reset();
      $('quick-log-form').hidden = true;
    }
    state.activeContactId = contactId;
    renderDrawer();
    updateSelection();
    $('contact-drawer').hidden = false;
    $('contact-drawer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

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
    $('contact-drawer').hidden = true;
    $('quick-log-form').hidden = true;
    setPanelWide(false);
    state.activeContactId = null;
    updateSelection();
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

  // Each additional contact is a mini card mirroring the main contact fields —
  // matching the Add Log popup so the two pages look and store the same.
  const RELATED_ROLES = ['Owner', 'Engineer', 'Contractor', 'Foreman', 'Site manager', 'Architect', 'Procurement'];

  function personFields(rc) {
    rc = rc || {};
    let first = rc.first_name || '', last = rc.last_name || '';
    if (!first && !last && rc.name) { const p = String(rc.name).trim().split(/\s+/); first = p[0] || ''; last = p.slice(1).join(' '); }
    return { prefix: rc.prefix || '', first, last, role: rc.role || rc.tag || '', phoneLabel: rc.phone_label || 'Mobile', phone: rc.phone || '', email: rc.email || '', primary: !!rc.primary };
  }

  // Options with a leading "—" for the empty choice, matching the Add Log card.
  function personOpts(list, selected) {
    return ['', ...list].map(o => `<option value="${escapeHtml(o)}"${o === (selected || '') ? ' selected' : ''}>${escapeHtml(o || '—')}</option>`).join('');
  }

  // Byte-for-byte the same markup/classes as the Add Log popup's contact-person
  // card (rx-person / rx-l / rx-in / rx-grid …), with the Contacts data-attrs
  // kept so the read/remove logic and the country picker still work. The card's
  // CSS is copied (scoped to .rx-person) into contact_info.css.
  function relatedContactRowMarkup(contact = {}) {
    const f = personFields(contact);
    const parts = phoneParts(f.phone);
    return `<div class="rx-person" data-related-contact-row>
      <div class="rx-person-head"><span class="rx-person-t" data-person-num>Contact</span>
        <button type="button" class="rx-person-x" data-remove-related-contact aria-label="Remove contact person">&times; Remove</button></div>
      <div class="rx-grid rx-g4">
        <div><label class="rx-l">Pre</label><select class="rx-in" data-related-prefix>${personOpts(PREFIXES, f.prefix)}</select></div>
        <div><label class="rx-l">First name</label><input class="rx-in" type="text" data-related-first maxlength="128" placeholder="Type or pick..." value="${escapeHtml(f.first)}"></div>
        <div><label class="rx-l">Last name</label><input class="rx-in" type="text" data-related-last maxlength="128" placeholder="Type or pick..." value="${escapeHtml(f.last)}"></div>
        <div><label class="rx-l">Role</label><select class="rx-in" data-related-role>${personOpts(RELATED_ROLES, f.role)}</select></div>
      </div>
      <div class="rx-grid rx-g-person">
        <div><label class="rx-l">Phone / WhatsApp</label><div class="rx-person-tel">
          <select class="rx-in rx-phone-label" data-related-phone-label aria-label="Number type">${optionMarkup(PHONE_LABELS, f.phoneLabel)}</select>
          <span class="tel-wrap">${countryButtonMarkup(parts, 'Choose contact person country code')}<input class="rx-in tel-num" type="tel" data-related-phone maxlength="50" inputmode="tel" autocomplete="tel-national" placeholder="70 123 456" value="${escapeHtml(parts.national)}"></span>
        </div></div>
        <div><label class="rx-l">Email</label><input class="rx-in" type="email" data-related-email maxlength="255" autocomplete="email" placeholder="name@company.com" value="${escapeHtml(f.email)}"></div>
        <div><label class="rx-l">Primary?</label><select class="rx-in" data-related-primary><option value="no"${f.primary ? '' : ' selected'}>No</option><option value="yes"${f.primary ? ' selected' : ''}>Yes</option></select></div>
      </div>
    </div>`;
  }

  function updateRelatedContactRows() {
    $('add-related-contact').disabled = $('related-contact-list').querySelectorAll('[data-related-contact-row]').length >= 8;
  }

  function renumberRelatedContacts() {
    $('related-contact-list').querySelectorAll('[data-person-num]').forEach((el, i) => { el.textContent = `Contact ${i + 2}`; });
  }

  function renderRelatedContactRows(contacts = []) {
    $('related-contact-list').innerHTML = contacts.slice(0, 8).map(relatedContactRowMarkup).join('');
    updateRelatedContactRows();
    renumberRelatedContacts();
  }

  function addRelatedContactRow() {
    const list = $('related-contact-list');
    if (list.querySelectorAll('[data-related-contact-row]').length >= 8) return;
    list.insertAdjacentHTML('beforeend', relatedContactRowMarkup());
    updateRelatedContactRows();
    renumberRelatedContacts();
    list.lastElementChild.querySelector('[data-related-first]').focus();
  }

  function readRelatedContactRows() {
    const contacts = [];
    for (const row of $('related-contact-list').querySelectorAll('[data-related-contact-row]')) {
      const g = s => row.querySelector(s);
      const first = (g('[data-related-first]').value || '').trim();
      const last = (g('[data-related-last]').value || '').trim();
      const email = (g('[data-related-email]').value || '').trim();
      const phone = fullPhoneNumber(row);
      if (!first && !last && !email && !phone) continue;
      if (!first && !last) throw new Error('Each contact person needs a name.');
      contacts.push({
        prefix: (g('[data-related-prefix]').value || '').trim() || null,
        first_name: first || null, last_name: last || null,
        role: (g('[data-related-role]').value || '').trim() || null,
        phone_label: (g('[data-related-phone-label]').value || 'Mobile').trim(),
        phone: phone || null, email: email || null,
        primary: g('[data-related-primary]').value === 'yes',
      });
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

  function openContactModal(contact = null, recordType = null) {
    $('contact-form').reset();
    $('form-error').textContent = '';
    $('contact-id').value = contact ? contact.id : '';
    const newType = recordType || (state.recordType === 'company' ? 'company' : 'person');
    $('contact-modal-title').textContent = contact
      ? 'Edit contact'
      : (newType === 'company' ? 'New company' : 'New person');
    $('record-type').value = contact ? contact.recordType : newType;
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
    refreshCountrySelect(contact ? (contact.country || '') : '');
    refreshDistrictSelect(contact ? (contact.district || '') : '');
    refreshCitySelect(contact ? (contact.city || '') : '');
    $('contact-street').value = contact ? (contact.street || '') : '';
    $('contact-no').value = contact ? (contact.siteNumber || '') : '';
    $('contact-building').value = contact ? (contact.siteBuilding || '') : '';
    $('contact-floor').value = contact ? (contact.siteFloor || '') : '';
    $('maps-url').value = contact ? (contact.mapsUrl || '') : '';
    $('map-field-status').textContent = '';
    $('map-field-status').className = 'map-field-status';
    updateModalMapPreview(false);
    $('contact-notes').value = contact ? (contact.notes || '') : '';
    $('contact-datetime').value = toDatetimeLocalValue(
      contact ? (contact.contactDate || contact.created_at) : null,
    );
    refreshContactWhenLabel();
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
    document.body.style.overflow = '';
  }

  async function useCurrentLocation() {
    const button = $('use-current-location');
    const statusNode = $('map-field-status');
    if (!window.isSecureContext) {
      statusNode.textContent = 'Current location requires HTTPS or localhost.';
      statusNode.className = 'map-field-status bad';
      return;
    }
    if (!navigator.geolocation) {
      statusNode.textContent = 'Location is not available in this browser.';
      statusNode.className = 'map-field-status bad';
      return;
    }

    const originalContent = button.innerHTML;
    button.disabled = true;
    button.textContent = 'Locating...';
    statusNode.textContent = 'Waiting for location permission...';
    statusNode.className = 'map-field-status';
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
      $('maps-url').value = `https://www.google.com/maps?q=${lat},${lng}`;
      // Fires the input listener → draws the preview and reverse-geocodes the
      // Country/District/City/Street fields, exactly as pasting a link would.
      $('maps-url').dispatchEvent(new Event('input', { bubbles: true }));
      const accuracy = Number(position.coords.accuracy);
      const metres = Number.isFinite(accuracy) ? Math.round(accuracy) : null;
      statusNode.textContent = `Location added${metres === null ? '' : ` — accuracy about ${metres} m`}. Check the map preview before saving.`;
      statusNode.className = 'map-field-status ok';
    } catch (error) {
      statusNode.textContent = error && error.code === 1
        ? 'Location permission was denied.'
        : 'Could not get your current location.';
      statusNode.className = 'map-field-status bad';
    } finally {
      button.disabled = false;
      button.innerHTML = originalContent;
    }
  }

  // Compose the free-text `location` from the structured site fields so CRM views
  // and the drawer map still get a readable address string.
  function composeContactLocation() {
    const street = $('contact-street').value.trim();
    const no = $('contact-no').value.trim();
    const building = $('contact-building').value.trim();
    const floor = $('contact-floor').value.trim();
    const detail = [
      street,
      no && `No. ${no}`,
      building && `Bldg ${building}`,
      floor && `Floor ${floor}`,
    ].filter(Boolean).join(', ');
    return [detail, geoValue('contact-city'), geoValue('contact-district'), geoValue('contact-country')]
      .filter(Boolean).join(', ');
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
      country: geoValue('contact-country') || null,
      district: geoValue('contact-district') || null,
      city: geoValue('contact-city') || null,
      street: $('contact-street').value.trim() || null,
      site_number: $('contact-no').value.trim() || null,
      site_building: $('contact-building').value.trim() || null,
      site_floor: $('contact-floor').value.trim() || null,
      location: composeContactLocation() || null,
      maps_url: mapsUrl || null,
      source: $('contact-source').value.trim() || null,
      quick_links: quickLinks,
      notes: $('contact-notes').value.trim() || null,
      contact_date: datetimeLocalToISO($('contact-datetime').value),
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
      // Keep the current filter unless it would hide the record just saved.
      if (state.recordType !== 'all' && state.recordType !== recordType) setRecordType(recordType);
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
      showToast('Activity saved.');
    } catch (error) {
      showToast(error.message, true);
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  // ── + Person popup ──────────────────────────────────────────────────────
  // One form: a first-contact log (header + quick capture) and the person, with
  // an optional linked company. Saves through the existing APIs, in order:
  //   1. new company  → POST /contact-info/contacts (record_type company)
  //   2. person       → POST /contact-info/contacts (linked by company_contact_id)
  //   3. log, only when something was captured → POST /files/ + /files/{id}/logs/
  //   4. attachments  → POST /logs/{id}/attachments

  // Option vocabularies shared with the Log page (log-core.js): same values,
  // same per-browser "+ Add New" storage keys.
  // The header's three pickers. log_type and reference are free text on the API,
  // so the label is stored as-is ("Log" keeps the API default, General).
  const RECORD_TYPES = ['Log', 'PROSP', 'Enquiry', 'Site Visit', 'Drawing', 'M/T', 'BOQ', 'Quotation',
    'Job', 'Invoice', 'Payment', 'Balance', 'Delivery Slip'];
  const LOG_CHANNELS = ['Inbound Call', 'Outbound Call', 'Meeting', 'WhatsApp', 'Email'];
  // The file's status column only accepts the codes in schemas.STATUSES, so each
  // label carries the code it saves as. "CLOSED — LOST" and "CANCELLED" are two
  // labels over the one code the API has for them.
  const STATUS_OPTIONS = [
    { key: 'open', label: 'OPEN', status: 'open', color: '#22c55e' },
    { key: 'scheduled', label: 'FOLLOW-UP SET', status: 'scheduled', color: '#f59e0b' },
    { key: 'viewed', label: 'WAITING CLIENT', status: 'viewed', color: '#0ea5e9' },
    { key: 'done', label: 'CLOSED — WON', status: 'done', color: '#15803d' },
    { key: 'closed_lost', label: 'CLOSED — LOST', status: 'cancelled', color: '#ef4444' },
    { key: 'cancelled', label: 'CANCELLED', status: 'cancelled', color: '#b91c1c' },
  ];
  const LOG_STAGES = [
    ['prospect', 'Prospect'], ['outreach', 'Outreach'], ['follow_up', 'Follow-up'], ['first_contact', 'First Contact'],
    ['second_follow_up', '2nd Follow-up'], ['enquiry', 'ENQ — new enquiry'], ['site_survey', 'Site Visit'],
    ['drawing', 'Drawing'], ['takeoff', 'Takeoff'], ['boq', 'BOQ'], ['resources', 'Resources'], ['plan', 'Plan'],
    ['costing', 'Costing'], ['pricing', 'Pricing'], ['quotation', 'Quotation'], ['negotiation', 'Negotiation'],
    ['accepted', 'Accepted'], ['cancelled', 'Cancelled'], ['on_hold', 'On Hold'],
  ];
  const LOG_TAG_SEED = ['Supplier', 'Client'];
  const LOG_TAG_KEY = 'achi_log_tags';
  const COMPANY_TYPE_KEY = 'achi_company_types';
  const SOURCE_KEY = 'achi_contact_sources';
  const INDUSTRY_KEY = 'achi_company_industries';
  const ACTIVITY_KEY = 'achi_company_activities';
  const ADD_NEW = '__add_new__';
  const REFERRAL_SOURCE = 'Referral — someone';
  const SOURCES = ['Returning client', 'Advertisement', 'Social media', REFERRAL_SOURCE, 'Website', 'Walk-in'];
  const COMPANY_TYPES = ['Contractor', 'Developer', 'Consultant', 'Architect', 'Owner'];
  const INDUSTRIES = ['Construction', 'Real estate', 'Industrial', 'Public sector'];
  const ACTIVITIES = ['General contracting', 'Scaffolding & formwork', 'Fit-out & finishing', 'MEP', 'Infrastructure', 'Developer / owner'];
  const COMPANY_SIZES = ['1–10', '11–50', '51–200', '200+'];
  const PP_PHONE_LABELS = ['Mobile', 'WhatsApp', 'Telephone', 'Fax', 'Office', 'Site', 'Home', 'Other'];
  // Country is still a select; District/City are free text with a datalist of
  // the shared lists, so a value outside them can simply be typed.
  const PERSON_GEO = { country: 'pp-a-country', district: 'pp-a-district', city: 'pp-a-city', error: 'pp-error' };

  function fillDatalist(id, values) {
    $(id).innerHTML = values.map(value => `<option value="${escapeHtml(value)}"></option>`).join('');
  }

  function refreshPersonDistrictList() {
    fillDatalist('pp-a-district-list', districtsMerged($('pp-a-country').value) || []);
  }

  function refreshPersonCityList() {
    fillDatalist('pp-a-city-list', mergedCities($('pp-a-country').value, $('pp-a-district').value) || []);
  }

  function resetPersonAddressFields() {
    ['pp-a-maps', 'pp-a-district', 'pp-a-city', 'pp-a-street', 'pp-a-building', 'pp-a-floor', 'pp-a-notes']
      .forEach(id => { $(id).value = ''; });
    refreshCountrySelect('', PERSON_GEO);
    refreshPersonDistrictList();
    refreshPersonCityList();
  }
  const HQ_GEO = { country: 'pp-hq-country', district: 'pp-hq-district', city: 'pp-hq-city', error: 'pp-error' };
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const pp = {
    quill: null,
    files: [],
    tags: [],
    photo: null,
    logo: null,
    company: null,          // existing company contact picked from search
    extras: [],             // additional contacts, each with its own card + state
    userLoaded: false,
    saving: false,
    created: { companyId: null, personId: null, logSaved: false },
    ac: null,               // { input, items, active, onPick }
  };

  function personModalOpen() {
    return !$('person-modal').hidden;
  }

  function optionsHtml(values, selected, { blank = null, addLabel = null, labels = null } = {}) {
    return (blank !== null ? `<option value="">${escapeHtml(blank)}</option>` : '')
      + values.map(value => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(labels ? labels[value] || value : value)}</option>`).join('')
      + (addLabel ? `<option value="${ADD_NEW}">${escapeHtml(addLabel)}</option>` : '');
  }

  function withCustom(base, key, extra = []) {
    const seen = new Set();
    return [...base, ...storedChoices(key), ...extra].filter(value => {
      const clean = String(value || '').trim();
      const lowered = clean.toLowerCase();
      if (!clean || seen.has(lowered)) return false;
      seen.add(lowered);
      return true;
    });
  }

  // A select whose last option prompts for a new value (kept per browser).
  function fillPicklist(id, base, key, { blank = '', addLabel = '+ Add New', extra = [], selected = '' } = {}) {
    $(id).innerHTML = optionsHtml(withCustom(base, key, extra), selected, { blank, addLabel: key ? addLabel : null });
    $(id).dataset.storageKey = key || '';
  }

  function handlePicklistAdd(select, base, maxLength = 64) {
    if (select.value !== ADD_NEW) return;
    const key = select.dataset.storageKey;
    const value = (window.prompt(`New value (max ${maxLength} characters):`) || '').trim();
    if (!value || value.length > maxLength) {
      if (value) $('pp-error').textContent = `Value must be ${maxLength} characters or fewer.`;
      select.value = '';
      return;
    }
    saveCustomChoice(key, value);
    const blank = select.querySelector('option[value=""]') ? select.querySelector('option[value=""]').textContent : null;
    select.innerHTML = optionsHtml(withCustom(base, key), value, { blank, addLabel: '+ Add New' });
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function nameInitials(...parts) {
    const words = parts.join(' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
  }

  function htmlToText(html) {
    return new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent || '';
  }

  // ── current user ("by XX") ──
  async function loadCurrentUser() {
    if (pp.userLoaded) return;
    try {
      const me = await request('/api/v1/users/me/');
      const name = me.full_name || me.email || '';
      $('pp-user').textContent = nameInitials(name) || '—';
      $('pp-user').title = name;
      pp.userLoaded = true;
    } catch (_error) {
      $('pp-user').textContent = '—';
    }
  }

  // ── notes editor (the project's vendored Quill, like the Log page) ──
  function ensureNotesEditor() {
    if (pp.quill || $('pp-notes-fallback')) return;
    const placeholder = 'Write everything here — notes while on the call, WhatsApp text, dimensions... drop photos, sketches, PDFs, voice notes.';
    if (window.Quill) {
      pp.quill = new window.Quill('#pp-notes', { theme: 'snow', placeholder, modules: { toolbar: '#pp-format' } });
    } else {
      $('pp-notes').innerHTML = `<textarea id="pp-notes-fallback" rows="5" placeholder="${escapeHtml(placeholder)}"></textarea>`;
      $('pp-format').hidden = true;
    }
  }

  function notesHtml() {
    if (pp.quill) {
      const html = pp.quill.root.innerHTML;
      return pp.quill.getText().trim() ? html : '';
    }
    const text = ($('pp-notes-fallback') && $('pp-notes-fallback').value.trim()) || '';
    return text ? text.split(/\n/).map(line => `<p>${escapeHtml(line) || '<br>'}</p>`).join('') : '';
  }

  // ── attachments (uploaded to the log after it is created) ──
  function fmtSize(bytes) {
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
  }

  function renderFiles() {
    $('pp-files').hidden = !pp.files.length;
    $('pp-files').innerHTML = pp.files.map((file, index) => `<span class="pp-file" title="${escapeHtml(file.name)}">
        <span>${escapeHtml(file.name)}</span><small>${fmtSize(file.size)}</small>
        <button type="button" class="pp-rx" data-remove-file="${index}" aria-label="Remove ${escapeHtml(file.name)}">&times;</button>
      </span>`).join('');
  }

  function addFiles(list) {
    for (const file of list || []) pp.files.push(file);
    renderFiles();
  }

  // ── tags (one comma-joined string on the log, max 255) ──
  function tagVocabulary() {
    const inUse = state.logs.flatMap(log => String(log.tags || '').split(','));
    return withCustom(LOG_TAG_SEED, LOG_TAG_KEY, inUse);
  }

  function renderTags() {
    $('pp-tags').innerHTML = pp.tags.map((tag, index) => `<span class="pp-tag">${escapeHtml(tag)}<button type="button" data-remove-tag="${index}" aria-label="Remove tag ${escapeHtml(tag)}">&times;</button></span>`).join('');
    const available = tagVocabulary().filter(tag => !pp.tags.some(chosen => chosen.toLowerCase() === tag.toLowerCase()));
    $('pp-tag-add').innerHTML = optionsHtml(available, '', { blank: '+ tag', addLabel: '+ Add tag' });
  }

  function addTag(value) {
    const tag = String(value || '').replace(/,/g, ' ').trim();
    if (!tag || pp.tags.some(chosen => chosen.toLowerCase() === tag.toLowerCase())) return;
    if ([...pp.tags, tag].join(',').length > 255) {
      $('pp-error').textContent = 'Tags are limited to 255 characters in total.';
      return;
    }
    pp.tags.push(tag);
    renderTags();
  }

  // ── photo / logo: downscaled in the browser, stored on the contact ──
  function readImage(file, maxSide = 256) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        reject(new Error('Choose a PNG, JPEG or WebP image.'));
        return;
      }
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read.')); };
      image.src = url;
    });
  }

  function renderPicture(kind) {
    const isLogo = kind === 'logo';
    const data = isLogo ? pp.logo : pp.photo;
    const view = $(isLogo ? 'pp-logo-view' : 'pp-photo-view');
    const initialsText = isLogo
      ? nameInitials($('pp-co-name').value)
      : nameInitials($('pp-first').value, $('pp-last').value);
    view.innerHTML = data
      ? `<img src="${escapeHtml(data)}" alt="">`
      : `<span id="${isLogo ? 'pp-co-initials' : 'pp-initials'}">${escapeHtml(initialsText)}</span>`;
    $(isLogo ? 'pp-logo-remove' : 'pp-photo-remove').hidden = !data || (isLogo && !!pp.company);
    $(isLogo ? 'pp-logo-add' : 'pp-photo-add').hidden = isLogo && !!pp.company;
  }

  // ── phone rows (reuse the page's country-code picker) ──
  function ppPhoneRow(label = 'Mobile', number = '') {
    const parts = phoneParts(number);
    return `<div class="pp-row pp-phone${label === 'WhatsApp' ? ' pp-wa' : ''}" data-pp-phone>
        <select class="pp-in" data-phone-label aria-label="Number type">${optionsHtml(PP_PHONE_LABELS, label)}</select>
        <span class="tel-wrap">
          ${countryButtonMarkup(parts)}
          <input class="pp-in" type="tel" data-phone-number maxlength="50" inputmode="tel" autocomplete="off" aria-label="${escapeHtml(label)} number" value="${escapeHtml(parts.national)}">
        </span>
        <button type="button" class="pp-rx" data-remove-row aria-label="Remove number">&times;</button>
      </div>`;
  }

  function readPpPhones(list) {
    return [...(typeof list === 'string' ? $(list) : list).querySelectorAll('[data-pp-phone]')].map(row => ({
      label: row.querySelector('[data-phone-label]').value || 'Mobile',
      number: fullPhoneNumber(row),
      iso: row.querySelector('[data-country-picker]').dataset.iso,
    })).filter(phone => phone.number);
  }

  // ── email / website / social rows ──
  function ppOnlineRow(kind) {
    if (kind === 'social') {
      return `<div class="pp-row pp-row-social" data-pp-online="social">
          <span class="pp-olabel">Social</span>
          <select class="pp-in" data-social-platform aria-label="Social platform">${optionsHtml(SOCIAL_PLATFORMS, 'IG')}</select>
          <input class="pp-in" type="text" data-online-value maxlength="128" placeholder="@handle" aria-label="Social handle">
          <button type="button" class="pp-rx" data-remove-row aria-label="Remove social handle">&times;</button>
        </div>`;
    }
    const isEmail = kind === 'email';
    return `<div class="pp-row" data-pp-online="${kind}">
        <span class="pp-olabel">${isEmail ? 'Email' : 'Website'}</span>
        <input class="pp-in" type="${isEmail ? 'email' : 'url'}" data-online-value maxlength="${isEmail ? 255 : 500}" placeholder="${isEmail ? 'name@company.com' : 'https://'}" aria-label="${isEmail ? 'Email' : 'Website'}">
        <button type="button" class="pp-rx" data-remove-row aria-label="Remove ${isEmail ? 'email' : 'website'}">&times;</button>
      </div>`;
  }

  function readPpOnline(list) {
    const rows = [...(typeof list === 'string' ? $(list) : list).querySelectorAll('[data-pp-online]')];
    const values = kind => rows.filter(row => row.dataset.ppOnline === kind)
      .map(row => ({ row, value: row.querySelector('[data-online-value]').value.trim() }))
      .filter(item => item.value);
    return {
      emails: values('email'),
      websites: values('website'),
      socials: values('social').map(item => ({
        row: item.row,
        platform: item.row.querySelector('[data-social-platform]').value,
        handle: item.value,
      })),
    };
  }

  function resetPhoneAndOnline(prefix, phoneLabels) {
    $(`${prefix}phones`).innerHTML = phoneLabels.map(label => ppPhoneRow(label)).join('');
    $(`${prefix}online`).innerHTML = ['email', 'website', 'social'].map(ppOnlineRow).join('');
  }

  // ── search dropdowns: duplicate people and companies, from the loaded directory ──
  function closeAc() {
    if (pp.ac && pp.ac.el) pp.ac.el.remove();
    pp.ac = null;
  }

  function renderAc() {
    const ac = pp.ac;
    if (!ac) return;
    const itemsHtml = ac.items.map((item, index) => `<button type="button" class="pp-ac-item${index === ac.active ? ' on' : ''}" data-ac-index="${index}">
        <span class="who${item.recordType === 'company' ? ' co' : ''}">${escapeHtml(initials(item))}</span>
        <span class="pp-ac-name">${escapeHtml(item.displayName)}<span class="pp-ac-sub">${escapeHtml(ac.subline(item))}</span></span>
        <span class="pp-ac-count">${escapeHtml(ac.count(item))}</span>
      </button>`).join('');
    const newIndex = ac.items.length;
    ac.el.innerHTML = (ac.head ? `<div class="pp-ac-head">${escapeHtml(ac.head)}</div>` : '')
      + itemsHtml
      + `<button type="button" class="pp-ac-new${ac.active === newIndex ? ' on' : ''}" data-ac-index="new">${escapeHtml(ac.newLabel)}</button>`;
  }

  function openAc(input, config) {
    closeAc();
    const el = document.createElement('div');
    el.className = 'pp-ac';
    el.setAttribute('role', 'listbox');
    input.closest('.pp-ac-wrap').appendChild(el);
    pp.ac = { input, el, active: -1, ...config };
    renderAc();
    // mousedown keeps focus in the input, so blur doesn't close before click lands.
    el.addEventListener('mousedown', event => event.preventDefault());
    el.addEventListener('click', event => {
      const button = event.target.closest('[data-ac-index]');
      if (!button || !pp.ac) return;
      const index = button.dataset.acIndex;
      const current = pp.ac;
      closeAc();
      if (index === 'new') current.onNew();
      else current.onPick(current.items[Number(index)]);
    });
  }

  function acKeydown(event) {
    const ac = pp.ac;
    if (!ac || event.target !== ac.input) return false;
    const last = ac.items.length;   // the "+ new" row
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      ac.active = event.key === 'ArrowDown' ? (ac.active >= last ? 0 : ac.active + 1) : (ac.active <= 0 ? last : ac.active - 1);
      renderAc();
      return true;
    }
    if (event.key === 'Enter' && ac.active >= 0) {
      event.preventDefault();
      const current = ac;
      closeAc();
      if (current.active === last) current.onNew();
      else current.onPick(current.items[current.active]);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAc();
      return true;
    }
    return false;
  }

  function companyPeopleCount(company) {
    const name = String(company.company_name || '').trim().toLowerCase();
    return state.contacts.filter(contact => contact.recordType === 'person'
      && (contact.companyContactId === company.id || (name && String(contact.company_name || '').trim().toLowerCase() === name))).length;
  }

  function showDuplicateMatches(input) {
    const scope = input.closest('.ppx');
    const firstEl = scope ? scope.querySelector('[data-x-first]') : $('pp-first');
    const lastEl = scope ? scope.querySelector('[data-x-last]') : $('pp-last');
    const first = firstEl.value.trim().toLowerCase();
    const last = lastEl.value.trim().toLowerCase();
    const typed = `${first} ${last}`.trim();
    if (typed.length < 2) { closeAc(); return; }
    const items = state.contacts.filter(contact => {
      if (contact.recordType !== 'person') return false;
      const haystack = [contact.first_name, contact.last_name, contact.displayName].filter(Boolean).join(' ').toLowerCase();
      return (!first || haystack.includes(first)) && (!last || haystack.includes(last));
    }).slice(0, 8);
    if (!items.length) { closeAc(); return; }
    openAc(input, {
      items,
      head: 'Already in Contacts? Open the existing record instead of creating a duplicate.',
      newLabel: '+ New contact — keep typing',
      subline: contact => [contactRole(contact), contactCompany(contact)].filter(Boolean).join(' · ') || contact.primaryPhone || '—',
      count: contact => {
        const logs = logsForContact(contact.id).length;
        return logs ? `${logs} log${logs === 1 ? '' : 's'}` : '';
      },
      onPick: contact => openExistingFromPersonModal(contact),
      onNew: () => input.focus(),
    });
  }

  function openExistingFromPersonModal(contact) {
    const typedSomething = $('pp-subject').value.trim() || htmlToText(notesHtml()).trim() || pp.files.length;
    if (typedSomething && !window.confirm(`Open ${contact.displayName}? The notes typed in this form will be discarded.`)) return;
    closePersonModal();
    if (!visibleContacts().some(item => item.id === contact.id)) {
      setRecordType('all');
      state.search = '';
      $('contact-search').value = '';
      renderTable();
    }
    openDrawer(contact.id);
  }

  function showCompanyMatches(input) {
    const query = input.value.trim().toLowerCase();
    if (!query) { closeAc(); return; }
    const items = state.contacts
      .filter(contact => contact.recordType === 'company'
        && [contact.company_name, contact.legal_name, contact.displayName].filter(Boolean).join(' ').toLowerCase().includes(query))
      .slice(0, 8);
    openAc(input, {
      items,
      newLabel: `+ Add "${input.value.trim()}" as new company`,
      subline: company => [company.companyType, company.city].filter(Boolean).join(' · ') || '—',
      count: company => {
        const people = companyPeopleCount(company);
        return people ? `${people} contact${people === 1 ? '' : 's'}` : '';
      },
      onPick: company => selectExistingCompany(company),
      onNew: () => startNewCompany(input.value.trim()),
    });
  }

  // ── company section ──
  function setCompanyFieldsDisabled(disabled) {
    document.querySelectorAll('#pp-company input, #pp-company select, #pp-company button').forEach(control => {
      control.disabled = disabled;
    });
    ['pp-co-phone-add', 'pp-co-online-add'].forEach(id => { $(id).hidden = disabled; });
  }

  function clearCompanyFields() {
    ['pp-co-name', 'pp-co-vat', 'pp-co-hq', 'pp-hq-maps', 'pp-hq-street', 'pp-hq-building'].forEach(id => { $(id).value = ''; });
    fillPicklist('pp-co-type', COMPANY_TYPES, COMPANY_TYPE_KEY);
    fillPicklist('pp-co-industry', INDUSTRIES, INDUSTRY_KEY);
    fillPicklist('pp-co-activity', ACTIVITIES, ACTIVITY_KEY);
    $('pp-co-size').innerHTML = optionsHtml(COMPANY_SIZES, '', { blank: '' });
    refreshCountrySelect('', HQ_GEO);
    refreshDistrictSelect('', HQ_GEO);
    refreshCitySelect('', HQ_GEO);
    $('pp-hq-detail').hidden = true;
    resetPhoneAndOnline('pp-co-', ['Telephone', 'Mobile', 'WhatsApp']);
    pp.logo = null;
    $('pp-co-name-error').textContent = '';
  }

  function setFromCompany(on) {
    $('pp-from-company').checked = on;
    $('pp-company').hidden = !on;
    updateCompanyTitle();
  }

  function updateCompanyTitle() {
    const name = pp.company ? pp.company.displayName : $('pp-co-name').value.trim();
    $('pp-company-title').textContent = name || 'new company';
    renderPicture('logo');
    syncExtraCompanies();
  }

  function selectExistingCompany(company) {
    pp.company = company;
    clearCompanyFields();
    $('pp-company-search').value = company.company_name || company.displayName;
    $('pp-co-name').value = company.company_name || company.displayName;
    fillPicklist('pp-co-type', COMPANY_TYPES, COMPANY_TYPE_KEY, { selected: company.companyType, extra: [company.companyType] });
    $('pp-co-vat').value = company.vat_number || '';
    $('pp-co-hq').value = company.location || '';
    fillPicklist('pp-co-industry', INDUSTRIES, INDUSTRY_KEY, { selected: company.industry, extra: [company.industry] });
    fillPicklist('pp-co-activity', ACTIVITIES, ACTIVITY_KEY, { selected: company.activity, extra: [company.activity] });
    $('pp-co-size').innerHTML = optionsHtml([...new Set([...COMPANY_SIZES, company.companySize].filter(Boolean))], company.companySize || '', { blank: '' });
    $('pp-co-phones').innerHTML = company.phones.map(phone => ppPhoneRow(phone.label, phone.number)).join('');
    $('pp-co-online').innerHTML = [
      ...company.emails.map(() => ppOnlineRow('email')),
      ...(company.website ? [ppOnlineRow('website')] : []),
      ...company.socials.map(() => ppOnlineRow('social')),
    ].join('');
    const onlineRows = [...$('pp-co-online').querySelectorAll('[data-pp-online]')];
    let cursor = 0;
    company.emails.forEach(email => { onlineRows[cursor++].querySelector('[data-online-value]').value = email.address; });
    if (company.website) onlineRows[cursor++].querySelector('[data-online-value]').value = company.website;
    company.socials.forEach(social => {
      const row = onlineRows[cursor++];
      row.querySelector('[data-social-platform]').innerHTML = optionsHtml([...new Set([...SOCIAL_PLATFORMS, social.platform])], social.platform);
      row.querySelector('[data-online-value]').value = social.handle;
    });
    pp.logo = company.photo || null;
    $('pp-company-note').hidden = false;
    setCompanyFieldsDisabled(true);
    setFromCompany(true);
  }

  function startNewCompany(name) {
    pp.company = null;
    clearCompanyFields();
    $('pp-co-name').value = name;
    $('pp-company-search').value = name;
    $('pp-company-note').hidden = true;
    setCompanyFieldsDisabled(false);
    setFromCompany(true);
    renderPicture('logo');
  }

  // ── additional contacts: one card per extra person, independent state ──
  let extraSeq = 0;

  function extraCardMarkup(key) {
    const geoIds = { country: `ppx-${key}-country`, district: `ppx-${key}-district`, city: `ppx-${key}-city` };
    return `<div class="ppx" data-extra-card data-key="${key}">
        <div class="ppx-t"><span data-x-number>Contact</span>
          <button type="button" class="ppx-rm" data-x-remove>&times; Remove</button>
        </div>
        <div class="pp-idrow">
          <div class="pp-pic">
            <div class="pp-pic-t">Photo</div>
            <div class="pp-pic-box" data-x-photo><span></span></div>
            <button type="button" class="pp-addlink" data-x-photo-add>+ Add photo</button>
            <button type="button" class="pp-addlink pp-remove" data-x-photo-remove hidden>Remove</button>
            <input type="file" accept="image/png,image/jpeg,image/webp" data-x-photo-input hidden>
            <button type="button" class="pf-btn" data-x-find-btn>🔍 Find online</button>
          </div>
          <div class="pp-grid">
            <label class="pp-f"><span>Pre</span><select class="pp-in" data-x-prefix></select></label>
            <div class="pp-f pp-ac-wrap">
              <label>First <i>*</i></label>
              <input class="pp-in" type="text" maxlength="255" autocomplete="off" data-x-first>
              <span class="pp-err" data-x-first-error></span>
            </div>
            <label class="pp-f"><span>Middle</span><input class="pp-in" type="text" maxlength="255" autocomplete="off" data-x-middle></label>
            <div class="pp-f pp-ac-wrap">
              <label>Last</label>
              <input class="pp-in" type="text" maxlength="255" autocomplete="off" data-x-last>
            </div>
            <label class="pp-f"><span>Father's name</span><input class="pp-in" type="text" maxlength="128" autocomplete="off" data-x-father></label>
            <label class="pp-f"><span>Mother's name</span><input class="pp-in" type="text" maxlength="128" autocomplete="off" data-x-mother></label>
            <label class="pp-f"><span>Role</span><select class="pp-in" data-x-role></select></label>
            <label class="pp-f"><span>Company</span><input class="pp-in" type="text" data-x-company readonly title="Additional contacts are saved under the company chosen for the main contact."></label>
            <label class="pp-f"><span>Found us via</span><select class="pp-in" data-x-source></select></label>
            <label class="pp-f pp-f-wide" data-x-referred-wrap hidden><span>Referred by</span><input class="pp-in" type="text" maxlength="255" data-x-referred placeholder="Who gave them our number? name / company"></label>
          </div>
        </div>

        <div class="pf" data-x-find hidden></div>

        <div class="pp-two">
          <div class="pp-panel">
            <div class="pp-panel-t">Phone numbers</div>
            <div class="pp-rows" data-x-phones></div>
            <button type="button" class="pp-addlink" data-x-phone-add>+ Add Number</button>
          </div>
          <div class="pp-panel">
            <div class="pp-panel-t">Email &amp; online</div>
            <div class="pp-rows" data-x-online></div>
            <select class="pp-addsel" data-x-online-add aria-label="Add email, website or social">
              <option value="">+ Add...</option>
              <option value="email">Email</option>
              <option value="website">Website</option>
              <option value="social">Social handle</option>
            </select>
          </div>
        </div>

        <button type="button" class="pp-addbtn" data-x-address-open>+ Add Address</button>
        <div class="ppa" data-x-address hidden>
          <div class="ppa-head">
            <span class="ppa-t">Address — personal</span>
            <span class="ppa-hint">where the person lives — the site address stays on the log</span>
            <button type="button" class="ppa-x" data-x-address-close title="Remove address" aria-label="Remove address">&times;</button>
          </div>
          <div class="ppa-grid">
            <label class="ppa-f"><span>Maps link</span><input class="pp-in" type="url" maxlength="2048" data-x-maps placeholder="https://maps.app.goo.gl/…"></label>
            <label class="ppa-f"><span>Country</span><select class="pp-in" id="${geoIds.country}" data-x-country></select></label>
            <label class="ppa-f"><span>District</span><input class="pp-in" type="text" maxlength="128" id="${geoIds.district}" data-x-district list="ppx-${key}-dl-district" autocomplete="off" placeholder="Type or select district"></label>
            <label class="ppa-f"><span>City</span><input class="pp-in" type="text" maxlength="128" id="${geoIds.city}" data-x-city list="ppx-${key}-dl-city" autocomplete="off" placeholder="Type or select city"></label>
            <label class="ppa-f"><span>Street</span><input class="pp-in" type="text" maxlength="255" data-x-street placeholder="Street name"></label>
            <label class="ppa-f"><span>Building</span><input class="pp-in" type="text" maxlength="64" data-x-building placeholder="Building / villa"></label>
            <label class="ppa-f"><span>Floor</span><input class="pp-in" type="text" maxlength="32" data-x-floor placeholder="Floor / unit"></label>
            <label class="ppa-f"><span>Notes</span><input class="pp-in" type="text" maxlength="1000" data-x-notes placeholder="landmark, gate code..."></label>
          </div>
          <datalist id="ppx-${key}-dl-district"></datalist>
          <datalist id="ppx-${key}-dl-city"></datalist>
        </div>
      </div>`;
  }

  function renderExtraPhoto(entry) {
    const box = entry.card.querySelector('[data-x-photo]');
    const initialsText = nameInitials(entry.card.querySelector('[data-x-first]').value, entry.card.querySelector('[data-x-last]').value);
    box.innerHTML = entry.photo ? `<img src="${escapeHtml(entry.photo)}" alt="">` : `<span>${escapeHtml(initialsText)}</span>`;
    entry.card.querySelector('[data-x-photo-remove]').hidden = !entry.photo;
  }

  function renumberExtras() {
    pp.extras.forEach((entry, index) => { entry.card.querySelector('[data-x-number]').textContent = `Contact ${index + 2}`; });
    $('pp-extra').hidden = pp.extras.length === 0;
  }

  // The company always follows the main contact's choice.
  function syncExtraCompanies() {
    const name = pp.company ? (pp.company.company_name || pp.company.displayName) : $('pp-company-search').value.trim();
    pp.extras.forEach(entry => { entry.card.querySelector('[data-x-company]').value = name; });
  }

  function removeExtra(entry) {
    entry.card.remove();
    pp.extras = pp.extras.filter(item => item !== entry);
    renumberExtras();
  }

  function addExtraContact() {
    const key = `x${extraSeq += 1}`;
    $('pp-extra-list').insertAdjacentHTML('beforeend', extraCardMarkup(key));
    const card = $('pp-extra-list').lastElementChild;
    const entry = { key, card, photo: null, savedId: null };
    pp.extras.push(entry);
    const q = selector => card.querySelector(selector);

    q('[data-x-prefix]').innerHTML = identityOptions(PREFIXES, PREFIX_STORAGE_KEY, '', ADD_PREFIX, '+ Add New');
    q('[data-x-role]').innerHTML = identityOptions(CONTACT_TAGS, TAG_STORAGE_KEY, '', ADD_TAG, '+ Add New');
    q('[data-x-source]').innerHTML = optionsHtml(withCustom(SOURCES, SOURCE_KEY, state.contacts.map(contact => contact.source).filter(Boolean)), '', { blank: '', addLabel: '+ Add New' });
    q('[data-x-source]').dataset.storageKey = SOURCE_KEY;
    q('[data-x-phones]').innerHTML = ['Mobile', 'WhatsApp', 'Telephone'].map(label => ppPhoneRow(label)).join('');
    q('[data-x-online]').innerHTML = ['email', 'website', 'social'].map(ppOnlineRow).join('');
    refreshCountrySelect('', { country: `ppx-${key}-country` });
    renderExtraPhoto(entry);
    renumberExtras();
    syncExtraCompanies();

    q('[data-x-find-btn]').addEventListener('click', () => findOnline(personScope(card)));
    q('[data-x-remove]').addEventListener('click', () => removeExtra(entry));
    ['[data-x-first]', '[data-x-last]'].forEach(selector => {
      q(selector).addEventListener('input', event => {
        renderExtraPhoto(entry);
        if (selector === '[data-x-first]' && event.target.value.trim()) {
          q('[data-x-first-error]').textContent = '';
          event.target.classList.remove('pp-invalid');
        }
        showDuplicateMatches(event.target);
      });
      q(selector).addEventListener('blur', () => window.setTimeout(() => { if (pp.ac && pp.ac.input === q(selector)) closeAc(); }, 120));
    });
    q('[data-x-prefix]').addEventListener('change', event => {
      if (event.target.value !== ADD_PREFIX) return;
      const value = (window.prompt('New prefix (max 16 characters):') || '').trim();
      if (value && value.length <= 16) saveCustomChoice(PREFIX_STORAGE_KEY, value);
      event.target.innerHTML = identityOptions(PREFIXES, PREFIX_STORAGE_KEY, value.length <= 16 ? value : '', ADD_PREFIX, '+ Add New');
    });
    q('[data-x-role]').addEventListener('change', event => {
      if (event.target.value !== ADD_TAG) return;
      const value = (window.prompt('New role (max 64 characters):') || '').trim();
      if (value && value.length <= 64) saveCustomChoice(TAG_STORAGE_KEY, value);
      event.target.innerHTML = identityOptions(CONTACT_TAGS, TAG_STORAGE_KEY, value.length <= 64 ? value : '', ADD_TAG, '+ Add New');
    });
    q('[data-x-source]').addEventListener('change', event => {
      handlePicklistAdd(event.target, SOURCES, 80);
      q('[data-x-referred-wrap]').hidden = event.target.value !== REFERRAL_SOURCE;
    });
    q('[data-x-photo-add]').addEventListener('click', () => q('[data-x-photo-input]').click());
    q('[data-x-photo-input]').addEventListener('change', async event => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        entry.photo = await readImage(file);
        renderExtraPhoto(entry);
      } catch (error) {
        $('pp-error').textContent = error.message;
      }
    });
    q('[data-x-photo-remove]').addEventListener('click', () => { entry.photo = null; renderExtraPhoto(entry); });
    q('[data-x-phone-add]').addEventListener('click', () => {
      const list = q('[data-x-phones]');
      if (list.children.length >= 8) return;
      list.insertAdjacentHTML('beforeend', ppPhoneRow('Mobile'));
      list.lastElementChild.querySelector('[data-phone-number]').focus();
    });
    q('[data-x-online-add]').addEventListener('change', event => {
      const kind = event.target.value;
      event.target.value = '';
      if (!kind) return;
      const list = q('[data-x-online]');
      list.insertAdjacentHTML('beforeend', ppOnlineRow(kind));
      list.lastElementChild.querySelector('[data-online-value]').focus();
    });
    q('[data-x-address-open]').addEventListener('click', () => {
      q('[data-x-address]').hidden = false;
      q('[data-x-address-open]').hidden = true;
      q('[data-x-maps]').focus();
    });
    q('[data-x-address-close]').addEventListener('click', () => {
      ['[data-x-maps]', '[data-x-district]', '[data-x-city]', '[data-x-street]', '[data-x-building]', '[data-x-floor]', '[data-x-notes]']
        .forEach(selector => { q(selector).value = ''; });
      refreshCountrySelect('', { country: `ppx-${key}-country` });
      q('[data-x-address]').hidden = true;
      q('[data-x-address-open]').hidden = false;
    });
    const refreshCardDistricts = () => fillDatalist(`ppx-${key}-dl-district`, districtsMerged(q('[data-x-country]').value) || []);
    const refreshCardCities = () => fillDatalist(`ppx-${key}-dl-city`, mergedCities(q('[data-x-country]').value, q('[data-x-district]').value) || []);
    q('[data-x-country]').addEventListener('change', () => {
      q('[data-x-district]').value = '';
      q('[data-x-city]').value = '';
      refreshCardDistricts();
      refreshCardCities();
    });
    q('[data-x-district]').addEventListener('input', refreshCardCities);
    refreshCardDistricts();
    refreshCardCities();

    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    q('[data-x-first]').focus();
    return entry;
  }

  function collectExtraContact(entry, errors) {
    const q = selector => entry.card.querySelector(selector);
    q('[data-x-first-error]').textContent = '';
    const first = q('[data-x-first]').value.trim();
    if (!first) {
      q('[data-x-first-error]').textContent = markInvalid(q('[data-x-first]'), 'First name is required.');
      errors.push(q('[data-x-first]'));
    }
    const online = readPpOnline(q('[data-x-online]'));
    checkOnline(online, errors);
    const maps = q('[data-x-maps]').value.trim();
    if (maps && !normalizeMapsUrl(maps)) flagInvalid(q('[data-x-maps]'), errors);
    return { entry, first, phones: readPpPhones(q('[data-x-phones]')), online, addressOpen: !q('[data-x-address]').hidden };
  }

  function extraPayload(form, companyId, companyName, occurredIso) {
    const q = selector => form.entry.card.querySelector(selector);
    const open = form.addressOpen;
    const value = selector => (open ? q(selector).value.trim() : '');
    const country = value('[data-x-country]');
    const district = value('[data-x-district]');
    const city = value('[data-x-city]');
    const street = value('[data-x-street]');
    const building = value('[data-x-building]');
    const floor = value('[data-x-floor]');
    const source = q('[data-x-source]').value && q('[data-x-source]').value !== ADD_NEW ? q('[data-x-source]').value : null;
    const pick = selector => (q(selector).value && ![ADD_NEW, ADD_PREFIX, ADD_TAG].includes(q(selector).value) ? q(selector).value : null);
    return {
      record_type: 'person',
      category: 'prospect',
      prefix: pick('[data-x-prefix]'),
      first_name: form.first,
      middle_name: q('[data-x-middle]').value.trim() || null,
      last_name: q('[data-x-last]').value.trim() || null,
      father_name: q('[data-x-father]').value.trim() || null,
      mother_name: q('[data-x-mother]').value.trim() || null,
      role: pick('[data-x-role]'),
      company_name: companyName || null,
      company_contact_id: companyId || null,
      source,
      referred_by: source === REFERRAL_SOURCE ? (q('[data-x-referred]').value.trim() || null) : null,
      photo: form.entry.photo,
      location: composeAddress([street, building && `Bldg ${building}`, floor && `Floor ${floor}`, city, district, country]),
      country: country || null,
      district: district || null,
      city: city || null,
      street: street || null,
      site_building: building || null,
      site_floor: floor || null,
      maps_url: open ? normalizeMapsUrl(q('[data-x-maps]').value) || null : null,
      address_notes: open ? (q('[data-x-notes]').value.trim() || null) : null,
      contact_date: occurredIso,
      ...phonesPayload(form.phones),
      ...onlinePayload(form.online),
    };
  }

  // ── Find online ─────────────────────────────────────────────────────────
  // Looks a person up through the app's contact-lookup endpoint and offers the
  // result for review before anything is written into the form.
  //
  // This project has no web-search / enrichment / profile-lookup API, so the
  // feature stays inert: nothing is invented client-side. Point
  // window.ACHI_CONTACT_LOOKUP at a real endpoint (POST {first_name, last_name,
  // company, city, phone, email} -> the shape normaliseLookup() reads) and the
  // button starts working, for the main contact and every additional card.
  const lookupEndpoint = () => (typeof window.ACHI_CONTACT_LOOKUP === 'string' ? window.ACHI_CONTACT_LOOKUP.trim() : '');

  // One adapter for both the main person block and an additional-contact card,
  // so a card's search can never touch another person's fields.
  function personScope(card) {
    const pick = (id, selector) => (card ? card.querySelector(selector) : $(id));
    return {
      card,
      first: pick('pp-first', '[data-x-first]'),
      last: pick('pp-last', '[data-x-last]'),
      role: pick('pp-role', '[data-x-role]'),
      company: pick('pp-company-search', '[data-x-company]'),
      phones: pick('pp-phones', '[data-x-phones]'),
      online: pick('pp-online', '[data-x-online]'),
      find: pick('pp-find', '[data-x-find]'),
      button: pick('pp-find-btn', '[data-x-find-btn]'),
      getPhoto: () => (card ? pp.extras.find(entry => entry.card === card).photo : pp.photo),
      setPhoto: value => {
        if (!card) {
          pp.photo = value;
          renderPicture('photo');
          return;
        }
        const entry = pp.extras.find(item => item.card === card);
        entry.photo = value;
        renderExtraPhoto(entry);
      },
    };
  }

  function lookupQuery(scope) {
    const phone = readPpPhones(scope.phones)[0];
    const email = readPpOnline(scope.online).emails[0];
    return {
      first_name: scope.first.value.trim(),
      last_name: scope.last.value.trim(),
      company: scope.company.value.trim(),
      city: scope.card ? '' : ($('pp-address').hidden ? '' : $('pp-a-city').value.trim()),
      phone: phone ? phone.number : '',
      email: email ? email.value : '',
    };
  }

  // Everything the panel shows comes from here; missing pieces stay missing.
  function normaliseLookup(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const text = (value, max = 255) => String(value == null ? '' : value).trim().slice(0, max);
    const httpUrl = value => (/^https:\/\/|^http:\/\//i.test(String(value || '').trim()) ? String(value).trim() : '');
    const image = value => {
      const url = String(value || '').trim();
      return /^data:image\/(png|jpeg|webp);base64,/.test(url) || /^https:\/\//i.test(url) ? url : '';
    };
    const socials = (Array.isArray(data.socials) ? data.socials : [])
      .map(item => ({ platform: text(item && item.platform, 32), handle: text(item && item.handle, 128), url: httpUrl(item && item.url) }))
      .filter(item => item.platform && item.handle)
      .slice(0, 12);
    return {
      name: text(data.name || [data.first_name, data.last_name].filter(Boolean).join(' ')),
      role: text(data.role, 64),
      company: text(data.company),
      why: text(data.match_note || data.why, 140),
      photo: image(data.photo || data.profile_photo),
      companyLogo: image(data.company_logo),
      email: text(data.email, 255),
      website: httpUrl(data.website),
      socials,
    };
  }

  function lookupIsEmpty(found) {
    return !found.photo && !found.role && !found.company && !found.email && !found.website
      && !found.socials.length && !found.companyLogo;
  }

  function clearFind(scope) {
    scope.find.hidden = true;
    scope.find.innerHTML = '';
  }

  function findNote(scope, message, isError = false) {
    scope.find.hidden = false;
    scope.find.innerHTML = `<div class="pf-note${isError ? ' pf-bad' : ''}">${escapeHtml(message)}</div>`;
  }

  function findBusy(scope, query) {
    const who = [query.first_name, query.last_name].filter(Boolean).join(' ') || query.company;
    scope.find.hidden = false;
    scope.find.innerHTML = `<div class="pf-busy"><span class="pf-spin"></span>
        <span>Searching the web &amp; socials for “${escapeHtml(who)}”${query.phone ? ` ${escapeHtml(query.phone)}` : ''}…
          <small>LinkedIn · Instagram · company site</small></span>
      </div>`;
  }

  function renderFindResult(scope, found) {
    const chips = [
      ...found.socials.map(social => `${social.platform} ✓`),
      found.email ? '✉ email' : '',
      found.website ? '🌐 website' : '',
      found.photo ? '📷 profile photo' : '',
      found.companyLogo ? '🏷 company logo' : '',
    ].filter(Boolean);
    const heading = [found.name || [scope.first.value.trim(), scope.last.value.trim()].filter(Boolean).join(' '),
      [found.role, found.company].filter(Boolean).join(' @ ')].filter(Boolean).join(' — ');
    scope.find.hidden = false;
    scope.find.innerHTML = `<div class="pf-res">
        <div class="pf-res-h">🔍 Found online — review before applying
          <button type="button" class="pf-x" data-find-close title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="pf-body">
          <span class="pf-pic">${found.photo
    ? `<img src="${escapeHtml(found.photo)}" alt="">`
    : escapeHtml(nameInitials(scope.first.value, scope.last.value))}</span>
          <span>
            <span class="pf-name">${escapeHtml(heading || '—')}</span>
            ${found.why ? `<span class="pf-why">· ${escapeHtml(found.why)}</span>` : ''}
            ${chips.length ? `<span class="pf-chips">${chips.map(chip => `<span class="pf-chip">${escapeHtml(chip)}</span>`).join('')}</span>` : ''}
          </span>
          <span class="pf-acts">
            <button type="button" class="pf-apply" data-find-apply>✓ Apply all</button>
            <button type="button" class="pf-photo-only" data-find-photo${found.photo ? '' : ' disabled'}>Photo only</button>
          </span>
        </div>
      </div>`;
    const panel = scope.find.querySelector('.pf-res');
    panel.querySelector('[data-find-close]').addEventListener('click', () => clearFind(scope));
    panel.querySelector('[data-find-apply]').addEventListener('click', () => applyFound(scope, found, panel, false));
    const photoOnly = panel.querySelector('[data-find-photo]');
    if (found.photo) photoOnly.addEventListener('click', () => applyFound(scope, found, panel, true));
  }

  // Only empty fields are filled, so nothing the user typed is overwritten.
  function applyFound(scope, found, panel, photoOnly) {
    const applied = [];

    if (found.photo && !scope.getPhoto()) {
      scope.setPhoto(found.photo);
      applied.push('photo');
    }

    if (!photoOnly) {
      if (found.role && !scope.role.value) {
        if (![...scope.role.options].some(option => option.value === found.role)) {
          scope.role.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(found.role)}">${escapeHtml(found.role)}</option>`);
        }
        scope.role.value = found.role;
        applied.push('role');
      }
      // A card's company follows the main contact, and a linked company is never touched.
      if (found.company && !scope.card && !pp.company && !scope.company.value.trim()) {
        scope.company.value = found.company;
        scope.company.dispatchEvent(new Event('input', { bubbles: true }));
        applied.push('company');
      }
      if (found.email) {
        const row = [...scope.online.querySelectorAll('[data-pp-online="email"]')]
          .find(item => !item.querySelector('[data-online-value]').value.trim());
        if (row) {
          row.querySelector('[data-online-value]').value = found.email;
          applied.push('email');
        }
      }
      if (found.website) {
        const row = [...scope.online.querySelectorAll('[data-pp-online="website"]')]
          .find(item => !item.querySelector('[data-online-value]').value.trim());
        if (row) {
          row.querySelector('[data-online-value]').value = found.website;
          applied.push('website');
        }
      }
      const addedSocials = found.socials.filter(social => {
        const rows = [...scope.online.querySelectorAll('[data-pp-online="social"]')];
        if (rows.some(row => row.querySelector('[data-online-value]').value.trim() === social.handle)) return false;
        let row = rows.find(item => !item.querySelector('[data-online-value]').value.trim());
        if (!row) {
          scope.online.insertAdjacentHTML('beforeend', ppOnlineRow('social'));
          row = scope.online.lastElementChild;
        }
        const platform = row.querySelector('[data-social-platform]');
        if (![...platform.options].some(option => option.value === social.platform)) {
          platform.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(social.platform)}">${escapeHtml(social.platform)}</option>`);
        }
        platform.value = social.platform;
        row.querySelector('[data-online-value]').value = social.handle;
        return true;
      });
      if (addedSocials.length) applied.push('socials');

      // Only for a company being created here, and only when it has no logo yet.
      if (found.companyLogo && !scope.card && !pp.company && $('pp-from-company').checked && !pp.logo) {
        pp.logo = found.companyLogo;
        renderPicture('logo');
        applied.push('company logo');
      }
    }

    const old = panel.querySelector('.pf-done');
    if (old) old.remove();
    const summary = applied.length
      ? `✓ Applied — ${applied.join(', ')} filled; everything stays editable`
      : '✓ Nothing to apply — the fields already have values; everything stays editable';
    panel.insertAdjacentHTML('beforeend', `<div class="pf-done">${escapeHtml(summary)}</div>`);
  }

  async function findOnline(scope) {
    const query = lookupQuery(scope);
    if (!query.first_name && !query.last_name && !query.phone && !query.email && !query.company) {
      findNote(scope, 'Enter a name, phone or company first.');
      return;
    }
    const endpoint = lookupEndpoint();
    if (!endpoint) {
      findNote(scope, 'Online lookup is not connected to this app yet.');
      return;
    }

    scope.button.disabled = true;
    scope.button.textContent = 'Searching…';
    findBusy(scope, query);
    try {
      const found = normaliseLookup(await request(endpoint, { method: 'POST', body: query }));
      if (lookupIsEmpty(found)) findNote(scope, 'No useful online match found. Try adding a mobile number, email or company.');
      else renderFindResult(scope, found);
    } catch (error) {
      findNote(scope, `Could not find reliable online information. ${error.message}`, true);
    } finally {
      scope.button.disabled = false;
      scope.button.textContent = '🔍 Find online';
    }
  }

  // ── open / close / reset ──
  function resetPersonModal() {
    $('pp-form').reset();
    closeAc();
    pp.files = [];
    pp.tags = [];
    pp.extras = [];
    clearFind(personScope(null));
    $('pp-extra-list').innerHTML = '';
    $('pp-extra').hidden = true;
    pp.photo = null;
    pp.company = null;
    pp.created = { companyId: null, personId: null, logSaved: false };
    $('pp-error').textContent = '';
    $('pp-first-error').textContent = '';
    document.querySelectorAll('#person-modal .pp-invalid').forEach(el => el.classList.remove('pp-invalid'));

    // "Log" is the default record type and keeps the API's own default log_type.
    $('pp-log-type').innerHTML = optionsHtml(RECORD_TYPES.filter(type => type !== 'Log'), '', { blank: 'Log' });
    $('pp-channel').innerHTML = optionsHtml(LOG_CHANNELS, 'Inbound Call');
    $('pp-status').innerHTML = STATUS_OPTIONS
      .map(option => `<option value="${option.key}"${option.key === 'open' ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
    updateStatusDot();
    $('pp-occurred').value = toDatetimeLocalValue(null);
    $('pp-log-code').textContent = 'New Log';
    $('pp-stage').innerHTML = LOG_STAGES.map(([value, text]) => `<option value="${value}"${value === 'enquiry' ? ' selected' : ''}>${escapeHtml(text)}</option>`).join('');

    ensureNotesEditor();
    if (pp.quill) pp.quill.setContents([]);
    renderFiles();
    renderTags();

    $('pp-prefix').innerHTML = identityOptions(PREFIXES, PREFIX_STORAGE_KEY, '', ADD_PREFIX, '+ Add New');
    $('pp-role').innerHTML = identityOptions(CONTACT_TAGS, TAG_STORAGE_KEY, '', ADD_TAG, '+ Add New');
    const sourcesInUse = state.contacts.map(contact => contact.source).filter(Boolean);
    fillPicklist('pp-source', SOURCES, SOURCE_KEY, { extra: sourcesInUse });
    $('pp-referred-wrap').hidden = true;
    renderPicture('photo');

    resetPhoneAndOnline('pp-', ['Mobile', 'WhatsApp', 'Telephone', 'Fax']);

    $('pp-address').hidden = true;
    $('pp-address-open').hidden = false;
    resetPersonAddressFields();

    clearCompanyFields();
    $('pp-company-note').hidden = true;
    setCompanyFieldsDisabled(false);
    setFromCompany(false);
    setPersonSaving(false);
  }

  function selectedStatus() {
    return STATUS_OPTIONS.find(option => option.key === $('pp-status').value) || STATUS_OPTIONS[0];
  }

  function updateStatusDot() {
    $('pp-status-dot').style.background = selectedStatus().color;
  }

  function openPersonModal() {
    window.clearTimeout(closeTimer);
    $('person-modal').classList.remove('pp-closing');
    resetPersonModal();
    $('person-modal').hidden = false;
    document.body.style.overflow = 'hidden';
    $('person-modal').querySelector('.pp-body').scrollTop = 0;
    loadCurrentUser();
    window.setTimeout(() => $('pp-subject').focus(), 0);
  }

  let closeTimer = null;

  function closePersonModal() {
    closeAc();
    closeCountryCodeMenu();
    const modal = $('person-modal');
    document.body.style.overflow = '';
    window.clearTimeout(closeTimer);
    // Let the close animation run, unless the viewer asked for less motion.
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      modal.hidden = true;
      return;
    }
    modal.classList.add('pp-closing');
    closeTimer = window.setTimeout(() => {
      modal.classList.remove('pp-closing');
      modal.hidden = true;
    }, 130);
  }

  function setPersonSaving(saving) {
    pp.saving = saving;
    $('pp-save').disabled = saving;
    $('pp-cancel').disabled = saving;
    $('pp-save').textContent = saving ? 'Saving…' : 'Create Person';
  }

  // ── validation + payloads ──
  function markInvalid(input, message) {
    input.classList.add('pp-invalid');
    return message;
  }

  function flagInvalid(input, errors) {
    markInvalid(input);
    errors.push(input);
  }

  function checkOnline(online, errors) {
    for (const email of online.emails) {
      if (!EMAIL_PATTERN.test(email.value)) flagInvalid(email.row.querySelector('[data-online-value]'), errors);
    }
    for (const site of online.websites) {
      if (!safeHref(site.value)) flagInvalid(site.row.querySelector('[data-online-value]'), errors);
    }
  }

  function collectPersonForm() {
    document.querySelectorAll('#person-modal .pp-invalid').forEach(el => el.classList.remove('pp-invalid'));
    $('pp-first-error').textContent = '';
    $('pp-co-name-error').textContent = '';
    const errors = [];

    const first = $('pp-first').value.trim();
    if (!first) {
      $('pp-first-error').textContent = markInvalid($('pp-first'), 'First name is required.');
      errors.push($('pp-first'));
    }

    const phones = readPpPhones('pp-phones');
    const online = readPpOnline('pp-online');
    checkOnline(online, errors);

    const addressOpen = !$('pp-address').hidden;
    const personMaps = addressOpen ? $('pp-a-maps').value.trim() : '';
    if (personMaps && !normalizeMapsUrl(personMaps)) flagInvalid($('pp-a-maps'), errors);

    const fromCompany = $('pp-from-company').checked;
    let companyOnline = null;
    let companyPhones = [];
    if (fromCompany && !pp.company) {
      if (!$('pp-co-name').value.trim()) {
        $('pp-co-name-error').textContent = markInvalid($('pp-co-name'), 'Company name is required.');
        errors.push($('pp-co-name'));
      }
      companyPhones = readPpPhones('pp-co-phones');
      companyOnline = readPpOnline('pp-co-online');
      checkOnline(companyOnline, errors);
      const hqMaps = $('pp-hq-maps').value.trim();
      if (hqMaps && !normalizeMapsUrl(hqMaps)) flagInvalid($('pp-hq-maps'), errors);
    }

    const extras = pp.extras.map(entry => collectExtraContact(entry, errors));
    return { errors, first, phones, online, addressOpen, fromCompany, companyPhones, companyOnline, extras };
  }

  function onlinePayload(online) {
    const websites = online.websites.map(site => site.value);
    return {
      emails: online.emails.map((email, index) => ({ label: index ? 'Other' : 'Primary', address: email.value })).slice(0, 8),
      primary_email: online.emails[0] ? online.emails[0].value : null,
      website: websites[0] || null,
      // The contact stores one website; any further ones are kept as quick links.
      quick_links: websites.slice(1, 13).map(url => ({ label: 'Website', url })),
      socials: online.socials.map(social => ({ platform: social.platform, handle: social.handle })).slice(0, 12),
    };
  }

  function phonesPayload(phones) {
    return {
      phones: phones.map(phone => ({ label: phone.label, number: phone.number })).slice(0, 8),
      country_code: phones[0] ? String(phones[0].iso || '').toUpperCase().slice(0, 2) || null : null,
    };
  }

  function picklistValue(id) {
    const value = $(id).value;
    return value && value !== ADD_NEW && value !== ADD_PREFIX && value !== ADD_TAG ? value : null;
  }

  function composeAddress(parts) {
    return parts.filter(Boolean).join(', ') || null;
  }

  function companyPayload(form, occurredIso) {
    const hqOpen = !$('pp-hq-detail').hidden;
    const country = hqOpen ? geoValue('pp-hq-country') : '';
    const district = hqOpen ? geoValue('pp-hq-district') : '';
    const city = hqOpen ? geoValue('pp-hq-city') : '';
    const street = hqOpen ? $('pp-hq-street').value.trim() : '';
    const building = hqOpen ? $('pp-hq-building').value.trim() : '';
    const hq = $('pp-co-hq').value.trim();
    return {
      record_type: 'company',
      category: 'prospect',
      company_name: $('pp-co-name').value.trim(),
      company_type: picklistValue('pp-co-type'),
      vat_number: $('pp-co-vat').value.trim() || null,
      industry: picklistValue('pp-co-industry'),
      activity: picklistValue('pp-co-activity'),
      company_size: $('pp-co-size').value || null,
      photo: pp.logo,
      location: hq || composeAddress([street, building && `Bldg ${building}`, city, district, country]),
      country: country || null,
      district: district || null,
      city: city || null,
      street: street || null,
      site_building: building || null,
      maps_url: hqOpen ? normalizeMapsUrl($('pp-hq-maps').value) || null : null,
      contact_date: occurredIso,
      ...phonesPayload(form.companyPhones),
      ...onlinePayload(form.companyOnline),
    };
  }

  function personPayload(form, companyId, companyName, occurredIso) {
    const open = form.addressOpen;
    const country = open ? geoValue('pp-a-country') : '';
    const district = open ? geoValue('pp-a-district') : '';
    const city = open ? geoValue('pp-a-city') : '';
    const street = open ? $('pp-a-street').value.trim() : '';
    const building = open ? $('pp-a-building').value.trim() : '';
    const floor = open ? $('pp-a-floor').value.trim() : '';
    const source = picklistValue('pp-source');
    return {
      record_type: 'person',
      category: 'prospect',
      prefix: picklistValue('pp-prefix'),
      first_name: form.first,
      middle_name: $('pp-middle').value.trim() || null,
      last_name: $('pp-last').value.trim() || null,
      father_name: $('pp-father').value.trim() || null,
      mother_name: $('pp-mother').value.trim() || null,
      role: picklistValue('pp-role'),
      company_name: companyName || null,
      company_contact_id: companyId || null,
      source,
      referred_by: source === REFERRAL_SOURCE ? ($('pp-referred').value.trim() || null) : null,
      photo: pp.photo,
      location: composeAddress([street, building && `Bldg ${building}`, floor && `Floor ${floor}`, city, district, country]),
      country: country || null,
      district: district || null,
      city: city || null,
      street: street || null,
      site_building: building || null,
      site_floor: floor || null,
      maps_url: open ? normalizeMapsUrl($('pp-a-maps').value) || null : null,
      address_notes: open ? ($('pp-a-notes').value.trim() || null) : null,
      contact_date: occurredIso,
      ...phonesPayload(form.phones),
      ...onlinePayload(form.online),
    };
  }

  function hasLogContent() {
    return Boolean($('pp-subject').value.trim() || htmlToText(notesHtml()).trim()
      || pp.files.length || pp.tags.length || $('pp-followup').value);
  }

  async function uploadLogAttachment(logId, file, retried = false) {
    const body = new FormData();
    body.append('file', file, file.name);
    const response = await fetch(`/api/v1/achi/logs/${encodeURIComponent(logId)}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken || ''}` },
      body,
    });
    if (response.status === 401 && !retried && await refreshAccessToken()) return uploadLogAttachment(logId, file, true);
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `Could not upload ${file.name}`);
    }
  }

  async function savePerson(event) {
    event.preventDefault();
    if (pp.saving) return;
    $('pp-error').textContent = '';
    const form = collectPersonForm();
    if (form.errors.length) {
      $('pp-error').textContent = form.errors.length === 1 && form.errors[0] === $('pp-first')
        ? 'First name is required.'
        : 'Check the highlighted fields.';
      form.errors[0].focus();
      return;
    }

    setPersonSaving(true);
    const occurredIso = datetimeLocalToISO($('pp-occurred').value) || new Date().toISOString();
    let companyId = pp.company ? pp.company.id : pp.created.companyId;
    let companyName = pp.company ? (pp.company.company_name || pp.company.displayName) : '';
    try {
      // 1. company (a retry after a later failure reuses the one already created)
      if (form.fromCompany && !pp.company) {
        companyName = $('pp-co-name').value.trim();
        if (!companyId) {
          const company = await request('/api/v1/achi/contact-info/contacts', { method: 'POST', body: companyPayload(form, occurredIso) });
          companyId = company.id;
          pp.created.companyId = companyId;
        }
      } else if (!form.fromCompany) {
        companyId = null;
        companyName = $('pp-company-search').value.trim();
      }

      // 2. main person
      if (!pp.created.personId) {
        const person = await request('/api/v1/achi/contact-info/contacts', {
          method: 'POST',
          body: personPayload(form, companyId, companyName, occurredIso),
        });
        pp.created.personId = person.id;
      }

      // 3. additional contacts, under the same company. Each remembers its own
      // id, so a retry after a later failure never creates it twice.
      for (const extra of form.extras) {
        if (extra.entry.savedId) continue;
        const saved = await request('/api/v1/achi/contact-info/contacts', {
          method: 'POST',
          body: extraPayload(extra, companyId, companyName, occurredIso),
        });
        extra.entry.savedId = saved.id;
      }
    } catch (error) {
      $('pp-error').textContent = pp.created.personId
        ? `The main contact was saved, but an additional contact failed: ${error.message}`
        : (pp.created.companyId ? `Company saved, but the person could not be created: ${error.message}` : error.message);
      setPersonSaving(false);
      return;
    }

    // 3–4. first log + attachments. The person exists now, so a failure here is
    // reported without keeping the popup open (retrying would duplicate them).
    const personId = pp.created.personId;
    let logMessage = '';
    let logError = '';
    if (hasLogContent() && !pp.created.logSaved) {
      try {
        const subject = $('pp-subject').value.trim();
        const file = await request('/api/v1/achi/files/', {
          method: 'POST',
          body: {
            contact_id: personId,
            company_contact_id: companyId || null,
            subject,
            stage: $('pp-stage').value,
            status: selectedStatus().status,
          },
        });
        const subjectHtml = subject ? `<p class="achi-note-subject"><strong>${escapeHtml(subject)}</strong></p>` : '';
        const log = await request(`/api/v1/achi/files/${encodeURIComponent(file.id)}/logs/`, {
          method: 'POST',
          body: {
            log_type: $('pp-log-type').value || 'General',
            reference: picklistValue('pp-channel'),
            tags: pp.tags.join(','),
            occurred_at: occurredIso,
            description: subjectHtml + notesHtml(),
            follow_up_date: $('pp-followup').value || null,
          },
        });
        logMessage = file.log_code ? ` · LOG #${file.log_code}` : ` · ${file.file_number}`;
        for (const attachment of pp.files) await uploadLogAttachment(log.id, attachment);
        pp.created.logSaved = true;
      } catch (error) {
        logError = error.message;
      }
    }

    closePersonModal();
    if (state.recordType !== 'all' && state.recordType !== 'person') setRecordType('person');
    await loadData({ silent: true });
    if (!visibleContacts().some(contact => contact.id === personId)) {
      state.search = '';
      $('contact-search').value = '';
      renderTable();
    }
    openDrawer(personId);
    const saved = 1 + pp.extras.filter(entry => entry.savedId).length;
    const people = saved === 1 ? 'Person created' : `${saved} people created`;
    if (logError) showToast(`${people}, but the log was not fully saved: ${logError}`, true);
    else showToast(`${people}${logMessage}.`);
  }

  function bindPersonModal() {
    $('new-person-button').addEventListener('click', openPersonModal);
    $('pp-close').addEventListener('click', closePersonModal);
    $('pp-cancel').addEventListener('click', closePersonModal);
    $('pp-form').addEventListener('submit', savePerson);

    // Enter in a single-line field must not submit the whole form.
    $('pp-form').addEventListener('keydown', event => {
      if (acKeydown(event)) return;
      if (event.key === 'Enter' && event.target.matches('input:not([type="submit"])')) event.preventDefault();
    });

    $('pp-status').addEventListener('change', updateStatusDot);

    // attachments: + / paperclip / drop onto the capture card
    ['pp-attach-add', 'pp-attach'].forEach(id => $(id).addEventListener('click', () => $('pp-file-input').click()));
    $('pp-file-input').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
    $('pp-files').addEventListener('click', event => {
      const button = event.target.closest('[data-remove-file]');
      if (!button) return;
      pp.files.splice(Number(button.dataset.removeFile), 1);
      renderFiles();
    });
    const capture = $('pp-capture');
    // Capture phase: Quill would otherwise embed dropped images into the note.
    capture.addEventListener('dragover', event => {
      if (!event.dataTransfer || ![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault();
      capture.classList.add('pp-drop');
    }, true);
    capture.addEventListener('dragleave', event => {
      if (!capture.contains(event.relatedTarget)) capture.classList.remove('pp-drop');
    }, true);
    capture.addEventListener('drop', event => {
      capture.classList.remove('pp-drop');
      if (!event.dataTransfer || !event.dataTransfer.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      addFiles(event.dataTransfer.files);
    }, true);

    // tags
    $('pp-tag-add').addEventListener('change', event => {
      const value = event.target.value;
      if (value === ADD_NEW) {
        const tag = (window.prompt('New tag (max 64 characters):') || '').trim();
        if (tag && tag.length <= 64) {
          saveCustomChoice(LOG_TAG_KEY, tag);
          addTag(tag);
        }
      } else if (value) {
        addTag(value);
      }
      renderTags();
    });
    $('pp-tags').addEventListener('click', event => {
      const button = event.target.closest('[data-remove-tag]');
      if (!button) return;
      pp.tags.splice(Number(button.dataset.removeTag), 1);
      renderTags();
    });

    // person identity
    $('pp-prefix').addEventListener('change', event => {
      if (event.target.value !== ADD_PREFIX) return;
      const value = (window.prompt('New prefix (max 16 characters):') || '').trim();
      if (value && value.length <= 16) saveCustomChoice(PREFIX_STORAGE_KEY, value);
      event.target.innerHTML = identityOptions(PREFIXES, PREFIX_STORAGE_KEY, value.length <= 16 ? value : '', ADD_PREFIX, '+ Add New');
    });
    $('pp-role').addEventListener('change', event => {
      if (event.target.value !== ADD_TAG) return;
      const value = (window.prompt('New role (max 64 characters):') || '').trim();
      if (value && value.length <= 64) saveCustomChoice(TAG_STORAGE_KEY, value);
      event.target.innerHTML = identityOptions(CONTACT_TAGS, TAG_STORAGE_KEY, value.length <= 64 ? value : '', ADD_TAG, '+ Add New');
    });
    ['pp-first', 'pp-last'].forEach(id => {
      $(id).addEventListener('input', event => {
        renderPicture('photo');
        if (id === 'pp-first' && event.target.value.trim()) {
          $('pp-first-error').textContent = '';
          event.target.classList.remove('pp-invalid');
        }
        showDuplicateMatches(event.target);
      });
      $(id).addEventListener('blur', () => window.setTimeout(() => { if (pp.ac && pp.ac.input === $(id)) closeAc(); }, 120));
    });
    $('pp-source').addEventListener('change', event => {
      handlePicklistAdd(event.target, SOURCES, 80);
      $('pp-referred-wrap').hidden = event.target.value !== REFERRAL_SOURCE;
    });

    // photo / logo
    const bindPicture = (kind, addId, inputId, removeId) => {
      $(addId).addEventListener('click', () => $(inputId).click());
      $(inputId).addEventListener('change', async event => {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        try {
          pp[kind] = await readImage(file);
          renderPicture(kind);
        } catch (error) {
          $('pp-error').textContent = error.message;
        }
      });
      $(removeId).addEventListener('click', () => { pp[kind] = null; renderPicture(kind); });
    };
    bindPicture('photo', 'pp-photo-add', 'pp-photo-input', 'pp-photo-remove');
    bindPicture('logo', 'pp-logo-add', 'pp-logo-input', 'pp-logo-remove');

    // phones + online rows (person and company panels share handlers)
    $('pp-phone-add').addEventListener('click', () => {
      if ($('pp-phones').children.length >= 8) return;
      $('pp-phones').insertAdjacentHTML('beforeend', ppPhoneRow('Mobile'));
      $('pp-phones').lastElementChild.querySelector('[data-phone-number]').focus();
    });
    $('pp-co-phone-add').addEventListener('click', () => {
      if ($('pp-co-phones').children.length >= 8) return;
      $('pp-co-phones').insertAdjacentHTML('beforeend', ppPhoneRow('Mobile'));
      $('pp-co-phones').lastElementChild.querySelector('[data-phone-number]').focus();
    });
    [['pp-online-add', 'pp-online'], ['pp-co-online-add', 'pp-co-online']].forEach(([selectId, listId]) => {
      $(selectId).addEventListener('change', event => {
        const kind = event.target.value;
        event.target.value = '';
        if (!kind) return;
        $(listId).insertAdjacentHTML('beforeend', ppOnlineRow(kind));
        $(listId).lastElementChild.querySelector('[data-online-value]').focus();
      });
    });
    const modal = $('person-modal');
    modal.addEventListener('click', event => {
      const remove = event.target.closest('[data-remove-row]');
      if (remove) { remove.closest('.pp-row').remove(); return; }
      const picker = event.target.closest('[data-country-picker]');
      if (picker && !picker.disabled) openCountryCodeMenu(picker);
    });
    modal.addEventListener('change', event => {
      if (!event.target.matches('[data-phone-label]')) return;
      event.target.closest('.pp-row').classList.toggle('pp-wa', event.target.value === 'WhatsApp');
    });
    modal.addEventListener('paste', event => {
      if (event.target.matches('[data-phone-number]')) window.setTimeout(() => normalizePhoneInput(event.target), 0);
    });
    modal.addEventListener('focusout', event => {
      if (event.target.matches('[data-phone-number]')) normalizePhoneInput(event.target);
    });

    // personal address
    $('pp-address-open').addEventListener('click', () => {
      $('pp-address').hidden = false;
      $('pp-address-open').hidden = true;
      $('pp-a-maps').focus();
    });
    $('pp-address-close').addEventListener('click', () => {
      resetPersonAddressFields();
      $('pp-address').hidden = true;
      $('pp-address-open').hidden = false;
    });
    $('pp-a-country').addEventListener('change', () => {
      $('pp-a-district').value = '';
      $('pp-a-city').value = '';
      refreshPersonDistrictList();
      refreshPersonCityList();
    });
    $('pp-a-district').addEventListener('input', refreshPersonCityList);
    bindGeoCascade(HQ_GEO);

    // company
    $('pp-company-search').addEventListener('input', event => {
      const name = event.target.value.trim();
      if (pp.company && name !== (pp.company.company_name || pp.company.displayName)) {
        // Typing over a picked company unlinks it.
        pp.company = null;
        clearCompanyFields();
        $('pp-company-note').hidden = true;
        setCompanyFieldsDisabled(false);
      }
      if (!pp.company) $('pp-co-name').value = name;
      updateCompanyTitle();
      syncExtraCompanies();
      showCompanyMatches(event.target);
    });
    $('pp-company-search').addEventListener('focus', event => { if (event.target.value.trim() && !pp.company) showCompanyMatches(event.target); });
    $('pp-company-search').addEventListener('blur', () => window.setTimeout(() => { if (pp.ac && pp.ac.input === $('pp-company-search')) closeAc(); }, 120));
    $('pp-from-company').addEventListener('change', event => {
      setFromCompany(event.target.checked);
      if (event.target.checked && !pp.company) {
        $('pp-co-name').value = $('pp-company-search').value.trim();
        updateCompanyTitle();
        $('pp-co-name').focus();
      }
    });
    $('pp-co-name').addEventListener('input', event => {
      if (pp.company) return;
      $('pp-company-search').value = event.target.value;
      if (event.target.value.trim()) {
        $('pp-co-name-error').textContent = '';
        event.target.classList.remove('pp-invalid');
      }
      updateCompanyTitle();
    });
    $('pp-find-btn').addEventListener('click', () => findOnline(personScope(null)));
    $('pp-add-person').addEventListener('click', addExtraContact);
    $('pp-co-type').addEventListener('change', event => handlePicklistAdd(event.target, COMPANY_TYPES));
    $('pp-co-industry').addEventListener('change', event => handlePicklistAdd(event.target, INDUSTRIES));
    $('pp-co-activity').addEventListener('change', event => handlePicklistAdd(event.target, ACTIVITIES));
    $('pp-hq-toggle').addEventListener('click', () => {
      $('pp-hq-detail').hidden = !$('pp-hq-detail').hidden;
      $('pp-hq-toggle').textContent = $('pp-hq-detail').hidden ? '+ Detail' : '− Detail';
    });
  }

  function bindEvents() {
    setToggleGroup('[data-view-mode]', 'viewMode', state.viewMode);
    document.querySelectorAll('[data-view-mode]').forEach(button => {
      button.addEventListener('click', () => {
        state.viewMode = button.dataset.viewMode === 'grid' ? 'grid' : 'list';
        try {
          localStorage.setItem('achi_contact_view', state.viewMode);
        } catch (_error) {
          // The selected view still works when browser storage is unavailable.
        }
        setToggleGroup('[data-view-mode]', 'viewMode', state.viewMode);
        renderTable();
      });
    });

    document.querySelectorAll('[data-column-filter]').forEach(select => {
      select.addEventListener('change', () => {
        state.columnFilters[select.dataset.columnFilter] = select.value;
        renderColumnFilters();
        renderTable();
      });
    });

    document.querySelectorAll('[data-record-type]').forEach(button => {
      button.addEventListener('click', () => {
        setRecordType(button.dataset.recordType);
        renderTable();
      });
    });

    $('contact-search').addEventListener('input', event => {
      state.search = event.target.value;
      renderTable();
    });

    // Rows and cards open the detail panel; their own links (city map) don't.
    const openFromDirectory = event => {
      if (event.target.closest('a')) return;
      const target = event.target.closest('[data-contact-id], [data-open-contact]');
      if (target) openDrawer(target.dataset.contactId || target.dataset.openContact);
    };
    $('contacts-table-body').addEventListener('click', openFromDirectory);
    $('contacts-cards').addEventListener('click', openFromDirectory);

    bindPersonModal();
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer-expand').addEventListener('click', () => setPanelWide(!state.panelWide));
    $('drawer-edit').addEventListener('click', () => openContactModal(activeContact()));
    $('drawer-delete').addEventListener('click', () => deleteContact(activeContact()));
    $('drawer-add-log').addEventListener('click', event => {
      event.preventDefault();
      $('quick-log-form').hidden = false;
      $('quick-log-notes').focus();
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
      renumberRelatedContacts();
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
    $('maps-url').addEventListener('input', updateModalMapPreview);
    bindGeoCascade(CONTACT_GEO);
    $('contact-datetime').addEventListener('input', refreshContactWhenLabel);
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
      if (personModalOpen()) {
        if (countryCodeMenu && !countryCodeMenu.hidden) closeCountryCodeMenu();
        else if (pp.ac) closeAc();
        else if (!pp.saving) closePersonModal();
        return;
      }
      if (!$('contact-modal').hidden) closeContactModal();
      else if (state.panelWide) setPanelWide(false);
      else if (isDrawerOpen()) closeDrawer();
    });
  }

  bindEvents();
  loadGeoCustomLists();
  loadData();
  window.setInterval(refreshSharedContacts, CONTACT_REFRESH_MS);
  window.addEventListener('focus', refreshSharedContacts);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshSharedContacts();
  });
}());
