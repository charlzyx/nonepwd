use serde::{Deserialize, Serialize};

use crate::otp_extractor::extract_registrable_domain;
use crate::random::random_int;

const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
const DIGITS: &[u8] = b"23456789";
const SYMBOLS: &[u8] = b"!@#$%^&*-_=+?";
const ALIAS_SUFFIX_CHARS: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PasswordOptions {
    pub length: Option<usize>,
    pub uppercase: Option<bool>,
    pub lowercase: Option<bool>,
    pub digits: Option<bool>,
    pub symbols: Option<bool>,
}

pub fn generate_password(options: &PasswordOptions) -> Result<String, String> {
    let length = options.length.unwrap_or(20).clamp(8, 128);
    let use_upper = options.uppercase.unwrap_or(true);
    let use_lower = options.lowercase.unwrap_or(true);
    let use_digits = options.digits.unwrap_or(true);
    let use_symbols = options.symbols.unwrap_or(true);

    let mut pools: Vec<&[u8]> = Vec::new();
    if use_upper {
        pools.push(UPPER);
    }
    if use_lower {
        pools.push(LOWER);
    }
    if use_digits {
        pools.push(DIGITS);
    }
    if use_symbols {
        pools.push(SYMBOLS);
    }
    if pools.is_empty() {
        pools.push(LOWER);
        pools.push(DIGITS);
    }

    let mut all_chars: Vec<u8> = Vec::new();
    let mut chars: Vec<u8> = Vec::with_capacity(length);
    for pool in &pools {
        all_chars.extend_from_slice(pool);
        chars.push(pool[random_int(pool.len())?]);
    }
    while chars.len() < length {
        chars.push(all_chars[random_int(all_chars.len())?]);
    }

    for i in (1..chars.len()).rev() {
        let j = random_int(i + 1)?;
        chars.swap(i, j);
    }

    Ok(String::from_utf8_lossy(&chars).to_string())
}

const WORDLIST: &[&str] = &[
    "amber", "anchor", "antler", "anvil", "apricot", "arcade", "arctic", "arrow",
    "aspen", "atlas", "aurora", "autumn", "badger", "bamboo", "banjo", "banner",
    "barley", "barrel", "basalt", "beacon", "beaver", "bison", "blazer", "blossom",
    "boulder", "breeze", "bridge", "bristle", "bronze", "brook", "bucket", "buffalo",
    "cactus", "canyon", "canvas", "captain", "caramel", "carbon", "carpet", "cascade",
    "castle", "cedar", "cellar", "chalk", "channel", "charter", "cherry", "chimney",
    "cipher", "citadel", "citrus", "clover", "cobalt", "cobble", "comet", "compass",
    "condor", "copper", "coral", "corner", "cosmos", "cotton", "cougar", "cradle",
    "crater", "creek", "cricket", "crimson", "crystal", "current", "cypress", "dagger",
    "daisy", "dancer", "dandelion", "dawn", "delta", "desert", "diamond", "dolphin",
    "domino", "dragon", "drift", "drizzle", "drum", "dune", "dynamo", "eagle",
    "echo", "eclipse", "elder", "ember", "emerald", "engine", "enigma", "equinox",
    "estate", "evergreen", "fable", "falcon", "feather", "fennel", "ferry", "festival",
    "fiber", "field", "filter", "finch", "fjord", "flame", "flannel", "flicker",
    "flint", "flower", "flute", "forest", "fossil", "fountain", "fox", "frost",
    "galaxy", "garden", "garnet", "gazelle", "geyser", "ginger", "glacier", "glider",
    "glow", "granite", "gravel", "griffin", "grove", "guitar", "harbor", "harvest",
    "haven", "hazel", "heather", "helmet", "heron", "hickory", "horizon", "hornet",
    "hummingbird", "hurricane", "icicle", "indigo", "ingot", "island", "ivory", "jacket",
    "jaguar", "jasper", "javelin", "juniper", "kayak", "kelp", "kestrel", "kettle",
    "keystone", "kingdom", "kite", "knight", "koala", "lagoon", "lantern", "larch",
    "lark", "laser", "lathe", "laurel", "lava", "lavender", "leather", "ledge",
    "lemon", "leopard", "liberty", "lichen", "lighthouse", "lilac", "linden", "linen",
    "lion", "lizard", "llama", "locket", "locust", "lodge", "lotus", "lumber",
    "lunar", "lynx", "magnet", "magpie", "mahogany", "mallet", "mammoth", "mandolin",
    "mango", "manor", "mantis", "maple", "marble", "marigold", "mariner", "marmot",
    "marshal", "meadow", "melon", "mercury", "meridian", "mesa", "meteor", "mineral",
    "mirage", "mitten", "monarch", "monkey", "monsoon", "mosaic", "moss", "mountain",
    "mulberry", "mustang", "myrtle", "narwhal", "nebula", "nectar", "needle", "nettle",
    "nickel", "nimbus", "north", "november", "nutmeg", "oak", "oasis", "obsidian",
    "ocean", "ocelot", "octane", "olive", "omega", "onyx", "opal",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PassphraseOptions {
    pub words: Option<usize>,
    pub separator: Option<String>,
    pub capitalize: Option<bool>,
    pub include_number: Option<bool>,
}

pub fn generate_passphrase(options: &PassphraseOptions) -> Result<String, String> {
    let count = options.words.unwrap_or(4).clamp(3, 12);
    let separator = options.separator.as_deref().unwrap_or("-");
    let capitalize = options.capitalize.unwrap_or(true);
    let include_number = options.include_number.unwrap_or(true);

    let mut picked = Vec::with_capacity(count);
    for _ in 0..count {
        let word = WORDLIST[random_int(WORDLIST.len())?];
        if capitalize {
            let mut chars = word.chars();
            let cap = match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            };
            picked.push(cap);
        } else {
            picked.push(word.to_string());
        }
    }

    if include_number && !picked.is_empty() {
        let idx = random_int(picked.len())?;
        let num = random_int(90)? + 10;
        picked[idx] = format!("{}{}", picked[idx], num);
    }

    Ok(picked.join(separator))
}

pub fn generate_email_alias(site_or_domain: &str, alias_domain: &str) -> Result<String, String> {
    let clean_domain = alias_domain.trim().to_ascii_lowercase();
    let clean_domain = clean_domain.trim_start_matches('@');
    if clean_domain.is_empty() || !clean_domain.contains('.') {
        return Err(format!("Invalid alias domain: \"{alias_domain}\""));
    }

    let reg = extract_registrable_domain(site_or_domain);
    let first_label = reg.split('.').next().unwrap_or("alias");
    let label_part: String = first_label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(14)
        .collect();
    let label = if label_part.is_empty() {
        "site".to_string()
    } else {
        label_part
    };

    let mut suffix = String::with_capacity(5);
    for _ in 0..5 {
        suffix.push(ALIAS_SUFFIX_CHARS[random_int(ALIAS_SUFFIX_CHARS.len())?] as char);
    }
    Ok(format!("{label}.{suffix}@{clean_domain}"))
}
