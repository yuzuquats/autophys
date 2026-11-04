//! `/api/v1` on actix-web: the SDK's draft contract rehomed, plus
//! `/workspace` and `/stream` for the browser. The daemon registers it from
//! its tento-web `DomainConfig`:
//!
//! ```ignore
//! .config(move |cfg| crate::http::configure(cfg, store.clone()))
//! ```
//!
//! Auth is in each handler's signature (store.md AX-9, O-3): `pair/*` takes
//! nothing; `/workspace`, `/stream`, `/pairings…` and `…/approvals` take
//! [`KeyOrBrowser`]; every other route takes [`Keyed`], a live
//! `Authorization: Bearer` key. A keyless write must be JSON (else 415) from
//! the daemon's own Origin (else 403).

pub mod auth;
mod sse;

use actix_web::http::StatusCode;
use actix_web::web::{self, Bytes};
use actix_web::{HttpRequest, HttpResponse, ResponseError};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::store::error::{Result, StoreError};
use crate::store::validate::{self, Envelope, Event, Kind};
use crate::store::{NewInvestigation, Store};

pub use auth::{Caller, KeyOrBrowser, Keyed};

/// The mount point.
pub const PREFIX: &str = "/api/v1";

/// Request bodies: a 1 MiB payload plus room for its envelope.
pub const BODY_LIMIT: usize = validate::MAX_PAYLOAD_BYTES + 64 * 1024;

impl ResponseError for StoreError {
    fn status_code(&self) -> StatusCode {
        StatusCode::from_u16(self.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
    }

    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status_code()).json(self.body())
    }
}

/// Register every `/api/v1` route on `cfg` (a tento-web `DomainConfig`
/// `.config` closure, or an `App::configure` in tests).
pub fn configure(cfg: &mut web::ServiceConfig, store: Store) {
    cfg.service(scope(store));
}

/// The `/api/v1` scope itself, with the store as app data and a JSON 404 for
/// anything it does not route.
pub fn scope(store: Store) -> actix_web::Scope {
    web::scope(PREFIX)
        .app_data(web::Data::new(store))
        .route("/pair/start", web::post().to(pair_start))
        .route("/pair/poll", web::post().to(pair_poll))
        .route("/pairings", web::get().to(pairings))
        .route(
            "/pairings/{user_code}/approve",
            web::post().to(pairing_approve),
        )
        .route("/pairings/{user_code}/deny", web::post().to(pairing_deny))
        .route("/whoami", web::get().to(whoami))
        .route("/workspace", web::get().to(workspace))
        .route("/stream", web::get().to(sse::stream))
        .route("/projects", web::get().to(projects))
        .route("/projects", web::post().to(create_project))
        .route(
            "/projects/{pid}/config_versions",
            web::get().to(config_versions),
        )
        .route(
            "/projects/{pid}/config_versions/{version}",
            web::put().to(put_config_version),
        )
        .route("/investigations", web::get().to(investigations))
        .route("/investigations", web::post().to(create_investigation))
        .route("/investigations/{inv}/records", web::get().to(records))
        .route(
            "/investigations/{inv}/measurements",
            web::post().to(measurements),
        )
        .route("/investigations/{inv}/runs", web::post().to(runs))
        .route("/investigations/{inv}/steps", web::post().to(steps))
        .route("/investigations/{inv}/outcome", web::post().to(outcome))
        .route("/investigations/{inv}/proposals", web::post().to(proposals))
        .route(
            "/investigations/{inv}/proposals/{pid}",
            web::get().to(proposal),
        )
        .route(
            "/investigations/{inv}/proposals/{pid}/approvals",
            web::post().to(approvals),
        )
        .route(
            "/investigations/{inv}/proposals/{pid}/data",
            web::post().to(data),
        )
        .default_service(web::to(not_found))
}

type Data = web::Data<Store>;

async fn read_body(body: web::Payload) -> Result<Bytes> {
    match body.to_bytes_limited(BODY_LIMIT).await {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(e)) => Err(StoreError::BadRequest(format!("reading the body: {e}"))),
        Err(_) => Err(StoreError::TooLarge(BODY_LIMIT)),
    }
}

async fn body_json(body: web::Payload) -> Result<Value> {
    let bytes = read_body(body).await?;
    if bytes.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| StoreError::BadRequest(format!("the body is not JSON: {e}")))
}

fn idempotency_key(req: &HttpRequest) -> Result<Option<String>> {
    match req.headers().get("idempotency-key") {
        None => Ok(None),
        Some(v) => v
            .to_str()
            .map(|s| Some(s.to_string()))
            .map_err(|_| StoreError::BadRequest("Idempotency-Key is not ASCII".into())),
    }
}

