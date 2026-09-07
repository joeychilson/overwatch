use overwatch_lib::{
    data::{Agent, Source},
    index::Index,
};
use serde_json::{Value, json};
use std::{
    error::Error,
    fs::{self, File},
    hint::black_box,
    io::{BufWriter, Write},
    path::Path,
    time::Instant,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const SAMPLES: usize = 7;
const BASE: i64 = 1_735_689_600_000; // 2025-01-01 UTC; historical so idle cursors expire.

fn measure(mut operation: impl FnMut() -> Result<()>) -> Result<Value> {
    let mut samples = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        operation()?;
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    Ok(distribution(samples))
}

fn distribution(samples: Vec<f64>) -> Value {
    let mut sorted = samples.clone();
    sorted.sort_by(f64::total_cmp);
    json!({"samplesMs": samples, "minMs": sorted[0],
        "medianMs": sorted[sorted.len() / 2], "maxMs": sorted[sorted.len() - 1]})
}

// The same on-disk corpus feeds the real parser/index and, via its snapshot,
// the frontend benchmarks. Generation and cleanup are never timed.
fn generate(root: &Path, sessions: usize, turns: usize, reader_turns: usize) -> Result<u64> {
    let padding = "Synthetic benchmark message. ".repeat(18);
    let mut bytes = 0;
    for session in 0..sessions {
        let folder = root.join(format!("sessions/project-{:02}", session % 20));
        fs::create_dir_all(&folder)?;
        let file = File::create(folder.join(format!("session-{session:05}.jsonl")))?;
        let mut file = BufWriter::new(file);
        writeln!(
            file,
            "{}",
            json!({"type":"session", "id":format!("bench-{session}"),
            "cwd":format!("/synthetic/project-{:02}", session % 20)})
        )?;
        let count = if session == 0 { reader_turns } else { turns };
        for turn in 0..count {
            let timestamp = BASE + (session * 37 % 365) as i64 * 86_400_000 + turn as i64 * 1000;
            let marker = if turn % 10 == 0 { "NEEDLE" } else { "ordinary" };
            writeln!(
                file,
                "{}",
                json!({"type":"message", "id":format!("user-{turn}"),
                "timestamp":timestamp, "message":{"role":"user",
                "content":format!("Request {turn} {marker} {padding}")}})
            )?;
            let mut usage = json!({"input":100, "output":20, "cacheRead":50, "cacheWrite":10});
            if turn % 2 == 0 {
                usage["cost"] = json!({"total":0.001});
            }
            writeln!(
                file,
                "{}",
                json!({"type":"message", "id":format!("assistant-{turn}"),
                "timestamp":timestamp + 500, "message":{"role":"assistant",
                "model":if turn % 2 == 0 { "alpha" } else { "beta" }, "provider":"benchmark",
                "content":format!("Response {turn} {padding}"), "usage":usage}})
            )?;
        }
        file.flush()?;
        bytes += file.get_ref().metadata()?.len();
    }
    Ok(bytes)
}

fn run(
    output: &Path,
    name: &str,
    sessions: usize,
    turns: usize,
    reader_turns: usize,
) -> Result<Value> {
    let root = tempfile::tempdir()?;
    let history = root.path().join("history");
    let bytes = generate(&history, sessions, turns, reader_turns)?;
    let sources: Vec<_> = Agent::ALL
        .into_iter()
        .map(|agent| Source {
            agent,
            path: history.to_string_lossy().into_owned(),
            enabled: agent == Agent::Pi,
        })
        .collect();
    let cache = root.path().join("index");
    let mut cold = Vec::new();
    for _ in 0..SAMPLES {
        let start = Instant::now();
        let index = Index::open(cache.clone(), sources.clone())?;
        assert!(index.scan()?);
        let snapshot = index.snapshot()?;
        black_box(serde_json::to_vec(&snapshot)?);
        cold.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(snapshot.sessions.len(), sessions);
        assert!(
            snapshot
                .sources
                .iter()
                .all(|source| source.issues.is_empty())
        );
        drop(index);
        fs::remove_dir_all(&cache)?;
    }
    let index = Index::open(cache.clone(), sources.clone())?;
    index.scan()?;
    let snapshot = index.snapshot()?;
    let usage_count: usize = snapshot
        .sessions
        .iter()
        .map(|session| session.usage.len())
        .sum();
    assert_eq!(usage_count, (sessions - 1) * turns + reader_turns);
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .map(|session| session.tokens.total())
            .sum::<u64>(),
        usage_count as u64 * 180
    );
    let reader = snapshot
        .sessions
        .iter()
        .find(|session| session.id.ends_with("bench-0"))
        .ok_or("Missing reader fixture")?;
    let id = reader.id.clone();
    let serialized = serde_json::to_vec(&snapshot)?;
    fs::write(output.join(format!("{name}-snapshot.json")), &serialized)?;
    drop(snapshot);

    // Warm the unchanged scan separately; false is essential to this workload.
    assert!(!index.scan()?);
    let idle = measure(|| {
        assert!(!index.scan()?);
        Ok(())
    })?;
    let snapshot_read = measure(|| {
        black_box(index.snapshot()?);
        Ok(())
    })?;
    let snapshot = index.snapshot()?;
    let serialize = measure(|| {
        black_box(serde_json::to_vec(&snapshot)?);
        Ok(())
    })?;
    drop(snapshot);
    drop(index);

    let cached_startup = measure(|| {
        let index = Index::open(cache.clone(), sources.clone())?;
        black_box(serde_json::to_vec(&index.snapshot()?)?);
        Ok(())
    })?;
    let mut reader_open = Vec::new();
    let mut first_search = Vec::new();
    for _ in 0..SAMPLES {
        let index = Index::open(cache.clone(), sources.clone())?;
        let start = Instant::now();
        let transcript = index.transcript(&id)?;
        black_box(&transcript);
        reader_open.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(transcript.timeline.len(), reader_turns * 2);
        let start = Instant::now();
        let page = index.events(&id, 0, "needle")?;
        black_box(&page);
        first_search.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(page.total as usize, reader_turns.div_ceil(10));
    }
    let index = Index::open(cache, sources)?;
    let transcript = index.transcript(&id)?;
    let timeline_bytes = serde_json::to_vec(&transcript.timeline)?.len();
    let mut searches = serde_json::Map::new();
    for (label, query, offset, expected) in [
        ("no_match", "not-present-in-fixture", 0, 0),
        ("sparse_match", "needle", 0, reader_turns.div_ceil(10)),
        ("broad_match", "synthetic", 0, reader_turns * 2),
        ("broad_second_page", "synthetic", 100, reader_turns * 2),
    ] {
        let page = index.events(&id, offset, query)?;
        assert_eq!(page.total as usize, expected);
        assert_eq!(
            page.events.len(),
            expected.saturating_sub(offset as usize).min(100)
        );
        searches.insert(
            label.into(),
            measure(|| {
                black_box(index.events(&id, offset, query)?);
                Ok(())
            })?,
        );
    }
    let metrics = json!({
        "name":name, "sessions":sessions, "historyFiles":sessions, "historyBytes":bytes,
        "usageRecords":usage_count, "readerEvents":reader_turns * 2,
        "snapshotBytes":serialized.len(), "timelineBytes":timeline_bytes,
        "coldIndexToSnapshot":distribution(cold), "cachedOpenToSnapshot":cached_startup,
        "idleScan":idle, "snapshotRead":snapshot_read, "snapshotSerialize":serialize,
        "uncachedReaderOpen":distribution(reader_open),
        "firstReaderSearch":distribution(first_search), "warmReaderSearch":searches
    });
    println!(
        "{name}: {sessions} sessions, {} snapshot bytes; idle scan {:.2} ms, snapshot read {:.2} ms (medians)",
        serialized.len(),
        metrics["idleScan"]["medianMs"].as_f64().unwrap(),
        metrics["snapshotRead"]["medianMs"].as_f64().unwrap()
    );
    Ok(metrics)
}

fn main() -> Result<()> {
    let output = std::env::var_os("OVERWATCH_BENCH_DIR")
        .ok_or("Run via `vp run benchmark` (OVERWATCH_BENCH_DIR is required)")?;
    let output = Path::new(&output);
    fs::create_dir_all(output)?;
    let workloads = [
        run(output, "small", 100, 10, 1000)?,
        run(output, "large", 5000, 40, 25000)?,
    ];
    fs::write(
        output.join("native.json"),
        serde_json::to_vec_pretty(&json!({
            "schemaVersion":1, "fixtureVersion":1, "samples":SAMPLES,
            "workloads":workloads
        }))?,
    )?;
    Ok(())
}
