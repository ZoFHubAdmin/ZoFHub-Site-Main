# Thumbnail scrape audit

- games processed: **6**
- fixed: **2**
- still missing: **4**
- hard timeouts: **0**

## Which layer succeeded

| layer | wins |
|---|---|
| L4 screenshot | 1 |

## Fixed

| slug | layer |
|---|---|
| attractive | L4 screenshot |
| bloxd-io | L1 og:image (resolved by hand, 2026-07-28) |

`bloxd-io` was previously reported here as `licence-blocked`. That was based on a
ToS quote that turned out not to be in Bloxd's terms at all — see the corrected
`risk_flags` in `data/games-manifest.json`. It is now served from Bloxd LTD's own
og:image, self-hosted at `/thumbs/bloxd-io.jpg`.

## Still missing

| slug | reason |
|---|---|
| vex-x3m | all layers exhausted (set GD_FEED_URL to fix) |
| purple-clicker-game | all layers exhausted |
| green-clicker-game | all layers exhausted |
| suroi | all layers exhausted (robots.txt disallows; needs a self-made screenshot) |

## Hard timeouts

_none_
