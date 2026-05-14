use chrono::{DateTime, Utc};
use notify_rust::Notification;

use crate::anthropic::UsageSnapshot;
use crate::tray::format_countdown;

pub struct NotificationState {
    pub session_80_notified: bool,
    pub session_95_notified: bool,
    pub weekly_80_notified: bool,
    pub weekly_95_notified: bool,
    pub current_session_window: Option<DateTime<Utc>>,
    pub current_weekly_window: Option<DateTime<Utc>>,
}

impl NotificationState {
    pub fn new() -> Self {
        Self {
            session_80_notified: false,
            session_95_notified: false,
            weekly_80_notified: false,
            weekly_95_notified: false,
            current_session_window: None,
            current_weekly_window: None,
        }
    }
}

pub fn check_and_notify(state: &mut NotificationState, snap: &UsageSnapshot) {
    if state.current_session_window != Some(snap.session_5h_reset_at) {
        state.session_80_notified = false;
        state.session_95_notified = false;
        state.current_session_window = Some(snap.session_5h_reset_at);
    }
    if state.current_weekly_window != Some(snap.weekly_reset_at) {
        state.weekly_80_notified = false;
        state.weekly_95_notified = false;
        state.current_weekly_window = Some(snap.weekly_reset_at);
    }

    if snap.session_5h_pct >= 95.0 && !state.session_95_notified {
        notify(
            "BurnClaw — Session critical",
            &format!(
                "Session at 95%. Resets in {}",
                format_countdown(&snap.session_5h_reset_at),
            ),
        );
        state.session_95_notified = true;
    } else if snap.session_5h_pct >= 80.0
        && !state.session_80_notified
        && !state.session_95_notified
    {
        notify(
            "BurnClaw — Session warning",
            &format!(
                "Session at 80%. Resets in {}",
                format_countdown(&snap.session_5h_reset_at),
            ),
        );
        state.session_80_notified = true;
    }

    if snap.weekly_pct >= 95.0 && !state.weekly_95_notified {
        notify(
            "BurnClaw — Weekly critical",
            &format!(
                "Weekly at 95%. Resets in {}",
                format_countdown(&snap.weekly_reset_at),
            ),
        );
        state.weekly_95_notified = true;
    } else if snap.weekly_pct >= 80.0 && !state.weekly_80_notified && !state.weekly_95_notified {
        notify(
            "BurnClaw — Weekly warning",
            &format!(
                "Weekly at 80%. Resets in {}",
                format_countdown(&snap.weekly_reset_at),
            ),
        );
        state.weekly_80_notified = true;
    }
}

fn notify(title: &str, body: &str) {
    let _ = Notification::new()
        .summary(title)
        .body(body)
        .timeout(notify_rust::Timeout::Default)
        .show();
}
