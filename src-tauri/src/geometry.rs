//! Where the window opens, and what it remembers about the last time.
//!
//! The app ships a 1440x900 window, which is larger than a 1366x768 laptop's
//! screen. Opening it as configured there puts the frameless titlebar's
//! right-hand end, the close button included, off screen. So:
//!
//! - the size is fitted into the monitor's work area (the monitor minus the
//!   taskbar and any dock), never below the window's own minimum unless the
//!   screen is smaller than that minimum;
//! - the size and position the user left are remembered, once, beside the
//!   tray preference;
//! - a remembered position that no longer lands on a connected monitor (a
//!   monitor was unplugged, a laptop dock went away) opens centred on the
//!   primary instead of nowhere.
//!
//! Everything here is logical pixels: the units the layout is written in.
//! The monitor's work area arrives in physical pixels and is converted with
//! that monitor's own scale factor.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Window};

/// A rectangle in logical pixels: what the layout sees.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The titlebar is drawn by the app, at the top of the window, and it is the
/// only handle a person can grab. These two numbers are what "reachable"
/// means: its band has to be on the screen, with enough of it to grab.
const TITLE_BAND: f64 = 40.0;
const DRAG_MIN: f64 = 160.0;

/// How often a drag or a resize may rewrite the file. The final position
/// always lands, because a close writes regardless (`save_now`).
const SAVE_EVERY: Duration = Duration::from_millis(750);

/// The geometry as it is written to disk.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct Saved {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
}

/// When the file was last written, so a drag does not rewrite it per pixel.
static LAST_WRITE: Mutex<Option<Instant>> = Mutex::new(None);

/// The remembered size fitted into `work`: no smaller than `min`, no larger
/// than the screen. A screen smaller than the minimum wins over the minimum,
/// because a window may not be larger than the display it opens on.
pub fn fit(want: (f64, f64), min: (f64, f64), work: (f64, f64)) -> (f64, f64) {
    let clamp = |want: f64, min: f64, work: f64| {
        let lower = min.min(work);
        want.max(lower).min(work)
    };
    (clamp(want.0, min.0, work.0), clamp(want.1, min.1, work.1))
}

/// Whether a position keeps the window grabbable on `work`: its titlebar band
/// is inside the rectangle vertically, and at least `DRAG_MIN` of the window's
/// width shares that space, so there is a piece of the bar to drag.
pub fn lands_on(pos: (f64, f64), size: (f64, f64), work: Rect) -> bool {
    let overlap = (pos.0 + size.0).min(work.x + work.width) - pos.0.max(work.x);
    let band_in = pos.1 >= work.y && pos.1 + TITLE_BAND.min(size.1) <= work.y + work.height;
    overlap >= DRAG_MIN.min(size.0) && band_in
}

/// Where to put a window this size on this screen: centred.
pub fn centred(size: (f64, f64), work: Rect) -> (f64, f64) {
    (
        work.x + ((work.width - size.0) / 2.0).max(0.0),
        work.y + ((work.height - size.1) / 2.0).max(0.0),
    )
}

/// Whether a window's geometry is worth remembering. A maximized window's
/// size and place are the screen's, not a choice: storing them would make the
/// next launch open at screen size and lose the resting size the user picked.
pub(crate) fn resting(maximized: bool) -> bool {
    !maximized
}

/// The size and position the window should open at.
///
/// `saved` is what the user left, `want` is the configured size for a first
/// launch, `min` is the configured minimum, `works` is every connected
/// monitor's work area, and `primary` is the one to centre on when the saved
/// position has nowhere to land.
pub(crate) fn place(
    saved: Option<Saved>,
    want: (f64, f64),
    min: (f64, f64),
    works: &[Rect],
    primary: Rect,
) -> ((f64, f64), (f64, f64)) {
    // The monitor the saved position still lands on, if any.
    let landing = saved.and_then(|saved| {
        works
            .iter()
            .copied()
            .find(|work| lands_on((saved.x, saved.y), (saved.width, saved.height), *work))
            .map(|work| (work, saved))
    });
    let (target, restore) = match landing {
        Some((work, saved)) => (work, Some(saved)),
        // A first launch, or a position that no longer exists: the primary.
        None => (primary, None),
    };
    // The size is the user's even when the position is not: a monitor that
    // went away says nothing about how large they like the window.
    let size = fit(
        saved.map(|s| (s.width, s.height)).unwrap_or(want),
        min,
        (target.width, target.height),
    );
    let pos = match restore {
        Some(saved) if lands_on((saved.x, saved.y), size, target) => (saved.x, saved.y),
        _ => centred(size, target),
    };
    (size, pos)
}

