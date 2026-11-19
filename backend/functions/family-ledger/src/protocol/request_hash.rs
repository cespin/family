//! The fingerprint of a saved request, which tells a retry from a different request that reused
//! its `requestId`.

use serde_json::Value;
use sha2::{Digest, Sha256};

fn canonical(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::from(key.as_str()).to_string());
                out.push(':');
                canonical(&map[*key], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// SHA-256 in hexadecimal of the body with sorted keys and no whitespace.
pub fn request_hash(body: &Value) -> String {
    let mut text = String::new();
    canonical(body, &mut text);
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn key_order_and_spacing_do_not_change_the_hash() {
        let spaced: Value =
            serde_json::from_str(r#"{ "b": 1, "a": {"d": [1, 2], "c": "ñ"} }"#).unwrap();
        assert_eq!(
            request_hash(&spaced),
            request_hash(&json!({"a": {"c": "ñ", "d": [1, 2]}, "b": 1}))
        );
    }

    #[test]
    fn different_content_changes_the_hash() {
        assert_ne!(
            request_hash(&json!({"a": 1})),
            request_hash(&json!({"a": 2}))
        );
    }
}
