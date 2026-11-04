//! Hash-chain parity with the SDK. `tests/vectors/chain.json` was written by
//! Python's json and hashlib with the SDK's exact rule (`canonical` and
//! `chain_hash` in the SDK's `store.py`): sorted keys, `(",", ":")`
//! separators, `ensure_ascii` and float `repr`. Each vector is
//! `{envelope, prev_hash, canonical, hash}`, where `canonical` is the text of
//! `{id, kind, payload}` that is hashed after `prev_hash`. The SDK asserts the
//! same file.

use autophys::store::{GENESIS, canonical, chain_hash};
use serde_json::{Value, json};

#[test]
fn canonical_json_and_chain_hash_match_python() {
    let file: Value = serde_json::from_str(include_str!("vectors/chain.json")).unwrap();
    let vectors = file["vectors"].as_array().unwrap();
    let mut prev = GENESIS.to_string();
    for v in vectors {
        let env = &v["envelope"];
        let (id, kind) = (env["id"].as_str().unwrap(), env["kind"].as_str().unwrap());
        assert_eq!(
            v["prev_hash"],
            prev.as_str(),
            "{id} chains from the previous vector"
        );
        let body = canonical(&json!({"id": id, "kind": kind, "payload": env["payload"]}));
        assert_eq!(body, v["canonical"].as_str().unwrap(), "canonical of {id}");
        let h = chain_hash(&prev, id, kind, &env["payload"]);
        assert_eq!(h, v["hash"].as_str().unwrap(), "hash of {id}");
        prev = h;
    }
    assert_eq!(vectors.len(), 5);
}
