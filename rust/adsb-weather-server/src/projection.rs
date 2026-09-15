//! The status projection: the one [`WeatherStatus`] everything reads.
//!
//! Joins the operator's *desired* setting (from [`crate::control`]) with the
//! refresh loop's *reported* state. This task is the only writer of the
//! status channel; the MQTT publisher and `GET /v1/status` only read it, so
//! both always show the same thing.
//!
//! A command shows up here immediately as `enabled`, while `state` still says
//! what the loop was doing. The gap between the two is what a UI shows as
//! "pending", and it closes when the loop reports that it has acted.

use crate::refresh::{Clock, ReportedState};
use crate::status::{STATUS_VERSION, WeatherStatus};
use tokio::sync::watch;

/// The status for a desired setting and a reported state, stamped `now_ms`.
pub fn project(enabled: bool, reported: &ReportedState, now_ms: i64) -> WeatherStatus {
    WeatherStatus {
        version: STATUS_VERSION,
        enabled,
        state: reported.state,
        consecutive_failures: reported.consecutive_failures,
        rate_limit: reported.rate_limit,
        last_success_ms: reported.last_success_ms,
        last_error: reported.last_error.clone(),
        next_fetch_ms: reported.next_fetch_ms,
        snapshot_valid_time_ms: reported.snapshot_valid_time_ms,
        updated_at_ms: now_ms,
    }
}

/// Whether two statuses say the same thing, whenever they were produced.
fn same_content(a: &WeatherStatus, b: &WeatherStatus) -> bool {
    *a == WeatherStatus {
        updated_at_ms: a.updated_at_ms,
        ..b.clone()
    }
}

/// Keeps `status` equal to the projection of `desired` and `reported` until
/// `shutdown` turns true.
///
/// Republishes only when the content changes: a re-sent identical report must
/// not reach the broker as a "new" status differing only in its timestamp.
pub async fn run(
    mut desired: watch::Receiver<bool>,
    mut reported: watch::Receiver<ReportedState>,
    status: watch::Sender<WeatherStatus>,
    mut shutdown: watch::Receiver<bool>,
    clock: Clock,
) {
    let mut desired_open = true;
    let mut reported_open = true;
    loop {
        let next = project(
            *desired.borrow_and_update(),
            &reported.borrow_and_update(),
            clock(),
        );
        status.send_if_modified(|current| {
            if same_content(current, &next) {
                false
            } else {
                *current = next;
                true
            }
        });

        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
            changed = desired.changed(), if desired_open => {
                desired_open = changed.is_ok();
            }
            changed = reported.changed(), if reported_open => {
                reported_open = changed.is_ok();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::{RateLimitScope, ServiceState};

    const NOW: i64 = 1_789_412_400_000;

    fn clock() -> i64 {
        NOW
    }

    fn reported(state: ServiceState) -> ReportedState {
        ReportedState {
            state,
            consecutive_failures: 3,
            rate_limit: Some(RateLimitScope::Hourly),
            last_success_ms: Some(1),
            last_error: Some("refused".into()),
            next_fetch_ms: Some(2),
            snapshot_valid_time_ms: Some(0),
        }
    }

    struct Running {
        desired: watch::Sender<bool>,
        reported: watch::Sender<ReportedState>,
        status: watch::Receiver<WeatherStatus>,
        shutdown: watch::Sender<bool>,
        task: tokio::task::JoinHandle<()>,
    }

    fn start() -> Running {
        let (desired, desired_rx) = watch::channel(true);
        let (reported, reported_rx) = watch::channel(ReportedState::default());
        let (status_tx, status) = watch::channel(project(true, &ReportedState::default(), 0));
        let (shutdown, shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(run(desired_rx, reported_rx, status_tx, shutdown_rx, clock));
        Running {
            desired,
            reported,
            status,
            shutdown,
            task,
        }
    }

    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[test]
    fn a_projection_carries_the_setting_and_every_reported_field() {
        let status = project(true, &reported(ServiceState::RateLimited), NOW);
        assert_eq!(status.version, STATUS_VERSION);
        assert!(status.enabled);
        assert_eq!(status.state, ServiceState::RateLimited);
        assert_eq!(status.consecutive_failures, 3);
        assert_eq!(status.rate_limit, Some(RateLimitScope::Hourly));
        assert_eq!(status.last_success_ms, Some(1));
        assert_eq!(status.last_error.as_deref(), Some("refused"));
        assert_eq!(status.next_fetch_ms, Some(2));
        assert_eq!(status.snapshot_valid_time_ms, Some(0));
        assert_eq!(status.updated_at_ms, NOW);
    }

    #[test]
    fn a_setting_the_loop_has_not_acted_on_yet_shows_as_a_disagreement() {
        let status = project(false, &reported(ServiceState::Fetching), NOW);
        assert!(!status.enabled);
        assert_eq!(status.state, ServiceState::Fetching);
    }

    #[tokio::test]
    async fn a_command_is_projected_before_the_loop_reacts() {
        let running = start();
        running.desired.send(false).unwrap();
        settle().await;

        let status = running.status.borrow().clone();
        assert!(!status.enabled);
        assert_eq!(status.state, ServiceState::Idle);
        running.task.abort();
    }

    #[tokio::test]
    async fn a_new_report_is_projected() {
        let running = start();
        running
            .reported
            .send(reported(ServiceState::Retrying))
            .unwrap();
        settle().await;

        assert_eq!(running.status.borrow().state, ServiceState::Retrying);
        running.task.abort();
    }

    #[tokio::test]
    async fn an_identical_report_does_not_publish_a_new_status() {
        let mut running = start();
        running.reported.send(reported(ServiceState::Idle)).unwrap();
        settle().await;
        running.status.borrow_and_update();

        // Same content, new version on the input channel.
        running.reported.send_replace(reported(ServiceState::Idle));
        settle().await;
        assert!(!running.status.has_changed().unwrap());
        running.task.abort();
    }

    #[tokio::test]
    async fn shutdown_stops_the_projection() {
        let running = start();
        running.shutdown.send(true).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), running.task)
            .await
            .expect("projection must exit on shutdown")
            .unwrap();
    }
}
