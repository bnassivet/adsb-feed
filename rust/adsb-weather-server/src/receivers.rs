//! Which receivers get a weather grid.
//!
//! Feeds announce their position (retained, `.../receiver/<id>`) and whether
//! they are up (retained, `.../receiver/<id>/availability`: `online` on
//! connect, `offline` as their last will). [`ActiveReceivers`] folds those
//! events and the clock into the set of sites to fetch weather for:
//!
//! - this service's own configured receiver, always;
//! - every other receiver with a known position that is online, or went
//!   offline less than the grace period ago;
//! - at most `max_receivers` in all, the most recently online first. Each
//!   grid costs Open-Meteo calls, and the free tier is per day.
//!
//! A receiver whose availability has never been seen is not active: being
//! "online on the bus" is the rule, and a retained announcement alone outlives
//! the feed that sent it.

use crate::grid::GridSpec;
use crate::refresh::ReceiverGrid;
use adsb_pulsar_client::config::receiver_from_topic;
use adsb_pulsar_client::forwarder::mqtt_forwarder::{AVAILABILITY_OFFLINE, AVAILABILITY_ONLINE};
use adsb_pulsar_client::receiver_location::ReceiverLocationMessage;
use std::collections::{BTreeMap, HashSet};
use tokio::sync::{mpsc, watch};
use tracing::warn;

/// A receiver that should have a grid.
#[derive(Debug, Clone, PartialEq)]
pub struct ReceiverSite {
    pub id: String,
    pub lat: f64,
    pub lon: f64,
}

/// What the bus said about a receiver.
#[derive(Debug, Clone, PartialEq)]
pub enum ReceiverEvent {
    Located { id: String, lat: f64, lon: f64 },
    Online { id: String },
    Offline { id: String },
}

/// Reads one publish under `prefix` (`.../receiver`) as an event. Anything
/// else -- another topic, a garbled payload, an unknown availability word --
/// is `None`.
pub fn parse_event(topic: &str, payload: &[u8], prefix: &str) -> Option<ReceiverEvent> {
    if let Some(id) = topic
        .strip_suffix("/availability")
        .and_then(|t| receiver_from_topic(t, prefix))
    {
        let id = id.to_string();
        return match payload {
            p if p == AVAILABILITY_ONLINE.as_bytes() => Some(ReceiverEvent::Online { id }),
            p if p == AVAILABILITY_OFFLINE.as_bytes() => Some(ReceiverEvent::Offline { id }),
            _ => None,
        };
    }
    let id = receiver_from_topic(topic, prefix)?;
    let msg = ReceiverLocationMessage::parse(payload).ok()?;
    Some(ReceiverEvent::Located {
        id: id.to_string(),
        lat: msg.latitude,
        lon: msg.longitude,
    })
}

#[derive(Debug, Clone, Default)]
struct Known {
    position: Option<(f64, f64)>,
    /// `None` until an availability message is seen.
    online: Option<bool>,
    /// When it was last known to be online (now, while it is).
    last_online_ms: i64,
}

/// The receivers to fetch weather for; see the module comment.
#[derive(Debug, Clone)]
pub struct ActiveReceivers {
    own: Option<ReceiverSite>,
    grace_ms: i64,
    max: usize,
    known: BTreeMap<String, Known>,
}

impl ActiveReceivers {
    /// `own` is this service's configured receiver, if it has a position.
    pub fn new(own: Option<ReceiverSite>, grace_ms: i64, max: usize) -> Self {
        Self {
            own,
            grace_ms,
            max: max.max(1),
            known: BTreeMap::new(),
        }
    }

    /// Records an event at `now_ms`.
    pub fn apply(&mut self, event: ReceiverEvent, now_ms: i64) {
        match event {
            ReceiverEvent::Located { id, lat, lon } => {
                self.known.entry(id).or_default().position = Some((lat, lon));
            }
            ReceiverEvent::Online { id } => {
                let k = self.known.entry(id).or_default();
                k.online = Some(true);
                k.last_online_ms = now_ms;
            }
            ReceiverEvent::Offline { id } => {
                let k = self.known.entry(id).or_default();
                // Seen going down: its grace starts now. Never seen up (a
                // retained "offline" at startup): it may have been down for
                // weeks, so it gets no grace at all.
                k.last_online_ms = if k.online == Some(true) {
                    now_ms
                } else {
                    i64::MIN / 2
                };
                k.online = Some(false);
            }
        }
    }

