//! `/open/{user}/{kind}/{name}` deep links (decisions.md DL-1 to DL-3): the
//! reserved user names, the demo account's public collection, and 404 for
//! everything a caller may not open.

mod common;

use std::path::PathBuf;

use actix_web::cookie::Cookie;
use actix_web::{App, test, web};
use autophys_cli::accounts::User;
use autophys_cli::keys::Options;
use autophys_cli::{AppConfig, BuildInfo, webapp};
use common::*;

const PUBLIC: &str = "https://autophys.example.org";
const BOOK: &str = "battery_cycler_demo";

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

/// (status, Location, Cache-Control, body)
async fn send<S, B>(app: &S, req: test::TestRequest) -> (u16, String, String, String)
where
    S: actix_web::dev::Service<
            actix_http::Request,
            Response = actix_web::dev::ServiceResponse<B>,
            Error = actix_web::Error,
        >,
    B: actix_web::body::MessageBody,
{
    let resp = test::call_service(app, req.to_request()).await;
    let header = |name: &str| {
        resp.headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default()
    };
    let (status, location, cache) = (
        resp.status().as_u16(),
        header("location"),
        header("cache-control"),
    );
    let body = String::from_utf8_lossy(&test::read_body(resp).await).to_string();
    (status, location, cache, body)
}

fn head(uri: &str, login: Option<&str>) -> test::TestRequest {
    as_caller(
        test::TestRequest::default()
            .method(actix_web::http::Method::HEAD)
            .uri(uri),
        login,
    )
}

fn get_page(uri: &str, login: Option<&str>) -> test::TestRequest {
    as_caller(test::TestRequest::get().uri(uri), login)
}

/// The same request as the daemon's own browser would send it.
fn local(req: test::TestRequest) -> test::TestRequest {
    req.insert_header(("host", "127.0.0.1:4794"))
}

fn as_caller(req: test::TestRequest, login: Option<&str>) -> test::TestRequest {
    let req = req
        .insert_header(("host", "autophys.example.org"))
        .peer_addr("127.0.0.1:50000".parse().unwrap());
    match login {
        Some(token) => req.cookie(Cookie::new("autophys_login", token.to_string())),
        None => req,
    }
}

/// An account with a password, signed in: (user, session token).
fn member(f: &Fixture, email: &str) -> (User, String) {
    let invite = f.api.keys.users_invite(email).unwrap();
    let user = f
        .api
        .keys
        .users_accept(&invite.token, "longenough1")
        .unwrap();
    let token = f.api.keys.session_start(&user).unwrap();
    (user, token)
}

