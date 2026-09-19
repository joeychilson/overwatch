//! The menu bar item: what is left of the limits being worked against, without
//! opening the window.
//!
//! Its icon is the app's mark with the ring drawn only as far round as the
//! limit it follows has left, and that figure sits beside it. Clicking it drops
//! down a panel with every account's limits, which hides again once anything
//! else is clicked, as a menu does.

use std::f64::consts::TAU;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{
    AppHandle, Manager, PhysicalPosition, Rect, Runtime, WebviewUrl, WebviewWindowBuilder, Window,
};

use crate::session::{Account, Limit};

/// The item's id.
const ID: &str = "limits";

/// The label of the panel the item drops down.
pub const PANEL: &str = "panel";

/// Space between the menu bar and the panel, and kept from the screen's edge,
/// in points.
const GAP: f64 = 6.0;

/// The panel's corner radius, in points, as macOS draws a menu bar panel's.
const RADIUS: f64 = 12.0;

/// What the item shows: the share left of the limit it follows, and whose
/// limit that is.
#[derive(Debug, Default, PartialEq)]
struct Shown {
    left: Option<f64>,
    tooltip: String,
}

/// What the item last showed, so a redraw that changes nothing is skipped, and
/// when the panel last hid itself.
#[derive(Default)]
struct Item {
    shown: Mutex<Shown>,
    dismissed: Mutex<Option<Instant>>,
}

/// Put the item in the menu bar, with its panel ready and hidden.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.manage(Item::default());
    // The panel sizes itself to what it holds once it has loaded. It is drawn
    // on a popover's material, with rounded corners and a shadow, as a menu is.
    WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("tray".into()))
        .title("Overwatch")
        .decorations(false)
        .transparent(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .radius(RADIUS)
                .build(),
        )
        .shadow(true)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .build()?;
    TrayIconBuilder::with_id(ID)
        .icon(ring(None))
        .icon_as_template(true)
        .tooltip("Overwatch")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                rect,
                button_state: MouseButtonState::Down,
                ..
            } = event
            {
                toggle(tray.app_handle(), rect);
            }
        })
        .build(app)?;
    Ok(())
}

/// Redraw the item for the accounts as they stand at `now`.
///
/// Blocks until the main thread has drawn it.
pub fn update<R: Runtime>(app: &AppHandle<R>, accounts: &[Account], now: i64) {
    let followed = followed(accounts, now);
    let shown = Shown {
        left: followed.map(|(_, _, left)| left),
        tooltip: followed.map_or_else(
            || "Overwatch".to_owned(),
            |(account, limit, _)| format!("{} · {}", account.provider.name(), limit.name),
        ),
    };
    let (Some(tray), Some(item)) = (app.tray_by_id(ID), app.try_state::<Item>()) else {
        return;
    };
    let mut last = item.shown.lock().unwrap_or_else(PoisonError::into_inner);
    if *last == shown {
        return;
    }
    let drawn = tray
        .set_icon_with_as_template(Some(ring(shown.left)), true)
        .and_then(|()| tray.set_title(shown.left.map(|left| format!("{left:.0}%"))))
        .and_then(|()| tray.set_tooltip(Some(&shown.tooltip)));
    match drawn {
        Ok(()) => *last = shown,
        // What was shown is left as it was, so the next redraw tries again.
        Err(error) => eprintln!("overwatch: could not redraw the menu bar item: {error}"),
    }
}

/// Hide the panel once it loses focus.
pub fn dismiss<R: Runtime>(panel: &Window<R>) {
    if let Some(item) = panel.try_state::<Item>() {
        *item
            .dismissed
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Instant::now());
    }
    let _ = panel.hide();
}

/// Drop the panel down under the item, or put it away if it is showing.
fn toggle<R: Runtime>(app: &AppHandle<R>, icon: Rect) {
    let (Some(panel), Some(item)) = (app.get_webview_window(PANEL), app.try_state::<Item>()) else {
        return;
    };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    // A click on the item can take focus from the panel before the click
    // itself arrives, and then the panel has already been put away.
    let dismissed = *item
        .dismissed
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if dismissed.is_some_and(|at| at.elapsed() < Duration::from_millis(300)) {
        return;
    }
    // The item reports where it is in physical pixels. The panel goes under
    // it, centred on it, and kept on its screen.
    let (at, size) = (
        icon.position.to_physical::<f64>(1.0),
        icon.size.to_physical::<f64>(1.0),
    );
    if let (Ok(Some(screen)), Ok(panel_size)) =
        (panel.monitor_from_point(at.x, at.y), panel.outer_size())
    {
        let gap = GAP * screen.scale_factor();
        let area = screen.work_area();
        let width = f64::from(panel_size.width);
        let left = f64::from(area.position.x) + gap;
        let right = left + f64::from(area.size.width) - width - 2.0 * gap;
        let x = (at.x + size.width / 2.0 - width / 2.0).clamp(left, right.max(left));
        let _ = panel.set_position(PhysicalPosition::new(x, at.y + size.height + gap));
    }
    let _ = panel.show();
    let _ = panel.set_focus();
}

