//! Reconnect pacing shared by the MQTT forwarder and source.
//!
//! Exists because of a measured failure, not a theoretical one. The MQTT
//! reconnect loops originally carried the comment "rumqttc applies its own
//! backoff before the next reconnect attempt, so this is not a busy loop".
//! That is false: `EventLoop::poll` returns the error immediately, so the loop
//! spun. Three feed clients sharing one MQTT client id evicted each other in
//! turn and produced **567,000 reconnects and a 144 MB log file**, with
//! connect/disconnect pairs 400 microseconds apart.
//!
//! Two lessons are encoded here: pace the retries, and do not log every one --
//! at that rate the logging *is* the damage.

use std::time::Duration;

/// Exponential backoff with a ceiling.
#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    /// Delay before the first retry.
    pub base: Duration,
    /// Ceiling. Without one, a long outage backs off to hours and the feed
    /// never comes back on its own.
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            // Short: a broker blip should not cost a second of feed downtime.
            base: Duration::from_millis(100),
            max: Duration::from_secs(30),
        }
    }
}

impl Backoff {
    /// Delay before retry number `attempt` (0-based).
    ///
    /// Saturates rather than overflowing: `2^attempt` on a `u32` is a panic
    /// waiting for a long outage.
    pub fn delay(&self, attempt: u32) -> Duration {
        let factor = 1u64.checked_shl(attempt.min(32)).unwrap_or(u64::MAX);
        let millis = (self.base.as_millis() as u64).saturating_mul(factor);
        Duration::from_millis(millis).min(self.max)
    }
}

/// Whether to log this reconnect attempt.
///
/// The first few, then every tenth. Enough to see a problem start and to
/// confirm it is ongoing, without turning a reconnect storm into a log storm.
pub fn should_log(attempt: u32) -> bool {
    // Plain modulo, not is_multiple_of: that is stable only since 1.87 and
    // this crate declares rust-version 1.85 for the edge targets.
    attempt < 3 || attempt % 10 == 0
}

/// Whether a connection lasted long enough to count as recovered.
///
/// Resetting the moment a connection establishes is wrong for a *flapping*
/// link: an MQTT eviction storm connects successfully every time and is kicked
/// milliseconds later, so an on-connect reset keeps the backoff pinned at its
/// minimum forever. Only a connection that held is evidence of recovery.
pub fn should_reset(connection_lasted: Duration) -> bool {
    connection_lasted >= Duration::from_secs(30)
}

/// A connection this short did not really work.
const SHORT_LIVED: Duration = Duration::from_secs(5);

/// Whether a connection that was established counts as short-lived.
pub fn was_short_lived(connection_lasted: Duration) -> bool {
    connection_lasted < SHORT_LIVED
}

/// Whether the churn looks like another client stealing the session.
///
/// The distinguishing signal is **successful connections that do not hold**,
/// not the retry count. A broker that is down never sends a ConnAck at all; a
/// duplicate client id connects fine every time and is evicted milliseconds
/// later, because MQTT brokers drop an existing session when a second client
/// arrives with the same id.
///
/// Worth naming explicitly: "connection closed by peer abruptly" gives an
/// operator nothing to go on, and the real cause is usually a second copy of
/// the process left running.
pub fn looks_like_id_collision(short_lived_connections: u32) -> bool {
    short_lived_connections >= 3
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn the_first_retry_is_prompt() {
        // A broker blip should not cost a second of feed downtime.
        assert_eq!(Backoff::default().delay(0), Duration::from_millis(100));
    }

    #[test]
    fn delay_grows_exponentially() {
        let b = Backoff::default();
        assert_eq!(b.delay(1), Duration::from_millis(200));
        assert_eq!(b.delay(2), Duration::from_millis(400));
        assert_eq!(b.delay(3), Duration::from_millis(800));
    }

    #[test]
    fn delay_is_capped() {
        // Without a cap a long outage backs off to hours and the feed never
        // returns on its own.
        let b = Backoff::default();
        assert_eq!(b.delay(50), b.max);
        assert_eq!(b.delay(u32::MAX), b.max);
    }

    #[test]
    fn a_high_attempt_count_does_not_overflow() {
        // 2^n on a u32 attempt count is an obvious panic waiting for a long
        // outage; delay() must saturate instead.
        let _ = Backoff::default().delay(u32::MAX);
        let _ = Backoff::default().delay(1_000_000);
    }

    #[test]
    fn the_first_few_failures_are_logged_then_it_goes_quiet() {
        // A duplicate-client-id storm produced 567k reconnects and a 144 MB
        // log. Logging every attempt is itself the damage.
        assert!(should_log(0));
        assert!(should_log(1));
        assert!(should_log(2));
        assert!(!should_log(3));
        assert!(!should_log(9));
    }

    #[test]
    fn logging_resumes_periodically_so_an_outage_is_still_visible() {
        // Silence forever is as unhelpful as spam: an operator tailing the log
        // must eventually see that it is still down.
        assert!(should_log(10));
        assert!(should_log(20));
        assert!(!should_log(11));
    }

    #[test]
    fn a_short_lived_connection_does_not_reset_the_backoff() {
        // The shape of an eviction storm: the connection SUCCEEDS and is then
        // kicked. Resetting on connect defeats both the backoff and the log
        // throttle -- measured at 59 successful connections in 12 seconds.
        assert!(!should_reset(Duration::from_millis(200)));
        assert!(!should_reset(Duration::from_secs(5)));
    }

    #[test]
    fn a_connection_that_held_resets_the_backoff() {
        // A genuine recovery must forget the previous outage, or a later blip
        // starts at a 30s delay for no reason.
        assert!(should_reset(Duration::from_secs(60)));
    }

    #[test]
    fn repeated_short_lived_connections_mean_a_duplicate_client_id() {
        // The signal is successful connections that do not hold. A broker that
        // is down never ConnAcks at all, so retry count cannot tell them apart.
        assert!(looks_like_id_collision(3));
        assert!(looks_like_id_collision(10));
        assert!(!looks_like_id_collision(0));
        assert!(!looks_like_id_collision(2));
    }

    #[test]
    fn a_connection_lasting_seconds_is_short_lived() {
        assert!(was_short_lived(Duration::from_millis(300)));
        assert!(!was_short_lived(Duration::from_secs(30)));
    }
}
