//! Overwatch desktop executable, which is also the MCP server agents start
//! with `overwatch mcp`, and runs one of its tools with `overwatch call`.

use std::process::ExitCode;

use overwatch_lib::mcp;

fn main() -> ExitCode {
    let mut arguments = std::env::args_os().skip(1);
    let outcome: Result<(), Box<dyn std::error::Error>> = match arguments.next() {
        Some(first) if first == mcp::SERVE => mcp::serve().map_err(Box::from),
        Some(first) if first == mcp::CALL => return mcp::call(arguments),
        _ => overwatch_lib::run().map_err(Box::from),
    };
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("overwatch: {error}");
            ExitCode::FAILURE
        }
    }
}
