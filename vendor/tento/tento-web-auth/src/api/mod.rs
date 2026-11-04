use tento_web_router::Router;

pub mod routes;

#[derive(Router)]
#[router {
  "/_/auth" {
    "/id" {
      get: routes::get_id
    }
    "/signout" {
      get: routes::signout,
      post: routes::signout
    }
    "/device" {
      "/start" {
        post: routes::device_start
      }
      "/poll" {
        post: routes::device_poll
      }
      "/verify" {
        post: routes::device_verify
      }
    }
  }
}]
pub struct Api;
