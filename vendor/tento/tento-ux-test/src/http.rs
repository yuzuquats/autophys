//! Mountable actix handlers + DTOs for the `/_/ux-test/*` **data** routes — the
//! HTTP wire contract for ux-test, and nothing else.
//!
//! Gated behind the `http` feature (`tento-web` enables it) so CLI-only
//! consumers don't pull `actix-web` / `tento-web-router`. Each handler is the
//! same thin shape as before — decode → call one [`SessionStore`] method →
//! respond.
//!
//! **The seam.** These handlers used to extract `web::Data<LLMLogger>`, which
//! bound the wire contract to the harness: mounting a route meant linking the
//! run folder, the ledger, the spec and the manifest, 5,517 lines behind a 356
//! line surface. They now extract `web::Data<Arc<dyn SessionStore>>`, so a
//! product that only speaks the wire protocol needs the trait and the DTOs and
//! not the implementation. The mount registers the store it has.
//!
//! **What stays in `tento-web`:** the `POST /_/ux-test/token` mint (it depends
//! on the web app's auth — `LoggedInViewerContext` + `HarnessSecret`), the
//! `HarnessTokenGuard`, and the unauth-vs-guarded route **grouping** in
//! `admin/router.rs`. tento-web references these handlers as
//! `tento_ux_test::http::<name>::<method>::route`.

use actix_web::{HttpResponse, http::StatusCode};
use tento_web_error::TentoWebErrorResponse;

/// Map an `anyhow::Error` to a `500` carrying the fleet's `{reason, details}`
/// envelope, split on the `reason/details` convention the harness uses.
///
/// The split lives in `tento_web_error`, so a harness error with no slug now
/// reports the category its status implies instead of `unknown`, and a message
/// whose prose contains a slash keeps its whole sentence in `details`.
fn error_response(e: anyhow::Error) -> HttpResponse {
  TentoWebErrorResponse::from_slug_message(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
    .build()
}

/// The judge a mounting product supplies for a `success` completion.
///
/// A "Works" click is a claim, not a verdict, so something has to audit it
/// against the spec's `verification` block. That judging is **not** wire
/// contract: it reads `spec.yaml` and re-runs the trace judge, so holding it in
/// this module made the module reach up into [`crate::spec`] and
/// [`crate::orchestration`] — the only two references it had — and dragged
/// 4,357 lines of harness behind the route surface.
///
/// So the mount supplies it, as an **opaque callback taking only a session id**.
/// The alternative — handing the judge a [`SessionStore`] — would have pulled
/// `session_dir`, `write_verification_record` and `refresh_status` into the
/// trait, and with them `folder::VerificationOutcome`, putting the run folder
/// back on the wire side. A closure that has already captured its store keeps
/// the seam at the twelve methods the routes actually call.
///
/// Register one as `app_data` and the `complete` route calls it on success;
/// register none and the completion is recorded unaudited, which is what
/// happened before the audit existed. The harness's implementation is
/// [`crate::orchestration::audit_completion`].
///
/// # FORK DELTA — deliberate, do not reconcile away
///
/// The canonical ux-test crate **deleted this type** in `ux(18.1)`: judging is
/// a mountable route collection there (`judge::JudgeRoutes`), and the board
/// judges on read when a completion carries no verification record. This copy
/// keeps it on purpose, as a bridge, and the operator accepted the delta on
/// 2026-09-18.
///
/// It goes on the day the board's run-folder read path is **live** — not
/// written — and it goes in the SAME change that ports `http.rs` up to the
/// canonical crate. Never the port first: removing the closure before
/// judge-on-read is live does not mean completions are judged later, it means
/// anything completed in that window is never judged at all, because nothing
/// comes back for those sessions.
///
/// A sync that "reconciles" this away without the board's half is therefore a
/// regression with no symptom. If you are here to reduce the fork, this is the
/// one difference that has to wait for something else to land first.
///
/// **And the symptom is quieter than a type would be.** At tento's committed
/// HEAD there is no `CompletionAudit` and no registration in
/// `tento-web/src/server.rs` at all: `complete::post` calls
/// `audit_completion(&logger, …)` inline, and the callback above is part of an
/// unlanded refactor. So a checkout that has not taken that refactor carries
/// the delta as ONE LINE INSIDE A ROUTE — and a sync toward the canonical crate
/// deletes it while everything still compiles. Nothing fails; completions
/// simply stop being judged. Whichever of the two shapes you are looking at,
/// the rule is the same: it leaves with the board's read path, not before.
pub type CompletionAudit = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

pub mod pending {
  pub mod get {
    use std::sync::Arc;

    use actix_web::{HttpResponse, web};
    use tento_web_router::api;

    use super::super::SessionStore;

    #[api(responses((status = 200, body = Option<crate::Session>)))]
    pub async fn route(store: web::Data<Arc<dyn SessionStore>>) -> HttpResponse {
      match store.get_first_pending() {
        Ok(session) => HttpResponse::Ok().json(session),
        Err(e) => super::super::error_response(e),
      }
    }
  }
}

pub mod pending_count {
  pub mod get {
    use std::sync::Arc;

    use actix_web::{HttpResponse, web};
    use serde::Serialize;
    use tento_openapi::ToSchema;
    use tento_web_router::api;

    use super::super::SessionStore;

    #[derive(Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    pub struct PendingCountResponse {
      pub count: usize,
    }

    #[api(responses((status = 200, body = PendingCountResponse)))]
    pub async fn route(store: web::Data<Arc<dyn SessionStore>>) -> HttpResponse {
      match store.get_pending_count() {
        Ok(count) => HttpResponse::Ok().json(PendingCountResponse { count }),
        Err(e) => super::super::error_response(e),
      }
    }
  }
}

