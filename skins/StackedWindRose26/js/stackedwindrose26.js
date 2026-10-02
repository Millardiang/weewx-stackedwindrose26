/*!
 * weewx-stackedwindrose26 1.0.0 - stacked wind rose renderer (D3 v7)
 * GPL-3.0-or-later
 *
 * Embed a single rose anywhere (needs d3 v7 and stackedwindrose26.css):
 *
 *   <div class="swr26" data-swr26-src="/windrose/data/day.json"></div>
 *
 * or from script:
 *
 *   StackedWindRose26.load(element, url, {legend: true, table: false});
 *   const rose = StackedWindRose26.render(element, data);  rose.update(newData);
 */
(function (global) {
  'use strict';

  const d3 = global.d3;
  if (!d3) { console.error('stackedwindrose26: d3 v7 is required'); return; }

  const SIZE = 400;            // viewBox edge
  const C = SIZE / 2;          // centre
  const R = C - 34;            // outer radius of the plot area
  const HUB = 26;              // calm hub radius
  const TAU = Math.PI * 2;
  const reduceMotion = () =>
    global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let uid = 0;

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function pct(f, digits) {
    const v = f * 100;
    if (v === 0) return '0%';
    if (v > 0 && v < 0.1) return '<0.1%';
    return v.toFixed(digits == null ? (v < 10 ? 1 : 0) : digits) + '%';
  }

  function cssVar(node, name, fallback) {
    const v = getComputedStyle(node).getPropertyValue(name).trim();
    return v || fallback;
  }

  /** Colours for n speed bands, slowest first. */
  function bandColors(node, data) {
    const n = data.bands.length;
    if (Array.isArray(data.colors) && data.colors.length) {
      const c = data.colors;
      if (c.length >= n) return c.slice(0, n);
      return d3.quantize(d3.piecewise(d3.interpolateLab, c), n);
    }
    const anchors = [1, 2, 3, 4, 5].map(i => cssVar(node, '--swr-ramp-' + i, '#3987e5'));
    if (n === anchors.length) return anchors;
    if (n === 1) return [anchors[2]];
    return d3.quantize(d3.piecewise(d3.interpolateLab, anchors), n);
  }

  function sectorTotals(data) {
    return data.petals.map(p => d3.sum(p));
  }

  function bandTotals(data) {
    return data.bands.map((_, b) => d3.sum(data.petals, p => p[b]));
  }

  function unitText(data) {
    return data.unit_label ? ' ' + data.unit_label : '';
  }

  function bandText(data, b) {
    const band = data.bands[b];
    if (band.label !== band.range) return band.label + ' (' + band.range + unitText(data) + ')';
    return band.range + unitText(data);
  }

  // --------------------------------------------------------------- render

  function render(container, data, options) {
    const opts = Object.assign({ legend: true, table: false, animate: true }, options || {});
    const id = 'swr26-' + (++uid);
    container.classList.add('swr26');
    container.replaceChildren();

    const chart = el('div', 'swr26-chart');
    const roseWrap = el('div', 'swr26-rose');
    const legend = el('div', 'swr26-legend');
    const tip = el('div', 'swr26-tooltip');
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    chart.append(roseWrap);
    if (opts.legend) chart.append(legend);
    container.append(chart, tip);
    let tableHost = null;
    if (opts.table) { tableHost = el('div', 'swr26-table-host'); container.append(tableHost); }

    const svg = d3.select(roseWrap).append('svg')
      .attr('viewBox', `0 0 ${SIZE} ${SIZE}`)
      .attr('class', 'swr26-svg')
      .attr('tabindex', 0)
      .attr('role', 'img');
    const desc = svg.append('desc').attr('id', id + '-desc');
    svg.attr('aria-describedby', id + '-desc');

    const gGrid = svg.append('g').attr('class', 'swr26-grid');
    const gPetals = svg.append('g').attr('class', 'swr26-petals');
    const gHits = svg.append('g').attr('class', 'swr26-hits');
    const gHub = svg.append('g').attr('class', 'swr26-hub').attr('transform', `translate(${C},${C})`);
    const gRingLabels = svg.append('g').attr('class', 'swr26-ring-labels');
    const gCardinals = svg.append('g').attr('class', 'swr26-cardinals');

    let current = null;
    let active = -1;       // focused/hovered sector
    let colors = [];
    let rScale = null;

    function radial(data) {
      const maxF = d3.max(sectorTotals(data)) || 0;
      const top = maxF > 0 ? d3.nice(0, maxF * 100, 4)[1] / 100 : 0.05;
      const scale = (data.radial_scale === 'sqrt' ? d3.scaleSqrt() : d3.scaleLinear())
        .domain([0, top]).range([0, R - HUB]);
      const ticks = (data.radial_scale === 'sqrt' ? d3.ticks(0, top * 100, 3) : d3.ticks(0, top * 100, 4))
        .filter(t => t > 0).map(t => t / 100);
      return { r: v => HUB + scale(v), top, ticks };
    }

    function draw(data, first) {
      current = data;
      colors = bandColors(container, data);
      const calmColor = data.calm_color || cssVar(container, '--swr-calm', '#d4d3cf');
      const n = data.sectors;
      const width = TAU / n;
      const half = width * Math.max(0.2, Math.min(1, data.petal_width || 0.85)) / 2;
      const rad = radial(data);
      rScale = rad.r;
      const totals = sectorTotals(data);

      // Accessible summary
      svg.attr('aria-label', `${data.label}: wind rose of ${data.obs_label}`);
      desc.text(`${data.prevailing ? 'Prevailing direction ' + data.prevailing + '. ' : ''}` +
        `Calm ${pct(data.calm.fraction)}. Use left and right arrow keys to read each direction.`);

      // --- grid: rings, spokes, cardinal labels
      gGrid.selectAll('*').remove();
      gGrid.append('circle').attr('class', 'swr26-plot-bg').attr('cx', C).attr('cy', C).attr('r', R);
      gGrid.selectAll('circle.swr26-ring').data(rad.ticks).join('circle')
        .attr('class', 'swr26-ring').attr('cx', C).attr('cy', C).attr('r', d => rad.r(d));
      gGrid.selectAll('line').data(d3.range(8)).join('line')
        .attr('class', d => 'swr26-spoke' + (d % 2 ? '' : ' swr26-spoke-major'))
        .attr('x1', d => C + HUB * Math.sin(d * TAU / 8)).attr('y1', d => C - HUB * Math.cos(d * TAU / 8))
        .attr('x2', d => C + (R + 6) * Math.sin(d * TAU / 8)).attr('y2', d => C - (R + 6) * Math.cos(d * TAU / 8));

      const card = data.cardinals || ['N', 'E', 'S', 'W'];
      gCardinals.selectAll('text').data(card).join('text')
        .attr('class', (d, i) => 'swr26-cardinal' + (i === 0 ? ' swr26-north' : ''))
        .attr('x', (d, i) => C + (R + 20) * Math.sin(i * TAU / 4))
        .attr('y', (d, i) => C - (R + 20) * Math.cos(i * TAU / 4))
        .attr('dy', '0.35em').attr('text-anchor', 'middle').text(d => d);

      // Ring labels go on the diagonal with the least petal in the way.
      const diag = [45, 135, 225, 315];
      const clutter = deg => {
        const s = Math.round(deg / (360 / n)) % n;
        return d3.max([s - 1, s, s + 1].map(k => totals[(k + n) % n]));
      };
      const bestDeg = d3.least(diag, clutter);
      const a = bestDeg * Math.PI / 180;
      gRingLabels.selectAll('text').data(rad.ticks).join('text')
        .attr('class', 'swr26-ring-label')
        .attr('x', d => C + rad.r(d) * Math.sin(a))
        .attr('y', d => C - rad.r(d) * Math.cos(a))
        .attr('dy', '0.35em').attr('text-anchor', 'middle')
        .text(d => Math.round(d * 1000) / 10 + '%');

      // --- petals
      const segs = [];
      data.petals.forEach((p, s) => {
        let cum = 0;
        const last = p.reduce((acc, v, b) => (v > 0 ? b : acc), -1);
        p.forEach((v, b) => {
          if (v <= 0) return;
          const lo = cum; cum += v;
          segs.push({ key: s + ':' + b, s, b, r0: rad.r(lo), r1: rad.r(cum),
                      a0: s * width - half, a1: s * width + half, outer: b === last });
        });
      });

      const arc = d3.arc();
      const path = d => arc({ innerRadius: d.r0, outerRadius: d.r1, startAngle: d.a0, endAngle: d.a1,
                              cornerRadius: d.outer ? 2 : 0 });
      const t = (opts.animate && !reduceMotion())
        ? svg.transition().duration(first ? 700 : 450).ease(d3.easeCubicOut) : null;

      gPetals.attr('transform', `translate(${C},${C})`);
      const sel = gPetals.selectAll('path').data(segs, d => d.key);
      sel.exit().remove();
      const enter = sel.enter().append('path')
        .attr('class', 'swr26-petal')
        .each(function (d) { this._prev = { r0: HUB, r1: HUB, a0: d.a0, a1: d.a1 }; });
      const all = enter.merge(sel)
        .attr('fill', d => colors[d.b])
        .attr('data-band', d => d.b)
        .attr('data-sector', d => d.s);
      if (t) {
        all.transition(t).attrTween('d', function (d) {
          const i = d3.interpolate(this._prev || d, d);
          this._prev = d;
          return u => path(Object.assign({}, d, i(u)));
        });
      } else {
        all.attr('d', path).each(function (d) { this._prev = d; });
      }

      // --- hit wedges: one per sector, full width, hub to rim
      const hitArc = d3.arc().innerRadius(HUB).outerRadius(R + 8);
      gHits.attr('transform', `translate(${C},${C})`);
      gHits.selectAll('path').data(d3.range(n)).join('path')
        .attr('class', 'swr26-hit')
        .attr('d', s => hitArc({ startAngle: s * width - width / 2, endAngle: s * width + width / 2 }))
        .on('pointerenter pointermove', (ev, s) => { setActive(s); placeTip(ev.clientX, ev.clientY); })
        .on('pointerleave', () => setActive(-1));

      // --- calm hub
      gHub.selectAll('*').remove();
      gHub.append('circle').attr('r', HUB).attr('class', 'swr26-hub-disc').attr('fill', calmColor);
      gHub.append('text').attr('class', 'swr26-hub-value').attr('dy', '0.15em').attr('text-anchor', 'middle')
        .text(pct(data.calm.fraction));
      gHub.append('text').attr('class', 'swr26-hub-label').attr('dy', '1.45em').attr('text-anchor', 'middle')
        .text('calm');
      gHub.on('pointerenter', ev => { setActive('calm'); placeTip(ev.clientX, ev.clientY); })
        .on('pointerleave', () => setActive(-1));

      if (opts.legend) drawLegend(data, calmColor);
      if (tableHost) drawTable(data);
      if (active !== -1) setActive(active);
    }

    function drawLegend(data, calmColor) {
      legend.replaceChildren();
      legend.append(el('div', 'swr26-legend-title', data.obs_label + (data.unit_label ? ' (' + data.unit_label + ')' : '')));
      const list = el('ul', 'swr26-legend-list');
      const bt = bandTotals(data);
      // fastest at the top, as the petals stack outward
      for (let b = data.bands.length - 1; b >= 0; b--) {
        const li = el('li', 'swr26-legend-item');
        li.tabIndex = 0;
        li.dataset.band = b;
        const sw = el('span', 'swr26-swatch'); sw.style.background = colors[b];
        const band = data.bands[b];
        const name = el('span', 'swr26-legend-name',
          band.label !== band.range ? band.label : band.range);
        if (band.label !== band.range) name.append(el('span', 'swr26-legend-sub', ' ' + band.range));
        li.append(sw, name, el('span', 'swr26-legend-value', pct(bt[b])));
        const on = () => highlightBand(b);
        li.addEventListener('pointerenter', on); li.addEventListener('focus', on);
        li.addEventListener('pointerleave', () => highlightBand(null));
        li.addEventListener('blur', () => highlightBand(null));
        list.append(li);
      }
      const calm = el('li', 'swr26-legend-item swr26-legend-calm');
      const sw = el('span', 'swr26-swatch swr26-swatch-calm'); sw.style.background = calmColor;
      calm.append(sw, el('span', 'swr26-legend-name', 'Calm' + (data.calm.threshold ? ' ≤ ' + data.calm.threshold : '')),
        el('span', 'swr26-legend-value', pct(data.calm.fraction)));
      list.append(calm);
      legend.append(list);
    }

    function drawTable(data) {
      tableHost.replaceChildren();
      const det = el('details', 'swr26-table');
      det.append(el('summary', null, 'Data table'));
      const wrap = el('div', 'swr26-table-scroll');
      const table = el('table');
      const cap = el('caption', null, `${data.label} — share of time by direction and ${data.obs_label.toLowerCase()} (${data.unit_label})`);
      const thead = el('thead'); const hr = el('tr');
      hr.append(el('th', null, 'Direction'));
      data.bands.forEach(b => hr.append(el('th', null, b.label !== b.range ? b.label : b.range)));
      hr.append(el('th', null, 'All'));
      thead.append(hr);
      const tbody = el('tbody');
      const totals = sectorTotals(data);
      data.petals.forEach((p, s) => {
        const tr = el('tr');
        const th = el('th', null, data.sector_labels[s]); th.scope = 'row';
        tr.append(th);
        p.forEach(v => tr.append(el('td', null, v ? pct(v, 1) : '–')));
        tr.append(el('td', 'swr26-strong', pct(totals[s], 1)));
        tbody.append(tr);
      });
      const foot = el('tfoot'); const fr = el('tr');
      const fth = el('th', null, 'All'); fth.scope = 'row'; fr.append(fth);
      bandTotals(data).forEach(v => fr.append(el('td', null, pct(v, 1))));
      fr.append(el('td', 'swr26-strong', pct(1 - data.calm.fraction, 1)));
      foot.append(fr);
      const calmRow = el('tr'); const cth = el('th', null, 'Calm'); cth.scope = 'row';
      calmRow.append(cth);
      const ctd = el('td', null, pct(data.calm.fraction, 1)); ctd.colSpan = data.bands.length + 1;
      calmRow.append(ctd); foot.append(calmRow);
      table.append(cap, thead, tbody, foot);
      wrap.append(table); det.append(wrap); tableHost.append(det);
    }

    function highlightBand(b) {
      gPetals.selectAll('path').classed('swr26-dim', d => b != null && d.b !== b);
      legend.querySelectorAll('.swr26-legend-item').forEach(li =>
        li.classList.toggle('swr26-dim', b != null && String(li.dataset.band) !== String(b)));
    }

    function setActive(s) {
      active = s;
      if (s === -1) {
        gPetals.selectAll('path').classed('swr26-dim', false).classed('swr26-lift', false);
        gHits.selectAll('path').classed('swr26-hit-active', false);
        tip.hidden = true;
        return;
      }
      const data = current;
      gPetals.selectAll('path')
        .classed('swr26-dim', d => s === 'calm' || d.s !== s)
        .classed('swr26-lift', d => d.s === s);
      gHits.selectAll('path').classed('swr26-hit-active', d => d === s);
      tip.replaceChildren();
      if (s === 'calm') {
        tip.append(el('div', 'swr26-tip-value', pct(data.calm.fraction, 1)),
          el('div', 'swr26-tip-title', 'Calm' + (data.calm.threshold ? ' (≤ ' + data.calm.threshold + unitText(data) + ')' : '')));
      } else {
        const p = data.petals[s];
        tip.append(el('div', 'swr26-tip-value', pct(d3.sum(p), 1)),
          el('div', 'swr26-tip-title', 'from ' + data.sector_labels[s]));
        const rows = el('ul', 'swr26-tip-rows');
        for (let b = p.length - 1; b >= 0; b--) {
          if (!p[b]) continue;
          const li = el('li');
          const key = el('span', 'swr26-tip-key'); key.style.background = colors[b];
          li.append(key, el('span', 'swr26-tip-num', pct(p[b], 1)), el('span', 'swr26-tip-band', bandText(data, b)));
          rows.append(li);
        }
        if (!rows.childElementCount) rows.append(el('li', 'swr26-tip-band', 'No wind from this direction'));
        tip.append(rows);
      }
      tip.hidden = false;
    }

    function placeTip(x, y) {
      const box = container.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = x - box.left + 14, top = y - box.top + 14;
      if (left + tw > box.width) left = x - box.left - tw - 14;
      if (left < 0) left = 4;
      if (top + th > box.height) top = Math.max(4, y - box.top - th - 14);
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
    }

    function tipAtSector(s) {
      const rect = svg.node().getBoundingClientRect();
      const k = rect.width / SIZE;
      const a = s * TAU / current.sectors;
      const rr = rScale(d3.sum(current.petals[s])) + 6;
      placeTip(rect.left + (C + rr * Math.sin(a)) * k, rect.top + (C - rr * Math.cos(a)) * k);
    }

    // keyboard: arrows walk the compass; Escape clears
    svg.on('keydown', ev => {
      if (!current) return;
      const n = current.sectors;
      let s = active === -1 || active === 'calm'
        ? (current.prevailing_index != null ? current.prevailing_index : 0) : active;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') s = active === -1 ? s : (s + 1) % n;
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') s = active === -1 ? s : (s - 1 + n) % n;
      else if (ev.key === 'Escape') { setActive(-1); return; }
      else return;
      ev.preventDefault();
      setActive(s); tipAtSector(s);
    });
    svg.on('focus', () => {
      if (!current) return;
      const s = current.prevailing_index != null ? current.prevailing_index : 0;
      setActive(s); tipAtSector(s);
    });
    svg.on('blur', () => setActive(-1));

    // follow colour-scheme changes (OS setting or a data-theme toggle)
    const redraw = () => current && draw(current, false);
    const mq = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
    if (mq && mq.addEventListener) mq.addEventListener('change', redraw);
    const mo = new MutationObserver(redraw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

    draw(data, true);

    return {
      update: d => draw(d, false),
      get data() { return current; },
      destroy() {
        if (mq && mq.removeEventListener) mq.removeEventListener('change', redraw);
        mo.disconnect();
        container.replaceChildren();
      },
    };
  }

  // ------------------------------------------------------------- loading

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText + ' (' + url + ')');
    return res.json();
  }

  function showError(container, err) {
    container.classList.add('swr26');
    container.replaceChildren(el('p', 'swr26-error', 'Wind rose unavailable: ' + err.message));
  }

  async function load(container, url, options) {
    try {
      const data = await fetchJSON(url);
      return render(container, data, options);
    } catch (err) {
      showError(container, err);
      throw err;
    }
  }

  // --------------------------------------------------------- full page app

  const fmtDate = ts => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(ts * 1000));

  function fmtSpeed(v, data) {
    if (v == null) return '–';
    return (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)) + unitText(data);
  }

  async function app(root, manifestUrl, options) {
    const opts = Object.assign({ refresh: 300 }, options || {});
    const q = sel => root.querySelector(sel);
    let manifest;
    try { manifest = await fetchJSON(manifestUrl); }
    catch (err) { showError(q('[data-swr26-chart]') || root, err); return; }

    if (manifest.station && manifest.station.location) {
      q('[data-swr26-station]').textContent = manifest.station.location;
      document.title = 'Wind rose — ' + manifest.station.location;
    }
    const roses = manifest.roses || [];
    const tabs = q('[data-swr26-tabs]');
    const chartHost = q('[data-swr26-chart]');
    let chart = null;
    let selected = null;

    roses.forEach(r => {
      const b = el('button', 'swr26-tab', r.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.dataset.name = r.name;
      b.addEventListener('click', () => select(r.name, true));
      tabs.append(b);
    });

    function fillMeta(data) {
      q('[data-swr26-title]').textContent = data.label;
      q('[data-swr26-range]').textContent = `${data.obs_label} · ${fmtDate(data.start)} – ${fmtDate(data.end)}`;
      const stats = q('[data-swr26-stats]');
      stats.replaceChildren();
      const tile = (label, value) => {
        const t = el('div', 'swr26-stat');
        t.append(el('div', 'swr26-stat-label', label), el('div', 'swr26-stat-value', value));
        stats.append(t);
      };
      tile('Prevailing', data.prevailing || '–');
      tile('Mean ' + data.obs_label.toLowerCase(), fmtSpeed(data.mean_speed, data));
      tile('Highest', fmtSpeed(data.max_speed, data));
      tile('Calm', pct(data.calm.fraction));
      const foot = [];
      foot.push('Data to ' + (data.time_stamp || fmtDate(data.end)));
      foot.push(data.records.toLocaleString() + ' archive records');
      if (data.missing_fraction > 0.005) foot.push(pct(data.missing_fraction) + ' missing');
      if (data.no_direction_fraction > 0.005) foot.push(pct(data.no_direction_fraction) + ' without direction (excluded)');
      foot.push(data.weighting === 'time' ? 'time-weighted' : 'sample-weighted');
      q('[data-swr26-foot]').textContent = foot.join(' · ');
      const gen = q('[data-swr26-generator]');
      if (gen) gen.textContent = data.generator;
    }

    async function select(name, push) {
      const rose = roses.find(r => r.name === name) || roses[0];
      if (!rose) { showError(chartHost, new Error('no roses configured')); return; }
      selected = rose.name;
      tabs.querySelectorAll('.swr26-tab').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.name === rose.name)));
      if (push) history.replaceState(null, '', '#' + rose.name);
      root.classList.add('swr26-loading');
      try {
        const data = await fetchJSON(rose.file);
        if (selected !== rose.name) return;          // a later click won
        fillMeta(data);
        if (chart) chart.update(data);
        else chart = render(chartHost, data, { legend: true, table: true });
      } catch (err) {
        chart = null;
        showError(chartHost, err);
      } finally {
        root.classList.remove('swr26-loading');
      }
    }

    await select((location.hash || '').slice(1) || (roses[0] && roses[0].name), false);
    if (opts.refresh > 0) setInterval(() => !document.hidden && select(selected, false), opts.refresh * 1000);
  }

  // ------------------------------------------------------------ autoload

  function autoload() {
    document.querySelectorAll('[data-swr26-src]').forEach(node => {
      if (node.dataset.swr26Loaded) return;
      node.dataset.swr26Loaded = '1';
      load(node, node.dataset.swr26Src, {
        legend: node.dataset.swr26Legend !== 'false',
        table: node.dataset.swr26Table === 'true',
      }).catch(() => {});
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoload);
  else autoload();

  global.StackedWindRose26 = { version: '1.0.0', render, load, app, autoload };
})(window);
