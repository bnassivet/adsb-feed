# Weather grid around each active receiver

## Context

The weather service builds **one** grid from its configured `[receiver]` at
startup and publishes it to one retained topic, `adsb/<stage>/weather/grid`.
Since receivers became data (plan 2026-11-23), a recorder can hold several
receivers, each with an announced position. Every receiver except the
configured one therefore has no weather, and the desktop's weather layer stops
matching the Receiver selector.

**Decisions (user, 2026-11-24):**
- **Active** = a position is announced AND the feed is online on the bus
  (retained availability with an `offline` last will). A receiver offline for
  longer than a grace period stops costing Open-Meteo calls.
- **One grid per receiver**, published retained to
  `adsb/<stage>/weather/grid/<id>` and recorded under that receiver's id. Shared
  lattice points are fetched once. The configured receiver's grid **also** stays
  on the existing topic, so existing desktops and recorders keep working.
- **Desktop** draws the selected receiver's grid, falling back to the grid on
  the existing topic.

## Design

### Feed: availability (adsb-pulsar-client)

- `Config::receiver_availability_topic()` = `adsb/<stage>/receiver/<id>/availability`.
  It sits one level below the announcement, so the `receiver/+` announcement
  filter never matches it.
- The forwarder sets a retained last will of `offline` there, and publishes
  `online`, retained, on every ConnAck, beside the announcement. The pattern is
  the one the weather service already uses for itself.

### Weather service: the active set (adsb-weather-server)

- **New module `receivers.rs`, pure.** `ActiveReceivers` folds
  announcement/availability events and the clock into the set of
  `(id, lat, lon)` that should have a grid:
  - announced + online;
  - offline for at most `offline_grace_minutes` (default 30);
  - capped at `max_receivers` (default 4, most recently online first). The
    cap protects the free tier.
  - The configured receiver is always in the set, even with no announcement,
    keyed by `source_id`.
- **Subscriptions.** The service subscribes to `receiver/+` and
  `receiver/+/availability` on its existing connection and feeds the set. The
  publisher module already owns that connection and its reconnect logic.
- **Grids.** `GridSpec::centered` per receiver, unchanged. A change of set (new
  receiver, moved position, expiry) logs the budget for the union of unique
  points and wakes the refresher.

### Weather service: fetching once per point

- **Refactor 1, the provider's partial-fetch cache becomes point-keyed.** It is
  keyed by `(rounded lat, lon)` per model hour instead of by request URL.
  `fetch(grid)` requests only the points it lacks, chunked as today, then
  assembles the snapshot from the cache. Overlapping grids, and the retry after
  a partial failure, both stop paying twice. The `WeatherProvider` trait is
  unchanged.
- **Refactor 2, the refresher refreshes a set.** `Refresher` holds a
  `watch::Receiver<Vec<ReceiverGrid>>` instead of one `GridSpec`, and one cycle
  fetches every grid in turn. The state machine (enable/disable, rate limit,
  backoff, status) stays as it is. A cycle succeeds if every grid fetched; a
  rate limit stops the cycle and keeps the grids already done. The snapshot
  channel becomes `watch<BTreeMap<id, WeatherSnapshot>>`. The cache file holds
  the map, and an old single-snapshot cache is still read.
- **Status.** `WeatherStatus` gains `grids: Vec<{id, points, valid_time_ms}>`, an
  additive field the OpenAPI document picks up.

### Weather service: publishing

- **Refactor 3.** `publisher::run` publishes each snapshot, retained, to
  `adsb/<stage>/weather/grid/<id>`, and the configured receiver's also to
  `adsb/<stage>/weather/grid`. Status and availability are unchanged.
  `WeatherTopics` gains `grid_for(id)`.
- An expired receiver's retained grid is left in place: it is still that
  site's last valid weather, and carries its own valid time.

### Recorder (adsb-data-server, adsb-data-engine)

- **Refactor 4, keyed aux topics in `MqttSource`.**
  `with_keyed_aux(prefix) -> watch::Receiver<BTreeMap<String, Vec<u8>>>`
  delivers `<prefix>/<key>` payloads whole, latest per key. Exact aux topics
  are unchanged.
- `persist_weather` reads the keyed map and stores each grid with
  `insert_weather_snapshot_for(source_id)`; the existing dedupe on
  `(source_id, valid_time)` applies. The legacy topic stays recorded under the
  recorder's own id; when that id is the configured receiver's, it is the same
  row.

### Desktop

- The bridge subscribes to `weather/grid/+` as well as the legacy topic and
  relays snapshots tagged with the receiver id (`adsb:weather-snapshot`
  payload gains `receiver`).
- `useWeatherSnapshot` keeps a map per receiver and returns the selected
  receiver's, else the legacy one.
- Historical weather (`getWeatherAt`) passes the selected receiver's
  `source_id` when the database knows it, else null as today.
- The weather status card lists the grids.

### Config

- `[weather] max_receivers = 4`, `offline_grace_minutes = 30`, in the template
  and rendered to `weather.toml`. `follow_receivers = true` (rendered;
  `false` = today's behaviour, configured receiver only).

## Phases (TDD, one cycle per commit)

1. Feed availability (topic, last will, `online` on connect).
2. `ActiveReceivers` (pure) plus config.
3. Point-keyed provider cache.
4. Refresher over a grid set, map snapshot channel, cache file compatibility, status `grids`.
5. Publisher per-receiver topics plus legacy topic, and the service wiring in `main.rs`.
6. `MqttSource::with_keyed_aux`; recorder records each grid under its receiver.
7. Desktop: bridge relay with receiver id, `useWeatherSnapshot` per receiver, historical weather `source_id`, status card.
8. Docs (DESIGN.md Weather Layer, QUICKSTART §6, CLAUDE.md), then `graphify update .`.

## Verification

- **Unit tests.** Active set: online/offline/grace/cap/configured always in.
  Point cache: overlapping grids fetch each point once; a partial failure
  retries only the missing points. Refresher: two grids, rate limit
  mid-cycle. Publisher topics. Keyed aux routing. Recorder stores two
  receivers' grids.
- **End to end.** A second mock feed with another id and position produces a
  second grid topic (`mosquitto_sub -v -t 'adsb/dev/weather/grid/#'`). `make
  receivers` and the desktop selector switch the drawn weather. Stopping the
  mock feed drops its grid from `make weather-status` after the grace period.
