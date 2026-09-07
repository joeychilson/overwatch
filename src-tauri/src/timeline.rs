use crate::data::{EventKind, SessionEvent, TimelineMark, TimelineSummary};
use std::collections::BTreeMap;

const BINS: usize = 320;
const EXACT_LIMIT: usize = BINS * 5;
fn lane(kind: EventKind) -> usize {
    match kind {
        EventKind::User => 0,
        EventKind::Assistant => 1,
        EventKind::Thinking => 2,
        EventKind::Tool => 3,
        EventKind::Compaction => 4,
    }
}
pub fn summarize(events: &[SessionEvent]) -> TimelineSummary {
    let undated = events
        .iter()
        .filter(|event| !(1..=8_640_000_000_000_000).contains(&event.timestamp))
        .count() as u32;
    let position = |index: usize, event: &SessionEvent| {
        if undated > 0 {
            index as i64
        } else {
            event.timestamp
        }
    };
    let finish = |index: usize, event: &SessionEvent| {
        position(index, event).saturating_add(if undated > 0 {
            0
        } else {
            event.duration_ms.unwrap_or_default().min(i64::MAX as u64) as i64
        })
    };
    let start = events
        .iter()
        .enumerate()
        .map(|(i, event)| position(i, event))
        .min()
        .unwrap_or(0);
    let end = events
        .iter()
        .enumerate()
        .map(|(i, event)| finish(i, event))
        .max()
        .unwrap_or(0)
        .max(start.saturating_add(1));
    let mut marks = BTreeMap::<(usize, usize), TimelineMark>::new();
    for (index, event) in events.iter().enumerate() {
        let at = position(index, event);
        let bin = if events.len() <= EXACT_LIMIT {
            index
        } else {
            (((at - start) as f64 / (end - start) as f64 * BINS as f64) as usize).min(BINS - 1)
        };
        let failed = u32::from(event.failed == Some(true));
        marks
            .entry((bin, lane(event.kind)))
            .and_modify(|mark| {
                mark.start = mark.start.min(at);
                mark.end = mark.end.max(finish(index, event));
                // A click on a group containing failures lands on its first failure.
                if mark.failures == 0 && failed > 0 {
                    mark.index = index as u32;
                }
                mark.count += 1;
                mark.failures += failed;
            })
            .or_insert(TimelineMark {
                index: index as u32,
                kind: event.kind,
                start: at,
                end: finish(index, event),
                count: 1,
                failures: failed,
            });
    }
    TimelineSummary {
        marks: marks.into_values().collect(),
        count: events.len() as u32,
        undated,
        start,
        end,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(index: usize) -> SessionEvent {
        SessionEvent {
            id: index.to_string(),
            kind: EventKind::Tool,
            timestamp: 1_700_000_000_000 + index as i64 * 1000,
            text: String::new(),
            model: String::new(),
            tool: Some("run".into()),
            output: None,
            duration_ms: None,
            failed: None,
        }
    }
    #[test]
    fn dense_summary_is_bounded_and_preserves_failures_and_duration_bounds() {
        let mut events: Vec<_> = (0..50_000).map(event).collect();
        events[49].failed = Some(true);
        events[0].duration_ms = Some(70_000_000);
        let summary = summarize(&events);
        assert_eq!(summary.count, 50_000);
        assert!(summary.marks.len() <= EXACT_LIMIT);
        assert_eq!(summary.marks.iter().map(|m| m.count).sum::<u32>(), 50_000);
        assert_eq!(summary.marks.iter().map(|m| m.failures).sum::<u32>(), 1);
        assert_eq!(
            summary.marks.iter().find(|m| m.failures > 0).unwrap().index,
            49
        );
        assert_eq!(summary.end, events[0].timestamp + 70_000_000);
        assert!(serde_json::to_vec(&summary).unwrap().len() < 250_000);
    }
    #[test]
    fn small_and_undated_histories_retain_exact_order_and_zero_duration() {
        let mut events: Vec<_> = (0..3).map(event).collect();
        events[1].duration_ms = Some(0);
        let summary = summarize(&events);
        assert_eq!(summary.marks.len(), 3);
        assert_eq!(summary.marks[1].start, summary.marks[1].end);
        events[1].timestamp = 0;
        let summary = summarize(&events);
        assert_eq!(summary.undated, 1);
        assert_eq!(summary.marks[2].start, 2);
        assert_eq!(summary.count, 3);
        assert_eq!(summarize(&[]).count, 0);
    }
}