    /// The sites to fetch weather for at `now_ms`, own receiver first.
    pub fn active(&self, now_ms: i64) -> Vec<ReceiverSite> {
        let own_id = self.own.as_ref().map(|o| o.id.as_str());
        let mut others: Vec<(&String, &Known, (f64, f64))> = self
            .known
            .iter()
            .filter(|(id, _)| Some(id.as_str()) != own_id)
            .filter_map(|(id, k)| {
                let position = k.position?;
                let in_force = match k.online {
                    Some(true) => true,
                    Some(false) => now_ms - k.last_online_ms <= self.grace_ms,
                    None => false,
                };
                in_force.then_some((id, k, position))
            })
            .collect();
        // Online first, then the most recently online, then by id for a
        // stable order.
        others.sort_by(|a, b| {
            (b.1.online == Some(true))
                .cmp(&(a.1.online == Some(true)))
                .then(b.1.last_online_ms.cmp(&a.1.last_online_ms))
                .then(a.0.cmp(b.0))
        });

        let mut sites = Vec::with_capacity(self.max);
        if let Some(own) = &self.own {
            let (lat, lon) = self
                .known
                .get(&own.id)
                .and_then(|k| k.position)
                .unwrap_or((own.lat, own.lon));
            sites.push(ReceiverSite {
                id: own.id.clone(),
                lat,
                lon,
            });
        }
        let room = self.max.saturating_sub(sites.len());
        sites.extend(
            others
                .into_iter()
                .take(room)
                .map(|(id, _, (lat, lon))| ReceiverSite {
                    id: id.clone(),
                    lat,
                    lon,
                }),
        );
        sites
    }

    /// When the next receiver's grace period runs out after `now_ms`, so the
    /// caller can recompute the set then.
    pub fn next_expiry(&self, now_ms: i64) -> Option<i64> {
        let own_id = self.own.as_ref().map(|o| o.id.as_str());
        self.known
            .iter()
            .filter(|(id, k)| {
                Some(id.as_str()) != own_id && k.position.is_some() && k.online == Some(false)
            })
            .map(|(_, k)| k.last_online_ms.saturating_add(self.grace_ms) + 1)
            .filter(|&at| at > now_ms)
            .min()
    }
}

/// One grid per site, from `grid_for` (lat, lon). A site whose grid cannot be
/// built is skipped and logged, never fatal.
pub fn site_grids(
    sites: &[ReceiverSite],
    grid_for: impl Fn(f64, f64) -> Option<GridSpec>,
) -> Vec<ReceiverGrid> {
    sites
        .iter()
        .filter_map(|site| match grid_for(site.lat, site.lon) {
            Some(grid) => Some(ReceiverGrid {
                id: site.id.clone(),
                grid,
            }),
            None => {
                warn!(
                    "No weather grid for receiver '{}' at ({}, {})",
                    site.id, site.lat, site.lon
                );
                None
            }
        })
        .collect()
}

/// Distinct points across `grids`: what one cycle actually pays Open-Meteo
/// for, since shared lattice points are fetched once.
pub fn unique_points(grids: &[ReceiverGrid]) -> usize {
    let mut seen = HashSet::new();
    for g in grids {
        for (lat, lon) in g.grid.points() {
            seen.insert(((lat * 1e6).round() as i64, (lon * 1e6).round() as i64));
        }
    }
    seen.len()
}

