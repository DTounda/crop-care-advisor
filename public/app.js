/**
 * Crop Care Advisor, frontend logic.
 *
 * The API supplies facts about individual plants. Everything below that reasons
 * across the whole garden, the combined schedule, the conflict warnings and the
 * companion suggestions, is this application's own work. The API has no idea
 * what else the user is growing.
 */

const GARDEN_KEY = 'cropCareAdvisor.garden';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let searchResults = [];

const $ = id => document.getElementById(id);

/* Escape API text before it goes into the DOM. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showStatus(message, type = 'error') {
  const el = $('statusMessage');
  el.textContent = message;
  el.className = 'status-message' + (type === 'info' ? ' info' : '');
  el.hidden = false;
}
function hideStatus() { $('statusMessage').hidden = true; }
function setLoading(on) { $('loading').hidden = !on; }

/* Server badge, identifies Web01 or Web02 behind the load balancer. */
async function pingHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    $('serverBadge').textContent = `served by: ${data.server}`;
  } catch {
    $('serverBadge').textContent = 'server unreachable';
  }
}
pingHealth();

/* The garden, stored on the user's own device */

function getGarden() {
  try { return JSON.parse(localStorage.getItem(GARDEN_KEY)) || []; }
  catch { return []; }
}

function saveGarden(list) {
  try { localStorage.setItem(GARDEN_KEY, JSON.stringify(list)); }
  catch { /* storage unavailable, the app still works for this session */ }
  $('gardenCount').textContent = list.length;
}

function inGarden(id) { return getGarden().some(p => p.id === id); }

async function addToGarden(id) {
  if (inGarden(id)) return;
  setLoading(true);
  hideStatus();
  try {
    const res = await fetch(`/api/plant/${encodeURIComponent(id)}`);
    const plant = await res.json();
    if (!res.ok) {
      showStatus(plant.error || 'Could not add that crop.');
      return;
    }
    saveGarden([...getGarden(), plant]);
    renderGarden();
    renderSearchResults();
    showStatus(`${plant.name} added to your garden.`, 'info');
  } catch {
    showStatus('Could not reach the server. Please try again.');
  } finally {
    setLoading(false);
  }
}

function removeFromGarden(id) {
  saveGarden(getGarden().filter(p => p.id !== id));
  renderGarden();
  renderSearchResults();
  if (!$('planTab').hidden) renderPlan();
}

/* Interpreting plant requirements
   The API returns free text like "full sun" or "sun-part shade", so these
   helpers turn it into something comparable. */

function sunCategories(sunlightArray) {
  const set = new Set();
  (sunlightArray || []).forEach(raw => {
    const s = String(raw).toLowerCase();
    if (s.includes('full sun') || s === 'sun') set.add('full sun');
    if (s.includes('part')) set.add('part shade');
    if (s.includes('full shade') || s.includes('deep shade')) set.add('full shade');
    if (s.includes('filtered') || s.includes('dappled')) set.add('part shade');
  });
  return set;
}

const WATER_RANK = { frequent: 3, average: 2, minimum: 1, none: 0 };

function waterRank(watering) {
  if (!watering) return null;
  const key = String(watering).toLowerCase().trim();
  return WATER_RANK[key] !== undefined ? WATER_RANK[key] : null;
}

/**
 * Turns a watering category into practical advice. The API gives a benchmark in
 * days for some plants; where it does not, this falls back to the category.
 */
function wateringAdvice(plant) {
  if (plant.wateringBenchmark) return `about every ${plant.wateringBenchmark}`;
  const rank = waterRank(plant.watering);
  if (rank === 3) return 'two to three times a week';
  if (rank === 2) return 'about once a week';
  if (rank === 1) return 'every two to three weeks';
  if (rank === 0) return 'rainfall is usually enough';
  return 'no watering guidance recorded';
}

/* Building the plan */

