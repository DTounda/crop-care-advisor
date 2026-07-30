/**
 * Crop Care Advisor
 * A planting and care planner for whatever you are actually growing.
 *
 * Backend API server.
 *
 * Responsibilities:
 *  1. Keep the Perenual API key on the server so it is never sent to the browser.
 *  2. Cache upstream responses so the daily request allowance is not wasted.
 *  3. Normalise the API's inconsistent field shapes into one predictable format.
 *  4. Turn every upstream failure into a clear, human readable message.
 *
 * Data source: Perenual Plant API, https://perenual.com/docs/api
 */

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.PERENUAL_API_KEY || '').trim();
const SERVER_NAME = process.env.SERVER_NAME || 'local-dev';
const API_BASE = 'https://perenual.com/api';

const CACHE_TTL_MS = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 15000;

app.use(express.static(path.join(__dirname, 'public')));

/* Cache */

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.storedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, storedAt: Date.now() });
}

/* Input validation */

function cleanQuery(raw, maxLength = 60) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxLength).replace(/[^a-zA-Z0-9 '\-]/g, '');
}

function isValidId(raw) {
  return /^\d{1,7}$/.test(String(raw));
}

const ALLOWED_SUNLIGHT = ['full_sun', 'part_shade', 'full_shade', 'sun-part_shade'];
const ALLOWED_WATERING = ['frequent', 'average', 'minimum', 'none'];
const ALLOWED_CYCLE = ['perennial', 'annual', 'biennial'];

/* Upstream fetching */

const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CropCareAdvisor/1.0)',
  'Accept': 'application/json'
};

function describeUpstreamError(status) {
  if (status === 401 || status === 403) {
    return 'The plant database rejected our access key. The administrator needs to check the API key.';
  }
  if (status === 429) {
    return 'We have reached the daily limit on the plant database. Please try again later today.';
  }
  if (status === 404) {
    return 'That plant record could not be found in the plant database.';
  }
  if (status >= 500) {
    return 'The plant database is temporarily unavailable. Please try again in a few minutes.';
  }
  return `The plant database returned an unexpected response (status ${status}).`;
}