fn ok(body: Value) -> HttpResponse {
    HttpResponse::Ok().json(body)
}

fn created(created: bool, body: Value) -> HttpResponse {
    if created {
        HttpResponse::Created().json(body)
    } else {
        ok(body)
    }
}

async fn not_found() -> HttpResponse {
    StoreError::NotFound("route").error_response()
}

// --- pairing (no key) -------------------------------------------------------

async fn pair_start(store: Data, body: web::Payload) -> Result<HttpResponse> {
    let v = body_json(body).await?;
    let device = v.get("device_name").and_then(Value::as_str).unwrap_or("");
    let client = v.get("client").and_then(Value::as_str).unwrap_or("");
    Ok(HttpResponse::Ok().json(store.pair_start(device, client).await?))
}

async fn pair_poll(store: Data, body: web::Payload) -> Result<HttpResponse> {
    let v = body_json(body).await?;
    let code = v
        .get("device_code")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::BadRequest("device_code is required".into()))?;
    Ok(HttpResponse::Ok().json(store.pair_poll(code).await?))
}

async fn pairings(_: KeyOrBrowser, store: Data) -> Result<HttpResponse> {
    Ok(ok(json!({ "pairings": store.pairings_pending().await? })))
}

async fn pairing_approve(
    _: KeyOrBrowser,
    store: Data,
    code: web::Path<String>,
) -> Result<HttpResponse> {
    Ok(ok(json!({ "pairing": store.pair_approve(&code).await? })))
}

async fn pairing_deny(
    _: KeyOrBrowser,
    store: Data,
    code: web::Path<String>,
) -> Result<HttpResponse> {
    Ok(ok(json!({ "pairing": store.pair_deny(&code).await? })))
}

async fn whoami(Keyed(key): Keyed, store: Data) -> HttpResponse {
    let opts = store.options();
    ok(json!({
        "account": opts.account, "workspace": opts.workspace,
        "key_id": key.id, "device_name": key.device,
    }))
}

// --- browser reads ------------------------------------------------------------

async fn workspace(_: KeyOrBrowser, store: Data) -> Result<HttpResponse> {
    Ok(HttpResponse::Ok().json(store.workspace().await?))
}

// --- projects and config versions -------------------------------------------

async fn projects(_: Keyed, store: Data) -> Result<HttpResponse> {
    Ok(ok(json!({ "projects": store.projects().await? })))
}

async fn create_project(_: Keyed, store: Data, body: web::Payload) -> Result<HttpResponse> {
    let v = body_json(body).await?;
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::invalid("name", "required string"))?;
    let (project, new) = store.ensure_project(name).await?;
    Ok(created(new, json!({ "project": project })))
}

async fn config_versions(_: Keyed, store: Data, pid: web::Path<String>) -> Result<HttpResponse> {
    Ok(ok(
        json!({ "config_versions": store.config_versions(&pid).await? }),
    ))
}

async fn put_config_version(
    _: Keyed,
    store: Data,
    path: web::Path<(String, String)>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let (pid, version) = path.into_inner();
    let bytes = read_body(body).await?;
    let new = store.put_config_version(&pid, &version, &bytes).await?;
    Ok(created(new, json!({ "version": version })))
}

// --- investigations ---------------------------------------------------------

async fn investigations(_: Keyed, store: Data) -> Result<HttpResponse> {
    Ok(ok(
        json!({ "investigations": store.investigations().await? }),
    ))
}

async fn create_investigation(
    _: Keyed,
    store: Data,
    req: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    let v = body_json(body).await?;
    let field = |k: &'static str| {
        v.get(k)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| StoreError::invalid(k, "required string"))
    };
    let new = NewInvestigation {
        project_id: field("project_id")?,
        config_version: field("config_version")?,
        overrides: v.get("overrides").cloned().unwrap_or(Value::Null),
        meta: v.get("meta").cloned().unwrap_or(Value::Null),
    };
    let (id, is_new) = store
        .create_investigation(new, idempotency_key(&req)?)
        .await?;
    Ok(created(is_new, json!({ "id": id })))
}

#[derive(Deserialize)]
struct KindQuery {
    kind: Option<String>,
}

async fn records(
    _: Keyed,
    store: Data,
    inv: web::Path<String>,
    q: web::Query<KindQuery>,
) -> Result<HttpResponse> {
    let kind = match q.kind.as_deref() {
        None | Some("") => None,
        Some(k) => Some(
            Kind::parse(k)
                .ok_or_else(|| StoreError::invalid("kind", format!("unknown kind {k:?}")))?,
        ),
    };
    Ok(ok(json!({ "records": store.records(&inv, kind).await? })))
}

