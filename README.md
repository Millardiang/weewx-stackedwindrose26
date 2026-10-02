# weewx-stackedwindrose26

A stacked wind rose for **WeeWX 5**, drawn in the browser with **D3 v7**.

It is a modern successor to the
[StackedWindRose image generator](https://github.com/weewx-contrib/stackedwindrose-extension)
by Gary Roderick. The old extension painted a fixed-size PNG with PIL; this one
splits the job in two:

* a small report generator bins your archive into direction sectors and speed
  bands and writes one JSON file per rose;
* the skin renders those files as crisp, responsive SVG with hover and keyboard
  readouts, a legend, a data table, and automatic light/dark themes.

No fonts to find, no image sizes to tune, no Pillow.

## Requirements

* WeeWX 5.0 or later (tested on 5.0.2 and 5.5.2; honours the 5.5 stop event)
* Python 3.7 or later
* Nothing else. D3 7.9.0 is bundled, so pages work on stations without internet.

## Install

```sh
weectl extension install weewx-stackedwindrose26-1.0.0.zip
sudo systemctl restart weewx      # or however you restart weewxd
```

After the next report cycle, open `<your web root>/windrose/`, for example
`http://your-station/weewx/windrose/`. The installer adds this to `weewx.conf`:

```ini
[StdReport]
    [[StackedWindRose26]]
        skin = StackedWindRose26
        enable = true
        HTML_ROOT = public_html/windrose    # your own HTML_ROOT + /windrose
```

To test without waiting: `weectl report run StackedWindRose26`.

To remove: `weectl extension uninstall weewx-stackedwindrose26`.

## What you get

```
windrose/
    index.html                  the wind rose page (period switcher, stats, table)
    stackedwindrose26.css
    stackedwindrose26.json      manifest: station + list of roses
    data/day.json  week.json  month.json  year.json
    js/d3.v7.min.js  js/stackedwindrose26.js
```

The page remembers the chosen period in the URL (`index.html#year`) and
refreshes its data every five minutes.

## Configuration

Defaults live in `skins/StackedWindRose26/skin.conf`, where every option is
commented. Put your changes in `weewx.conf` so upgrades keep them:

```ini
[StdReport]
    [[StackedWindRose26]]
        skin = StackedWindRose26
        HTML_ROOT = public_html/windrose
        [[[Units]]]
            [[[[Groups]]]]
                group_speed = knot
        [[[StackedWindRose26]]]
            speed_bands = 5, 10, 15, 20, 25     # fixed bands, comparable across periods
            [[[[gust_month]]]]
                label = Gusts this month
                obs = windGust
                time_length = month
                speed_bands = beaufort
```

| Option | Default | Meaning |
|---|---|---|
| `sectors` | `16` | Direction sectors, 4 to 72. Divisors of 16 get compass labels, others degrees. |
| `speed_bands` | `auto` | `auto`, `beaufort`, or a list of band edges in the display unit. |
| `auto_bands` | `5` | Band count for `auto`. Bands are sized from the 99th percentile speed, so one freak gust doesn't flatten the rose. |
| `calm_threshold` | `0` | Speeds at or below this are calm and shown in the hub. |
| `weighting` | `time` | `time` weights each record by its interval; `samples` counts records, as the original did. |
| `radial_scale` | `linear` | `sqrt` makes petal area, rather than length, track frequency, so small directions stay visible. |
| `petal_width` | `0.85` | Petal width as a fraction of its sector. |
| `petal_colors` | built-in ramp | Any CSS colours, slowest band first. Interpolated if there are fewer colours than bands. |
| `calm_color` | theme grey | Hub colour. |
| `time_stamp` | `%d %b %Y %H:%M` | strftime format of the "Data to" stamp. |
| `data_dir` | `data` | Folder for the JSON, under the report's HTML_ROOT. |
| `data_binding` | `wx_binding` | Database binding. |

Each subsection of `[StackedWindRose26]` is one rose. Per-rose options:

| Option | Meaning |
|---|---|
| `label` | Title, also used on the period button. |
| `time_length` | Seconds ending at report time (rolling), or `day`, `week`, `month`, `year` for the calendar period so far. `week` follows `[Station] week_start`. |
| `obs` | `windSpeed` (default) or `windGust`. |
| `dir_obs` | Direction observation. Defaults to `windDir`, or `windGustDir` for gusts; falls back to `windDir` when the gust direction is empty, as it is on many stations. |
| `stale_age` | Skip regenerating while the file is younger than this many seconds. The bundled week/month/year roses use it. |

Any global option can also be set inside a rose to override it there.

### Moving from the old StackedWindRose

| Old (`StackedWindRoseImageGenerator`) | New |
|---|---|
| `[[day_images]] time_length` + `[[[daywindrose]]]` + `[[[[windSpeed]]]]` | one section `[[day]]` with `time_length` and `obs` |
| `label` | `label` |
| `windrose_plot_petal_colors` | `petal_colors` (first colour was calm; now calm is `calm_color`) |
| `windrose_plot_petal_width` (degrees) | `petal_width` (fraction of sector) |
| speed bands at 10/20/30/50/70/100% of max | `speed_bands = auto` (rounded widths) or your own list |
| `image_*`, `windrose_font_*`, `*_font_color` | gone - size and style come from the page's CSS |
| `time_stamp_location` | gone - the stamp sits under the rose |
| `[Labels] compass_points` | taken from WeeWX's own `[Units] [[Ordinates]] directions`, so they follow your skin language |

The two extensions can be installed side by side.

## Putting a rose on another page

Any page that can load the script can show a rose, for example the Seasons
skin's `index.html.tmpl`:

```html
<link rel="stylesheet" href="windrose/stackedwindrose26.css">
<div data-swr26-src="windrose/data/day.json" data-swr26-theme="light"></div>
<script src="windrose/js/d3.v7.min.js"></script>
<script src="windrose/js/stackedwindrose26.js"></script>
```

Attributes:

* `data-swr26-legend="false"` hides the legend
* `data-swr26-table="true"` adds the data table
* `data-swr26-theme="light"` or `"dark"` pins the colour scheme (otherwise it
  follows the viewer's system setting, or `<html data-theme="...">` if your skin
  sets one)

From script:

```js
const rose = await StackedWindRose26.load(element, 'windrose/data/week.json', { legend: true });
rose.update(otherData);   // animates to the new data
```

### Styling

All colours are CSS custom properties on `.swr26`, for example:

```css
.swr26 {
  --swr-ramp-1: #fde68a; --swr-ramp-2: #fbbf24; --swr-ramp-3: #f97316;
  --swr-ramp-4: #dc2626; --swr-ramp-5: #7f1d1d;
  --swr-calm: #e5e7eb; --swr-plot: #ffffff;
}
```

`--swr-ramp-1` to `--swr-ramp-5` are anchors; the script interpolates between
them for any number of bands. The default ramp is a single blue hue, light to
dark (reversed for dark mode so the strongest winds stay the most prominent),
checked for step separation and contrast against both backgrounds.

## Reading the rose

Each petal points to the direction the wind blew **from**. Its length is the
share of the period the wind came from that sector; the coloured segments split
that share by speed, slowest nearest the centre. Calm time sits in the hub.
Percentages are of all valid observations, so petals plus calm add to 100%.
Records with a speed but no direction are left out and reported under the rose.

Hover a petal (or focus the rose and use the arrow keys) to read every band for
that direction; hover a legend entry to isolate a band.

## JSON format

Each `data/<name>.json` holds `bands` (each with `lo`, `hi`, `label`),
`petals` (one array per sector, one fraction per band), `calm.fraction`,
`sector_labels`, `unit`/`unit_label`, `start`/`end` (epoch seconds), and
summary values: `prevailing`, `mean_speed`, `max_speed`, `samples`,
`missing_fraction`. It is stable (`"schema": 1`) and handy for your own charts.

## Credits and licence

Original StackedWindRose image generator © 2013-2020 Gary Roderick, kept alive
by weewx-contrib. This rewrite is GPL-3.0-or-later, like the original
generator. D3 is © Mike Bostock, ISC licence (`js/d3.LICENSE.txt`).
