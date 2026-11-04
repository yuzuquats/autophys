//! Opaque, typed host resources. Values share one revocable owner; wire data
//! never carries the payload or an authority-bearing registry key.
use std::{
  any::Any,
  cell::{Cell, RefCell},
  rc::{Rc, Weak},
};

type Payload = Rc<RefCell<Option<Box<dyn Any>>>>;

#[derive(Clone)]
pub struct Resource {
  owner: Rc<Identity>,
  payload: Payload,
  name: &'static str,
}

#[derive(Default)]
struct Identity {
  closed: Cell<bool>,
}

impl std::fmt::Debug for Resource {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("Resource")
      .field("kind", &self.name)
      .finish_non_exhaustive()
  }
}

/// A cloneable registration/access capability. The host must call `close_all`
/// in its destructor: native closures may retain clones after host teardown.
#[derive(Clone, Default)]
pub struct ResourceScope {
  identity: Rc<Identity>,
  resources: Rc<RefCell<Vec<Weak<RefCell<Option<Box<dyn Any>>>>>>>,
}

impl ResourceScope {
  pub fn insert<T: Any>(&self, name: &'static str, value: T) -> Result<Resource, String> {
    if self.identity.closed.get() {
      return Err("resource host is closed".into());
    }
    let payload: Payload = Rc::new(RefCell::new(Some(Box::new(value))));
    let mut resources = self.resources.borrow_mut();
    resources.retain(|r| r.strong_count() != 0);
    resources.push(Rc::downgrade(&payload));
    Ok(Resource {
      owner: self.identity.clone(),
      payload,
      name,
    })
  }

  fn check(&self, resource: &Resource) -> Result<(), String> {
    if !Rc::ptr_eq(&self.identity, &resource.owner) {
      return Err("resource belongs to another host".into());
    }
    if self.identity.closed.get() {
      return Err("resource host is closed".into());
    }
    Ok(())
  }

  pub fn with_mut<T: Any, R>(
    &self,
    resource: &Resource,
    f: impl FnOnce(&mut T) -> R,
  ) -> Result<R, String> {
    self.check(resource)?;
    let mut slot = resource
      .payload
      .try_borrow_mut()
      .map_err(|_| "resource is already borrowed")?;
    let payload = slot.as_mut().ok_or("resource is closed or moved")?;
    let value = payload.downcast_mut::<T>().ok_or("wrong resource kind")?;
    Ok(f(value))
  }

  /// Move ownership out. Every old alias becomes stale. A wrong type leaves
  /// the original payload intact, so a failed adapter cannot lose a resource.
  pub fn take<T: Any>(&self, resource: &Resource) -> Result<T, String> {
    self.check(resource)?;
    let mut slot = resource
      .payload
      .try_borrow_mut()
      .map_err(|_| "resource is already borrowed")?;
    if !slot
      .as_ref()
      .ok_or("resource is closed or moved")?
      .is::<T>()
    {
      return Err("wrong resource kind".into());
    }
    let value = slot
      .take()
      .expect("checked payload")
      .downcast::<T>()
      .map_err(|_| "wrong resource kind")?;
    Ok(*value)
  }

  /// Idempotent cleanup; allowed even after the host has already closed it.
  pub fn close(&self, resource: &Resource) -> Result<(), String> {
    if !Rc::ptr_eq(&self.identity, &resource.owner) {
      return Err("resource belongs to another host".into());
    }
    resource
      .payload
      .try_borrow_mut()
      .map_err(|_| "resource is already borrowed")?
      .take();
    Ok(())
  }

  pub fn close_all(&self) {
    self.identity.closed.set(true);
    for weak in self.resources.borrow_mut().drain(..) {
      if let Some(payload) = weak.upgrade() {
        payload.borrow_mut().take();
      }
    }
  }
}

/// A cleanup-only weak reference. It cannot read, transfer, or keep a resource alive.
pub struct ResourceRevoker(Weak<RefCell<Option<Box<dyn Any>>>>);
impl ResourceRevoker {
  pub fn close(&self) {
    if let Some(payload) = self.0.upgrade() {
      payload.borrow_mut().take();
    }
  }
}

impl Resource {
  pub fn revoker(&self) -> ResourceRevoker {
    ResourceRevoker(Rc::downgrade(&self.payload))
  }

  pub fn kind(&self) -> &'static str {
    self.name
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[derive(Debug)]
  struct Count(Rc<Cell<usize>>);
  impl Drop for Count {
    fn drop(&mut self) {
      self.0.set(self.0.get() + 1);
    }
  }
  #[test]
  fn aliases_move_close_and_host_teardown() {
    let scope = ResourceScope::default();
    let other = ResourceScope::default();
    let drops = Rc::new(Cell::new(0));
    let r = scope.insert("test", Count(drops.clone())).unwrap();
    let alias = r.clone();
    assert!(
      other
        .take::<Count>(&r)
        .unwrap_err()
        .contains("another host")
    );
    assert!(scope.take::<String>(&r).is_err());
    let moved = scope.take::<Count>(&r).unwrap();
    assert!(scope.take::<Count>(&alias).is_err());
    let r = scope.insert("test", moved).unwrap();
    scope.close(&r).unwrap();
    scope.close(&r).unwrap();
    assert_eq!(drops.get(), 1);
    let escaped = scope.insert("test", Count(drops.clone())).unwrap();
    scope.close_all();
    assert_eq!(drops.get(), 2);
    assert!(scope.with_mut::<Count, _>(&escaped, |_| ()).is_err());
    assert!(scope.insert("test", Count(drops.clone())).is_err());
    assert_eq!(drops.get(), 3);
  }
  #[test]
  fn abandoned_last_alias_reclaims_without_host_teardown() {
    let scope = ResourceScope::default();
    let drops = Rc::new(Cell::new(0));
    let r = scope.insert("test", Count(drops.clone())).unwrap();
    let alias = r.clone();
    drop(r);
    assert_eq!(drops.get(), 0);
    drop(alias);
    assert_eq!(drops.get(), 1);
  }
}
