//! Anonymous landing traffic must not consume the local document-session cap.
mod common;

use actix_web::{App, cookie::Cookie, test, web};
use autophys_cli::{AppConfig, BuildInfo, keys::Options, webapp};
use std::{path::PathBuf, sync::Arc};

#[actix_web::test]
async fn signed_out_landings_preserve_authenticated_document_admission() {
    let f = common::fixture_with(Options {
        login: true,
        ..common::options()
    });
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("routes")).unwrap();
    std::fs::write(root.path().join("routes/index.anon.html"), "<body></body>").unwrap();
    let config = AppConfig {
        project_root: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        web_root: root.path().to_path_buf(),
        store: Some(f.api.clone()),
    };
    let domain = Arc::new(webapp(&config, BuildInfo::current(), false).unwrap());
    let app =
        test::init_service(App::new().configure(move |cfg| domain.configure(cfg, web::scope(""))))
            .await;
    for _ in 0..16 {
        let response =
            test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;
        assert_eq!(response.status(), 200);
        assert!(
            !response
                .response()
                .cookies()
                .any(|c| c.name() == "autophys_session")
        );
    }
    let invite = f.api.keys.users_invite("admission@example.org").unwrap();
    let user = f
        .api
        .keys
        .users_accept(&invite.token, "test-password-123")
        .unwrap();
    let login = f.api.keys.session_start(&user).unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/app")
            .cookie(Cookie::new("autophys_login", login.clone()))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), 200);
    assert!(
        response
            .response()
            .cookies()
            .any(|c| c.name() == "autophys_session" && c.value().len() == 64)
    );
    // Exactly one authenticated document has spent admission, regardless of
    // the preceding anonymous requests. Keep the existing bounded policy.
    for _ in 1..4096 {
        f.api.sessions.issue_cookie().unwrap();
    }
    assert!(f.api.sessions.issue_cookie().is_err());
    let response = test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;
    assert_eq!(
        response.status(),
        200,
        "the anonymous landing works even at capacity"
    );
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/v1/workspace")
            .insert_header(("host", "localhost"))
            .insert_header(("sec-fetch-site", "same-origin"))
            .cookie(Cookie::new("autophys_login", login))
            .to_request(),
    )
    .await;
    assert_eq!(
        response.status(),
        200,
        "persistent sign-in API admission is independent"
    );
}
