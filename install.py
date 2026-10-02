"""
Installer for weewx-stackedwindrose26, a D3 stacked wind rose for WeeWX 5.

    weectl extension install weewx-stackedwindrose26-1.0.0.zip

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 3 of the License, or (at your option) any later
version.
"""

import weewx
from weecfg.extension import ExtensionInstaller

REQUIRED_WEEWX = '5.0.0'
VERSION = '1.0.0'
REPORT = 'StackedWindRose26'


def loader():
    return StackedWindRose26Installer()


class StackedWindRose26Installer(ExtensionInstaller):
    def __init__(self):
        weewx.require_weewx_version('weewx-stackedwindrose26 %s' % VERSION,
                                    REQUIRED_WEEWX)
        super().__init__(
            version=VERSION,
            name='weewx-stackedwindrose26',
            description='Stacked wind rose for WeeWX 5, rendered in the browser with D3.',
            author='Ian Millard',
            author_email='',
            config={
                'StdReport': {
                    REPORT: {
                        'skin': REPORT,
                        'enable': 'true',
                        # weectl prepends the station's own HTML_ROOT, so this
                        # becomes public_html/windrose, /var/www/html/weewx/windrose ...
                        'HTML_ROOT': 'windrose',
                    }
                }
            },
            files=[
                ('bin/user', ['bin/user/stackedwindrose26.py']),
                ('skins/%s' % REPORT, [
                    'skins/%s/skin.conf' % REPORT,
                    'skins/%s/index.html' % REPORT,
                    'skins/%s/stackedwindrose26.css' % REPORT,
                ]),
                ('skins/%s/js' % REPORT, [
                    'skins/%s/js/d3.v7.min.js' % REPORT,
                    'skins/%s/js/stackedwindrose26.js' % REPORT,
                    'skins/%s/js/d3.LICENSE.txt' % REPORT,
                ]),
            ],
        )
