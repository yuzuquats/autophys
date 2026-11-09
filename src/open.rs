//! Deep links into the workbench (decisions.md, "Case study deep links",
//! DL-1 to DL-3).
//!
//! ```text
//! HEAD /open/{user}/{kind}/{name}   200 when the caller may open it, else 404
//! GET  /open/{user}/{kind}/{name}   302 /app?open={user}/{kind}/{name}, else 404
//! ```
//!
//! `user` is a reserved name, never an account id or email: `demo` is the
//! demo account's collection (only with `serve --login` and a demo account),
//! `me` the caller's own (the local collection without `--login`), and `local`
//! the local collection of a login-off install. Any other name answers 404;
//! the slot is kept for `@handles` once collections can be shared. `kind`
//! names a registered [`Kind`]; `name` is the target's slug inside the
//! collection.
//!
//! Access (DL-3): the demo account's collection is public, derived from
//! `users.demo`; every other collection answers only its owner. A target the
//! caller may not open answers exactly like a missing one, so a probe never
//! reveals another account's workbooks. A probe reads the server database
//! and stats one file; it opens no workbook.

use std::path::{Path, PathBuf};

use actix_web::http::header;
use actix_web::{HttpRequest, HttpResponse, web};

use crate::accounts::User;
use crate::error::Result;
use crate::http::auth::signed_in;
use crate::http::{Api, blocking};

/// The mount point.
pub const PREFIX: &str = "/open";

/// A kind of deep-link target: how a name is checked inside a collection.
pub struct Kind {
    pub name: &'static str,
    /// Whether `name` (already a [`valid_name`]) exists in the collection at `root`.
    pub exists: fn(root: &Path, name: &str) -> bool,
}

/// The registered kinds. Add a row to link to another kind of target.
pub const KINDS: &[Kind] = &[Kind {
    name: "workbook",
    exists: workbook_exists,
}];

/// A project's workbook, `<name>.ap-workbook`, named by its slug.
fn workbook_exists(root: &Path, name: &str) -> bool {
    autophys::slug(name) == name && root.join(format!("{name}{}", autophys::SUFFIX)).is_file()
}

/// A target name: a slug of 1 to 100 lowercase letters, digits, `_`, `-` and
/// `.`, starting with a letter or digit, with no `..`. Nothing that could
/// leave the collection directory or need escaping in the `/app` address.
pub fn valid_name(name: &str) -> bool {
    (1..=100).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && !name.contains("..")
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-' | b'.')
        })
}

/// DL-3's light access rule: the demo account's collection is public; any
/// other account's collection is its owner's alone.
pub fn may_open(owner: &User, caller: Option<&User>) -> bool {
    owner.demo || caller.is_some_and(|c| c.id == owner.id)
}

/// Register `/open/{user}/{kind}/{name}` (HEAD and GET) and a plain 404 for
/// any other `/open` path, so none of them falls through to the app shell.
pub fn configure(cfg: &mut web::ServiceConfig, api: Api) {
    let data = web::Data::new(api);
    cfg.service(
        web::resource(format!("{PREFIX}/{{user}}/{{kind}}/{{name}}"))
            .app_data(data)
            .route(web::head().to(probe))
            .route(web::get().to(open))
            .default_service(web::to(missing)),
    );
    cfg.route(PREFIX, web::route().to(missing));
    cfg.route(&format!("{PREFIX}/{{tail:.*}}"), web::route().to(missing));
}

/// The collection a reserved user name selects, when the caller may open it.
fn collection(
    api: &Api,
    login: bool,
    user: &str,
    caller: Option<&User>,
) -> Result<Option<PathBuf>> {
    let local = || Some(api.client.root().to_path_buf());
    let owner = match (user, login) {
        ("local", false) | ("me", false) => return Ok(local()),
        ("demo", true) => api.keys.users_demo()?.filter(|u| u.active),
        ("me", true) => caller.cloned(),
        _ => None,
    };
    match owner {
        Some(owner) if may_open(&owner, caller) => api.keys.collection_of(&owner.id),
        _ => Ok(None),
    }
}

/// Whether the caller may open `{user}/{kind}/{name}`.
async fn allowed(api: &Api, req: &HttpRequest, path: &(String, String, String)) -> Result<bool> {
    let (user, kind, name) = path;
    let Some(kind) = KINDS.iter().find(|k| k.name == kind) else {
        return Ok(false);
    };
    if !valid_name(name) {
        return Ok(false);
    }
    let login = api.options().login;
    // A login-off daemon answers only its own local browser (loopback, local Host).
    if !login && !crate::http::auth::local_browser(req, api) {
        return Ok(false);
    }
    let caller = if login {
        signed_in(api, req).await?
    } else {
        None
    };
    let (api, user, name, exists) = (api.clone(), user.clone(), name.clone(), kind.exists);
    blocking(move || {
        Ok(collection(&api, login, &user, caller.as_ref())?
            .is_some_and(|root| exists(&root, &name)))
    })
    .await
}

fn no_store(mut response: actix_web::HttpResponseBuilder) -> actix_web::HttpResponseBuilder {
    response.insert_header((header::CACHE_CONTROL, "no-store"));
    response
}

async fn missing() -> HttpResponse {
    no_store(HttpResponse::NotFound())
        .content_type("text/plain; charset=utf-8")
        .body("Not found\n")
}

/// `HEAD`: 200 or 404, no body.
async fn probe(
    api: web::Data<Api>,
    req: HttpRequest,
    path: web::Path<(String, String, String)>,
) -> Result<HttpResponse> {
    Ok(if allowed(&api, &req, &path).await? {
        no_store(HttpResponse::Ok()).finish()
    } else {
        no_store(HttpResponse::NotFound()).finish()
    })
}

/// `GET`: into the workbench, which selects the target once it has loaded.
async fn open(
    api: web::Data<Api>,
    req: HttpRequest,
    path: web::Path<(String, String, String)>,
) -> Result<HttpResponse> {
    if !allowed(&api, &req, &path).await? {
        return Ok(missing().await);
    }
    let (user, kind, name) = path.into_inner();
    // Every part is a reserved word, a registered kind or a valid_name: no escaping needed.
    Ok(no_store(HttpResponse::Found())
        .insert_header((header::LOCATION, format!("/app?open={user}/{kind}/{name}")))
        .finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str, demo: bool) -> User {
        User {
            id: id.into(),
            email: format!("{id}@lab.org"),
            created: String::new(),
            active: true,
            read_only: demo,
            demo,
        }
    }

    #[test]
    fn names_are_slugs_that_stay_in_the_collection() {
        for good in ["battery_cycler_demo", "a", "thermal-rc.v2", "9lives"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in [
            "",
            "..",
            "../x",
            "a/../b",
            "a/b",
            "a\\b",
            ".hidden",
            "-x",
            "_x",
            "Battery",
            "a b",
            "a%2Fb",
            "a..b",
            "a\0b",
            "ä",
            &"x".repeat(101),
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_demo_is_public_and_every_other_collection_its_owners() {
        let (demo, ada, bob) = (
            user("u_demo", true),
            user("u_ada", false),
            user("u_bob", false),
        );
        assert!(may_open(&demo, None));
        assert!(may_open(&demo, Some(&ada)));
        assert!(may_open(&ada, Some(&ada)));
        assert!(!may_open(&ada, None));
        assert!(!may_open(&ada, Some(&bob)));
    }
}
