//! `/api/v1` on actix-web over a collection of workbooks. Every handler
//! parses its request, makes one call into the `autophys` crate (after
//! finding the workbook that holds the project or investigation), and
//! serialises the result; validation, hashing, projections and their errors
//! live in the crate. Keys and pairing are the server's own ([`KeyStore`]).
//! The daemon registers the scope from its tento-web `DomainConfig`:
//!
//! ```ignore
//! .config(move |cfg| crate::http::configure(cfg, api.clone()))
//! ```
//!
//! Auth is in each handler's signature (AX-9, O-3): `pair/*` takes nothing;
//! `/workspace`, `/stream`, `/pairings…` and `…/approvals` take
//! [`KeyOrBrowser`], a document session cookie or API key; every other route
//! takes [`Keyed`]. Browser writes also require JSON (else 415) and the
//! daemon's own Origin or a configured one (else 403).
//!
//! Cursors (rust-sdk.md, "Cursors"): `gseq` orders records within one
//! workbook. A request scoped to one project (`?project=`) or investigation
//! uses that workbook's integer `gseq`, as before. An unscoped `/workspace`
//! and `/stream` use a collection cursor, `prj_…:<gseq>,prj_…:<gseq>`.

pub mod auth;
mod display;
mod sse;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use actix_web::http::StatusCode;
use actix_web::web::{self, Bytes};
use actix_web::{HttpRequest, HttpResponse, ResponseError};
use autophys::{Client, Envelope, Event, Investigation, Kind, Workbook};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::error::{ApiError, Result};
use crate::keys::{KeyStore, Options};

pub use auth::{Caller, KeyOrBrowser, Keyed};

/// The mount point.
pub const PREFIX: &str = "/api/v1";

/// Request bodies: a 1 MiB payload plus room for its envelope.
pub const BODY_LIMIT: usize = autophys::MAX_PAYLOAD_BYTES + 64 * 1024;
/// Largest blob `PUT /projects/{pid}/blobs/{sha256}` takes: a playbook's
/// SKILL.md or a step image.
pub const BLOB_LIMIT: usize = 16 << 20;

/// What the `/api/v1` scope serves: a collection of workbooks, the server
/// database, and a wake-up channel for `/stream` (a project id after each
/// write this server makes; streams also poll for other writers).
#[derive(Clone)]
pub struct Api {
    pub client: Client,
    pub keys: Arc<KeyStore>,
    pub sessions: auth::BrowserSessions,
    wake: broadcast::Sender<String>,
}

impl std::fmt::Debug for Api {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Api")
            .field("collection", &self.client.root())
            .field("keys", &self.keys.path())
            .finish()
    }
}

impl Api {
    pub fn new(client: Client, keys: KeyStore) -> Api {
        let (wake, _) = broadcast::channel(1024);
        Api {
            client,
            keys: Arc::new(keys),
            sessions: auth::BrowserSessions::default(),
            wake,
        }
    }

    /// The collection at `collection` and the server database at `server_db`.
    pub fn open(collection: &Path, server_db: &Path, opts: Options) -> Result<Api> {
        let text = collection
            .to_str()
            .ok_or_else(|| ApiError::Internal(format!("{} is not UTF-8", collection.display())))?;
        let client = autophys::connect(Some(text))?;
        Ok(Api::new(client, KeyStore::open_with(server_db, opts)?))
    }

    pub fn options(&self) -> &Options {
        self.keys.options()
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<String> {
        self.wake.subscribe()
    }

    fn woke(&self, project_id: &str) {
        let _ = self.wake.send(project_id.to_string());
    }
}

impl ResponseError for ApiError {
    fn status_code(&self) -> StatusCode {
        StatusCode::from_u16(self.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
    }

    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status_code()).json(self.body())
    }
}

/// Run a blocking library call off the async workers.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    web::block(f)
        .await
        .map_err(|e| ApiError::Internal(format!("blocking task: {e}")))?
}

/// Register every `/api/v1` route on `cfg` (a tento-web `DomainConfig`
/// `.config` closure, or an `App::configure` in tests).
pub fn configure(cfg: &mut web::ServiceConfig, api: Api) {
    cfg.service(scope(api));
}

