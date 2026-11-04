//! Provision a separate unattended vault from explicitly named records.
//! Values stay inside the vault APIs; the new store has its own keys.
//! Run with `--features vault --example provision-subset -- SOURCE DEST NS/NAME...`.
#[cfg(feature = "vault")]
fn main() -> anyhow::Result<()> {
  let args: Vec<String> = std::env::args().skip(1).collect();
  anyhow::ensure!(
    args.len() >= 3,
    "usage: provision-subset SOURCE DEST NS/NAME..."
  );
  provision(
    std::path::Path::new(&args[0]),
    std::path::Path::new(&args[1]),
    &args[2..],
  )?;
  println!(
    "Provisioned {} records into a separate encrypted vault",
    args.len() - 2
  );
  Ok(())
}

#[cfg(not(feature = "vault"))]
fn main() {
  eprintln!("provision-subset requires --features vault");
  std::process::exit(2);
}

#[cfg(feature = "vault")]
fn provision(
  source: &std::path::Path,
  destination: &std::path::Path,
  names: &[String],
) -> anyhow::Result<()> {
  use anyhow::{Context, ensure};
  use std::collections::BTreeSet;
  use tento_secrets::{Address, SetOpts, Unlock, Vault, write_lock};
  ensure!(!names.is_empty(), "select at least one record");
  ensure!(!destination.exists(), "destination must not exist");
  let _source_lock = write_lock::acquire(source)?;
  let source_vault = Vault::open_at(source)?;
  let mut seen = BTreeSet::new();
  let mut selected = Vec::new();
  for name in names {
    ensure!(seen.insert(name), "duplicate selected address");
    let address = Address::parse(name)?;
    let record = source_vault
      .record(&address)
      .context("selected record is missing")?;
    ensure!(
      record.kind.script_readable() && record.unlock == Unlock::None,
      "only unattended api-key and token-json records can be provisioned"
    );
    let value = source_vault.read(&address, Some(record.current))?;
    let options = SetOpts {
      provider: record.provider.clone(),
      account: record.account.clone(),
      expires: record.expires,
      renewal_url: record.renewal_url.clone(),
      unlock: Some(record.unlock),
      kind: Some(record.kind),
      source: Some("operator-provision-subset".into()),
    };
    selected.push((address, value, options));
  }
  // Validate and decrypt the complete selection before creating a destination.
  // init_at creates fresh identity/signing keys; it never copies source keys.
  std::fs::create_dir(destination)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o700))?;
  }
  let _destination_lock = write_lock::acquire(destination)?;
  let mut target = Vault::init_at(destination)?;
  for (address, value, options) in selected {
    target.set(&address, value.expose(), options)?;
    let copied = target.read(&address, None)?;
    ensure!(
      copied.expose() == value.expose(),
      "provisioned value verification failed"
    );
  }
  Ok(())
}

#[cfg(all(test, feature = "vault"))]
mod tests {
  use super::provision;
  use tento_secrets::{Address, Kind, SetOpts, Unlock, Vault};

  #[test]
  fn copies_only_selected_current_values_with_fresh_keys_and_preserves_source() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("acceptance");
    let mut vault = Vault::init_at(&source).unwrap();
    let address = Address::parse("provider/profile").unwrap();
    vault.set(&address, b"old", SetOpts::default()).unwrap();
    vault
      .set(
        &address,
        b"current",
        SetOpts {
          kind: Some(Kind::TokenJson),
          ..Default::default()
        },
      )
      .unwrap();
    vault
      .set(
        &Address::parse("provider/password").unwrap(),
        b"excluded",
        SetOpts {
          kind: Some(Kind::Password),
          ..Default::default()
        },
      )
      .unwrap();
    let before = std::fs::read(source.join("manifest.json")).unwrap();
    provision(&source, &target, &["provider/profile".into()]).unwrap();
    let copied = Vault::open_at(&target).unwrap();
    assert_eq!(copied.records().count(), 1);
    assert_ne!(copied.recipient_hex(), vault.recipient_hex());
    assert_ne!(copied.manifest().signer, vault.manifest().signer);
    assert_eq!(copied.read(&address, None).unwrap().expose(), b"current");
    assert_eq!(copied.record(&address).unwrap().kind, Kind::TokenJson);
    assert_eq!(copied.record(&address).unwrap().unlock, Unlock::None);
    assert_eq!(std::fs::read(source.join("manifest.json")).unwrap(), before);
    assert!(provision(&source, &target, &["provider/profile".into()]).is_err());
  }

  #[test]
  fn invalid_selection_leaves_no_destination() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("acceptance");
    let mut vault = Vault::init_at(&source).unwrap();
    vault
      .set(
        &Address::parse("provider/password").unwrap(),
        b"excluded",
        SetOpts {
          kind: Some(Kind::Password),
          ..Default::default()
        },
      )
      .unwrap();
    vault
      .set(
        &Address::parse("provider/profile").unwrap(),
        b"ok",
        SetOpts::default(),
      )
      .unwrap();
    for names in [
      vec![],
      vec!["provider/missing"],
      vec!["provider/profile", "provider/password"],
      vec!["provider/profile", "provider/profile"],
    ] {
      assert!(
        provision(
          &source,
          &target,
          &names.into_iter().map(String::from).collect::<Vec<_>>()
        )
        .is_err()
      );
      assert!(!target.exists());
    }
  }
}