pub mod pending_flaky {
  pub mod get {
    use std::sync::Arc;

    use actix_web::{HttpResponse, web};
    use tento_web_router::api;

    use super::super::SessionStore;

    #[api(responses((status = 200, body = Vec<crate::Session>)))]
    pub async fn route(store: web::Data<Arc<dyn SessionStore>>) -> HttpResponse {
      match store.get_all_pending_flaky() {
        Ok(sessions) => HttpResponse::Ok().json(sessions),
        Err(e) => super::super::error_response(e),
      }
    }
  }
}

pub mod logs {
  pub mod post {
    use std::sync::Arc;

    use actix_web::{HttpResponse, web};
    use serde::Deserialize;
    use tento_openapi::ToSchema;
    use tento_web_router::api;

    use super::super::SessionStore;

    #[derive(Deserialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    pub struct BatchEntriesRequest {
      pub session_id: String,
      pub entries: Vec<serde_json::Value>,
    }

    #[api(request_body = BatchEntriesRequest, responses((status = 200)))]
    pub async fn route(
      store: web::Data<Arc<dyn SessionStore>>,
      body: web::Json<BatchEntriesRequest>,
    ) -> HttpResponse {
      match store.append_ljson_entries(&body.session_id, &body.entries) {
        Ok(()) => HttpResponse::Ok().finish(),
        Err(e) => super::super::error_response(e),
      }
    }
  }
}

pub mod complete {
  pub mod post {
    use std::sync::Arc;

    use actix_web::{HttpRequest, HttpResponse, web};
    use serde::Deserialize;
    use tento_openapi::ToSchema;
    use tento_web_router::api;

    use super::super::{CompletionAudit, SessionStore};
    use crate::SessionResult;

    #[derive(Deserialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    #[serde_with::skip_serializing_none]
    pub struct CompleteRequest {
      pub session_id: String,
      pub result: SessionResult,
      pub feedback: Option<String>,
    }

    #[api(request_body = CompleteRequest, responses((status = 200)))]
    pub async fn route(
      req: HttpRequest,
      store: web::Data<Arc<dyn SessionStore>>,
      body: web::Json<CompleteRequest>,
    ) -> HttpResponse {
      match store.mark_complete(&body.session_id, body.result.clone(), body.feedback.clone()) {
        Ok(()) => {
          // A "Works" click is a claim, not a verdict. Audit it against the
          // spec's verification block while the trace is fresh — before this,
          // manual completions skipped the judges entirely and the board
          // showed green for runs whose trace failed verification.
          if matches!(body.result, SessionResult::Success) {
            if let Some(audit) = req.app_data::<web::Data<CompletionAudit>>() {
              audit(&body.session_id);
            }
          }
          HttpResponse::Ok().finish()
        }
        Err(e) => super::super::error_response(e),
      }
    }
  }
}

pub mod step {
  pub mod post {
    use std::sync::Arc;

