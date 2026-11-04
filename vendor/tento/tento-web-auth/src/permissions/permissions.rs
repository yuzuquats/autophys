use std::fmt::{Debug, Display};

#[derive(Debug, PartialEq)]
pub enum Permission {
  Admin,
  Read,
  Write,
}

impl Permission {
  pub fn to_static_str(&self) -> &'static str {
    match self {
      Permission::Admin => "admin",
      Permission::Read => "read",
      Permission::Write => "write",
    }
  }
}

#[async_trait::async_trait]
pub trait PermittedTo<Resource> {
  async fn permitted_to(&self, resource: &Resource, permission: Permission) -> bool;

  async fn assert_readable(&self, resource: &Resource) -> Result<(), PermissionDenied>
  where
    Resource: 'async_trait + Debug + Sync,
  {
    if !self.permitted_to(resource, Permission::Read).await {
      return Err(PermissionDenied {
        desired_access: Permission::Read,
        resource_dbg: format!("{:?}", resource),
      });
    }
    Ok(())
  }

  async fn assert_writeable(&self, resource: &Resource) -> Result<(), PermissionDenied>
  where
    Resource: 'async_trait + Debug + Sync,
  {
    if !self.permitted_to(resource, Permission::Write).await {
      return Err(PermissionDenied {
        desired_access: Permission::Write,
        resource_dbg: format!("{:?}", resource),
      });
    }
    Ok(())
  }

  async fn assert_admin(&self, resource: &Resource) -> Result<(), PermissionDenied>
  where
    Resource: 'async_trait + Debug + Sync,
  {
    if !self.permitted_to(resource, Permission::Admin).await {
      return Err(PermissionDenied {
        desired_access: Permission::Admin,
        resource_dbg: format!("{:?}", resource),
      });
    }
    Ok(())
  }
}

#[derive(Debug, thiserror::Error)]
pub struct PermissionDenied {
  pub desired_access: Permission,
  pub resource_dbg: String,
}

impl Display for PermissionDenied {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_fmt(format_args!(
      "{} access denied for resource {:?}",
      match self.desired_access {
        Permission::Admin => "Admin",
        Permission::Read => "Read",
        Permission::Write => "Write",
      },
      self.resource_dbg
    ))?;
    Ok(())
  }
}
