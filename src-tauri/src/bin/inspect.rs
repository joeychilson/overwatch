use overwatch_lib::index::{Index, default_sources};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let directory = args.next().ok_or("Pass a disposable index directory")?;
    let readers = match args.next() {
        None => false,
        Some(flag) if flag == "--read-transcripts" => true,
        Some(_) => return Err("Unknown option; use --read-transcripts".into()),
    };
    let index = Index::open(directory.into(), default_sources()?)?;
    let start = std::time::Instant::now();
    index.scan()?;
    let snapshot = index.snapshot()?;
    for source in snapshot.sources {
        let tokens: u64 = snapshot
            .sessions
            .iter()
            .filter(|session| session.agent == source.source.agent)
            .map(|session| session.tokens.total())
            .sum();
        println!(
            "{}: {} sessions, {} tokens, {} source issues",
            source.source.agent.id(),
            source.sessions,
            tokens,
            source.issues.len()
        );
    }
    println!("Scan: {:.2?}", start.elapsed());
    let start = std::time::Instant::now();
    println!("Idle changed: {} ({:.2?})", index.scan()?, start.elapsed());
    if readers {
        let start = std::time::Instant::now();
        let mut events = 0;
        for session in &snapshot.sessions {
            let transcript = index.transcript(&session.id)?;
            let page = index.events(&session.id, 0, "")?;
            if transcript.timeline.count as usize != page.total as usize {
                return Err("Transcript timeline and page counts differ".into());
            }
            events += transcript.timeline.count as usize;
        }
        println!(
            "Read {} transcripts, {events} events ({:.2?})",
            snapshot.sessions.len(),
            start.elapsed()
        );
    }
    Ok(())
}
