//! What usage would cost at list prices.
//!
//! Most agents record no cost, and those that do price it from the same
//! models.dev catalog, so a response's cost is estimated the same way whichever
//! agent made it: its tokens at the rates its provider lists for its model, in
//! the context tier the response fell in. Grok alone reports what was actually
//! charged, and its figure is used instead. `prices.json` is that catalog cut
//! down to prices, and `vp run prices` refreshes it.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::LazyLock;

use serde::Deserialize;

use crate::session::Tokens;

/// The catalog, cut down to prices.
const PRICES: &str = include_str!("prices.json");

/// Every provider's models, and each model's rates by context size, from the
/// base rates up. The file ships inside the binary, and a test parses it.
static CATALOG: LazyLock<HashMap<String, HashMap<String, Vec<Rates>>>> =
    LazyLock::new(|| serde_json::from_str(PRICES).expect("prices.json is valid"));

/// Dollars per million tokens, for requests whose context was above `above`.
#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) struct Rates {
    #[serde(default)]
    above: i64,
    /// Fresh input.
    pub(crate) input: f64,
    /// Output.
    pub(crate) output: f64,
    /// Input served from a prompt cache.
    pub(crate) cache_read: f64,
    /// Input written into a prompt cache.
    pub(crate) cache_write: f64,
    /// Reasoning counted apart from output.
    pub(crate) reasoning: f64,
}

impl Rates {
    /// What `tokens` cost at these rates.
    ///
    /// Reasoning is priced only as far as it was counted apart from output.
    pub(crate) fn cost(&self, tokens: &Tokens) -> f64 {
        (tokens.input as f64 * self.input
            + tokens.output as f64 * self.output
            + tokens.cache_read as f64 * self.cache_read
            + tokens.cache_write as f64 * self.cache_write
            + tokens.reasoning as f64 * self.reasoning)
            / 1_000_000.0
    }
}

/// The rates `provider` lists for `model`, for a request whose context held
/// `context` tokens, or `None` when the catalog has no price for it.
pub(crate) fn rates(provider: &str, model: &str, context: i64) -> Option<Rates> {
    let tiers = CATALOG.get(provider)?.get(model)?;
    // The last tier the context passed, or the base rates.
    tiers
        .iter()
        .rev()
        .find(|tier| context > tier.above)
        .or(tiers.first())
        .copied()
}

/// A value that changes whenever the prices do, so that costs estimated with
/// other prices can be estimated again.
pub(crate) fn version() -> u64 {
    let mut hasher = DefaultHasher::new();
    PRICES.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_priced_in_the_tier_its_context_reached() {
        // Checked against models.dev: $4 and $20 per million, doubling to $8
        // and $30 above 272,000 tokens of context.
        let small = rates("openai", "gpt-5.6-sol", 100_000).expect("priced");
        assert_eq!((small.input, small.output), (4.0, 20.0));
        let large = rates("openai", "gpt-5.6-sol", 300_000).expect("priced");
        assert_eq!((large.input, large.output), (8.0, 30.0));
        assert!(rates("openai", "no-such-model", 0).is_none());
    }

    #[test]
    fn every_model_lists_its_tiers_from_the_base_rates_up() {
        for (provider, models) in CATALOG.iter() {
            for (model, tiers) in models {
                let rising = tiers.windows(2).all(|pair| pair[0].above < pair[1].above);
                assert!(!tiers.is_empty() && rising, "{provider} {model}");
            }
        }
    }

    #[test]
    fn every_kind_of_token_is_priced_at_its_own_rate() {
        let rates = rates("anthropic", "claude-opus-5", 0).expect("priced");
        let tokens = Tokens {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 1_000_000,
            cache_write: 1_000_000,
            reasoning: 0,
            total: 4_000_000,
        };
        // $5 + $25 + $0.50 + $6.25, the catalog's rates for a million of each.
        assert_eq!(rates.cost(&tokens), 36.75);
    }
}
