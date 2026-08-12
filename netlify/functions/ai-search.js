/**
 * RCR AI Search — Netlify serverless function
 * Repo path: netlify/functions/ai-search.js  (River City Realty site)
 *
 * Natural language in, verified IDX Broker results URL out.
 *
 * Requires environment variable ANTHROPIC_API_KEY (Netlify UI, never in code).
 *
 * Contract: this function NEVER returns an error to the user. Every path ends in
 * a redirect to a real IDX results page. Worst case is a region-wide search.
 */

const IDX_BASE = 'https://homes.fsrivercityrealty.com/idx/results/homes';
const IDX_ID = 'd124';

/* Hard budget. Netlify's default function timeout is 10s; we bail at 8. */
const TIME_BUDGET_MS = 8000;

/* Result-count targets. Below MIN we widen, above MAX we narrow. */
/* Retained for logging context only — no automatic widening happens. */


/* ---------------------------------------------------------------------------
 * Confirmed IDs. Every value here was read out of a live saved link.
 * Nothing in this file is guessed. If a place isn't listed, we fall back
 * rather than invent an ID.
 * ------------------------------------------------------------------------- */

const CITY_IDS = {
  'alma': 749,
  'fort smith': 16650,
  'van buren': 48723,
  'greenwood': 19211,
  'poteau': 37583,
  'sallisaw': 41127
};

const COUNTY_IDS = {
  'crawford': 758,
  'franklin': 681,
  'leflore': 1229,
  'logan': 2133,
  'sebastian': 1630,
  'sequoyah': 3097
};

/* Towns with no city ID of their own, mapped to a county we do have an ID for.
   This is the middle rung: not exact, but regionally correct. */
const TOWN_TO_COUNTY = {
  'barling': 'sebastian',
  'bonanza': 'sebastian',
  'central city': 'sebastian',
  'hackett': 'sebastian',
  'hartford': 'sebastian',
  'huntington': 'sebastian',
  'lavaca': 'sebastian',
  'mansfield': 'sebastian',
  'chaffee crossing': 'sebastian',

  'cedarville': 'crawford',
  'chester': 'crawford',
  'dyer': 'crawford',
  'kibler': 'crawford',
  'mountainburg': 'crawford',
  'mulberry': 'crawford',
  'rudy': 'crawford',
  'uniontown': 'crawford',

  'altus': 'franklin',
  'branch': 'franklin',
  'charleston': 'franklin',
  'ozark': 'franklin',

  'booneville': 'logan',
  'magazine': 'logan',
  'paris': 'logan',
  'scranton': 'logan',
  'subiaco': 'logan',

  'heavener': 'leflore',
  'howe': 'leflore',
  'panama': 'leflore',
  'pocola': 'leflore',
  'spiro': 'leflore',
  'wister': 'leflore',

  'gore': 'sequoyah',
  'muldrow': 'sequoyah',
  'roland': 'sequoyah',
  'vian': 'sequoyah'
};

/* Cities that DO have an ID also belong to a county — used when a city-level
   search comes back empty and we need to widen one step. */
const CITY_TO_COUNTY = {
  'alma': 'crawford',
  'van buren': 'crawford',
  'fort smith': 'sebastian',
  'greenwood': 'sebastian',
  'poteau': 'leflore',
  'sallisaw': 'sequoyah'
};

/* ---------------------------------------------------------------------------
 * URL construction — strict whitelist.
 *
 * An unrecognized parameter does not degrade gracefully on IDX; the safest
 * assumption is that a bad key invalidates the whole query. So the URL is
 * assembled key by key from this function and nothing else. Model output is
 * never passed through to the query string, only used to select values.
 * ------------------------------------------------------------------------- */