    use actix_web::{HttpResponse, web};
    use serde::Deserialize;
    use tento_openapi::ToSchema;
    use tento_web_router::api;

    use super::super::SessionStore;

    #[derive(Deserialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    pub struct StepRequest {
      pub session_id: String,
      pub step_index: usize,
      pub step_text: String,
      pub checked: bool,
    }

    /// Set-state step marking (idempotent). Sits in the unauthenticated
    /// write-only group beside `logs`/`complete` for the same reason: step
    /// checks happen on anonymous surfaces (the signin page of an onboarding
    /// test), and the write targets an opaque server-minted session id with
    /// no read-back.
    #[api(request_body = StepRequest, responses((status = 200)))]
    pub async fn route(
      store: web::Data<Arc<dyn SessionStore>>,
      body: web::Json<StepRequest>,
    ) -> HttpResponse {
      match store.set_step(
        &body.session_id,
        body.step_index,
        &body.step_text,
        body.checked,
      ) {
        Ok(()) => HttpResponse::Ok().finish(),
        Err(e) => super::super::error_response(e),
      }
    }
  }
}

pub mod abandon {
  pub mod post {
    use std::sync::Arc;

    use actix_web::{HttpResponse, web};
    use serde::Deserialize;
    use tento_openapi::ToSchema;
    use tento_web_router::api;

    use super::super::SessionStore;

    #[derive(Deserialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    pub struct AbandonRequest {
      pub session_id: String,
    }

    /// The Skip counterpart to `complete`: flips the session to `Abandoned`
    /// without a verdict. Write-only to an opaque session id, so it sits beside
    /// `logs`/`complete` in the unauthenticated group for the same reason — a
    /// skip can happen on an anonymous surface, and a skip the server never
    /// hears about is the bug this route exists to fix.
    #[api(request_body = AbandonRequest, responses((status = 200)))]
    pub async fn route(
      store: web::Data<Arc<dyn SessionStore>>,
      body: web::Json<AbandonRequest>,
    ) -> HttpResponse {
      match store.mark_abandoned(&body.session_id) {
        Ok(()) => HttpResponse::Ok().finish(),
        Err(e) => super::super::error_response(e),
      }
    }
  }
}

pub mod session {
  pub mod get {
    use std::sync::Arc;

    use actix_web::{HttpResponse, web};
    use tento_web_router::api;

    use super::super::SessionStore;

    #[api(
      params(("session_id" = String,)),
      responses((status = 200, body = Option<crate::Session>))
    )]
    pub async fn route(
      store: web::Data<Arc<dyn SessionStore>>,
      path: web::Path<String>,
    ) -> HttpResponse {
      let session_id = path.into_inner();
      match store.get_session(&session_id) {
        Ok(session) => HttpResponse::Ok().json(Some(session)),
        Err(_) => HttpResponse::Ok().json(Option::<crate::Session>::None),
      }
    }
  }
}

pub mod session_logs {
  pub mod get {
    use std::sync::Arc;

    use actix_web::{HttpResponse, web};
    use tento_web_router::api;

    use super::super::SessionStore;

    #[api(
      params(("session_id" = String,)),
      responses((status = 200))
    )]
    pub async fn route(
      store: web::Data<Arc<dyn SessionStore>>,
      path: web::Path<String>,
    ) -> HttpResponse {
      let session_id = path.into_inner();

      // Prefer pre-snapshotted trace.ljson (client + server entries)
      match store.read_trace_ljson(&session_id) {
        Ok(entries) if !entries.is_empty() => {
          return HttpResponse::Ok().json(entries);
        }
        Err(e) => {
          tracing::warn!("read_trace_ljson failed for {session_id}: {e:#}");
        }
        _ => {}
      }

      // Fallback: return client-only logs.ljson
      match store.read_logs_ljson(&session_id) {
        Ok(entries) => HttpResponse::Ok().json(entries),
        Err(e) => super::super::error_response(e),
      }
    }
  }
}

pub mod sessions {
  pub mod get {
    use std::sync::Arc;

    use actix_web::{HttpResponse, web};
    use serde::Serialize;
    use tento_openapi::ToSchema;
    use tento_web_router::api;

    use super::super::SessionStore;
    use crate::{Session, SessionCompletion};

