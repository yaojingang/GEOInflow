# Third-party notices

Liekan application source is distributed under the MIT license. The complete application copyright and license are retained in LICENSE. Dependency and data licenses remain in force independently.

| Component | License / attribution | Use |
| --- | --- | --- |
| Apache ECharts 6.1.0 (runtime), 5.5.0 (design references) | Apache-2.0; shared license text in public/liekan/licenses/echarts-5.5.0-APACHE-2.0.txt; runtime NOTICE retained in node_modules/echarts/NOTICE | Report rendering with v5 appearance and preserved prototype references |
| Inter | SIL Open Font License 1.1; public/liekan/licenses/Inter-OFL-1.1.txt | Locally served font |
| detect-browser | MIT; bundled dependency license | Browser recognition |
| GeoLite2 City | MaxMind GeoLite2 data terms; https://www.maxmind.com/en/geolite2/eula | Optional external geography database, inherited local data copy |
| DB-IP City Lite | CC BY 4.0; https://creativecommons.org/licenses/by/4.0/; data by https://db-ip.com | Default account-free geography database, downloaded from https://db-ip.com/db/download/ip-to-city-lite; product and share pages retain attribution |
| MaxMind-DB City test fixture | MIT option; tests/liekan/fixtures/LICENSE-MIT; copyright MaxMind, Inc. | Synthetic deployment test data from https://github.com/maxmind/MaxMind-DB; excluded from the application image |
| pg-boss 12.36.0 | MIT, retained package LICENSE | Durable PostgreSQL queue and controlled queue bootstrap |
| node-postgres (pg) 8.23.1 | MIT, retained package LICENSE | Queue initialization and isolated integration verification |
| Node.js 22.23.4 | Node.js and bundled third-party licenses, LICENSE retained inside each collector archive | Linux collector runtime |
| IANA Time Zone Database 2026e | Public domain for the used timezone data files; https://data.iana.org/time-zones/tzdb/LICENSE | Country/timezone choices and aliases generated from the official archive; source hashes and local country mappings are recorded in src/lib/liekan/contracts/country-timezones.json |
| Official crawler IP ranges | Public provider data, source URLs and retrieval dates in config/liekan/bot-ranges.json | Time-bounded identity verification |

The direct ua-parser-js dependency has been removed. Next.js may bundle a separate ua-parser-js 1.x implementation with its own MIT notice. The application MIT license does not change the licenses of Next.js, ECharts, fonts, geography data or other dependencies. A clean open-source release must retain their notices and exclude private configuration, database backups and non-distributable data.
The installed dependency inventory is provided inside the image at public/liekan/licenses/dependencies.json. Package LICENSE/COPYING notices remain in node_modules, and the inventory is regenerated for the Linux image. The libvips shared library used for Next.js image processing is licensed LGPL-3.0-or-later; its source and license links are provided by @img/sharp-libvips. The library remains a separate file in node_modules. JSZip is used under its MIT license option.


## ip2region.js 3.1.8

Copyright 2022 The Ip2Region Authors. The binding is used unchanged for offline IPv4 and IPv6 lookup. The upstream software license is Apache-2.0 OR MIT; this distribution retains the full upstream license in public/liekan/licenses/ip2region-LICENSE.md. The npm 3.1.8 package metadata declares ISC, while its source headers declare Apache-2.0. The upstream license and original copyright notices are retained. Database permissions are verified separately. No XDB database is included in this distribution.

Upstream: https://github.com/lionsoul2014/ip2region/blob/master/LICENSE.md

## Application license and data boundaries

The application and project documentation use the MIT license in LICENSE, retaining the Umami and Liekan copyright notices. The [Open Source Initiative MIT text](https://opensource.org/license/mit) describes the license permissions and notice condition. The application license leaves third-party license terms in force.

DB-IP City Lite remains subject to [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), including attribution, the license link and identification of changes when applicable. MaxMind and other privately supplied geography databases follow their own data terms. Runtime databases, private configuration, signing keys and third-party data without redistribution permission are outside the source release.
