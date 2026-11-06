//! `serve --login`: invite-only browser accounts gate the app document and
//! every keyless `/api/v1` call; API keys are unaffected; a signed-in
//! person's approvals are recorded under their email.

mod common;

use std::path::PathBuf;

use actix_web::{App, test, web};
use autophys::sha256_hex;
use autophys_cli::keys::Options;
use autophys_cli::{AppConfig, BuildInfo, webapp};
use common::*;
use serde_json::{Value, json};

const PUBLIC: &str = "https://autophys.example.org";
const CONFIG: &[u8] = br#"{"name":"thermal","x":1.5}"#;

fn web_root() -> PathBuf {
    let dir = tempfile::tempdir().unwrap().keep();
    std::fs::create_dir_all(dir.join("routes")).unwrap();
    std::fs::write(
        dir.join("routes/index.anon.html"),
        "<!doctype html><title>autophys</title><body></body></html>",
    )
    .unwrap();
    dir
}

macro_rules! app {
    ($api:expr) => {{
        let config = AppConfig {
            project_root: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            web_root: web_root(),
            store: Some($api.clone()),
        };
        let info = BuildInfo {
            version: "0.1.0".into(),
            commit: "test".into(),
            web_id: None,
        };
        let webapp = std::sync::Arc::new(webapp(&config, info, false).unwrap());
        test::init_service(App::new().configure(move |cfg| webapp.configure(cfg, web::scope(""))))
            .await
    }};
}

fn login_fixture() -> Fixture {
    fixture_with(Options {
        login: true,
        public_url: Some(PUBLIC.into()),
        ..options()
    })
}

/// A request as it arrives through the public proxy (Host is not local).
fn public(req: test::TestRequest) -> test::TestRequest {
    req.insert_header(("host", "autophys.example.org"))
        .insert_header(("sec-fetch-site", "same-origin"))
        .peer_addr("127.0.0.1:50000".parse().unwrap())
}

fn form(path: &str, body: &str, origin: Option<&str>) -> test::TestRequest {
    let req = public(test::TestRequest::post().uri(path))
        .insert_header(("content-type", "application/x-www-form-urlencoded"))
        .set_payload(body.to_string());
    match origin {
        Some(o) => req.insert_header(("origin", o)),
        None => req,
    }
}

/// (status, Location, the named Set-Cookie value, body)
async fn send<S, B>(
    app: &S,
    req: test::TestRequest,
    cookie: &str,
) -> (u16, String, Option<String>, String)
where
    S: actix_web::dev::Service<
            actix_http::Request,
            Response = actix_web::dev::ServiceResponse<B>,
            Error = actix_web::Error,
        >,
    B: actix_web::body::MessageBody,
{
    let resp = test::call_service(app, req.to_request()).await;
    let status = resp.status().as_u16();
    let location = resp
        .headers()
        .get("location")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let set = resp
        .response()
        .cookies()
        .find(|c| c.name() == cookie)
        .map(|c| c.value().to_string());
    let body = String::from_utf8_lossy(&test::read_body(resp).await).to_string();
    (status, location, set, body)
}

