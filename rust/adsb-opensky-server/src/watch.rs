//! The watch set: what clients have asked the service to poll, as leases.
//!
//! In memory only, by design. Each client's request replaces its previous one
//! and lapses `lease` after it was made unless renewed. The poller works on the
//! **union** of the live leases; an empty union means no polling at all, so a
//! service nobody is looking at spends nothing.

use crate::api::{Area, WatchRequest};
use std::collections::{BTreeMap, BTreeSet};

/// Limits a request must respect, whatever the client sends.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WatchLimits {
    /// Aircraft per client, and in the union.
    pub max_icao: usize,
    /// Areas per client, and in the union.
    pub max_areas: usize,
    /// Largest area accepted, square degrees.
    pub max_area_sq_deg: f64,
}

impl Default for WatchLimits {
    fn default() -> Self {
        Self {
            max_icao: 20,
            max_areas: 4,
            max_area_sq_deg: 100.0,
        }
    }
}

/// Why a watch request was refused. Nothing is changed when it is.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum WatchError {
    #[error("'{0}' is not an ICAO 24-bit address (six hex digits)")]
    BadIcao(String),
    #[error("{count} aircraft requested, at most {max} are watched per client")]
    TooManyAircraft { count: usize, max: usize },
    #[error("{count} areas requested, at most {max} are watched per client")]
    TooManyAreas { count: usize, max: usize },
    #[error("{0}")]
    BadArea(String),
    #[error("area '{id}' is {sq_deg:.0} square degrees; at most {max:.0} are accepted")]
    AreaTooLarge { id: String, sq_deg: f64, max: f64 },
    #[error("a client id must be 1 to 64 letters, digits, '-', '_' or '.'")]
    BadClientId,
}

/// One client's normalised request and when it lapses.
#[derive(Debug, Clone, PartialEq)]
struct Lease {
    icao24: BTreeSet<String>,
    areas: Vec<Area>,
    expires_ms: i64,
}

/// What the poller polls: every live lease merged.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WatchUnion {
    /// Lowercase, sorted, deduplicated.
    pub icao24: Vec<String>,
    /// Deduplicated by id; the first client to name an id wins.
    pub areas: Vec<Area>,
    /// Clients with a live lease.
    pub clients: usize,
}

impl WatchUnion {
    pub fn is_empty(&self) -> bool {
        self.icao24.is_empty() && self.areas.is_empty()
    }
}

/// Validates a client id: it goes in a URL path and in logs.
pub fn valid_client_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Normalises an icao24: trimmed, lowercased, six hex digits.
pub fn normalise_icao(raw: &str) -> Result<String, WatchError> {
    let s = raw.trim().to_ascii_lowercase();
    if s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(s)
    } else {
        Err(WatchError::BadIcao(raw.to_string()))
    }
}

/// The live leases.
#[derive(Debug, Clone)]
pub struct WatchSet {
    limits: WatchLimits,
    lease_ms: i64,
    leases: BTreeMap<String, Lease>,
}

impl WatchSet {
    pub fn new(limits: WatchLimits, lease_ms: i64) -> Self {
        Self {
            limits,
            lease_ms,
            leases: BTreeMap::new(),
        }
    }

    pub fn limits(&self) -> WatchLimits {
        self.limits
    }

    pub fn lease_ms(&self) -> i64 {
        self.lease_ms
    }

