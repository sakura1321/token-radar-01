// Token Radar's page. It reads window.RADAR (data.js, written beside this
// folder by main.ts from the same board board.json carries) and renders the
// ranked board, the set-aside trading protocols, and one detail view per
// protocol with the model's arithmetic and the farm plan. No network: every
// figure on the page is already in data.js.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;
  var M = D.model;

  var state = {
    q: '', cat: 'all', chain: 'all', min: 0, watch: false,
    view: 'board', sort: 'rank', dir: 1, selected: null,
  };

  // ---- formatting -----------------------------------------------------------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtFull(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'not on record';
    if (days >= 365) return (days / 365).toFixed(1) + 'y (' + days.toLocaleString('en-US') + 'd)';
    return days + 'd';
  }
  function $(id) { return document.getElementById(id); }

  // ---- state in the hash, so a view can be linked and screenshotted ---------

  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('cat')) state.cat = p.get('cat');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('min')) state.min = Number(p.get('min')) || 0;
    if (p.get('watch') === '1') state.watch = true;
    if (p.get('view') === 'live') state.view = 'live';
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('dir')) state.dir = Number(p.get('dir')) < 0 ? -1 : 1;
    if (p.get('p')) state.selected = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.cat !== 'all') p.set('cat', state.cat);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.min) p.set('min', String(state.min));
    if (state.watch) p.set('watch', '1');
    if (state.view === 'live') p.set('view', 'live');
    if (state.sort !== 'rank') p.set('sort', state.sort);
    if (state.dir !== 1) p.set('dir', String(state.dir));
    if (state.selected) p.set('p', state.selected);
    var s = p.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }

  // ---- the model's own account of itself ------------------------------------

  function renderChrome() {
    $('mastMeta').innerHTML =
      'SNAPSHOT <b>' + esc(D.as_of) + '</b><br>MODEL <b>' + esc(M.version) + '</b><br>DATA <b>DefiLlama protocol index</b>';
    var st = D.stats;
    $('stats').innerHTML =
      stat('Protocols ranked', String(st.ranked)) +
      stat('Watchlist covered', '<em>' + st.watchlist_covered + ' / ' + st.watchlist_total + '</em>') +
      stat('Early rows below the $50M floor', String(st.early_rows)) +
      stat('Total implied value', fmtUsd(st.total_implied_usd)) +
      stat('Trading protocols calibrating', String(M.tokenised_count));
    function stat(label, value) {
      return '<div class="stat"><span>' + esc(label) + '</span><b>' + value + '</b></div>';
    }
    $('modelText').textContent =
      'Every protocol on this board records no token in the snapshot. Its implied value starts from what the market ' +
      'already pays the protocols that do trade: for each category, the median market-cap-to-TVL ratio of its ' +
      M.tokenised_count + ' trading protocols, each ratio first winsorised to [' + M.ratio_floor + ', ' + M.ratio_cap + '] so one freak ' +
      'ratio cannot rule a category, then shrunk toward the global median of ' + M.global_multiple + ' with a weight of ' +
      M.shrink_weight + ' phantom protocols, and clamped to [' + M.multiple_min + ', ' + M.multiple_max + ']. That multiple is then lifted or cut by the ' +
      'protocol\'s own seven-day TVL growth, clamped to [' + M.growth_low + '%, +' + M.growth_high + '%] and halved, and by a track-record bonus of up to +' +
      Math.round(M.age_bonus * 100) + '% for the time it has run while recording no token, capped at ' + M.age_cap_days.toLocaleString('en-US') + ' days; a protocol ' +
      'with no listing date is given the snapshot\'s median tracked age of ' + M.fallback_age_days + ' days. Ranks fall strictly: where the ' +
      'arithmetic ties, values are stepped down a dollar at a time. Nothing here predicts that a token will exist. It is ' +
      'the snapshot\'s own figures, priced the way the market prices their trading peers.';
    $('modelFormula').textContent =
      'implied = round( TVL x category multiple x (1 + clamp(7d change, ' + M.growth_low + ', +' + M.growth_high + ') / 100 x ' +
      M.growth_weight + ') x (1 + ' + M.age_bonus + ' x min(age days, ' + M.age_cap_days + ') / ' + M.age_cap_days + ') )';
    $('footNote').textContent =
      'Built from the sealed snapshot in this entry\'s input: DefiLlama\'s protocol index as of ' + D.as_of + '. Implied values are a ' +
      'model\'s arithmetic, not prices or predictions, and a farm plan is a plan, not a promise of a token or an airdrop.';
  }

  // ---- controls ---------------------------------------------------------------

  function fillSelect(sel, values, allLabel, current) {
    sel.innerHTML = '';
    var all = document.createElement('option');
    all.value = 'all';
    all.textContent = allLabel;
    sel.appendChild(all);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    sel.value = values.indexOf(current) >= 0 ? current : 'all';
  }

  function wireControls() {
    fillSelect($('catSel'), D.categories, 'All categories', state.cat);
    fillSelect($('chainSel'), D.chains, 'All chains', state.chain);
    $('q').value = state.q;
    $('minSel').value = String(state.min);
    $('watchOnly').checked = state.watch;
    $('q').addEventListener('input', function () { state.q = $('q').value; sync(); });
    $('catSel').addEventListener('change', function () { state.cat = $('catSel').value; sync(); });
    $('chainSel').addEventListener('change', function () { state.chain = $('chainSel').value; sync(); });
    $('minSel').addEventListener('change', function () { state.min = Number($('minSel').value) || 0; sync(); });
    $('watchOnly').addEventListener('change', function () { state.watch = $('watchOnly').checked; sync(); });
    $('viewBoard').addEventListener('click', function () { state.view = 'board'; state.selected = null; sync(); });
    $('viewLive').addEventListener('click', function () { state.view = 'live'; state.selected = null; sync(); });
  }

  // ---- the board ---------------------------------------------------------------

  var COLUMNS = [
    { key: 'rank', label: '#', num: false },
    { key: 'name', label: 'Protocol', num: false },
    { key: 'category', label: 'Category', num: false },
    { key: 'chains', label: 'Chains', num: false },
    { key: 'tvl', label: 'TVL', num: true },
    { key: 'change', label: '7d', num: true },
    { key: 'multiple', label: 'Multiple', num: true },
    { key: 'implied', label: 'Implied value', num: true },
  ];

  function shownRows() {
    var q = state.q.trim().toLowerCase();
    return D.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.cat !== 'all' && (r.category || 'Uncategorised') !== state.cat) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) === -1) return false;
      if (r.tvl_usd < state.min) return false;
      if (!q) return true;
      var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortValue(r, key) {
    switch (key) {
      case 'rank': return r.rank;
      case 'name': return r.name.toLowerCase();
      case 'category': return (r.category || 'Uncategorised').toLowerCase();
      case 'chains': return (r.chains[0] || '').toLowerCase();
      case 'tvl': return r.tvl_usd;
      case 'change': return r.change_7d === null ? -1e18 : r.change_7d;
      case 'multiple': return r.multiple;
      default: return r.implied_value_usd;
    }
  }

  function sorted(list) {
    var key = state.sort;
    var dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.rank - b.rank;
    });
  }

  function renderBoard() {
    var head = $('boardHead');
    head.innerHTML = COLUMNS.map(function (c) {
      var arrow = state.sort === c.key ? ' <span class="dir">' + (state.dir > 0 ? '▲' : '▼') + '</span>' : '';
      return '<th scope="col"' + (c.num ? ' class="num"' : '') + '><button type="button" data-sort="' + c.key + '">' + c.label + arrow + '</button></th>';
    }).join('');
    Array.prototype.forEach.call(head.querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-sort');
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = key === 'name' || key === 'category' || key === 'chains' || key === 'rank' ? 1 : -1; }
        sync();
      });
    });

    var list = sorted(shownRows());
    var max = list.reduce(function (m, r) { return Math.max(m, r.implied_value_usd); }, 1);
    $('boardBody').innerHTML = list.map(function (r) {
      var chg = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var chains = r.chains.length === 0 ? '—' : esc(r.chains[0]) + (r.chains.length > 1 ? ' <span class="psub">+' + (r.chains.length - 1) + '</span>' : '');
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' +
        (r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : '<span class="badge early">EARLY</span>') +
        '<span class="psub">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || 'Uncategorised') + '</td>' +
        '<td>' + chains + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + chg + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">x' + r.multiple.toFixed(3) + '</td>' +
        '<td class="num"><span class="implied"><span class="track"><span class="fill" style="width:' +
        Math.max(2, Math.round((r.implied_value_usd / max) * 100)) + '%"></span></span>' + fmtUsd(r.implied_value_usd) + '</span></td>' +
        '</tr>';
    }).join('');
    Array.prototype.forEach.call($('boardBody').querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
    });
    $('emptyMsg').hidden = list.length !== 0;
    $('rowCount').textContent = list.length + ' of ' + D.rows.length + ' protocols shown';
  }

  // ---- the set-aside trading protocols ------------------------------------------

  function renderLive() {
    $('liveBody').innerHTML = D.live.map(function (r) {
      var chg = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      return '<tr>' +
        '<td><span class="pname">' + esc(r.name) + '</span><span class="psub">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || 'Uncategorised') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + chg + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtUsd(r.mcap_usd) + '</td>' +
        '<td class="num">x' + r.mcap_tvl.toFixed(3) + '</td>' +
        '</tr>';
    }).join('');
    $('rowCount').textContent = D.live.length + ' largest trading protocols, set aside from the ranking';
  }

  // ---- one protocol in full -------------------------------------------------------

  function openDetail(slug) {
    state.selected = slug;
    sync();
    window.scrollTo(0, 0);
  }

  function renderDetail() {
    var box = $('detailView');
    var r = D.rows.filter(function (x) { return x.slug === state.selected; })[0];
    if (!r) { box.hidden = true; return; }
    var catLabel = r.category || 'Uncategorised';
    var multNote = r.multiple_sample > 0
      ? catLabel + ' median from ' + r.multiple_sample + ' trading protocol' + (r.multiple_sample === 1 ? '' : 's')
      : 'global median: no ' + catLabel + ' protocol trades yet';
    var growthNote = r.change_7d === null
      ? 'no seven-day change on record, so the growth factor is 1.000'
      : 'seven-day change ' + fmtPct(r.change_7d) + (r.change_7d < M.growth_low || r.change_7d > M.growth_high
        ? ', entering the formula clamped to ' + fmtPct(Math.max(M.growth_low, Math.min(M.growth_high, r.change_7d))) : '');
    var ageNote = r.age_days === null
      ? 'no listing date on record, so the snapshot\'s median tracked age of ' + M.fallback_age_days + ' days stands in'
      : 'tracked since ' + r.listed_at;
    var steps = r.farm_steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var act = at >= 0 ? s.slice(0, at) : s;
      var meta = at >= 0 ? s.slice(at + 1) : '';
      return '<li><span class="act">' + esc(act) + '</span>' + (meta ? '<span class="meta">' + esc(meta) + '</span>' : '') + '</li>';
    }).join('');
    box.innerHTML =
      '<div class="detail-head"><div>' +
      '<h2 id="detailName">' + esc(r.name) + (r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : '<span class="badge early">EARLY</span>') + '</h2>' +
      '<p class="sub">' + esc(r.slug) + ' · ' + esc(catLabel) + ' · ' + esc(r.chains.join(', ') || 'no chain on record') + '</p></div>' +
      '<div class="big-implied"><span>Implied launch value</span><b>' + fmtFull(r.implied_value_usd) + '</b></div></div>' +
      '<div class="detail-grid">' +
      dfact('Board rank', '#' + r.rank + ' of ' + D.rows.length) +
      dfact('TVL', fmtFull(r.tvl_usd)) +
      dfact('7d TVL change', fmtPct(r.change_7d)) +
      dfact('Age with no token', fmtAge(r.age_days)) +
      dfact('Listed on DefiLlama', r.listed_at || 'not on record') +
      dfact('Chains', String(r.chains.length)) +
      '</div>' +
      '<h3>The model, on this protocol</h3>' +
      '<p class="equation">' + fmtFull(r.tvl_usd) + ' TVL x ' + r.multiple.toFixed(3) + ' multiple x ' + r.growth_factor.toFixed(3) +
      ' growth x ' + r.age_factor.toFixed(3) + ' age = <span class="res">' + fmtFull(r.implied_value_usd) + '</span></p>' +
      '<p class="model-note">The multiple is the ' + esc(multNote) + ', winsorised, shrunk toward the global median and clamped. ' +
      'Growth: ' + esc(growthNote) + '. Age: ' + esc(ageNote) + '. Where the raw arithmetic ties with a neighbour, the board ' +
      'steps values down a dollar at a time so ranks are strict. ' + esc(r.name) + ' records no token in the snapshot: that is a ' +
      'statement about the record, and this value is what a launch would be worth if the market priced its TVL the way it ' +
      'prices its trading peers today.</p>' +
      '<h3>Farm plan</h3>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<button type="button" class="backbtn" id="backBtn">&larr; Back to the board</button>';
    box.hidden = false;
    $('backBtn').addEventListener('click', function () { state.selected = null; sync(); });
    function dfact(label, value) {
      return '<div class="dfact"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
    }
  }

  // ---- render root ---------------------------------------------------------------

  function sync() {
    writeHash();
    $('viewBoard').className = 'viewbtn' + (state.view === 'board' ? ' on' : '');
    $('viewLive').className = 'viewbtn' + (state.view === 'live' ? ' on' : '');
    var detail = state.selected !== null && state.view === 'board';
    $('detailView').hidden = !detail;
    $('boardView').hidden = detail || state.view !== 'board';
    $('liveView').hidden = detail || state.view !== 'live';
    if (detail) renderDetail();
    else if (state.view === 'live') renderLive();
    else renderBoard();
  }

  readHash();
  renderChrome();
  wireControls();
  sync();
})();