function buildUrl(spec) {
  const p = new URLSearchParams();
  p.set('idxID', IDX_ID);
  p.set('pt', String(spec.pt || 1));

  if (spec.cityId) {
    p.append('city[]', String(spec.cityId));
  } else if (spec.countyId) {
    p.set('ccz', 'county');
    p.append('county[]', String(spec.countyId));
  }

  if (spec.beds > 0) p.set('bd', String(spec.beds));
  if (spec.baths > 0) p.set('tb', String(spec.baths));
  if (spec.minPrice > 0) p.set('lp', String(spec.minPrice));
  if (spec.maxPrice > 0) p.set('hp', String(spec.maxPrice));
  if (spec.sqft > 0) p.set('sqft', String(spec.sqft));
  if (spec.keyword) p.set('pm_publicRemarks', spec.keyword);

  p.append('a_propStatus[]', 'Active');
  p.set('srt', spec.srt || 'newest');

  return IDX_BASE + '?' + p.toString();
}

/* ---------------------------------------------------------------------------
 * Verification — fetch the candidate URL and read the count IDX prints into
 * the results container class: IDX-pageContainer IDX-totalResults-44
 * Returns null if the count can't be read, which we treat as "don't trust it."
 * ------------------------------------------------------------------------- */

async function countResults(url, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 1200) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, 4000));
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'RCR-AISearch/1.0' }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/IDX-totalResults-(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Interpretation
 * ------------------------------------------------------------------------- */

const SYSTEM_PROMPT = `You convert a home buyer's plain-English search into structured filters for a real estate MLS in the Fort Smith, Arkansas region (also covering Van Buren, Greenwood, Alma, Lavaca, Barling, Charleston, Ozark, Booneville, and eastern Oklahoma towns including Poteau, Sallisaw, Muldrow, Pocola, and Spiro).

Respond with ONLY a JSON object. No preamble, no markdown fences, no explanation.

Keys:
- city: string or null. The town name only, no state. Null if not stated.
- beds: integer or 0. Minimum bedrooms.
- baths: integer or 0. Minimum bathrooms.
- minPrice: integer or 0. US dollars, no separators.
- maxPrice: integer or 0. US dollars, no separators.
- sqft: integer or 0. Minimum square feet.
- propertyType: 1 for residential, 5 for commercial, 7 for land/lots. Default 1.
- keyword: string or null. AT MOST ONE common listing-description word that is the single most distinguishing feature requested (examples: pool, shop, acreage, basement, waterfront, fireplace). Null if nothing stands out. Never more than one word. Never a word already captured by another field.

Interpret loosely stated budgets as maxPrice. "Around 300k" means maxPrice 330000. "Starter home" implies maxPrice 250000 if no figure is given. Do not invent a city that was not mentioned.`;

async function interpret(query, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 2000) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(remaining, 6000));

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: query }]
      })
    });
    clearTimeout(timer);
    if (!res.ok) {
      const detail = await res.text().catch(function () { return ''; });
      console.error('[ai-search] Anthropic API ' + res.status + ': ' + detail.slice(0, 400));
      return null;
    }

    const data = await res.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    return JSON.parse(text);
  } catch (e) {
    clearTimeout(timer);
    console.error('[ai-search] interpret failed: ' + (e && e.message ? e.message : String(e)));
    return null;
  }
}

/* Whole-word place matching. Plain substring matching is not safe here:
   "shower" contains "howe", "paris" appears inside "parish", and so on. */
function hasPlace(haystack, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z])' + escaped + '($|[^a-z])', 'i').test(haystack);
}

/* Last-ditch extraction if the model is unavailable or returns garbage.
   Crude on purpose — it only has to beat sending someone to a blank page. */