    /// Replaces `client`'s request. Returns the aircraft and area counts kept.
    ///
    /// All or nothing: a request with one bad entry is refused whole, so the
    /// client never believes it is watching something it is not.
    pub fn put(
        &mut self,
        client: &str,
        request: &WatchRequest,
        now_ms: i64,
    ) -> Result<(usize, usize), WatchError> {
        if !valid_client_id(client) {
            return Err(WatchError::BadClientId);
        }
        let icao24 = request
            .icao24
            .iter()
            .map(|h| normalise_icao(h))
            .collect::<Result<BTreeSet<_>, _>>()?;
        if icao24.len() > self.limits.max_icao {
            return Err(WatchError::TooManyAircraft {
                count: icao24.len(),
                max: self.limits.max_icao,
            });
        }
        if request.areas.len() > self.limits.max_areas {
            return Err(WatchError::TooManyAreas {
                count: request.areas.len(),
                max: self.limits.max_areas,
            });
        }
        for area in &request.areas {
            if let Some(problem) = area.problem() {
                return Err(WatchError::BadArea(problem));
            }
            let sq_deg = area.square_degrees();
            if sq_deg > self.limits.max_area_sq_deg {
                return Err(WatchError::AreaTooLarge {
                    id: area.id.clone(),
                    sq_deg,
                    max: self.limits.max_area_sq_deg,
                });
            }
        }
        let counts = (icao24.len(), request.areas.len());
        if icao24.is_empty() && request.areas.is_empty() {
            self.leases.remove(client);
        } else {
            self.leases.insert(
                client.to_string(),
                Lease {
                    icao24,
                    areas: request.areas.clone(),
                    expires_ms: now_ms + self.lease_ms,
                },
            );
        }
        Ok(counts)
    }

    /// Drops `client`'s request. True if there was one.
    pub fn remove(&mut self, client: &str) -> bool {
        self.leases.remove(client).is_some()
    }

    /// Drops lapsed leases. True if any were dropped.
    pub fn expire(&mut self, now_ms: i64) -> bool {
        let before = self.leases.len();
        self.leases.retain(|_, l| l.expires_ms > now_ms);
        self.leases.len() != before
    }

    /// When the next lease lapses, if any is live.
    pub fn next_expiry(&self) -> Option<i64> {
        self.leases.values().map(|l| l.expires_ms).min()
    }

