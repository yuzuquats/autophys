use actix::fut::{Ready, ready};
use actix_http::Extensions;
use actix_web::{FromRequest, HttpMessage};
use serde::Serialize;
use tento_openapi::ToSchema;
use tento_web_files::resource_behavior::ResourceBehavior;

#[derive(Serialize, ToSchema)]
pub struct ServiceViewerContext(pub ViewerContextJson);

impl ServiceViewerContext {
  pub fn extract(ext: &Extensions) -> Self {
    ServiceViewerContext(ViewerContextJson::extract(ext))
  }

  pub fn is_logged_in(&self) -> bool {
    self.0.is_logged_in()
  }

  pub fn auth_expired(&self) -> bool {
    self.0.auth_expired()
  }

  pub fn redirect(&self) -> Option<ResourceBehavior> {
    self.0.redirect()
  }

  pub fn id(&self) -> Option<String> {
    match &self.0 {
      ViewerContextJson::Anon(_) => None,
      ViewerContextJson::User {
        id,
        auth_expired: _,
        redirect: _,
        data: _,
      } => Some(id.clone()),
    }
  }
}

impl FromRequest for ServiceViewerContext {
  type Error = actix_web::Error;
  type Future = Ready<Result<Self, Self::Error>>;

  fn from_request(req: &actix_web::HttpRequest, _: &mut actix_http::Payload) -> Self::Future {
    let vc = ViewerContextJson::extract(&req.extensions());
    ready(Ok(ServiceViewerContext(vc)))
  }
}

#[derive(Clone, Serialize, Debug, ToSchema)]
pub enum ViewerContextJson {
  Anon(Option<ServiceAnonViewerContext>),
  User {
    id: String,
    auth_expired: bool,
    redirect: Option<ResourceBehavior>,
    #[serde(flatten)]
    data: Option<ServiceLoggedInViewerContext>,
  },
}

impl ViewerContextJson {
  pub fn extract(ext: &Extensions) -> ViewerContextJson {
    ext
      .get::<ViewerContextJson>()
      .expect("viewer context json should be present! if not add the middleware")
      .clone()
  }

  pub fn is_logged_in(&self) -> bool {
    match self {
      ViewerContextJson::Anon(_) => false,
      ViewerContextJson::User {
        id: _,
        auth_expired: _,
        redirect: _,
        data: _,
      } => true,
    }
  }

  pub fn auth_expired(&self) -> bool {
    match self {
      ViewerContextJson::Anon(_) => false,
      ViewerContextJson::User {
        id: _,
        auth_expired,
        redirect: _,
        data: _,
      } => *auth_expired,
    }
  }

  pub fn redirect(&self) -> Option<ResourceBehavior> {
    match self {
      ViewerContextJson::Anon(_) => None,
      ViewerContextJson::User {
        id: _,
        auth_expired: _,
        redirect,
        data: _,
      } => redirect.clone(),
    }
  }

  pub fn serialize(&self) -> String {
    serde_json::to_string(self).expect("couldn't serialize VC")
  }
}

#[derive(Clone, Serialize, Debug, ToSchema)]
pub struct ServiceAnonViewerContext(pub serde_json::Value);

#[derive(Clone, Serialize, Debug, ToSchema)]
pub struct ServiceLoggedInViewerContext(pub serde_json::Value);
