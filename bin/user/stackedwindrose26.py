"""
stackedwindrose26.py

Data generator for the weewx-stackedwindrose26 extension.

The original StackedWindRose extension (Gary Roderick, 2013-2020, maintained
in weewx-contrib) drew each wind rose into a PNG with PIL.  This rewrite
separates the work in two:

  * this generator reads the archive, bins wind speed and direction into
    direction sectors and speed bands, and writes one small JSON file per rose
    plus a manifest listing them;
  * the skin ships a D3 (v7) renderer that draws the stacked rose in the
    browser as resizable, themeable, interactive SVG.

Requires WeeWX 5.0 or later and python 3.7 or later.  Honours the stop event
that WeeWX 5.5 and later hand to report generators.

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE.  See the GNU General Public License for more details.
"""

import bisect
import inspect
import json
import logging
import math
import os
import os.path
import tempfile
import time

import weeutil.logger
import weeutil.weeutil
import weewx
import weewx.reportengine
import weewx.units
import weewx.xtypes
from weeutil.config import search_up
from weeutil.weeutil import to_bool, to_float, to_int, option_as_list

log = logging.getLogger(__name__)

VERSION = '1.0.0'
GENERATOR_NAME = 'weewx-stackedwindrose26'
SCHEMA_VERSION = 1

# Name of the section in skin.conf that holds our options.
SECTION = 'StackedWindRose26'

# Upper limits, in knots, of Beaufort forces 0 to 11.  Anything at or above
# the last value is force 12.
BEAUFORT_KNOTS = [1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64]

# "Nice" mantissas used when choosing automatic speed band widths.
NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

DEFAULT_ORDINATES = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                     'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

# Direction observation used for each speed observation unless dir_obs is set.
DIRECTION_FOR = {
    'windSpeed': 'windDir',
    'windGust': 'windGustDir',
}

# WeeWX 5.5 added stop_event to ReportGenerator.__init__.  Earlier 5.x
# releases do not accept it, so only pass it on when the base class takes it.
_BASE_TAKES_STOP_EVENT = 'stop_event' in inspect.signature(
    weewx.reportengine.ReportGenerator.__init__).parameters