    /// Every live lease merged, capped at the limits: several clients cannot
    /// together make one poll cost more than one client could.
    pub fn union(&self, now_ms: i64) -> WatchUnion {
        let live: Vec<&Lease> = self
            .leases
            .values()
            .filter(|l| l.expires_ms > now_ms)
            .collect();
        let icao24: BTreeSet<&String> = live.iter().flat_map(|l| &l.icao24).collect();
        let mut seen = BTreeSet::new();
        let areas: Vec<Area> = live
            .iter()
            .flat_map(|l| &l.areas)
            .filter(|a| seen.insert(a.id.clone()))
            .take(self.limits.max_areas)
            .cloned()
            .collect();
        WatchUnion {
            icao24: icao24
                .into_iter()
                .take(self.limits.max_icao)
                .cloned()
                .collect(),
            areas,
            clients: live.len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEASE: i64 = 60_000;

    fn set() -> WatchSet {
        WatchSet::new(WatchLimits::default(), LEASE)
    }

    fn area(id: &str, side: f64) -> Area {
        Area {
            id: id.into(),
            north: 46.0 + side,
            south: 46.0,
            east: -2.0 + side,
            west: -2.0,
        }
    }

    fn req(icao: &[&str], areas: Vec<Area>) -> WatchRequest {
        WatchRequest {
            icao24: icao.iter().map(|s| s.to_string()).collect(),
            areas,
        }
    }

    #[test]
    fn a_request_is_normalised() {
        let mut w = set();
        let counts = w
            .put("laptop", &req(&[" 3C6444", "3c6444", "39de4f"], vec![]), 0)
            .unwrap();
        assert_eq!(counts, (2, 0));
        assert_eq!(w.union(1).icao24, ["39de4f", "3c6444"]);
    }

    #[test]
    fn a_bad_entry_refuses_the_whole_request() {
        let mut w = set();
        w.put("laptop", &req(&["3c6444"], vec![]), 0).unwrap();
        let err = w.put("laptop", &req(&["39de4f", "SIM-0001"], vec![]), 1);
        assert!(matches!(err, Err(WatchError::BadIcao(_))));
        // The previous request stands.
        assert_eq!(w.union(2).icao24, ["3c6444"]);
    }

    #[test]
    fn limits_are_enforced() {
        let mut w = set();
        let many: Vec<String> = (0..21).map(|i| format!("{i:06x}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(matches!(
            w.put("c", &req(&many, vec![]), 0),
            Err(WatchError::TooManyAircraft { count: 21, max: 20 })
        ));
        let areas = (0..5).map(|i| area(&format!("a{i}"), 1.0)).collect();
        assert!(matches!(
            w.put("c", &req(&[], areas), 0),
            Err(WatchError::TooManyAreas { .. })
        ));
        assert!(matches!(
            w.put("c", &req(&[], vec![area("big", 11.0)]), 0),
            Err(WatchError::AreaTooLarge { .. })
        ));
        let inverted = Area {
            north: 40.0,
            ..area("inv", 1.0)
        };
        assert!(matches!(
            w.put("c", &req(&[], vec![inverted]), 0),
            Err(WatchError::BadArea(_))
        ));
    }

    #[test]
    fn a_client_id_must_be_safe_for_a_path() {
        let mut w = set();
        assert_eq!(
            w.put("../etc", &req(&["3c6444"], vec![]), 0),
            Err(WatchError::BadClientId)
        );
        assert!(valid_client_id("dev-laptop-dev.desktop_1"));
    }

    #[test]
    fn a_lease_lapses_unless_renewed() {
        let mut w = set();
        w.put("laptop", &req(&["3c6444"], vec![]), 0).unwrap();
        assert!(!w.union(LEASE - 1).is_empty());
        assert!(w.union(LEASE).is_empty());
        // Renewed before it lapses: it holds.
        w.put("laptop", &req(&["3c6444"], vec![]), LEASE - 1)
            .unwrap();
        assert!(!w.union(LEASE + 10).is_empty());
    }

    #[test]
    fn expire_drops_lapsed_leases_and_reports_the_next_expiry() {
        let mut w = set();
        w.put("a", &req(&["3c6444"], vec![]), 0).unwrap();
        w.put("b", &req(&["39de4f"], vec![]), 30_000).unwrap();
        assert_eq!(w.next_expiry(), Some(LEASE));
        assert!(w.expire(LEASE));
        assert_eq!(w.next_expiry(), Some(30_000 + LEASE));
        assert!(!w.expire(LEASE + 1));
    }

    #[test]
    fn an_empty_request_drops_the_client() {
        let mut w = set();
        w.put("a", &req(&["3c6444"], vec![]), 0).unwrap();
        w.put("a", &WatchRequest::default(), 1).unwrap();
        assert_eq!(w.union(2).clients, 0);
        assert!(!w.remove("a"));
    }

    #[test]
    fn the_union_merges_clients_and_dedupes_areas_by_id() {
        let mut w = set();
        w.put("a", &req(&["3c6444"], vec![area("west", 1.0)]), 0)
            .unwrap();
        w.put(
            "b",
            &req(
                &["3c6444", "39de4f"],
                vec![area("west", 2.0), area("south", 1.0)],
            ),
            0,
        )
        .unwrap();
        let u = w.union(1);
        assert_eq!(u.icao24, ["39de4f", "3c6444"]);
        assert_eq!(u.areas.len(), 2);
        assert_eq!(u.clients, 2);
        // The first client's "west" wins.
        assert_eq!(u.areas[0].north, 47.0);
    }

    #[test]
    fn the_union_is_capped_at_the_limits() {
        let limits = WatchLimits {
            max_icao: 2,
            max_areas: 1,
            ..WatchLimits::default()
        };
        let mut w = WatchSet::new(limits, LEASE);
        w.put("a", &req(&["000001", "000002"], vec![area("x", 1.0)]), 0)
            .unwrap();
        w.put("b", &req(&["000003"], vec![area("y", 1.0)]), 0)
            .unwrap();
        let u = w.union(1);
        assert_eq!(u.icao24.len(), 2);
        assert_eq!(u.areas.len(), 1);
    }
}
