//! The bare name `default` is always the bundled playbook (Python reference:
//! `test_A9_bare_name_always_bundled`). Its own test binary: it changes the
//! working directory.
use autophys::playbook::load_playbook;

#[test]
fn the_bare_name_is_always_bundled() {
    let expected = load_playbook("default").unwrap().sha256;
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("default")).unwrap();
    let mut data = load_playbook("default").unwrap().data().unwrap();
    data.extend_from_slice(b"\nWrong.\n");
    std::fs::write(dir.path().join("default/SKILL.md"), data).unwrap();
    let cwd = std::env::current_dir().unwrap();
    std::env::set_current_dir(dir.path()).unwrap();
    let (bare, dotted) = (
        load_playbook("default").map(|b| b.sha256),
        load_playbook("./default").map(|b| b.sha256),
    );
    std::env::set_current_dir(cwd).unwrap();
    assert_eq!(bare.unwrap(), expected);
    assert_ne!(dotted.unwrap(), expected);
}