#[actix_web::test]
async fn sign_in_gates_the_app_and_the_browser_api() {
    let f = login_fixture();
    let app = app!(f.api);

    // Signed-out workspaces render the app shell, whose main pane owns sign-in.
    // Keyless reads are refused even with a document session and a local Host.
    let (s, _, _, page) = send(
        &app,
        public(test::TestRequest::get().uri("/app/inv_1?x=1")),
        "x",
    )
    .await;
    assert_eq!(s, 200);
    assert!(page.contains("data-signed-in=\"false\""));
    assert_eq!(
        call(
            &app,
            browser(&f.api, get("/workspace", None), false).to_request()
        )
        .await
        .0,
        401
    );
    // Legacy login links always enter the workspace; no standalone form is served.
    for (uri, expected) in [
        ("/login", "/app"),
        (
            "/login?next=%2Fapp%2Finv_1%3Fx%3D1%23record",
            "/app/inv_1?x=1#record",
        ),
        ("/login?next=%2Flogin", "/app"),
        ("/login?next=%2F%2Fevil.example", "/app"),
    ] {
        let (s, to, _, page) = send(&app, public(test::TestRequest::get().uri(uri)), "x").await;
        assert_eq!((s, to.as_str()), (303, expected), "{uri}");
        assert!(!page.contains("<form"));
    }

    // Both landing and workspace are public shells; account data remains gated.
    let (s, _, _, page) = send(&app, public(test::TestRequest::get().uri("/")), "x").await;
    assert!(s == 200 && page.contains("data-signed-in=\"false\"") && !page.contains("Sign out"));
    for uri in [
        "/app",
        "/app?source=fixtures",
        "/app/inv_1?x=1&source=fixtures",
    ] {
        let (s, _, _, page) = send(&app, public(test::TestRequest::get().uri(uri)), "x").await;
        assert!(
            s == 200 && page.contains("data-signed-in=\"false\""),
            "{uri}: {s}"
        );
    }

    // Accept an invite: password rules, then a session cookie.
    let invite = f.api.keys.users_invite("Ada@Lab.org").unwrap();
    let body =
        |pw: &str, confirm: &str| format!("token={}&password={pw}&confirm={confirm}", invite.token);
    let (s, _, _, page) = send(
        &app,
        form(
            "/api/auth/invite",
            &body("longenough1", "different11"),
            Some(PUBLIC),
        ),
        "x",
    )
    .await;
    assert!(s == 400 && page.contains("don&#39;t match"), "{page}");
    let (s, _, _, _) = send(
        &app,
        form(
            "/api/auth/invite",
            &body("longenough1", "longenough1"),
            None,
        ),
        "x",
    )
    .await;
    assert_eq!(s, 403, "a form POST needs an Origin");
    let (s, _, _, _) = send(
        &app,
        form(
            "/api/auth/invite",
            &body("longenough1", "longenough1"),
            Some("https://evil.example"),
        ),
        "x",
    )
    .await;
    assert_eq!(s, 403, "a foreign Origin");
    let (s, to, login, _) = send(
        &app,
        form(
            "/api/auth/invite",
            &body("longenough1", "longenough1"),
            Some(PUBLIC),
        ),
        "autophys_login",
    )
    .await;
    assert_eq!((s, to.as_str()), (303, "/app"));
    let login = login.expect("sign-in cookie");
    // The invite is spent.
    let (s, _, _, page) = send(
        &app,
        form(
            "/api/auth/invite",
            &body("longenough1", "longenough1"),
            Some(PUBLIC),
        ),
        "x",
    )
    .await;
    assert!(s == 400 && page.contains("expired"), "{page}");

    // Signed in: the document carries the badge and a document session.
    let doc = public(test::TestRequest::get().uri("/app")).cookie(actix_web::cookie::Cookie::new(
        "autophys_login",
        login.clone(),
    ));
    let (s, _, session, page) = send(&app, doc, "autophys_session").await;
    assert_eq!(s, 200, "{page}");
    assert!(page.contains("ada@lab.org") && page.contains("/api/auth/logout"));
    let session = session.expect("document session");
    let both = |req: test::TestRequest| {
        public(req)
            .cookie(actix_web::cookie::Cookie::new(
                "autophys_login",
                login.clone(),
            ))
            .cookie(actix_web::cookie::Cookie::new(
                "autophys_session",
                session.clone(),
            ))
    };
    assert_eq!(
        call(&app, both(get("/workspace", None)).to_request())
            .await
            .0,
        200
    );
    let (s, me) = call(
        &app,
        both(test::TestRequest::get().uri("/api/auth/me")).to_request(),
    )
    .await;
    assert_eq!(
        (s, me["user"]["email"].as_str()),
        (200, Some("ada@lab.org"))
    );
    // The sign-in cookie alone is enough, so a daemon restart (which drops the
    // process-local document sessions) does not sign anyone out.
    let only_login = |req: test::TestRequest| {
        public(req).cookie(actix_web::cookie::Cookie::new(
            "autophys_login",
            login.clone(),
        ))
    };
    assert_eq!(
        call(&app, only_login(get("/workspace", None)).to_request())
            .await
            .0,
        200
    );
    // A read that is not same-origin (a sibling subdomain, a cross-site
    // navigation) is refused even with the sign-in cookie.
    for site in ["same-site", "cross-site", "none"] {
        let req = only_login(get("/workspace", None)).insert_header(("sec-fetch-site", site));
        assert_eq!(call(&app, req.to_request()).await.0, 401, "{site}");
    }
    // The signed-in document refuses framing; the badge fragment serves an in-place sign-in.
    let doc = only_login(test::TestRequest::get().uri("/app")).to_request();
    let resp = test::call_service(&app, doc).await;
    assert_eq!(resp.headers().get("x-frame-options").unwrap(), "DENY");
    let (s, _, _, frag) = send(
        &app,
        only_login(test::TestRequest::get().uri("/api/auth/badge")),
        "x",
    )
    .await;
    assert!(
        s == 200 && frag.contains("ada@lab.org") && frag.contains("/api/auth/logout"),
        "{frag}"
    );
    // The demo account: no password; the workspace advertises it only when set.
    let (_, _, _, page) = send(&app, public(test::TestRequest::get().uri("/app")), "x").await;
    assert!(page.contains("data-demo=\"false\""));
    let (s, _, _, _) = send(
        &app,
        form("/api/auth/demo", "next=%2Fapp", Some(PUBLIC)),
        "x",
    )
    .await;
    assert_eq!(s, 404, "no demo account yet");
    let demo = f.api.keys.users_set_demo("Demo@Lab.org", true).unwrap();
    assert!(demo.demo && demo.active);
    let (_, _, _, page) = send(&app, public(test::TestRequest::get().uri("/app")), "x").await;
    assert!(page.contains("data-demo=\"true\""), "{page}");
    let (_, _, _, page) = send(&app, public(test::TestRequest::get().uri("/")), "x").await;
    assert!(page.contains("data-demo=\"true\""), "{page}");
    let (s, _, _, _) = send(&app, form("/api/auth/demo", "next=%2Fapp", None), "x").await;
    assert_eq!(s, 403, "the demo form needs an Origin");
    let (s, to, demo_cookie, _) = send(
        &app,
        form("/api/auth/demo", "next=%2Fapp", Some(PUBLIC)),
        "autophys_login",
    )
    .await;
    assert_eq!((s, to.as_str()), (303, "/app"));
    let as_demo = |req: test::TestRequest| {
        public(req).cookie(actix_web::cookie::Cookie::new(
            "autophys_login",
            demo_cookie.clone().unwrap(),
        ))
    };
    let (_, _, _, frag) = send(
        &app,
        as_demo(test::TestRequest::get().uri("/api/auth/badge")),
        "x",
    )
    .await;
    assert!(
        frag.contains("demo@lab.org") && frag.contains("Demo account"),
        "{frag}"
    );
    assert!(
        f.api
            .keys
            .users_check("demo@lab.org", "")
            .unwrap()
            .is_none(),
        "no password sign-in"
    );
    // Turning the demo off signs its sessions out and drops the button.
    f.api.keys.users_set_demo("demo@lab.org", false).unwrap();
    assert_eq!(
        call(&app, as_demo(get("/workspace", None)).to_request())
            .await
            .0,
        401
    );
    let (_, _, _, page) = send(&app, public(test::TestRequest::get().uri("/app")), "x").await;
    assert!(page.contains("data-demo=\"false\""));
    // A read-only account reads but cannot write, and the popover says so.
    f.api.keys.users_set_read_only("ada@lab.org", true).unwrap();
    assert_eq!(
        call(&app, only_login(get("/workspace", None)).to_request())
            .await
            .0,
        200
    );
    let write = only_login(test::TestRequest::post().uri("/api/v1/pairings/ABCD-1234/approve"))
        .insert_header(("origin", PUBLIC))
        .insert_header(("content-type", "application/json"))
        .set_payload("{}");
    assert_eq!(call(&app, write.to_request()).await.0, 403);
    let (_, _, _, frag) = send(
        &app,
        only_login(test::TestRequest::get().uri("/api/auth/badge")),
        "x",
    )
    .await;
    assert!(frag.contains("Read-only"), "{frag}");
    f.api
        .keys
        .users_set_read_only("ada@lab.org", false)
        .unwrap();
    // Writes still need one of the daemon's own origins.
    let foreign = only_login(test::TestRequest::post().uri("/api/v1/pairings/ABCD-1234/approve"))
        .insert_header(("origin", "https://evil.example"))
        .insert_header(("content-type", "application/json"))
        .set_payload("{}");
    assert_eq!(call(&app, foreign.to_request()).await.0, 403);

    // Password sign-in.
    let (s, _, _, failure) = send(
        &app,
        form(
            "/api/auth/login",
            "email=ada%40lab.org&password=wrongwrong1&next=%2Fapp",
            Some(PUBLIC),
        ),
        "x",
    )
    .await;
    assert_eq!(s, 401);
    assert_eq!(
        serde_json::from_str::<Value>(&failure).unwrap()["error"],
        "invalid"
    );
    // Repeated failures for one email lock it for the window (429), even
    // with the right password; other emails are unaffected.
    for _ in 1..autophys_cli::login::Throttle::FAILURES {
        let (s, _, _, _) = send(
            &app,
            form(
                "/api/auth/login",
                "email=ada%40lab.org&password=wrongwrong1",
                Some(PUBLIC),
            ),
            "x",
        )
        .await;
        assert_eq!(s, 401);
    }
    let (s, _, _, page) = send(
        &app,
        form(
            "/api/auth/login",
            "email=ada%40lab.org&password=longenough1",
            Some(PUBLIC),
        ),
        "x",
    )
    .await;
    assert!(s == 429 && page.contains("Too many"), "{s}");
    let (s, to, _, page) = send(
        &app,
        form(
            "/api/auth/login",
            "email=ada%40lab.org&password=wrong",
            Some(PUBLIC),
        )
        .insert_header(("sec-fetch-mode", "navigate")),
        "x",
    )
    .await;
    assert_eq!((s, to.as_str()), (303, "/app?signin_error=throttled"));
    assert!(!page.contains("<form"));
    let app = app!(f.api);
    let (s, to, again, _) = send(
        &app,
        form(
            "/api/auth/login",
            "email=ADA%40lab.org&password=longenough1&next=%2F%2Fevil.example",
            Some(PUBLIC),
        ),
        "autophys_login",
    )
    .await;
    assert_eq!((s, to.as_str()), (303, "/app"), "next is same-site only");
    assert!(again.is_some());

    // Sign out ends the session.
    let out = form("/api/auth/logout", "", Some(PUBLIC)).cookie(actix_web::cookie::Cookie::new(
        "autophys_login",
        login.clone(),
    ));
    let (s, to, _, _) = send(&app, out, "x").await;
    assert_eq!((s, to.as_str()), (303, "/app"));
    assert_eq!(
        call(&app, both(get("/workspace", None)).to_request())
            .await
            .0,
        401
    );
}