/// Open the shell's window where it belongs. Called from setup, before the
/// first paint, so the configured size is never drawn on a screen too small
/// for it.
pub fn open(app: &AppHandle) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let (works, primary) = match screens(app) {
        Some(found) => found,
        // No monitor answered: leave the configured geometry alone rather
        // than guess. The next launch tries again.
        None => return,
    };
    let Some(cfg) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
    else {
        return;
    };
    let min = (cfg.min_width.unwrap_or(0.0), cfg.min_height.unwrap_or(0.0));
    let (size, pos) = place(read(app), (cfg.width, cfg.height), min, &works, primary);
    let _ = window.set_size(LogicalSize::new(size.0, size.1));
    let _ = window.set_position(LogicalPosition::new(pos.0, pos.1));
    // Applying the geometry fires a resize and a move; those are not the
    // user's choice and must not rewrite what was just restored.
    *LAST_WRITE.lock().expect("geometry lock") = Some(Instant::now());
}

/// Remember where the window is, at most every `SAVE_EVERY`.
pub fn remember(window: &Window) {
    // The same rule as the write below, checked before the debounce so a
    // maximized window does not spend the slot either.
    if !resting(window.is_maximized().unwrap_or(false)) {
        return;
    }
    {
        let mut last = LAST_WRITE.lock().expect("geometry lock");
        if last.is_some_and(|at| at.elapsed() < SAVE_EVERY) {
            return;
        }
        *last = Some(Instant::now());
    }
    save(window);
}

/// Remember where the window is, now. The close path calls this so the last
/// drag before quitting is not lost to the debounce.
pub fn save_now(window: &Window) {
    save(window);
}

fn save(window: &Window) {
    // The last writer of a session is this one (via `save_now` on close), so
    // the guard belongs on the write itself as well: closing while maximized
    // must not store the screen's size as the resting size.
    if !resting(window.is_maximized().unwrap_or(false)) {
        return;
    }
    let app = window.app_handle();
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let (Ok(size), Ok(pos)) = (window.inner_size(), window.outer_position()) else {
        return;
    };
    let size = size.to_logical::<f64>(scale);
    let pos = pos.to_logical::<f64>(scale);
    let saved = Saved {
        width: size.width,
        height: size.height,
        x: pos.x,
        y: pos.y,
    };
    if let Some(path) = store_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec(&saved) {
            let _ = std::fs::write(path, json);
        }
    }
}

fn read(app: &AppHandle) -> Option<Saved> {
    let path = store_path(app)?;
    let raw = std::fs::read(path).ok()?;
    let saved: Saved = serde_json::from_slice(&raw).ok()?;
    // A damaged or absurd file is no better than no file.
    (saved.width >= 1.0 && saved.height >= 1.0).then_some(saved)
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("window.json"))
}

/// Every monitor's work area in logical pixels, plus the primary's.
fn screens(app: &AppHandle) -> Option<(Vec<Rect>, Rect)> {
    let as_rect = |monitor: &tauri::Monitor| {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        Rect {
            x: work.position.x as f64 / scale,
            y: work.position.y as f64 / scale,
            width: work.size.width as f64 / scale,
            height: work.size.height as f64 / scale,
        }
    };
    let works: Vec<Rect> = app.available_monitors().ok()?.iter().map(as_rect).collect();
    let primary = app.primary_monitor().ok()?.map(|m| as_rect(&m))?;
    (!works.is_empty()).then_some((works, primary))
}