function buildPlan(garden) {
  const monthIndex = new Date().getMonth();
  const monthName = MONTHS[monthIndex];

  const watering = { frequent: [], average: [], minimum: [], none: [], unknown: [] };
  const pruning = [];
  const harvest = [];
  const safety = [];

  garden.forEach(plant => {
    const rank = waterRank(plant.watering);
    if (rank === 3) watering.frequent.push(plant);
    else if (rank === 2) watering.average.push(plant);
    else if (rank === 1) watering.minimum.push(plant);
    else if (rank === 0) watering.none.push(plant);
    else watering.unknown.push(plant);

    // Pruning months come back as month names.
    const prunesNow = (plant.pruningMonths || []).some(
      m => String(m).toLowerCase() === monthName.toLowerCase()
    );
    if (prunesNow) pruning.push(plant);

    if (plant.harvestSeason) harvest.push(plant);

    if (plant.poisonousToPets || plant.poisonousToHumans) safety.push(plant);
  });

  return { monthName, watering, pruning, harvest, safety };
}

/**
 * Compares every pair of crops in the garden. Two crops conflict when their
 * sunlight needs do not overlap at all, or when their watering needs are two or
 * more steps apart, because one bed cannot satisfy both.
 */
function findConflictsAndCompanions(garden) {
  const conflicts = [];
  const companions = [];

  for (let i = 0; i < garden.length; i++) {
    for (let j = i + 1; j < garden.length; j++) {
      const a = garden[i], b = garden[j];

      const sunA = sunCategories(a.sunlight);
      const sunB = sunCategories(b.sunlight);
      const sunOverlap = [...sunA].some(s => sunB.has(s));
      const bothHaveSun = sunA.size > 0 && sunB.size > 0;

      const rankA = waterRank(a.watering);
      const rankB = waterRank(b.watering);
      const bothHaveWater = rankA !== null && rankB !== null;
      const waterGap = bothHaveWater ? Math.abs(rankA - rankB) : 0;

      const reasons = [];
      if (bothHaveSun && !sunOverlap) {
        reasons.push(
          `${a.name} needs ${[...sunA].join(' or ')} while ${b.name} needs ${[...sunB].join(' or ')}`
        );
      }
      if (bothHaveWater && waterGap >= 2) {
        reasons.push(
          `${a.name} wants ${String(a.watering).toLowerCase()} water and ${b.name} wants ${String(b.watering).toLowerCase()}`
        );
      }

      if (reasons.length) {
        conflicts.push({ a, b, reasons });
      } else if (bothHaveSun && sunOverlap && bothHaveWater && waterGap === 0) {
        companions.push({ a, b });
      }
    }
  }
  return { conflicts, companions };
}

/* Rendering the garden */