async function fetchUpstream(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal, headers: UPSTREAM_HEADERS });

    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      console.error(`Upstream ${res.status} :: ${body}`);
      const err = new Error(describeUpstreamError(res.status));
      err.statusCode = res.status === 429 ? 429 : 502;
      throw err;
    }

    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('The plant database took too long to respond. Please try again.');
      timeoutErr.statusCode = 504;
      throw timeoutErr;
    }
    if (!err.statusCode) {
      console.error(`Network failure: ${err.message}`);
      err.statusCode = 502;
      err.message = 'Could not reach the plant database. Please check the connection and try again.';
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* Normalising

   The API is inconsistent: some fields are arrays, some are strings, some are
   null. Everything is flattened here so the frontend never has to guess. */

function asArray(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

function firstImage(image) {
  if (!image || typeof image !== 'object') return null;
  return image.small_url || image.thumbnail || image.regular_url || null;
}

function normaliseListItem(item) {
  return {
    id: item.id,
    name: item.common_name || 'Unnamed plant',
    scientificName: asArray(item.scientific_name).join(', '),
    cycle: item.cycle || null,
    watering: item.watering || null,
    sunlight: asArray(item.sunlight),
    image: firstImage(item.default_image)
  };
}

function normaliseDetails(d) {
  const benchmark = d.watering_general_benchmark;
  return {
    id: d.id,
    name: d.common_name || 'Unnamed plant',
    scientificName: asArray(d.scientific_name).join(', '),
    family: d.family || null,
    type: d.type || null,
    cycle: d.cycle || null,
    watering: d.watering || null,
    wateringBenchmark: benchmark && benchmark.value
      ? `${benchmark.value} ${benchmark.unit || 'days'}`
      : null,
    sunlight: asArray(d.sunlight),
    pruningMonths: asArray(d.pruning_month),
    harvestSeason: d.harvest_season || null,
    floweringSeason: d.flowering_season || null,
    soil: asArray(d.soil),
    growthRate: d.growth_rate || null,
    careLevel: d.care_level || null,
    maintenance: d.maintenance || null,
    droughtTolerant: Boolean(d.drought_tolerant),
    indoor: Boolean(d.indoor),
    edibleFruit: Boolean(d.edible_fruit),
    edibleLeaf: Boolean(d.edible_leaf),
    medicinal: Boolean(d.medicinal),
    poisonousToPets: Boolean(d.poisonous_to_pets),
    poisonousToHumans: Boolean(d.poisonous_to_humans),
    invasive: Boolean(d.invasive),
    thorny: Boolean(d.thorny),
    attracts: asArray(d.attracts),
    propagation: asArray(d.propagation),
    pestSusceptibility: asArray(d.pest_susceptibility),
    description: typeof d.description === 'string' ? d.description : null,
    image: firstImage(d.default_image)
  };
}

/* Routes */

/**
 * Health check. The server field identifies which machine answered the request,
 * which is how load balancing is demonstrated once this runs behind Lb01.
 */
app.get('/api/health', (req, res) => {
  res.json({ server: SERVER_NAME, status: 'ok', time: new Date().toISOString() });
});

/**
 * Plant search. Supports a free text query plus the growing-condition filters
 * that the Perenual API exposes, so filtering happens upstream rather than by
 * downloading everything and discarding most of it.
 */
app.get('/api/search', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'The server has no API key configured.' });
  }

  const q = cleanQuery(req.query.q || '');
  const sunlight = ALLOWED_SUNLIGHT.includes(req.query.sunlight) ? req.query.sunlight : '';
  const watering = ALLOWED_WATERING.includes(req.query.watering) ? req.query.watering : '';
  const cycle = ALLOWED_CYCLE.includes(req.query.cycle) ? req.query.cycle : '';
  const edible = req.query.edible === 'true';

  if (!q && !sunlight && !watering && !cycle && !edible) {
    return res.status(400).json({ error: 'Enter a plant name or choose at least one growing condition.' });
  }

  const params = [`key=${API_KEY}`];
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  if (sunlight) params.push(`sunlight=${sunlight}`);
  if (watering) params.push(`watering=${watering}`);
  if (cycle) params.push(`cycle=${cycle}`);
  if (edible) params.push('edible=1');

  const url = `${API_BASE}/v2/species-list?${params.join('&')}`;
  const cacheKey = `search:${params.slice(1).join('&')}`;

  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const json = await fetchUpstream(url);
    const results = (json.data || []).map(normaliseListItem);
    const payload = {
      results,
      matched: results.length,
      total: json.total || results.length,
      servedBy: SERVER_NAME,
      cached: false
    };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('Search failed:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Full detail for one plant. This is what gets stored in a user's garden, so it
 * carries every field the planner needs to build a schedule.
 */
app.get('/api/plant/:id', async (req, res) => {
  const { id } = req.params;

  if (!isValidId(id)) {
    return res.status(400).json({ error: 'That is not a valid plant reference.' });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: 'The server has no API key configured.' });
  }

  const cacheKey = `plant:${id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const json = await fetchUpstream(`${API_BASE}/v2/species/details/${id}?key=${API_KEY}`);
    const plant = normaliseDetails(json);
    cacheSet(cacheKey, plant);
    res.json(plant);
  } catch (err) {
    console.error('Detail lookup failed:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Diagnostic endpoint, used to verify a fresh deployment without exposing the key.
 */
app.get('/api/diagnose', async (req, res) => {
  const report = {
    server: SERVER_NAME,
    keyPresent: Boolean(API_KEY),
    keyLength: API_KEY.length,
    checks: []
  };

  const targets = [
    { label: 'species list', url: `${API_BASE}/v2/species-list?key=${API_KEY}&q=tomato` },
    { label: 'species details', url: `${API_BASE}/v2/species/details/1?key=${API_KEY}` }
  ];

  for (const target of targets) {
    try {
      const upstream = await fetch(target.url, { headers: UPSTREAM_HEADERS });
      const text = await upstream.text();
      let records = null;
      try {
        const parsed = JSON.parse(text);
        records = Array.isArray(parsed.data) ? parsed.data.length : (parsed.id ? 1 : null);
      } catch { /* not json */ }
      report.checks.push({ check: target.label, status: upstream.status, records });
    } catch (err) {
      report.checks.push({ check: target.label, error: err.message });
    }
  }

  res.json(report);
});

// Unknown routes fall back to the single page app.
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Crop Care Advisor running on port ${PORT} (server: ${SERVER_NAME})`);
});
