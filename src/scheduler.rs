//! FSRS-6 long-term scheduler, compatible with ts-fsrs 5.2.0's pinned parameters.
//! Adapted from ts-fsrs (MIT); see licenses/ts-fsrs.txt.
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
const W: [f64; 21] = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
    0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];
fn round8(x: f64) -> f64 {
    (x * 1e8).round() / 1e8
}
fn clamp(x: f64, a: f64, b: f64) -> f64 {
    x.max(a).min(b)
}
pub fn empty(now: DateTime<Utc>) -> Value {
    json!({"due":now.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"stability":0,"difficulty":0,"elapsed_days":0,"scheduled_days":0,"reps":0,"lapses":0,"learning_steps":0,"state":0})
}
fn n(card: &Value, key: &str) -> f64 {
    card.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}
fn ts(card: &Value, key: &str) -> Option<DateTime<Utc>> {
    card.get(key)?
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|v| v.with_timezone(&Utc))
}
fn factor() -> f64 {
    round8((0.9f64.ln() / (-W[20])).exp() - 1.0)
}
fn forgetting(t: f64, s: f64) -> f64 {
    round8((1.0 + factor() * t / s).powf(-W[20]))
}
fn initial_stability(g: usize) -> f64 {
    W[g - 1].max(0.1)
}
fn initial_difficulty(g: usize) -> f64 {
    round8(W[4] - (((g - 1) as f64) * W[5]).exp() + 1.0)
}
fn next_difficulty(d: f64, g: usize) -> f64 {
    let delta = -W[6] * (g as f64 - 3.0);
    let next = d + round8(delta * (10.0 - d) / 9.0);
    clamp(
        round8(W[7] * initial_difficulty(4) + (1.0 - W[7]) * next),
        1.0,
        10.0,
    )
}
fn recall(d: f64, s: f64, r: f64, g: usize) -> f64 {
    let penalty = if g == 2 { W[15] } else { 1.0 };
    let easy = if g == 4 { W[16] } else { 1.0 };
    round8(clamp(
        s * (1.0
            + W[8].exp()
                * (11.0 - d)
                * s.powf(-W[9])
                * (((1.0 - r) * W[10]).exp() - 1.0)
                * penalty
                * easy),
        0.01,
        36500.0,
    ))
}
fn forget(d: f64, s: f64, r: f64) -> f64 {
    round8(clamp(
        W[11] * d.powf(-W[12]) * ((s + 1.0).powf(W[13]) - 1.0) * ((1.0 - r) * W[14]).exp(),
        0.01,
        36500.0,
    ))
}
fn interval(s: f64) -> i64 {
    let modifier = round8((0.9f64.powf(1.0 / (-W[20])) - 1.0) / factor());
    clamp((s * modifier).round(), 1.0, 36500.0) as i64
}
pub fn next(before: &Value, rating: &str, now: DateTime<Utc>) -> Value {
    let state = n(before, "state") as i64;
    let last = ts(before, "last_review");
    let elapsed = if state == 0 {
        0
    } else {
        last.map(|v| {
            now.date_naive()
                .signed_duration_since(v.date_naive())
                .num_days()
        })
        .unwrap_or(0)
    };
    let d = n(before, "difficulty");
    let s = n(before, "stability");
    let g: usize = if rating == "good" { 3 } else { 1 };
    let mut stabilities = [0.0; 4];
    let mut difficulties = [0.0; 4];
    let mut intervals = [0i64; 4];
    for grade in 1..=4 {
        let (new_d, new_s) = if state == 0 {
            (
                clamp(initial_difficulty(grade), 1.0, 10.0),
                initial_stability(grade),
            )
        } else {
            let r = forgetting(elapsed as f64, s);
            (
                next_difficulty(d, grade),
                if grade == 1 {
                    clamp(s, 0.01, forget(d, s, r))
                } else {
                    recall(d, s, r, grade)
                },
            )
        };
        stabilities[grade - 1] = new_s;
        difficulties[grade - 1] = new_d;
        intervals[grade - 1] = interval(new_s);
    }
    intervals[0] = intervals[0].min(intervals[1]);
    intervals[1] = intervals[1].max(intervals[0] + 1);
    intervals[2] = intervals[2].max(intervals[1] + 1);
    intervals[3] = intervals[3].max(intervals[2] + 1);
    let days = intervals[g - 1];
    let due = now + Duration::days(days);
    let mut card = before.clone();
    card["stability"] = json!(stabilities[g - 1]);
    card["difficulty"] = json!(difficulties[g - 1]);
    card["elapsed_days"] = json!(elapsed);
    card["scheduled_days"] = json!(days);
    card["reps"] = json!(n(before, "reps") as i64 + 1);
    card["lapses"] = json!(n(before, "lapses") as i64 + if g == 1 && state != 0 { 1 } else { 0 });
    card["learning_steps"] = json!(0);
    card["state"] = json!(2);
    card["last_review"] = json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    card["due"] = json!(due.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    card
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_node_fsrs_6_fixtures() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../fixtures/scheduler.json")).unwrap();
        for (i, f) in fixtures.as_array().unwrap().iter().enumerate() {
            let now = DateTime::parse_from_rfc3339(f["now"].as_str().unwrap())
                .unwrap()
                .with_timezone(&Utc);
            let result = next(&f["before"], f["rating"].as_str().unwrap(), now);
            let expected = &f["after"];
            for key in [
                "state",
                "reps",
                "lapses",
                "learning_steps",
                "scheduled_days",
                "elapsed_days",
            ] {
                assert_eq!(result[key], expected[key], "step {i} field {key}")
            }
            for key in ["due", "last_review"] {
                let actual = DateTime::parse_from_rfc3339(result[key].as_str().unwrap())
                    .unwrap()
                    .timestamp_millis();
                let want = DateTime::parse_from_rfc3339(expected[key].as_str().unwrap())
                    .unwrap()
                    .timestamp_millis();
                assert_eq!(actual, want, "step {i} field {key}")
            }
            for key in ["stability", "difficulty"] {
                let actual = result[key].as_f64().unwrap();
                let want = expected[key].as_f64().unwrap();
                assert!(
                    (actual - want).abs() < 1e-7,
                    "step {i} {key}: {actual} != {want}"
                )
            }
        }
    }
}