/// The `/api/v1` scope itself, with the [`Api`] as app data and a JSON 404
/// for anything it does not route.
pub fn scope(api: Api) -> actix_web::Scope {
    web::scope(PREFIX)
        .app_data(web::Data::new(api))
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
        .route("/projects/{pid}/display", web::put().to(display::put))
        .route("/projects/{pid}/blobs/{sha256}", web::put().to(put_blob))
        .route("/projects/{pid}/blobs/{sha256}", web::get().to(get_blob))
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
        .route("/investigations/{inv}/reveal", web::post().to(reveal))
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

type Data = web::Data<Api>;

async fn read_body(body: web::Payload) -> Result<Bytes> {
    match body.to_bytes_limited(BODY_LIMIT).await {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(e)) => Err(ApiError::bad_request(format!("reading the body: {e}"))),
        Err(_) => Err(ApiError::too_large(BODY_LIMIT)),
    }
}

async fn body_json(body: web::Payload) -> Result<Value> {
    let bytes = read_body(body).await?;
    if bytes.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::bad_request(format!("the body is not JSON: {e}")))
}

fn idempotency_key(req: &HttpRequest) -> Result<Option<String>> {
    match req.headers().get("idempotency-key") {
        None => Ok(None),
        Some(v) => v
            .to_str()
            .map(|s| Some(s.to_string()))
            .map_err(|_| ApiError::bad_request("Idempotency-Key is not ASCII")),
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
    ApiError::not_found("route").error_response()
}

/// The workbook holding investigation `inv`.
async fn investigation(api: &Api, inv: &str) -> Result<Investigation> {
    let (client, inv) = (api.client.clone(), inv.to_string());
    blocking(move || Ok(client.find_investigation(&inv)?)).await
}

/// The workbook of project `pid`.
async fn workbook(api: &Api, pid: &str) -> Result<Workbook> {
    let (client, pid) = (api.client.clone(), pid.to_string());
    blocking(move || Ok(client.project_by_id(&pid)?)).await
}

// --- pairing (no key) -------------------------------------------------------

async fn pair_start(api: Data, body: web::Payload) -> Result<HttpResponse> {
    let v = body_json(body).await?;
    let device = v
        .get("device_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let client = v
        .get("client")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let keys = api.keys.clone();
    Ok(ok(json!(
        blocking(move || keys.pair_start(&device, &client)).await?
    )))
}

async fn pair_poll(api: Data, body: web::Payload) -> Result<HttpResponse> {
    let v = body_json(body).await?;
    let code = v
        .get("device_code")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("device_code is required"))?
        .to_string();
    let keys = api.keys.clone();
    Ok(ok(json!(blocking(move || keys.pair_poll(&code)).await?)))
}

async fn pairings(_: KeyOrBrowser, api: Data) -> Result<HttpResponse> {
    let keys = api.keys.clone();
    let list = blocking(move || keys.pairings_pending()).await?;
    Ok(ok(json!({ "pairings": list })))
}

async fn pairing_approve(
    _: KeyOrBrowser,
    api: Data,
    code: web::Path<String>,
) -> Result<HttpResponse> {
    let keys = api.keys.clone();
    let p = blocking(move || keys.pair_approve(&code)).await?;
    Ok(ok(json!({ "pairing": p })))
}

async fn pairing_deny(_: KeyOrBrowser, api: Data, code: web::Path<String>) -> Result<HttpResponse> {
    let keys = api.keys.clone();
    let p = blocking(move || keys.pair_deny(&code)).await?;
    Ok(ok(json!({ "pairing": p })))
}

async fn whoami(Keyed(key): Keyed, api: Data) -> HttpResponse {
    let opts = api.options();
    ok(json!({
        "account": opts.account, "workspace": opts.workspace,
        "key_id": key.id, "device_name": key.device,
    }))
}

// --- browser reads ------------------------------------------------------------

#[derive(Deserialize)]
struct ProjectQuery {
    project: Option<String>,
}

/// A collection cursor: `prj_…:<gseq>` per workbook, comma-separated,
/// sorted by project id.
pub(crate) fn cursor_token(cursors: &BTreeMap<String, i64>) -> String {
    cursors
        .iter()
        .map(|(p, g)| format!("{p}:{g}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// Parse a collection cursor (empty or `0` is the start of every workbook).
pub(crate) fn parse_cursor_token(text: &str) -> Result<BTreeMap<String, i64>> {
    let mut out = BTreeMap::new();
    let text = text.trim();
    if text.is_empty() || text == "0" {
        return Ok(out);
    }
    for part in text.split(',') {
        let parsed = part
            .split_once(':')
            .and_then(|(p, g)| Some((p, g.parse::<i64>().ok()?)))
            .filter(|(p, g)| p.starts_with("prj_") && *g >= 0);
        let Some((p, g)) = parsed else {
            return Err(ApiError::bad_request(format!(
                "cursor {text:?}: an unscoped cursor is prj_…:<gseq>[,…] (from /workspace or an event id); \
                 an integer gseq needs ?project= or ?investigation="
            )));
        };
        out.insert(p.to_string(), g);
    }
    Ok(out)
}

/// `GET /workspace[?project=]`: everything the browser needs. Each workbook
/// is read in one transaction. Scoped to a project, `cursor` is that
/// workbook's `gseq`; unscoped it is the collection cursor, and `cursors`
/// holds every workbook's `gseq` by project id.
async fn workspace(
    _: KeyOrBrowser,
    api: Data,
    q: web::Query<ProjectQuery>,
) -> Result<HttpResponse> {
    let client = api.client.clone();
    let only = q.into_inner().project.filter(|p| !p.is_empty());
    let scoped = only.is_some();
    let snaps = blocking(move || Ok(client.snapshots(only.as_deref())?)).await?;
    let mut cursors = BTreeMap::new();
    let (mut projects, mut configs, mut invs, mut props, mut records) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for s in snaps {
        cursors.insert(s.project.id.clone(), s.cursor);
        for c in s.config_versions {
            configs.push(
                json!({"project_id": s.project.id, "version": c.version, "config": c.config}),
            );
        }
        let mut project = serde_json::to_value(&s.project)
            .map_err(|e| ApiError::Internal(format!("project JSON: {e}")))?;
        project["display"] = s.display.map(|d| d.body).unwrap_or(Value::Null);
        projects.push(project);
        invs.extend(s.investigations);
        props.extend(s.proposals);
        records.extend(s.records);
    }
    let cursor = if scoped {
        json!(cursors.values().next().copied().unwrap_or(0))
    } else {
        json!(cursor_token(&cursors))
    };
    Ok(ok(json!({
        "cursor": cursor,
        "cursors": cursors,
        "projects": projects,
        "config_versions": configs,
        "investigations": invs,
        "proposals": props,
        "records": records,
    })))
}

// --- projects and config versions -------------------------------------------

async fn projects(_: Keyed, api: Data) -> Result<HttpResponse> {
    let client = api.client.clone();
    let list = blocking(move || Ok(client.projects()?)).await?;
    Ok(ok(json!({ "projects": list })))
}

async fn create_project(_: Keyed, api: Data, body: web::Payload) -> Result<HttpResponse> {
    let v = body_json(body).await?;
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid("name", "required string"))?
        .to_string();
    let client = api.client.clone();
    let (wb, new) = blocking(move || Ok(client.ensure_project(&name)?)).await?;
    Ok(created(new, json!({ "project": wb.project() })))
}

async fn config_versions(_: Keyed, api: Data, pid: web::Path<String>) -> Result<HttpResponse> {
    let wb = workbook(&api, &pid).await?;
    let list = blocking(move || Ok(wb.config_versions()?)).await?;
    Ok(ok(json!({ "config_versions": list })))
}

async fn put_config_version(
    _: Keyed,
    api: Data,
    path: web::Path<(String, String)>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let (pid, version) = path.into_inner();
    let bytes = read_body(body).await?;
    let wb = workbook(&api, &pid).await?;
    let v = version.clone();
    let new = blocking(move || Ok(wb.put_config_version(&v, &bytes)?)).await?;
    Ok(created(new, json!({ "version": version })))
}

// --- blobs -----------------------------------------------------------------

/// A blob path names its bare sha256: 64 lowercase hex digits.
fn blob_hash(hash: &str) -> Result<String> {
    if hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(hash.to_string())
    } else {
        Err(ApiError::invalid("sha256", "64 lowercase hex digits"))
    }
}

/// Store bytes a record names by hash (a playbook, a step image) before the
/// record is written. The server hashes the body itself; the media type is
/// the request's Content-Type. Idempotent: 201 on create, 200 when present.
async fn put_blob(
    _: Keyed,
    api: Data,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let (pid, hash) = path.into_inner();
    let hash = blob_hash(&hash)?;
    let media_type = req
        .headers()
        .get(actix_web::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::invalid("Content-Type", "required: the blob's media type"))?
        .to_string();
    let bytes = match body.to_bytes_limited(BLOB_LIMIT).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => return Err(ApiError::bad_request(format!("reading the body: {e}"))),
        Err(_) => return Err(ApiError::too_large(BLOB_LIMIT)),
    };
    if autophys::sha256_hex([&bytes[..]]) != hash {
        return Err(autophys::Error::HashMismatch.into());
    }
    let wb = workbook(&api, &pid).await?;
    let h = hash.clone();
    let new = blocking(move || {
        let new = match wb.get_blob(&h) {
            Ok(_) => false,
            Err(autophys::Error::NotFound(_)) => true,
            Err(e) => return Err(e.into()),
        };
        wb.put_blob(&bytes, &media_type)?;
        Ok(new)
    })
    .await?;
    Ok(created(new, json!({ "sha256": hash })))
}

/// The bytes of a stored blob, served with the media type they were put with.
async fn get_blob(_: Keyed, api: Data, path: web::Path<(String, String)>) -> Result<HttpResponse> {
    let (pid, hash) = path.into_inner();
    let hash = blob_hash(&hash)?;
    let wb = workbook(&api, &pid).await?;
    let (bytes, media_type) = blocking(move || Ok(wb.get_blob(&hash)?)).await?;
    Ok(HttpResponse::Ok().content_type(media_type).body(bytes))
}

// --- investigations ---------------------------------------------------------

async fn investigations(_: Keyed, api: Data, q: web::Query<ProjectQuery>) -> Result<HttpResponse> {
    let client = api.client.clone();
    let only = q.into_inner().project.filter(|p| !p.is_empty());
    let list = blocking(move || Ok(client.investigations_in(only.as_deref())?)).await?;
    Ok(ok(json!({ "investigations": list })))
}

async fn create_investigation(
    _: Keyed,
    api: Data,
    req: HttpRequest,
    body: web::Payload,
) -> Result<HttpResponse> {
    let v = body_json(body).await?;
    let field = |k: &'static str| {
        v.get(k)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| ApiError::invalid(k, "required string"))
    };
    let (project_id, config_version) = (field("project_id")?, field("config_version")?);
    // The pin travels in the record: the client's meta with the top-level
    // fields set over it (workbook-format.md, "Appending a record").
    let mut meta = match v.get("meta").cloned().unwrap_or(Value::Null) {
        Value::Null => serde_json::Map::new(),
        Value::Object(m) => m,
        _ => return Err(ApiError::invalid("meta", "must be an object")),
    };
    meta.insert("project_id".into(), json!(project_id));
    meta.insert("config_version".into(), json!(config_version));
    meta.insert(
        "overrides".into(),
        v.get("overrides").cloned().unwrap_or(Value::Null),
    );
    let key = idempotency_key(&req)?;
    let client = api.client.clone();
    let pid = project_id.clone();
    let (inv, is_new) = blocking(move || {
        // An unknown project cannot have the pinned config version: the same
        // 409 as before workbooks were per project.
        let wb = client.project_by_id(&pid).map_err(|e| match e {
            autophys::Error::NotFound(_) => autophys::Error::Conflict {
                code: "unknown_config_version",
                message: format!("unknown project {pid}; PUT the config version first"),
            },
            e => e,
        })?;
        Ok(wb.create_investigation(Value::Object(meta), key.as_deref())?)
    })
    .await?;
    if is_new {
        api.woke(&project_id);
    }
    Ok(created(is_new, json!({ "id": inv.id })))
}