#[cfg(test)]
mod tests {
    use super::{centred, fit, lands_on, place, resting, Rect};

    const MIN: (f64, f64) = (1024.0, 640.0);

    fn work(width: f64, height: f64) -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        }
    }

    // A 1366x768 laptop with a 40px taskbar is the screen this exists for.
    #[test]
    fn a_window_larger_than_the_screen_shrinks_to_it() {
        assert_eq!(fit((1440.0, 900.0), MIN, (1366.0, 728.0)), (1366.0, 728.0));
    }

    #[test]
    fn a_window_that_fits_is_left_alone() {
        assert_eq!(fit((1280.0, 800.0), MIN, (1920.0, 1040.0)), (1280.0, 800.0));
    }

    #[test]
    fn the_minimum_is_kept_but_never_wider_than_the_screen() {
        assert_eq!(fit((900.0, 500.0), MIN, (1920.0, 1040.0)), MIN);
        assert_eq!(fit((900.0, 500.0), MIN, (1024.0, 600.0)), (1024.0, 600.0));
    }

    #[test]
    fn a_window_centred_on_a_small_screen() {
        assert_eq!(
            centred((1000.0, 500.0), work(1366.0, 728.0)),
            (183.0, 114.0)
        );
    }

    #[test]
    fn the_titlebar_has_to_be_on_the_screen() {
        let screen = work(1366.0, 728.0);
        // Inside, with the whole bar in view.
        assert!(lands_on((100.0, 100.0), (1280.0, 800.0), screen));
        // Hung off the top: the bar, and the only drag handle, is off screen.
        assert!(!lands_on((100.0, -60.0), (1280.0, 800.0), screen));
        // Almost entirely off the left edge: too little to grab.
        assert!(!lands_on((-1200.0, 100.0), (1280.0, 800.0), screen));
        // Partly off the left, with a grabbable strip left on screen.
        assert!(lands_on((-1000.0, 100.0), (1280.0, 800.0), screen));
    }

    #[test]
    fn a_position_on_a_second_monitor_is_kept() {
        let left = Rect {
            x: 0.0,
            y: 0.0,
            width: 1366.0,
            height: 728.0,
        };
        let right = Rect {
            x: 1366.0,
            y: 0.0,
            width: 1920.0,
            height: 1040.0,
        };
        let saved = super::Saved {
            width: 1280.0,
            height: 800.0,
            x: 1400.0,
            y: 20.0,
        };
        let (size, pos) = place(Some(saved), (1440.0, 900.0), MIN, &[left, right], left);
        assert_eq!(size, (1280.0, 800.0));
        assert_eq!(pos, (1400.0, 20.0));
    }

    #[test]
    fn a_position_on_a_monitor_that_is_gone_opens_centred_on_the_primary() {
        let screen = work(1366.0, 728.0);
        let saved = super::Saved {
            width: 1280.0,
            height: 800.0,
            x: 2600.0,
            y: 30.0,
        };
        let (size, pos) = place(Some(saved), (1440.0, 900.0), MIN, &[screen], screen);
        // The size is the user's, fitted to the screen it landed on.
        assert_eq!(size, (1280.0, 728.0));
        assert_eq!(pos, centred(size, screen));
    }

    #[test]
    fn a_first_launch_fits_the_configured_size_to_the_primary() {
        let screen = work(1366.0, 728.0);
        let (size, pos) = place(None, (1440.0, 900.0), MIN, &[screen], screen);
        assert_eq!(size, (1366.0, 728.0));
        assert_eq!(pos, (0.0, 0.0));
    }

    /// Both write paths (the debounced one and the close path) ask this, so
    /// the rule has one home. The window itself cannot be built in a unit
    /// test; what is pinned here is the answer, not the call.
    #[test]
    fn a_maximized_window_never_becomes_the_resting_size() {
        assert!(resting(false));
        assert!(!resting(true));
    }
}