/// Create project `name`'s workbook in account `email`'s collection.
fn workbook_for(f: &Fixture, email: &str, name: &str) {
    let inventory = f.api.keys.workspace_inventory().unwrap();
    let root = inventory["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["email"] == email)
        .and_then(|a| a["collection"].as_str())
        .unwrap()
        .to_string();
    autophys::connect(Some(&root))
        .unwrap()
        .ensure_project(name)
        .unwrap();
}

#[actix_web::test]
async fn the_demo_collection_is_public_and_every_other_one_private() {
    let f = fixture_with(Options {
        login: true,
        public_url: Some(PUBLIC.into()),
        ..options()
    });
    let app = app!(f.api);
    let demo_link = format!("/open/demo/workbook/{BOOK}");

    // No demo account yet: nothing to open.
    assert_eq!(send(&app, head(&demo_link, None)).await.0, 404);

    f.api.keys.users_set_demo("demo@lab.org", true).unwrap();
    assert_eq!(
        send(&app, head(&demo_link, None)).await.0,
        404,
        "no such workbook yet"
    );
    workbook_for(&f, "demo@lab.org", BOOK);

    // Anyone may probe and follow a demo link, signed out or as another account.
    let (s, _, cache, body) = send(&app, head(&demo_link, None)).await;
    assert_eq!((s, cache.as_str(), body.as_str()), (200, "no-store", ""));
    let (s, to, cache, _) = send(&app, get_page(&demo_link, None)).await;
    assert_eq!(
        (s, to.as_str(), cache.as_str()),
        (
            302,
            "/app?open=demo/workbook/battery_cycler_demo",
            "no-store"
        )
    );
    let (ada, ada_token) = member(&f, "ada@lab.org");
    let (_, bob_token) = member(&f, "bob@lab.org");
    assert_eq!(send(&app, head(&demo_link, Some(&ada_token))).await.0, 200);
    assert_eq!(
        send(&app, get_page(&demo_link, Some(&bob_token))).await.0,
        302
    );

    // `me` is the caller's own collection, and only theirs.
    workbook_for(&f, "ada@lab.org", "ada_cell");
    let mine = "/open/me/workbook/ada_cell";
    assert_eq!(send(&app, head(mine, Some(&ada_token))).await.0, 200);
    let (s, to, _, _) = send(&app, get_page(mine, Some(&ada_token))).await;
    assert_eq!((s, to.as_str()), (302, "/app?open=me/workbook/ada_cell"));
    assert_eq!(send(&app, head(mine, None)).await.0, 404, "signed out");
    // Another account gets the same 404 as a missing workbook, never a 403.
    for uri in [
        mine.to_string(),
        format!("/open/{}/workbook/ada_cell", ada.id),
        "/open/ada@lab.org/workbook/ada_cell".to_string(),
    ] {
        let (s, _, cache, _) = send(&app, head(&uri, Some(&bob_token))).await;
        assert_eq!((s, cache.as_str()), (404, "no-store"), "{uri}");
        let (s, to, _, body) = send(&app, get_page(&uri, Some(&bob_token))).await;
        assert_eq!(
            (s, to.as_str(), body.as_str()),
            (404, "", "Not found\n"),
            "{uri}"
        );
    }
    // Account ids and emails are not user names, even for the owner.
    let by_id = format!("/open/{}/workbook/ada_cell", ada.id);
    assert_eq!(send(&app, head(&by_id, Some(&ada_token))).await.0, 404);

    // The demo account's own `me` is the demo collection, and its documents say so.
    let demo = f.api.keys.users_demo().unwrap().unwrap();
    let demo_token = f.api.keys.session_start(&demo).unwrap();
    let demo_mine = format!("/open/me/workbook/{BOOK}");
    assert_eq!(send(&app, head(&demo_mine, Some(&demo_token))).await.0, 200);
    let (_, _, _, page) = send(&app, get_page("/app", Some(&demo_token))).await;
    assert!(page.contains(r#""demo":true"#), "{page}");
    let (_, _, _, page) = send(&app, get_page("/app", Some(&ada_token))).await;
    assert!(page.contains(r#""demo":false"#), "{page}");

    // Unknown users, kinds and names, and anything that is not a slug.
    for uri in [
        "/open/local/workbook/battery_cycler_demo",
        "/open/nobody/workbook/battery_cycler_demo",
        "/open/@demo/workbook/battery_cycler_demo",
        "/open/demo/notebook/battery_cycler_demo",
        "/open/demo/workbook/missing",
        "/open/demo/workbook/Battery_Cycler_Demo",
        "/open/demo/workbook/battery_cycler_demo.ap-workbook",
        "/open/demo/workbook/..",
        "/open/demo/workbook/%2E%2E",
        "/open/demo/workbook/..%2Fbattery_cycler_demo",
        "/open/demo/workbook/%2E%2E%2Fworkspaces%2Fbattery_cycler_demo",
        "/open/demo/workbook/battery_cycler_demo%00",
        "/open/demo/workbook/.battery_cycler_demo",
        "/open/demo/workbook/battery_cycler_demo/x",
        "/open/demo/workbook",
        "/open",
    ] {
        let (s, to, cache, _) = send(&app, head(uri, Some(&ada_token))).await;
        assert_eq!((s, cache.as_str()), (404, "no-store"), "HEAD {uri}");
        let (s, to2, _, _) = send(&app, get_page(uri, None)).await;
        assert_eq!((s, to.as_str(), to2.as_str()), (404, "", ""), "GET {uri}");
    }

    // Turning the demo off makes its links 404.
    f.api.keys.users_set_demo("demo@lab.org", false).unwrap();
    assert_eq!(send(&app, head(&demo_link, None)).await.0, 404);
}

#[actix_web::test]
async fn a_login_off_install_opens_its_local_collection() {
    let f = fixture();
    f.api.client.ensure_project(BOOK).unwrap();
    let app = app!(f.api);
    for user in ["local", "me"] {
        let uri = format!("/open/{user}/workbook/{BOOK}");
        // Another Host (DNS rebinding) or a remote peer learns nothing.
        assert_eq!(send(&app, head(&uri, None)).await.0, 404, "{uri} via a foreign Host");
        let remote = local(head(&uri, None)).peer_addr("10.0.0.5:50000".parse().unwrap());
        assert_eq!(send(&app, remote).await.0, 404, "{uri} from a remote peer");
        assert_eq!(send(&app, local(head(&uri, None))).await.0, 200, "{uri}");
        let (s, to, _, _) = send(&app, local(get_page(&uri, None))).await;
        assert_eq!((s, to), (302, format!("/app?open={user}/workbook/{BOOK}")));
        let missing = format!("/open/{user}/workbook/missing");
        assert_eq!(send(&app, local(head(&missing, None))).await.0, 404, "{missing}");
    }
    // There is no demo account without --login.
    f.api.keys.users_set_demo("demo@lab.org", true).unwrap();
    assert_eq!(
        send(&app, head(&format!("/open/demo/workbook/{BOOK}"), None))
            .await
            .0,
        404
    );
}