#[derive(Deserialize)]
struct RecordsQuery {
    kind: Option<String>,
    after: Option<i64>,
}

async fn records(
    _: Keyed,
    api: Data,
    inv: web::Path<String>,
    q: web::Query<RecordsQuery>,
) -> Result<HttpResponse> {
    let inv = investigation(&api, &inv).await?;
    let q = q.into_inner();
    let kind = q.kind.filter(|k| !k.is_empty());
    if let Some(k) = &kind {
        Kind::parse(k).ok_or_else(|| ApiError::invalid("kind", format!("unknown kind {k:?}")))?;
    }
    let list = blocking(move || {
        Ok(match q.after {
            // `?after=<gseq>`: this investigation's records after that
            // position in its workbook (Rust and server only).
            Some(after) => inv
                .records_after(after)?
                .into_iter()
                .map(|l| l.record)
                .filter(|r| kind.as_deref().is_none_or(|k| r.kind == k))
                .collect(),
            None => inv.records(kind.as_deref())?,
        })
    })
    .await?;
    Ok(ok(json!({ "records": list })))
}

async fn proposal(_: Keyed, api: Data, path: web::Path<(String, String)>) -> Result<HttpResponse> {
    let (inv, pid) = path.into_inner();
    let inv = investigation(&api, &inv).await?;
    let p = blocking(move || Ok(inv.proposal(&pid)?)).await?;
    Ok(ok(json!(p)))
}