/// Keeps `grids` equal to the grids of the active receivers, from bus events
/// and the clock, until `events` closes or `shutdown` turns true.
/// `on_change` sees every new set (for the budget log).
pub async fn follow(
    mut set: ActiveReceivers,
    mut events: mpsc::UnboundedReceiver<ReceiverEvent>,
    grid_for: impl Fn(f64, f64) -> Option<GridSpec>,
    grids: watch::Sender<Vec<ReceiverGrid>>,
    clock: fn() -> i64,
    on_change: impl Fn(&[ReceiverGrid]),
    mut shutdown: watch::Receiver<bool>,
) {
    let mut last: Option<Vec<ReceiverGrid>> = None;
    loop {
        let now = clock();
        let next = site_grids(&set.active(now), &grid_for);
        if last.as_ref() != Some(&next) {
            on_change(&next);
            grids.send_replace(next.clone());
            last = Some(next);
        }
        let expiry = set
            .next_expiry(now)
            .map(|at| std::time::Duration::from_millis((at - now).max(0) as u64));
        tokio::select! {
            event = events.recv() => match event {
                Some(event) => set.apply(event, clock()),
                None => return,
            },
            _ = tokio::time::sleep(expiry.unwrap_or_default()), if expiry.is_some() => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid_at(lat: f64, lon: f64) -> Option<GridSpec> {
        GridSpec::centered(lat, lon, 60.0, 1.0).ok()
    }

    #[test]
    fn each_site_gets_its_grid_and_an_unbuildable_one_is_skipped() {
        let sites = vec![
            ReceiverSite {
                id: "home".into(),
                lat: 46.7,
                lon: -2.3,
            },
            ReceiverSite {
                id: "broken".into(),
                lat: 95.0,
                lon: 0.0,
            },
        ];
        let grids = site_grids(&sites, grid_at);
        assert_eq!(grids.len(), 1);
        assert_eq!(grids[0].id, "home");
        assert_eq!(Some(grids[0].grid), grid_at(46.7, -2.3));
    }

    #[test]
    fn shared_lattice_points_count_once() {
        let a = ReceiverGrid {
            id: "a".into(),
            grid: grid_at(46.7, -2.3).unwrap(),
        };
        let b = ReceiverGrid {
            id: "b".into(),
            grid: grid_at(47.2, -1.5).unwrap(),
        };
        let alone = a.grid.len() + b.grid.len();
        let shared = unique_points(&[a.clone(), b]);
        assert!(shared < alone, "{shared} vs {alone}");
        assert_eq!(unique_points(&[a.clone(), a.clone()]), a.grid.len());
    }

    #[tokio::test(start_paused = true)]
    async fn follow_tracks_the_bus_and_expires_offline_receivers() {
        fn clock() -> i64 {
            tokio::time::Instant::now()
                .duration_since(START.with(|s| *s))
                .as_millis() as i64
        }
        thread_local! {
            static START: tokio::time::Instant = tokio::time::Instant::now();
        }
        START.with(|_| ());

        let (events, events_rx) = mpsc::unbounded_channel();
        let (grids_tx, mut grids) = watch::channel(Vec::new());
        let (_shutdown_tx, shutdown) = watch::channel(false);
        let set = ActiveReceivers::new(Some(own()), 60_000, 4);
        tokio::spawn(follow(
            set,
            events_rx,
            grid_at,
            grids_tx,
            clock,
            |_| {},
            shutdown,
        ));

        grids.changed().await.unwrap();
        assert_eq!(ids_of(&grids.borrow()), ["home"]);

        events.send(located("pi-a", 47.2)).unwrap();
        events.send(online("pi-a")).unwrap();
        grids.changed().await.unwrap();
        assert_eq!(ids_of(&grids.borrow()), ["home", "pi-a"]);

        events.send(offline("pi-a")).unwrap();
        // Still within the grace period: no change.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        assert_eq!(ids_of(&grids.borrow()), ["home", "pi-a"]);
        // Past it: the timer, not a new event, drops it.
        grids.changed().await.unwrap();
        assert_eq!(ids_of(&grids.borrow()), ["home"]);
    }

    fn ids_of(grids: &[ReceiverGrid]) -> Vec<&str> {
        grids.iter().map(|g| g.id.as_str()).collect()
    }

    const PREFIX: &str = "adsb/dev/receiver";
    const GRACE: i64 = 30 * 60_000;

    fn own() -> ReceiverSite {
        ReceiverSite {
            id: "home".into(),
            lat: 46.7,
            lon: -2.3,
        }
    }

    fn located(id: &str, lat: f64) -> ReceiverEvent {
        ReceiverEvent::Located {
            id: id.into(),
            lat,
            lon: -1.0,
        }
    }

    fn online(id: &str) -> ReceiverEvent {
        ReceiverEvent::Online { id: id.into() }
    }

    fn offline(id: &str) -> ReceiverEvent {
        ReceiverEvent::Offline { id: id.into() }
    }

    fn ids(sites: &[ReceiverSite]) -> Vec<&str> {
        sites.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn announcements_and_availability_parse_and_anything_else_does_not() {
        let msg = ReceiverLocationMessage {
            latitude: 47.0,
            longitude: -1.5,
            altitude_ft: None,
            since_ms: 1,
        };
        assert_eq!(
            parse_event("adsb/dev/receiver/pi-a", &msg.to_json(), PREFIX),
            Some(ReceiverEvent::Located {
                id: "pi-a".into(),
                lat: 47.0,
                lon: -1.5
            })
        );
        assert_eq!(
            parse_event("adsb/dev/receiver/pi-a/availability", b"online", PREFIX),
            Some(online("pi-a"))
        );
        assert_eq!(
            parse_event("adsb/dev/receiver/pi-a/availability", b"offline", PREFIX),
            Some(offline("pi-a"))
        );
        assert_eq!(
            parse_event("adsb/dev/receiver/pi-a/availability", b"maybe", PREFIX),
            None
        );
        assert_eq!(
            parse_event("adsb/dev/receiver/pi-a", b"{nope", PREFIX),
            None
        );
        assert_eq!(parse_event("adsb/dev/weather/grid", b"{}", PREFIX), None);
        assert_eq!(
            parse_event("adsb/dev/receiver/a/b/availability", b"online", PREFIX),
            None
        );
    }

    #[test]
    fn the_own_receiver_is_always_active() {
        let set = ActiveReceivers::new(Some(own()), GRACE, 4);
        assert_eq!(set.active(0), vec![own()]);
        assert!(ActiveReceivers::new(None, GRACE, 4).active(0).is_empty());
    }

    #[test]
    fn a_receiver_needs_a_position_and_to_be_online() {
        let mut set = ActiveReceivers::new(Some(own()), GRACE, 4);
        set.apply(located("pi-a", 47.0), 0);
        assert_eq!(
            ids(&set.active(0)),
            vec!["home"],
            "announced but never seen online"
        );
        set.apply(online("pi-b"), 0);
        assert_eq!(ids(&set.active(0)), vec!["home"], "online but no position");
        set.apply(online("pi-a"), 0);
        assert_eq!(ids(&set.active(0)), vec!["home", "pi-a"]);
    }

    #[test]
    fn availability_before_position_counts_once_the_position_arrives() {
        // Retained messages replay in no particular order.
        let mut set = ActiveReceivers::new(None, GRACE, 4);
        set.apply(online("pi-a"), 0);
        set.apply(located("pi-a", 47.0), 0);
        assert_eq!(ids(&set.active(0)), vec!["pi-a"]);
    }

    #[test]
    fn an_offline_receiver_keeps_its_grid_for_the_grace_period() {
        let mut set = ActiveReceivers::new(None, GRACE, 4);
        set.apply(located("pi-a", 47.0), 0);
        set.apply(online("pi-a"), 0);
        set.apply(offline("pi-a"), 1_000);
        assert_eq!(ids(&set.active(1_000 + GRACE)), vec!["pi-a"]);
        assert!(set.active(1_000 + GRACE + 1).is_empty());
        assert_eq!(set.next_expiry(5_000), Some(1_000 + GRACE + 1));
        set.apply(online("pi-a"), 2_000_000_000);
        assert_eq!(ids(&set.active(2_000_000_000)), vec!["pi-a"], "back online");
        assert_eq!(set.next_expiry(2_000_000_000), None);
    }

    #[test]
    fn a_retained_offline_at_startup_gets_no_grace() {
        // The feed may have been down for weeks: paying for its grid again on
        // every restart of this service would be waste.
        let mut set = ActiveReceivers::new(None, GRACE, 4);
        set.apply(located("pi-dead", 47.0), 0);
        set.apply(offline("pi-dead"), 0);
        assert!(set.active(0).is_empty());
        assert_eq!(set.next_expiry(0), None);
    }

    #[test]
    fn a_move_updates_the_site() {
        let mut set = ActiveReceivers::new(None, GRACE, 4);
        set.apply(located("pi-a", 47.0), 0);
        set.apply(online("pi-a"), 0);
        set.apply(located("pi-a", 48.0), 10);
        assert_eq!(set.active(10)[0].lat, 48.0);
    }

    #[test]
    fn the_own_receiver_announcing_itself_takes_the_announced_position() {
        let mut set = ActiveReceivers::new(Some(own()), GRACE, 4);
        set.apply(located("home", 50.0), 0);
        let active = set.active(0);
        assert_eq!(ids(&active), vec!["home"], "not twice");
        assert_eq!(active[0].lat, 50.0);
    }

    #[test]
    fn the_cap_keeps_the_own_receiver_then_the_most_recently_online() {
        let mut set = ActiveReceivers::new(Some(own()), GRACE, 3);
        for (id, t) in [("pi-a", 10), ("pi-b", 30), ("pi-c", 20)] {
            set.apply(located(id, 47.0), t);
            set.apply(online(id), t);
        }
        assert_eq!(ids(&set.active(40)), vec!["home", "pi-b", "pi-c"]);
        // Online beats recently-offline, whatever the times.
        set.apply(offline("pi-b"), 50);
        assert_eq!(ids(&set.active(60)), vec!["home", "pi-c", "pi-a"]);
    }
}