function renderGarden() {
  const garden = getGarden();
  const target = $('gardenGrid');
  target.innerHTML = '';
  $('gardenCount').textContent = garden.length;

  if (!garden.length) {
    target.innerHTML = `<div class="empty-state">
      <strong>Your garden is empty</strong>
      Go to "Find plants", search a crop you grow, and add it. Once you have two or
      more, this app can start comparing them for you.</div>`;
    return;
  }

  garden.forEach(plant => {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <img src="${esc(plant.image) || placeholder(plant.name)}" alt="${esc(plant.name)}" loading="lazy"
           onerror="this.onerror=null;this.src='${placeholder(plant.name)}'">
      <div class="card-body">
        <h3>${esc(plant.name)}</h3>
        ${plant.scientificName ? `<div class="sci">${esc(plant.scientificName)}</div>` : ''}
        <div class="tags">
          ${plant.watering ? `<span class="tag">water: ${esc(plant.watering)}</span>` : ''}
          ${plant.sunlight.length ? `<span class="tag">${esc(plant.sunlight.join(', '))}</span>` : ''}
          ${plant.cycle ? `<span class="tag none">${esc(plant.cycle)}</span>` : ''}
          ${plant.poisonousToPets ? '<span class="tag warn">toxic to pets</span>' : ''}
        </div>
        <button class="card-btn remove">Remove from garden</button>
      </div>`;
    card.querySelector('.card-btn').addEventListener('click', ev => {
      ev.stopPropagation();
      removeFromGarden(plant.id);
    });
    card.addEventListener('click', () => openPlant(plant.id));
    target.appendChild(card);
  });
}

/**
 * Builds a placeholder image as an inline SVG data URI. The plant database has
 * no photograph for every species, so rather than showing a broken image icon
 * this draws a labelled tile. It is generated in the browser, so it needs no
 * external image service and works even with no internet connection.
 */
function placeholder(name) {
  const label = String(name || 'plant').slice(0, 18).replace(/[^a-zA-Z0-9 ,.\-]/g, '');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160">' +
    '<rect width="300" height="160" fill="#e8f3ec"/>' +
    '<text x="150" y="80" font-family="Segoe UI, sans-serif" font-size="15" ' +
    'fill="#24503a" text-anchor="middle">' + label + '</text>' +
    '<text x="150" y="102" font-family="Segoe UI, sans-serif" font-size="11" ' +
    'fill="#6d6f68" text-anchor="middle">no photo available</text>' +
    '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* Rendering the plan */

function renderPlan() {
  const garden = getGarden();
  const target = $('planContent');
  target.innerHTML = '';

  if (garden.length === 0) {
    target.innerHTML = `<div class="empty-state">
      <strong>Nothing to plan yet</strong>
      Add the crops you grow and a combined schedule will appear here.</div>`;
    return;
  }

  const plan = buildPlan(garden);
  $('planHeading').textContent = `Your plan for ${plan.monthName}`;

  let html = '';

  /* Watering */
  const wateringGroups = [
    { key: 'frequent', label: 'Water these often', urgent: true },
    { key: 'average', label: 'Water these weekly', urgent: false },
    { key: 'minimum', label: 'These need very little water', urgent: false },
    { key: 'none', label: 'These do not need watering', urgent: false }
  ].filter(g => plan.watering[g.key].length > 0);

  if (wateringGroups.length) {
    html += '<div class="plan-block"><h3>Watering</h3>';
    wateringGroups.forEach(group => {
      plan.watering[group.key].forEach(plant => {
        html += `
          <div class="plan-item">
            <div class="plan-icon ${group.urgent ? 'urgent' : ''}">W</div>
            <div class="plan-text">
              <div class="plan-title">${esc(plant.name)}</div>
              <div class="plan-note">${esc(wateringAdvice(plant))}</div>
            </div>
          </div>`;
      });
    });
    html += '</div>';
  }

  if (plan.watering.unknown.length) {
    html += '<div class="plan-block"><h3>No watering data</h3>';
    plan.watering.unknown.forEach(plant => {
      html += `<div class="plan-item">
        <div class="plan-icon">?</div>
        <div class="plan-text">
          <div class="plan-title">${esc(plant.name)}</div>
          <div class="plan-note">The database has no watering guidance for this plant.</div>
        </div></div>`;
    });
    html += '</div>';
  }

  /* Pruning due this month */
  if (plan.pruning.length) {
    html += `<div class="plan-block"><h3>Prune this month</h3>`;
    plan.pruning.forEach(plant => {
      html += `<div class="plan-item">
        <div class="plan-icon urgent">P</div>
        <div class="plan-text">
          <div class="plan-title">${esc(plant.name)}</div>
          <div class="plan-note">Pruning months: ${esc(plant.pruningMonths.join(', '))}</div>
        </div></div>`;
    });
    html += '</div>';
  }

  /* Harvest */
  if (plan.harvest.length) {
    html += '<div class="plan-block"><h3>Harvest timing</h3>';
    plan.harvest.forEach(plant => {
      html += `<div class="plan-item">
        <div class="plan-icon">H</div>
        <div class="plan-text">
          <div class="plan-title">${esc(plant.name)}</div>
          <div class="plan-note">Harvest season: ${esc(plant.harvestSeason)}</div>
        </div></div>`;
    });
    html += '</div>';
  }

  /* Conflicts and companions */
  const { conflicts, companions } = findConflictsAndCompanions(garden);

  if (conflicts.length) {
    html += '<div class="section-intro"><h2>Planting warnings</h2><p>These crops should not share a bed.</p></div>';
    conflicts.forEach(c => {
      html += `<div class="conflict">
        <h4>Do not plant ${esc(c.a.name)} with ${esc(c.b.name)}</h4>
        <p>${c.reasons.map(r => esc(r)).join('. ')}. In one bed, one of them will suffer.</p>
      </div>`;
    });
  }

  if (companions.length) {
    html += '<div class="section-intro"><h2>Safe to plant together</h2><p>These share the same conditions.</p></div>';
    companions.slice(0, 6).forEach(c => {
      html += `<div class="companion">
        <h4>${esc(c.a.name)} and ${esc(c.b.name)}</h4>
        <p>Same sunlight and watering needs, so they can share a bed and a watering routine.</p>
      </div>`;
    });
  }

  if (garden.length === 1) {
    html += `<div class="empty-state">Add a second crop and this app will start
      checking whether your crops can be planted together.</div>`;
  }

  /* Safety */
  if (plan.safety.length) {
    html += '<div class="section-intro"><h2>Safety notes</h2></div>';
    plan.safety.forEach(plant => {
      const who = [];
      if (plant.poisonousToHumans) who.push('people');
      if (plant.poisonousToPets) who.push('pets');
      html += `<div class="safety">
        <h4>${esc(plant.name)} is toxic to ${esc(who.join(' and '))}</h4>
        <p>Keep it away from where children or animals might eat it.</p>
      </div>`;
    });
  }

  target.innerHTML = html;
}

/* Search */

$('searchForm').addEventListener('submit', e => {
  e.preventDefault();
  runSearch();
});

['filterSun', 'filterWater', 'filterCycle', 'filterEdible'].forEach(id => {
  $(id).addEventListener('change', runSearch);
});

$('sortBy').addEventListener('change', () => renderSearchResults());

$('resetBtn').addEventListener('click', () => {
  $('searchInput').value = '';
  $('filterSun').value = '';
  $('filterWater').value = '';
  $('filterCycle').value = '';
  $('filterEdible').value = 'false';
  $('sortBy').value = 'name';
  searchResults = [];
  $('searchSummary').textContent = '';
  renderSearchResults();
  hideStatus();
});

async function runSearch() {
  hideStatus();
  setLoading(true);

  const params = new URLSearchParams();
  const q = $('searchInput').value.trim();
  if (q) params.set('q', q);
  if ($('filterSun').value) params.set('sunlight', $('filterSun').value);
  if ($('filterWater').value) params.set('watering', $('filterWater').value);
  if ($('filterCycle').value) params.set('cycle', $('filterCycle').value);
  if ($('filterEdible').value === 'true') params.set('edible', 'true');

  try {
    const res = await fetch(`/api/search?${params.toString()}`);
    const data = await res.json();

    if (!res.ok) {
      showStatus(data.error || 'Something went wrong while searching.');
      searchResults = [];
      $('searchSummary').textContent = '';
      renderSearchResults();
      return;
    }

    searchResults = data.results;
    $('searchSummary').textContent = `${data.matched} plants found`;
    renderSearchResults();

    if (data.matched === 0) {
      showStatus('Nothing matched those conditions. Try a different name or loosen a filter.', 'info');
    }
  } catch {
    showStatus('Could not reach the server. Please check your connection and try again.');
    renderSearchResults();
  } finally {
    setLoading(false);
  }
}

function renderSearchResults() {
  const target = $('searchGrid');
  target.innerHTML = '';

  if (!searchResults.length) {
    target.innerHTML = `<div class="empty-state">
      <strong>No results yet</strong>
      Search a crop by name, or use the filters on their own to see what grows
      in your conditions.</div>`;
    return;
  }

  const rows = [...searchResults];
  const sort = $('sortBy').value;
  if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'nameDesc') rows.sort((a, b) => b.name.localeCompare(a.name));
  if (sort === 'water') {
    rows.sort((a, b) => (waterRank(b.watering) ?? -1) - (waterRank(a.watering) ?? -1));
  }

  rows.forEach(plant => {
    const already = inGarden(plant.id);
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <img src="${esc(plant.image) || placeholder(plant.name)}" alt="${esc(plant.name)}" loading="lazy"
           onerror="this.onerror=null;this.src='${placeholder(plant.name)}'">
      <div class="card-body">
        <h3>${esc(plant.name)}</h3>
        ${plant.scientificName ? `<div class="sci">${esc(plant.scientificName)}</div>` : ''}
        <div class="tags">
          ${plant.watering ? `<span class="tag">water: ${esc(plant.watering)}</span>` : ''}
          ${plant.cycle ? `<span class="tag none">${esc(plant.cycle)}</span>` : ''}
        </div>
        <button class="card-btn ${already ? 'added' : ''}">
          ${already ? 'In your garden' : 'Add to my garden'}
        </button>
      </div>`;

    const btn = card.querySelector('.card-btn');
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!already) addToGarden(plant.id);
    });
    card.addEventListener('click', () => openPlant(plant.id));
    target.appendChild(card);
  });
}