// --- appends ----------------------------------------------------------------

/// What a POST route admits before the envelope reaches `Investigation::append`.
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
            return Err(ApiError::bad_request(format!(
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
            return Err(ApiError::invalid(
                "payload.event",
                format!("this route accepts {}", names.join(" or ")),
            ));
        }
        if path_pid.is_some_and(|p| p != pid) {
            return Err(ApiError::invalid(
                "payload.proposal_id",
                "does not match the proposal in the path",
            ));
        }
        Ok(())
    }
}

/// Parse the envelope, check it against the route, then one
/// `Investigation::append` with the client's id as the idempotency key.
async fn ingest(
    api: &Api,
    inv: &str,
    req: &HttpRequest,
    body: web::Payload,
    rule: Rule<'_>,
) -> Result<HttpResponse> {
    ingest_value(api, inv, req, body_json(body).await?, rule).await
}

/// [`ingest`] over a body already parsed (and possibly stamped by the server).
async fn ingest_value(
    api: &Api,
    inv: &str,
    req: &HttpRequest,
    body: Value,
    rule: Rule<'_>,
) -> Result<HttpResponse> {
    let env = Envelope::from_value(body)?;
    if idempotency_key(req)?.is_some_and(|k| k != env.id) {
        return Err(ApiError::bad_request(
            "Idempotency-Key differs from the envelope id",
        ));
    }
    rule.check(&env)?;
    let inv = investigation(api, inv).await?;
    let project = inv.workbook().id().to_string();
    let out =
        blocking(move || Ok(inv.append(env.kind.as_str(), env.payload, Some(&env.id))?)).await?;
    if out.created {
        api.woke(&project);
    }
    // `gseq` sits beside the record, never in it (AX-8), so a client can
    // resume `/stream?investigation=` from its own write.
    Ok(created(out.created, json!(out)))
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

async fn reveal(
    _: Keyed,
    s: Data,
    inv: web::Path<String>,
    r: HttpRequest,
    b: web::Payload,
) -> Result<HttpResponse> {
    ingest(&s, &inv, &r, b, Rule::Kind(Kind::Reveal)).await
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
    KeyOrBrowser(caller): KeyOrBrowser,
    s: Data,
    path: web::Path<(String, String)>,
    r: HttpRequest,
    b: web::Payload,
) -> Result<HttpResponse> {
    let (inv, pid) = path.into_inner();
    let mut body = body_json(b).await?;
    // A signed-in person decides as themselves, whatever the page sent.
    if let Some(by) = caller.person() {
        if let Some(payload) = body.get_mut("payload").and_then(Value::as_object_mut) {
            payload.insert("by".into(), json!(by));
        }
    }
    ingest_value(&s, &inv, &r, body, Rule::Decide(&pid)).await
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