#[actix_web::test]
async fn api_keys_still_work_and_approvals_record_the_person() {
    let f = login_fixture();
    let app = app!(f.api);
    // Pairing and keyed calls are untouched by --login.
    let key = pair(&app, &f.api, "lab-pc").await;
    let k = Some(key.as_str());
    let (_, p) = call(
        &app,
        post("/projects", k, &json!({"name": "thermal"})).to_request(),
    )
    .await;
    let pid = p["project"]["id"].as_str().unwrap().to_string();
    let version = format!("sha256:{}", sha256_hex([CONFIG]));
    let (s, _) = call(
        &app,
        put_raw(
            &format!("/projects/{pid}/config_versions/{version}"),
            k,
            CONFIG,
        )
        .to_request(),
    )
    .await;
    assert_eq!(s, 201);
    let body = json!({"project_id": pid, "config_version": version, "overrides": {"free": ["C"]}, "meta": {"name": "thermal"}});
    let (s, inv) = call(&app, post("/investigations", k, &body).to_request()).await;
    assert_eq!(s, 201, "{inv}");
    let inv = inv["id"].as_str().unwrap().to_string();
    let base = format!("/investigations/{inv}/proposals");
    let proposed = json!({"id": "r1", "kind": "proposal", "payload": {"proposal_id": "p1", "event": "proposed", "experiment": "sine", "settings": {"f": 0.44}}});
    assert_eq!(
        call(&app, post(&base, k, &proposed).to_request()).await.0,
        201
    );

    // A signed-in browser approves; the page claims to be "james".
    let invite = f.api.keys.users_invite("ada@lab.org").unwrap();
    let user = f
        .api
        .keys
        .users_accept(&invite.token, "longenough1")
        .unwrap();
    let login = f.api.keys.session_start(&user).unwrap();
    let approve = json!({"id": "a1", "kind": "proposal", "payload": {"proposal_id": "p1", "event": "approved", "by": "james"}});
    let req = public(post(&format!("{base}/p1/approvals"), None, &approve))
        .insert_header(("origin", PUBLIC))
        .cookie(actix_web::cookie::Cookie::new("autophys_login", login))
        .cookie(f.api.sessions.issue_cookie().unwrap());
    let (s, out) = call(&app, req.to_request()).await;
    assert_eq!(s, 201, "{out}");
    let (_, records) = call(
        &app,
        get(&format!("/investigations/{inv}/records?kind=proposal"), k).to_request(),
    )
    .await;
    let approved: Vec<&Value> = records["records"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["payload"]["event"] == "approved")
        .collect();
    assert_eq!(approved.len(), 1, "{records}");
    assert_eq!(approved[0]["payload"]["by"], "ada@lab.org");
}

#[actix_web::test]
async fn without_login_the_local_browser_rules_are_unchanged() {
    let f = fixture();
    let app = app!(f.api);
    let (s, _, session, page) = send(
        &app,
        public(test::TestRequest::get().uri("/app")),
        "autophys_session",
    )
    .await;
    assert!(s == 200 && session.is_some() && !page.contains("ap-account"));
    assert_eq!(
        call(
            &app,
            browser(&f.api, get("/workspace", None), false).to_request()
        )
        .await
        .0,
        200
    );
}