/// The limit the item follows, with what it has left from 0 to 100.
///
/// It is the tightest limit on all usage among the accounts in use, or else
/// among those used last, or else among every account. A limit on one model
/// does not stop work with the others, so it is left out; a window that has
/// ended since it was read has refilled.
fn followed(accounts: &[Account], now: i64) -> Option<(&Account, &Limit, f64)> {
    let last = accounts.iter().filter_map(|account| account.used_at).max();
    let since = last.map(|last| last.min(now - Account::IN_USE));
    accounts
        .iter()
        .filter(|account| account.used_at >= since)
        .flat_map(|account| {
            account
                .limits
                .iter()
                .filter(|limit| limit.scope.is_none())
                .map(move |limit| {
                    let left = match limit.resets_at {
                        Some(resets_at) if resets_at <= now => 100.0,
                        _ => (100.0 - limit.used_percent).clamp(0.0, 100.0),
                    };
                    (account, limit, left)
                })
        })
        .min_by(|a, b| a.2.total_cmp(&b.2))
}

/// The icon: the app's mark, a dot in a ring, with the ring drawn only as far
/// round as `left` percent and faint beyond it.
///
/// Drawn rather than loaded, at twice the menu bar's 18 points, as a template
/// the system colours to suit the menu bar.
fn ring(left: Option<f64>) -> Image<'static> {
    const SIZE: u32 = 36;
    // Samples per pixel along each axis, for smooth edges.
    const SAMPLES: u32 = 4;
    let reach = left.unwrap_or(100.0) / 100.0;
    let center = f64::from(SIZE) / 2.0;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut coverage = 0.0;
            for sample in 0..SAMPLES * SAMPLES {
                let offset = |step: u32| (f64::from(step) + 0.5) / f64::from(SAMPLES);
                let dx = f64::from(x) + offset(sample % SAMPLES) - center;
                let dy = f64::from(y) + offset(sample / SAMPLES) - center;
                let distance = dx.hypot(dy);
                // How far round from twelve o'clock, clockwise, from 0 to 1.
                let round = (dx.atan2(-dy) / TAU).rem_euclid(1.0);
                coverage += if distance <= 4.5 {
                    1.0
                } else if (12.0..=15.0).contains(&distance) {
                    if round <= reach { 1.0 } else { 0.3 }
                } else {
                    0.0
                };
            }
            let alpha = (coverage / f64::from(SAMPLES * SAMPLES) * 255.0).round() as u8;
            rgba.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Provider;

    const MINUTE: i64 = 60_000;

    fn limit(name: &str, used: f64, resets_in_minutes: i64) -> Limit {
        Limit {
            name: name.into(),
            scope: None,
            used_percent: used,
            resets_at: Some(resets_in_minutes * MINUTE),
            starts_at: None,
            runs_out_at: None,
            per_hour: None,
        }
    }

    fn account(provider: Provider, used_at: Option<i64>, limits: Vec<Limit>) -> Account {
        Account {
            id: format!("{}:a", provider.key()),
            provider,
            label: None,
            plan: None,
            via: Vec::new(),
            limits,
            read_at: Some(0),
            problem: None,
            used_at,
        }
    }

    /// The subscription and share left of the limit followed at `now`.
    fn figure(accounts: &[Account], now: i64) -> Option<(Provider, f64)> {
        followed(accounts, now).map(|(account, _, left)| (account.provider, left))
    }

    #[test]
    fn the_figure_follows_the_subscriptions_in_use() {
        let now = 600 * MINUTE;
        let at = |minutes_ago| Some(now - minutes_ago * MINUTE);
        let accounts = |claude, codex| {
            [
                account(Provider::Claude, claude, vec![limit("5 hours", 60.0, 900)]),
                account(Provider::Codex, codex, vec![limit("5 hours", 30.0, 900)]),
                // The tightest of all, but never used here.
                account(Provider::Grok, None, vec![limit("Weekly", 95.0, 900)]),
            ]
        };
        // Both in use: the tighter of the two.
        assert_eq!(
            figure(&accounts(at(5), at(20)), now),
            Some((Provider::Claude, 40.0))
        );
        // Only Codex in use.
        assert_eq!(
            figure(&accounts(at(45), at(20)), now),
            Some((Provider::Codex, 70.0))
        );
        // Neither: the one used last.
        assert_eq!(
            figure(&accounts(at(90), at(60)), now),
            Some((Provider::Codex, 70.0))
        );
        // Nothing used here at all: every account.
        assert_eq!(
            figure(&accounts(None, None), now),
            Some((Provider::Grok, 5.0))
        );
    }

    #[test]
    fn the_figure_is_the_tightest_limit_on_all_usage() {
        let mut spark = limit("Weekly", 100.0, 60);
        spark.scope = Some("Spark".into());
        // Spark is used up, but only Spark, and the week has refilled.
        let accounts = [account(
            Provider::Codex,
            None,
            vec![limit("5 hours", 42.0, 60), spark, limit("Weekly", 97.0, -1)],
        )];
        assert_eq!(figure(&accounts, 0), Some((Provider::Codex, 58.0)));
        assert_eq!(figure(&[], 0), None);
    }

    #[test]
    fn the_ring_is_drawn_as_far_round_as_is_left() {
        // A pixel on the ring a quarter of the way round from the top.
        let alpha = |left| ring(Some(left)).rgba()[(18 * 36 + 31) * 4 + 3];
        assert_eq!(alpha(100.0), 255);
        assert!(alpha(10.0) < 100, "faint past what is left");
    }
}