class StackedWindRoseGenerator(weewx.reportengine.ReportGenerator):
    """Write the binned wind data that the D3 stacked wind rose renders."""

    def __init__(self, config_dict, skin_dict, gen_ts, first_run, stn_info,
                 record=None, stop_event=None):
        if _BASE_TAKES_STOP_EVENT:
            super().__init__(config_dict, skin_dict, gen_ts, first_run,
                             stn_info, record, stop_event)
        else:
            super().__init__(config_dict, skin_dict, gen_ts, first_run,
                             stn_info, record)
        self.stop_event = stop_event

    # ------------------------------------------------------------------ run

    def run(self):
        t1 = time.time()
        self.log_success = to_bool(search_up(self.skin_dict, 'log_success', True))
        self.log_failure = to_bool(search_up(self.skin_dict, 'log_failure', True))

        try:
            gen_dict = self.skin_dict[SECTION]
        except KeyError:
            log.error("No [%s] section in skin '%s'; nothing to do",
                      SECTION, self.skin_dict.get('REPORT_NAME', '?'))
            return

        self.converter = weewx.units.Converter.fromSkinDict(self.skin_dict)
        self.formatter = weewx.units.Formatter.fromSkinDict(self.skin_dict)

        html_root = os.path.join(self.config_dict['WEEWX_ROOT'],
                                 self.skin_dict['HTML_ROOT'])
        data_dir = os.path.join(html_root, gen_dict.get('data_dir', 'data'))
        os.makedirs(data_dir, exist_ok=True)

        manifest = []
        ngen = 0
        for rose_name in gen_dict.sections:
            if self._stopping(rose_name):
                return
            opts = weeutil.weeutil.accumulateLeaves(gen_dict[rose_name])
            file_name = '%s.json' % rose_name
            path = os.path.join(data_dir, file_name)
            manifest.append({
                'name': rose_name,
                'label': opts.get('label', rose_name),
                'file': '%s/%s' % (gen_dict.get('data_dir', 'data'), file_name),
            })
            if self._is_fresh(path, to_int(opts.get('stale_age'))):
                continue
            try:
                rose = self._build_rose(rose_name, opts)
            except Exception as e:
                if self.log_failure:
                    log.error("Unable to generate wind rose '%s': %s", rose_name, e)
                    weeutil.logger.log_traceback(log.error, "    ****  ")
                continue
            _write_json(path, rose)
            ngen += 1

        _write_json(os.path.join(html_root, 'stackedwindrose26.json'), {
            'schema': SCHEMA_VERSION,
            'generator': '%s %s' % (GENERATOR_NAME, VERSION),
            'generated': int(time.time()),
            'station': {
                'location': _plain(getattr(self.stn_info, 'location', '')),
                'latitude': getattr(self.stn_info, 'latitude_f', None),
                'longitude': getattr(self.stn_info, 'longitude_f', None),
            },
            'roses': manifest,
        })

        if self.log_success:
            log.info("Generated %d wind rose data file%s for %s in %.2f seconds",
                     ngen, '' if ngen == 1 else 's',
                     self.skin_dict.get('REPORT_NAME', SECTION), time.time() - t1)

    # -------------------------------------------------------------- helpers

    def _stopping(self, rose_name):
        """True if WeeWX (5.5+) has asked report generators to stop."""
        if self.stop_event is not None and self.stop_event.is_set():
            log.info("Stop requested, abandoning wind rose '%s' and any after it",
                     rose_name)
            return True
        return False

    @staticmethod
    def _is_fresh(path, stale_age):
        if not stale_age:
            return False
        try:
            return time.time() - os.stat(path).st_mtime < stale_age
        except OSError:
            return False

    def _end_ts(self, db_manager):
        return self.gen_ts or db_manager.lastGoodStamp() or int(time.time())

    def _timespan(self, time_length, end_ts):
        """Turn a time_length option into a TimeSpan.

        Integers are a rolling period in seconds ending at end_ts.  The
        keywords day, week, month and year select the calendar period that
        contains end_ts (today, this week, this month, this year).
        """
        key = str(time_length).strip().lower()
        if key == 'day':
            return weeutil.weeutil.archiveDaySpan(end_ts)
        if key == 'week':
            week_start = to_int(self.config_dict.get('Station', {}).get('week_start', 6))
            return weeutil.weeutil.archiveWeekSpan(end_ts, week_start)
        if key == 'month':
            return weeutil.weeutil.archiveMonthSpan(end_ts)
        if key == 'year':
            return weeutil.weeutil.archiveYearSpan(end_ts)
        seconds = to_int(time_length)
        if not seconds or seconds <= 0:
            raise ValueError("bad time_length '%s'" % time_length)
        return weeutil.weeutil.TimeSpan(end_ts - seconds, end_ts)

    def _series(self, obs_type, timespan, db_manager):
        start_vt, stop_vt, data_vt = weewx.xtypes.get_series(obs_type, timespan,
                                                             db_manager)
        return start_vt.value, stop_vt.value, data_vt

    def _sector_labels(self, sectors):
        try:
            ordinates = option_as_list(
                self.skin_dict['Units']['Ordinates']['directions'])[:16]
        except KeyError:
            ordinates = DEFAULT_ORDINATES
        if len(ordinates) < 16:
            ordinates = DEFAULT_ORDINATES
        if 16 % sectors == 0:
            return ordinates[::16 // sectors], ordinates
        return ['%g°' % round(i * 360.0 / sectors, 1) for i in range(sectors)], ordinates

    # --------------------------------------------------------- the binning

    def _build_rose(self, rose_name, opts):
        db_manager = self.db_binder.get_manager(opts.get('data_binding', 'wx_binding'))
        end_ts = self._end_ts(db_manager)
        span = self._timespan(opts.get('time_length', 86400), end_ts)
        # A calendar period (this week, month ...) is still in progress, so the
        # data actually stops at end_ts, not at the end of the period.
        data_end = min(span.stop, end_ts)

        obs = opts.get('obs', 'windSpeed')
        dir_obs = opts.get('dir_obs', DIRECTION_FOR.get(obs, 'windDir'))
        sectors = to_int(opts.get('sectors', 16))
        if not sectors or sectors < 4 or sectors > 72:
            raise ValueError("sectors must be between 4 and 72, not %s" % sectors)
        calm = to_float(opts.get('calm_threshold', 0.0)) or 0.0
        by_time = opts.get('weighting', 'time').strip().lower() != 'samples'

        starts, stops, speed_vt = self._series(obs, span, db_manager)
        speed_vt = self.converter.convert(speed_vt)
        unit = speed_vt.unit
        speeds = speed_vt.value

        try:
            _, _, dir_vt = self._series(dir_obs, span, db_manager)
            dirs = dir_vt.value
        except weewx.UnknownType:
            dirs = [None] * len(speeds)
        if dir_obs != 'windDir' and speeds and all(d is None for d in dirs):
            # Many stations never record a gust direction; fall back.
            log.debug("No %s data for rose '%s'; using windDir", dir_obs, rose_name)
            dir_obs = 'windDir'
            _, _, dir_vt = self._series(dir_obs, span, db_manager)
            dirs = dir_vt.value

        # Align on length, defensively.
        n = min(len(speeds), len(dirs), len(starts), len(stops))

        valid = sorted(s for s in speeds[:n] if s is not None)
        max_speed = valid[-1] if valid else None
        # Automatic bands are sized from the 99th percentile rather than the
        # maximum, so one freak gust does not squash everything else into
        # the first band.
        p99 = valid[min(len(valid) - 1, int(0.99 * len(valid)))] if valid else None

        edges, bands = self._bands(opts, unit, p99, calm)
        nbands = len(bands)

        petals = [[0.0] * nbands for _ in range(sectors)]
        calm_w = no_dir_w = missing_w = 0.0
        speed_sum = speed_w = 0.0
        width = 360.0 / sectors
        samples = 0
        for i in range(n):
            w = (stops[i] - starts[i]) if by_time else 1.0
            if w <= 0:
                w = 1.0 if not by_time else 0.0
            s = speeds[i]
            if s is None:
                missing_w += w
                continue
            samples += 1
            speed_sum += s * w
            speed_w += w
            if s <= calm:
                calm_w += w
                continue
            d = dirs[i]
            if d is None:
                no_dir_w += w
                continue
            sector = int(((d % 360.0) + width / 2.0) // width) % sectors
            petals[sector][bisect.bisect_right(edges, s)] += w

        total = calm_w + sum(map(sum, petals))
        if beaufort_mode(opts):
            # Drop empty forces at the top so the legend stops where the data does.
            used = [b for b in range(nbands) if any(p[b] for p in petals)]
            keep = (max(used) + 1) if used else 1
            bands = bands[:keep]
            petals = [p[:keep] for p in petals]

        frac = (lambda x: round(x / total, 6)) if total else (lambda x: 0.0)
        sector_totals = [sum(p) for p in petals]
        prevailing = (max(range(sectors), key=lambda k: sector_totals[k])
                      if total and any(sector_totals) else None)
        sector_labels, ordinates = self._sector_labels(sectors)

        stamp_fmt = opts.get('time_stamp', '%d %b %Y %H:%M')
        unit_label = self.formatter.get_label_string(unit).strip()
        obs_label = _plain(self.skin_dict.get('Labels', {}).get('Generic', {}).get(obs, obs))

        return {
            'schema': SCHEMA_VERSION,
            'generator': '%s %s' % (GENERATOR_NAME, VERSION),
            'name': rose_name,
            'label': opts.get('label', rose_name),
            'obs': obs,
            'obs_label': obs_label,
            'dir_obs': dir_obs,
            'unit': unit,
            'unit_label': unit_label,
            'start': span.start,
            'end': data_end,
            'period_end': span.stop,
            'generated': int(time.time()),
            'time_stamp': time.strftime(stamp_fmt, time.localtime(data_end)) if stamp_fmt else None,
            'weighting': 'time' if by_time else 'samples',
            'sectors': sectors,
            'sector_labels': sector_labels,
            'cardinals': [ordinates[0], ordinates[4], ordinates[8], ordinates[12]],
            'bands': bands,
            'calm': {'threshold': calm, 'fraction': frac(calm_w)},
            'petals': [[frac(v) for v in p] for p in petals],
            'samples': samples,
            'records': n,
            'missing_fraction': round(missing_w / (total + no_dir_w + missing_w), 6)
                                if (total + no_dir_w + missing_w) else 0.0,
            'no_direction_fraction': round(no_dir_w / (total + no_dir_w), 6)
                                     if (total + no_dir_w) else 0.0,
            'max_speed': _round(max_speed),
            'mean_speed': _round(speed_sum / speed_w) if speed_w else None,
            'prevailing': sector_labels[prevailing] if prevailing is not None else None,
            'prevailing_index': prevailing,
            'colors': option_as_list(opts['petal_colors']) if opts.get('petal_colors') else None,
            'calm_color': opts.get('calm_color') or None,
            'radial_scale': opts.get('radial_scale', 'linear'),
            'petal_width': to_float(opts.get('petal_width', 0.85)),
        }

    def _bands(self, opts, unit, top_speed, calm):
        """Return (edges, bands).

        edges are the ascending lower bounds of every band except the first,
        so bisect_right(edges, speed) gives a speed's band index.  bands is the
        JSON description of each band: lo, hi (None when open-ended) and label.
        """
        spec = opts.get('speed_bands', 'auto')
        if isinstance(spec, (list, tuple)) and len(spec) == 1:
            spec = spec[0]

        if beaufort_mode(opts):
            edges = [weewx.units.convert((k, 'knot', 'group_speed'), unit)[0]
                     for k in BEAUFORT_KNOTS]
            bands = []
            lows = [None] + edges
            for force in range(len(lows)):
                lo = lows[force] if lows[force] is not None else calm
                hi = edges[force] if force < len(edges) else None
                bands.append({
                    'lo': _round(lo), 'hi': _round(hi),
                    'label': 'Force %d' % force,
                    'range': _range_label(lo, hi, unit),
                })
            return edges, bands

        if isinstance(spec, (list, tuple)) or (
                isinstance(spec, str) and spec.strip().lower() != 'auto'):
            values = spec if isinstance(spec, (list, tuple)) else spec.split(',')
            edges = sorted(float(v) for v in values if str(v).strip())
            if not edges:
                raise ValueError("speed_bands is empty")
        else:
            count = max(2, min(12, to_int(opts.get('auto_bands', 5)) or 5))
            # (count - 1) closed bands reach at least the 99th percentile;
            # the last, open band holds whatever is above.
            step = _nice_ceil(max(top_speed or 0.0, calm, 0.1) / (count - 1))
            edges = [_round(step * k) for k in range(1, count)]

        bands = []
        lows = [calm] + edges
        for b in range(len(lows)):
            lo = lows[b]
            hi = edges[b] if b < len(edges) else None
            label = _range_label(lo, hi, unit)
            bands.append({'lo': _round(lo), 'hi': _round(hi),
                          'label': label, 'range': label})
        return edges, bands


# ----------------------------------------------------------------- utilities

def beaufort_mode(opts):
    spec = opts.get('speed_bands', 'auto')
    if isinstance(spec, (list, tuple)):
        spec = spec[0] if len(spec) == 1 else ''
    return str(spec).strip().lower() == 'beaufort'


def _nice_ceil(x):
    if x <= 0:
        return 1.0
    exp = math.floor(math.log10(x))
    base = 10 ** exp
    for m in NICE_STEPS:
        if m * base >= x - 1e-9:
            return m * base
    return 10 * base


def _round(x, places=2):
    if x is None:
        return None
    r = round(float(x), places)
    return int(r) if r == int(r) else r


def _fmt(x):
    return ('%.1f' % x).rstrip('0').rstrip('.') if x is not None else ''


def _range_label(lo, hi, unit):
    if hi is None:
        return '≥ %s' % _fmt(lo)
    return '%s–%s' % (_fmt(lo), _fmt(hi))


def _plain(s):
    """Strip any HTML entities WeeWX labels sometimes carry, e.g. '&deg;'."""
    import html
    return html.unescape(str(s)) if s is not None else ''


def _write_json(path, payload):
    """Write JSON atomically so a web server never serves a half file."""
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix='.swr26-', suffix='.json', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