    #[derive(Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    #[serde_with::skip_serializing_none]
    pub struct SessionListEntry {
      #[serde(flatten)]
      pub session: Session,
      pub completion: Option<SessionCompletion>,
    }

    #[api(responses((status = 200, body = Vec<SessionListEntry>)))]
    pub async fn route(store: web::Data<Arc<dyn SessionStore>>) -> HttpResponse {
      match store.get_all_sessions() {
        Ok(sessions) => {
          let entries: Vec<SessionListEntry> = sessions
            .into_iter()
            .map(|(session, completion)| SessionListEntry {
              session,
              completion,
            })
            .collect();
          HttpResponse::Ok().json(entries)
        }
        Err(e) => super::super::error_response(e),
      }
    }
  }

  pub mod delete {
    use std::sync::Arc;

    use actix_web::{HttpResponse, web};
    use tento_web_router::api;

    use super::super::SessionStore;

    #[api(
      params(("session_id" = String,)),
      responses((status = 200))
    )]
    pub async fn route(
      store: web::Data<Arc<dyn SessionStore>>,
      path: web::Path<String>,
    ) -> HttpResponse {
      let session_id = path.into_inner();
      match store.delete_session(&session_id) {
        Ok(()) => HttpResponse::Ok().finish(),
        Err(e) => super::super::error_response(e),
      }
    }
  }
}

/// The session store the data routes read and write, as an interface.
///
/// This is the seam. The routes above are the HTTP wire contract — request and
/// response shapes, status codes, the `/_/ux-test/*` paths. The store behind
/// them (`LLMLogger`, the run folder, the ledger, the spec, the manifest) is
/// 5,517 lines of harness. Holding both in one crate meant any product that
/// mounted the routes linked the whole harness, which is how one broken host
/// adapter took every project's testing down with it.
///
/// A trait makes the boundary an interface instead of a cut line: the routes
/// name what they need, the harness supplies it, and nothing is copied to
/// either side. [`crate::LLMLogger`] is the implementation, in
/// [`crate::session`]; a product that only mounts routes never needs it.
///
/// Every method is fallible and synchronous, matching `LLMLogger` exactly — the
/// routes already `match` on `Result` and map the error through
/// [`error_response`], so the trait changes no behaviour.
pub trait SessionStore: Send + Sync + 'static {
  /// The oldest session still awaiting an operator verdict, if any.
  fn get_first_pending(&self) -> anyhow::Result<Option<crate::Session>>;
  /// How many sessions await a verdict — the badge count.
  fn get_pending_count(&self) -> anyhow::Result<usize>;
  /// Pending sessions whose test is marked flaky, which the board groups apart.
  fn get_all_pending_flaky(&self) -> anyhow::Result<Vec<crate::Session>>;
  /// Append client trace lines to a session's `logs.ljson`.
  fn append_ljson_entries(
    &self,
    session_id: &str,
    entries: &[serde_json::Value],
  ) -> anyhow::Result<()>;
  /// Record an operator verdict. A `Success` is a claim, not a judgement — see
  /// [`CompletionAudit`].
  fn mark_complete(
    &self,
    session_id: &str,
    result: crate::SessionResult,
    feedback: Option<String>,
  ) -> anyhow::Result<()>;
  /// Tick or untick one step of a running session.
  fn set_step(
    &self,
    session_id: &str,
    step_index: usize,
    step_text: &str,
    checked: bool,
  ) -> anyhow::Result<()>;
  /// Abandon a session without a verdict.
  fn mark_abandoned(&self, session_id: &str) -> anyhow::Result<()>;
  /// One session's record.
  fn get_session(&self, session_id: &str) -> anyhow::Result<crate::Session>;
  /// The client-only log stream for a session.
  fn read_logs_ljson(
    &self,
    session_id: &str,
  ) -> anyhow::Result<Vec<tento_logger::ljson::LjsonEntry>>;
  /// The unified client+server trace, when it has been materialized.
  fn read_trace_ljson(
    &self,
    session_id: &str,
  ) -> anyhow::Result<Vec<tento_logger::ljson::LjsonEntry>>;
  /// Every session with its completion, for the sessions list.
  fn get_all_sessions(
    &self,
  ) -> anyhow::Result<Vec<(crate::Session, Option<crate::SessionCompletion>)>>;
  /// Delete a session and its artifacts.
  fn delete_session(&self, session_id: &str) -> anyhow::Result<()>;
}