async fn proposal(
    _: Keyed,
    store: Data,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse> {
    let (inv, pid) = path.into_inner();
    Ok(HttpResponse::Ok().json(store.proposal(&inv, &pid).await?))
}

// --- appends ----------------------------------------------------------------

/// What a POST route admits before the envelope reaches `Store::append`.
#[derive(Clone, Copy)]
enum Rule<'a> {
    Kind(Kind),
    /// `/proposals`: a new proposal, or the SDK withdrawing one.
    Propose,
    /// `…/approvals`: the UI's decision on proposal `pid`.
    Decide(&'a str),
    /// `…/data`: the SDK attaching data to proposal `pid`.
    Data(&'a str),
}

impl Rule<'_> {
    fn check(self, env: &Envelope) -> Result<()> {
        let want = match self {
            Rule::Kind(k) => k,
            _ => Kind::Proposal,
        };
        if env.kind != want {
            return Err(StoreError::BadRequest(format!(
                "kind {} does not match the route ({})",
                env.kind.as_str(),
                want.as_str()
            )));
        }
        let Some((pid, ev)) = env.proposal() else {
            return Ok(());
        };
        let (allowed, path_pid): (&[Event], Option<&str>) = match self {
            Rule::Kind(_) => return Ok(()),
            Rule::Propose => (&[Event::Proposed, Event::Withdrawn], None),
            Rule::Decide(p) => (&[Event::Approved, Event::Edited, Event::Rejected], Some(p)),
            Rule::Data(p) => (&[Event::DataAttached], Some(p)),
        };
        if !allowed.contains(&ev) {
            let names: Vec<_> = allowed.iter().map(|e| e.as_str()).collect();
            return Err(StoreError::invalid(
                "payload.event",
                format!("this route accepts {}", names.join(" or ")),
            ));
        }
        if path_pid.is_some_and(|p| p != pid) {
            return Err(StoreError::invalid(
                "payload.proposal_id",
                "does not match the proposal in the path",
            ));
        }
        Ok(())
    }
}

async fn ingest(
    store: &Store,
    inv: &str,
    req: &HttpRequest,
    body: web::Payload,
    rule: Rule<'_>,
) -> Result<HttpResponse> {
    let env = Envelope::from_value(body_json(body).await?)?;
    if idempotency_key(req)?.is_some_and(|k| k != env.id) {
        return Err(StoreError::BadRequest(
            "Idempotency-Key differs from the envelope id".into(),
        ));
    }
    rule.check(&env)?;
    let out = store.append(inv, env).await?;
    // `gseq` sits beside the record, never in it (AX-8), so a client can
    // resume `/stream` from its own write.
    Ok(created(
        out.created,
        json!({ "record": out.record, "gseq": out.gseq }),
    ))
}

async fn measurements(
    _: Keyed,
    s: Data,
    inv: web::Path<String>,
    r: HttpRequest,
    b: web::Payload,
) -> Result<HttpResponse> {
    ingest(&s, &inv, &r, b, Rule::Kind(Kind::Measurement)).await
}

async fn runs(
    _: Keyed,
    s: Data,
    inv: web::Path<String>,
    r: HttpRequest,
    b: web::Payload,
) -> Result<HttpResponse> {
    ingest(&s, &inv, &r, b, Rule::Kind(Kind::Run)).await
}

async fn steps(
    _: Keyed,
    s: Data,
    inv: web::Path<String>,
    r: HttpRequest,
    b: web::Payload,
) -> Result<HttpResponse> {
    ingest(&s, &inv, &r, b, Rule::Kind(Kind::Step)).await
}

async fn outcome(
    _: Keyed,
    s: Data,
    inv: web::Path<String>,
    r: HttpRequest,
    b: web::Payload,
) -> Result<HttpResponse> {
    ingest(&s, &inv, &r, b, Rule::Kind(Kind::Outcome)).await
}

async fn proposals(
    _: Keyed,
    s: Data,
    inv: web::Path<String>,
    r: HttpRequest,
    b: web::Payload,
) -> Result<HttpResponse> {
    ingest(&s, &inv, &r, b, Rule::Propose).await
}

async fn approvals(
    _: KeyOrBrowser,
    s: Data,
    path: web::Path<(String, String)>,
    r: HttpRequest,
    b: web::Payload,
) -> Result<HttpResponse> {
    let (inv, pid) = path.into_inner();
    ingest(&s, &inv, &r, b, Rule::Decide(&pid)).await
}

async fn data(
    _: Keyed,
    s: Data,
    path: web::Path<(String, String)>,
    r: HttpRequest,
    b: web::Payload,
) -> Result<HttpResponse> {
    let (inv, pid) = path.into_inner();
    ingest(&s, &inv, &r, b, Rule::Data(&pid)).await
}
