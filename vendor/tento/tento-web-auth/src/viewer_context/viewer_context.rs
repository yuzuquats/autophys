use std::fmt;

use actix::fut::{Ready, ready};
use actix_web::{FromRequest, HttpMessage, HttpResponse, ResponseError};
use anyhow::anyhow;

#[derive(Debug)]
pub struct NotLoggedInError;

impl fmt::Display for NotLoggedInError {
  fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
    write!(f, "User is not logged in")
  }
}

impl ResponseError for NotLoggedInError {
  fn error_response(&self) -> HttpResponse {
    HttpResponse::Unauthorized().body("User is not logged in")
  }
}

#[derive(Clone, Debug)]
pub struct LoggedInViewerContext {
  pub id: String,
}

impl FromRequest for LoggedInViewerContext {
  type Error = NotLoggedInError;
  type Future = Ready<Result<Self, Self::Error>>;

  fn from_request(req: &actix_web::HttpRequest, _: &mut actix_http::Payload) -> Self::Future {
    let extensions = req.extensions();
    let vc = extensions
      .get::<LoggedInViewerContext>()
      .cloned()
      .ok_or(NotLoggedInError);
    ready(vc)
  }
}

#[derive(Clone, Debug)]
pub struct AnonViewerContext;

#[derive(Clone, Debug)]
pub struct AdminViewerContext;

#[derive(Clone, Debug)]
pub enum ViewerContext {
  Anon(AnonViewerContext),
  User(LoggedInViewerContext),
  Admin(AdminViewerContext),
}

impl ViewerContext {
  pub fn user(id: impl Into<String>) -> ViewerContext {
    ViewerContext::User(LoggedInViewerContext { id: id.into() })
  }

  pub fn admin() -> ViewerContext {
    ViewerContext::Admin(AdminViewerContext)
  }

  pub fn anon() -> ViewerContext {
    ViewerContext::Anon(AnonViewerContext)
  }

  pub fn id(&self) -> Option<&str> {
    match self {
      ViewerContext::User(vc) => Some(&vc.id),
      _ => None,
    }
  }

  // pub fn get_admin_vc(&self) -> Option<AdminViewerContext> {
  //   match self {
  //     ViewerContext::Admin(_) => Some(AdminViewerContext),
  //     _ => None,
  //   }
  // }

  pub fn check_if_admin(&self) -> Result<(), anyhow::Error> {
    match self {
      ViewerContext::Admin(_) => Ok(()),
      _ => Err(anyhow!("VC needs to be admin")),
    }
  }

  pub fn check_if_user_matches(&self, user_id: &str) -> Result<(), anyhow::Error> {
    match self {
      ViewerContext::Admin(_) => Ok(()),
      ViewerContext::User(vc) => {
        if vc.id == user_id {
          Ok(())
        } else {
          Err(anyhow!("User VC does not match user's"))
        }
      }
      _ => Err(anyhow!("VC needs to be admin")),
    }
  }

  pub fn check_if_not_anon(&self) -> Result<(), anyhow::Error> {
    // Note: check exhaustive because this can be sensitive
    match self {
      ViewerContext::Anon(_) => Err(anyhow!("User must be logged in")),
      ViewerContext::User(_) => Ok(()),
      ViewerContext::Admin(_) => Ok(()),
    }
  }
}

impl FromRequest for ViewerContext {
  type Error = actix_web::Error;
  type Future = Ready<Result<Self, Self::Error>>;

  fn from_request(req: &actix_web::HttpRequest, _: &mut actix_http::Payload) -> Self::Future {
    let extensions = req.extensions();
    let vc = extensions.get::<ViewerContext>().cloned();
    ready(Ok(vc.unwrap_or(ViewerContext::Anon(AnonViewerContext))))
  }
}
