//! Index this machine's real agent history and report what it cost.
//!
//! Read-only: it writes an index into a temporary directory and never touches
//! an agent's own files. Run with `cargo run --release --example scan`.

use std::collections::HashMap;
use std::time::Instant;

/// Dollars, or a dash for usage with no price.
fn usd(cost: Option<f64>) -> String {
    cost.map_or_else(|| "—".into(), |cost| format!("${cost:.2}"))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let data = std::env::temp_dir().join(format!("overwatch-scan-{}", std::process::id()));

    let opened = Instant::now();
    let index = overwatch_lib::index::Index::open(&data, home)?;
    println!("open:            {:>8.0?}", opened.elapsed());

    let cold = Instant::now();
    let status = index.scan(|_| {})?;
    let cold_time = cold.elapsed();

    println!("agents:          {:?}", status.agents);
    println!("files parsed:    {:>8}", status.files_read);
    println!("sessions:        {:>8}", status.sessions);
    println!("problems:        {:>8}", status.problems.len());
    for problem in status.problems.iter().take(3) {
        println!("  - {problem}");
    }
    println!("COLD SCAN:       {cold_time:>8.2?}");

    let warm = Instant::now();
    let again = index.scan(|_| {})?;
    println!(
        "WARM RESCAN:     {:>8.2?}  ({} files re-parsed)",
        warm.elapsed(),
        again.files_read
    );

    let listed = Instant::now();
    let page = index.read(|store| {
        store.list(&overwatch_lib::session::Filter {
            limit: 100,
            ..Default::default()
        })
    })?;
    println!("LIST 100 of {:<5}{:>8.2?}", page.total, listed.elapsed());

    let searched = Instant::now();
    let hits = index.read(|store| {
        store.list(&overwatch_lib::session::Filter {
            search: Some("rust".into()),
            include_spawned: true,
            limit: 100,
            ..Default::default()
        })
    })?;
    println!(
        "SEARCH 'rust':   {:>8.2?}  ({} hits)",
        searched.elapsed(),
        hits.total
    );

    let modelled = Instant::now();
    let models = index.read(|store| store.models(None, None))?;
    println!(
        "MODELS:          {:>8.2?}  ({} models)",
        modelled.elapsed(),
        models.len()
    );
    for model in models.iter().take(6) {
        println!(
            "  {:<34} {:>14} tokens  {:>10}  {:>4} sessions",
            model.model,
            model.tokens.total,
            usd(model.cost_usd),
            model.sessions
        );
    }

    let projected = Instant::now();
    let projects = index.read(|store| store.projects(None, None))?;
    println!(
        "PROJECTS:        {:>8.2?}  ({} projects)",
        projected.elapsed(),
        projects.len()
    );

    let overviewed = Instant::now();
    let overview = index.read(|store| store.overview(None, None))?;
    println!(
        "OVERVIEW:        {:>8.2?}  ({} days, {} total)",
        overviewed.elapsed(),
        overview.daily.len(),
        usd(overview.cost_usd)
    );
    for agent in &overview.by_agent {
        println!(
            "  {:<34} {:>14} tokens  {:>10}",
            agent.agent.key(),
            agent.tokens.total,
            usd(agent.cost_usd)
        );
    }

    // Reading the largest session end to end is the one operation that parses
    // a whole file, so it is the worst case worth measuring.
    if let Some(biggest) = page.sessions.iter().max_by_key(|s| s.tokens.total) {
        let read = Instant::now();
        let transcript = index.transcript(&biggest.id, 0, 200)?;
        println!(
            "TRANSCRIPT:      {:>8.2?}  ({} turns, {} messages, {} tools) {}",
            read.elapsed(),
            transcript.total,
            transcript.messages,
            transcript.tools,
            biggest.title.as_deref().unwrap_or("(untitled)")
        );
        let paged = Instant::now();
        index.transcript(&biggest.id, 400, 200)?;
        println!(
            "  next page:     {:>8.2?}  (held, not re-read)",
            paged.elapsed()
        );
    }

    // What opening a conversation costs across the whole corpus, not just the
    // one outlier, since that is what a person actually does all day.
    let mut times: Vec<(u128, i64, String)> = Vec::new();
    let all = index.read(|store| {
        store.list(&overwatch_lib::session::Filter {
            include_spawned: true,
            limit: 500,
            ..Default::default()
        })
    })?;
    for session in &all.sessions {
        let at = Instant::now();
        if index.transcript(&session.id, 0, 200).is_ok() {
            times.push((
                at.elapsed().as_micros(),
                session.tokens.total,
                session.id.clone(),
            ));
        }
        index.close();
    }
    times.sort_unstable();
    if !times.is_empty() {
        let pick = |q: f64| times[((times.len() - 1) as f64 * q) as usize].0 as f64 / 1000.0;
        println!(
            "TRANSCRIPT OPEN over {} sessions: median {:.1}ms  p90 {:.1}ms  p99 {:.1}ms  max {:.0}ms",
            times.len(),
            pick(0.5),
            pick(0.9),
            pick(0.99),
            pick(1.0)
        );
        let slow = times.iter().rev().take(3);
        for (micros, tokens, id) in slow {
            let path = index.read(|store| store.locate(id))?;
            let bytes = path.map_or(0, |(unit, _)| {
                std::fs::metadata(&unit.path).map_or(0, |data| data.len())
            });
            println!(
                "  {:>7.0}ms  {:>6.0} MB source  {:>12} tokens",
                *micros as f64 / 1000.0,
                bytes as f64 / 1e6,
                tokens
            );
        }
    }

    // Tool calls must come back paired with their results. A reader matching
    // by position rather than by id would still pair everything, so a high
    // share is not proof of correctness; a low one is proof of a bug.
    let mut paired: HashMap<&str, (usize, usize)> = HashMap::new();
    for session in &all.sessions {
        let Ok(read) = index.transcript(&session.id, 0, 2_000) else {
            continue;
        };
        let entry = paired.entry(session.agent.key()).or_default();
        for turn in &read.turns {
            if let Some(tool) = turn.tool.as_ref() {
                entry.0 += 1;
                entry.1 += usize::from(tool.output.is_some());
            }
        }
        index.close();
    }
    println!("TOOL CALLS PAIRED WITH A RESULT:");
    let mut rows: Vec<_> = paired.into_iter().collect();
    rows.sort_unstable();
    for (agent, (calls, answered)) in rows {
        let share = if calls == 0 {
            0.0
        } else {
            100.0 * answered as f64 / calls as f64
        };
        println!("  {agent:<12} {answered:>6} / {calls:<6} ({share:>3.0}%)");
    }

    // Searching what was said reads the agents' own files. A rare word is
    // passed over unparsed in most of them; a common one is parsed in each
    // until the search has found the most it answers with.
    let everything = overwatch_lib::session::Filter {
        include_spawned: true,
        ..Default::default()
    };
    for query in ["idempotency", "the"] {
        let started = Instant::now();
        let first = std::cell::Cell::new(None);
        let found = std::cell::Cell::new(0);
        let searched = index.search(query, &everything, |batch| {
            first.set(first.get().or(Some(started.elapsed())));
            found.set(found.get() + batch.len());
            true
        })?;
        println!(
            "SEARCH {query:<12} {:>8.0?}  first found {:>8.0?}  {} found, {} of {} read{}",
            started.elapsed(),
            first.get().unwrap_or_default(),
            found.get(),
            searched.searched,
            searched.total,
            if searched.capped {
                ", stopped at the most"
            } else {
                ""
            },
        );
    }

    let size = std::fs::metadata(data.join("index.sqlite")).map_or(0, |data| data.len());
    println!("INDEX SIZE:      {:>8.1} MB", size as f64 / 1e6);
    std::fs::remove_dir_all(&data).ok();
    Ok(())
}