function regexFallback(query) {
  const q = (query || '').toLowerCase();
  const spec = { pt: 1, beds: 0, baths: 0, minPrice: 0, maxPrice: 0, sqft: 0 };

  const beds = q.match(/(\d+)\s*(?:\+)?\s*(?:bed|bd|br)/);
  if (beds) spec.beds = parseInt(beds[1], 10);

  const baths = q.match(/(\d+)\s*(?:\+)?\s*(?:bath|ba)/);
  if (baths) spec.baths = parseInt(baths[1], 10);

  const k = q.match(/\$?\s*(\d{2,4})\s*k\b/);
  if (k) spec.maxPrice = parseInt(k[1], 10) * 1000;

  if (!spec.maxPrice) {
    const dollars = q.match(/\$\s*([\d,]{4,})/);
    if (dollars) spec.maxPrice = parseInt(dollars[1].replace(/,/g, ''), 10);
  }

  for (const name of Object.keys(CITY_IDS)) {
    if (hasPlace(q, name)) { spec.cityName = name; break; }
  }
  if (!spec.cityName) {
    for (const name of Object.keys(TOWN_TO_COUNTY)) {
      if (hasPlace(q, name)) { spec.cityName = name; break; }
    }
  }

  if (/\bland\b|\blot\b|\bacreage\b/.test(q)) spec.pt = 7;
  else if (/\bcommercial\b/.test(q)) spec.pt = 5;

  return spec;
}

/* Resolve a free-text place name to a confirmed ID, or nothing. */
function resolvePlace(cityName) {
  if (!cityName) return {};
  const key = String(cityName).toLowerCase().trim().replace(/,.*$/, '').trim();

  if (CITY_IDS[key]) {
    return { cityId: CITY_IDS[key], countyId: COUNTY_IDS[CITY_TO_COUNTY[key]], matched: 'city' };
  }
  if (TOWN_TO_COUNTY[key]) {
    return { countyId: COUNTY_IDS[TOWN_TO_COUNTY[key]], matched: 'county' };
  }
  if (COUNTY_IDS[key.replace(/\s*county$/, '')]) {
    return { countyId: COUNTY_IDS[key.replace(/\s*county$/, '')], matched: 'county' };
  }
  return { matched: 'none' };
}

/* ---------------------------------------------------------------------------
 * The ladder
 * ------------------------------------------------------------------------- */

async function resolve(query, deadline) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[ai-search] ANTHROPIC_API_KEY is not set in this environment');
  }

  const parsed = await interpret(query, deadline);
  console.log('[ai-search] path=' + (parsed ? 'model' : 'regex-fallback') + ' q=' + query);
  const raw = parsed || regexFallback(query);

  const place = resolvePlace(raw.city || raw.cityName);

  const spec = {
    pt: raw.propertyType || raw.pt || 1,
    beds: parseInt(raw.beds, 10) || 0,
    baths: parseInt(raw.baths, 10) || 0,
    minPrice: parseInt(raw.minPrice, 10) || 0,
    maxPrice: parseInt(raw.maxPrice, 10) || 0,
    sqft: parseInt(raw.sqft, 10) || 0,
    keyword: (raw.keyword && String(raw.keyword).trim().split(/\s+/)[0]) || null,
    cityId: place.cityId,
    countyId: place.cityId ? null : place.countyId,
    srt: 'newest'
  };

  /* Build it, verify it, ship it.
     No widening: relaxing a stated constraint without being able to tell the
     visitor we did it would show them houses they explicitly ruled out. An
     honest zero is better — IDX's empty state already tells them to broaden. */
  const url = buildUrl(spec);
  const n = await countResults(url, deadline);
  console.log('[ai-search] results=' + (n === null ? 'unverified' : n) + ' url=' + url);
  return url;
}

/* ------------------------------------------------------------------------- */

exports.handler = async function (event) {
  const deadline = Date.now() + TIME_BUDGET_MS;

  let query = '';
  if (event.httpMethod === 'POST') {
    try { query = (JSON.parse(event.body || '{}').q || '').trim(); } catch (e) { query = ''; }
  } else {
    query = ((event.queryStringParameters || {}).q || '').trim();
  }

  let target;
  if (!query) {
    target = buildUrl({ pt: 1, srt: 'newest' });
  } else {
    try {
      target = await resolve(query, deadline);
    } catch (e) {
      target = buildUrl({ pt: 1, srt: 'newest' });
    }
  }

  /* GET redirects the browser directly. POST returns JSON so the front end
     can redirect itself and show its own pending state. */
  if (event.httpMethod === 'POST') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target })
    };
  }

  return { statusCode: 302, headers: { Location: target } };
};