/* Plant detail */

async function openPlant(id) {
  const overlay = $('modalOverlay');
  const content = $('modalContent');
  content.innerHTML = '<p class="no-data">Loading plant details</p>';
  overlay.hidden = false;

  try {
    const res = await fetch(`/api/plant/${encodeURIComponent(id)}`);
    const p = await res.json();

    if (!res.ok) {
      content.innerHTML = `<p class="no-data">${esc(p.error || 'Could not load this plant.')}</p>`;
      return;
    }

    const facts = [
      ['Water', p.watering || 'not recorded'],
      ['How often', wateringAdvice(p)],
      ['Sunlight', p.sunlight.length ? p.sunlight.join(', ') : 'not recorded'],
      ['Life cycle', p.cycle || 'not recorded'],
      ['Care level', p.careLevel || 'not recorded'],
      ['Maintenance', p.maintenance || 'not recorded'],
      ['Growth rate', p.growthRate || 'not recorded'],
      ['Harvest', p.harvestSeason || 'not recorded']
    ];

    content.innerHTML = `
      <h2>${esc(p.name)}</h2>
      ${p.scientificName ? `<p class="sci">${esc(p.scientificName)}</p>` : ''}
      ${p.image ? `<img class="hero-img" src="${esc(p.image)}" alt="${esc(p.name)}">` : ''}

      <div class="fact-grid">
        ${facts.map(([label, value]) => `
          <div class="fact">
            <div class="fact-label">${esc(label)}</div>
            <div class="fact-value">${esc(value)}</div>
          </div>`).join('')}
      </div>

      ${p.pruningMonths.length ? `<p class="desc"><strong>Prune in:</strong> ${esc(p.pruningMonths.join(', '))}</p>` : ''}
      ${p.soil.length ? `<p class="desc"><strong>Soil:</strong> ${esc(p.soil.join(', '))}</p>` : ''}
      ${p.propagation.length ? `<p class="desc"><strong>Propagate by:</strong> ${esc(p.propagation.join(', '))}</p>` : ''}
      ${p.pestSusceptibility.length ? `<p class="desc"><strong>Watch for:</strong> ${esc(p.pestSusceptibility.join(', '))}</p>` : ''}
      ${(p.poisonousToPets || p.poisonousToHumans)
        ? `<p class="desc"><strong>Caution:</strong> toxic to ${esc([p.poisonousToHumans ? 'people' : '', p.poisonousToPets ? 'pets' : ''].filter(Boolean).join(' and '))}.</p>`
        : ''}
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}`;
  } catch {
    content.innerHTML = '<p class="no-data">Could not reach the server. Please try again.</p>';
  }
}

$('modalClose').addEventListener('click', () => { $('modalOverlay').hidden = true; });
$('modalOverlay').addEventListener('click', e => {
  if (e.target.id === 'modalOverlay') e.target.hidden = true;
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $('modalOverlay').hidden = true;
});

/* Tabs */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('gardenTab').hidden = tab !== 'garden';
    $('planTab').hidden = tab !== 'plan';
    $('findTab').hidden = tab !== 'find';
    hideStatus();
    if (tab === 'plan') renderPlan();
    if (tab === 'garden') renderGarden();
  });
});

/* Start */

saveGarden(getGarden());
renderGarden();
renderSearchResults();
