pub struct PartialResults<R, E> {
  pub oks: Vec<R>,
  pub errs: Vec<E>,
}

pub trait ResultsExt {
  type Ok;
  type Err;

  fn partition_res(self) -> (Vec<Self::Ok>, Vec<Self::Err>);
  fn partial_res(self) -> Result<Vec<Self::Ok>, PartialResults<Self::Ok, Self::Err>>;
  fn full_res(self) -> Result<Vec<Self::Ok>, Vec<Self::Err>>;
}

impl<R, E> ResultsExt for Vec<Result<R, E>> {
  type Ok = R;
  type Err = E;

  fn partition_res(self) -> (Vec<Self::Ok>, Vec<Self::Err>) {
    let mut oks = Vec::new();
    let mut errs = Vec::new();

    for result in self {
      match result {
        Ok(r) => oks.push(r),
        Err(e) => errs.push(e),
      }
    }

    (oks, errs)
  }

  fn partial_res(self) -> Result<Vec<Self::Ok>, PartialResults<Self::Ok, Self::Err>> {
    let (oks, errs) = self.partition_res();
    if !errs.is_empty() {
      return Err(PartialResults { oks, errs });
    }
    Ok(oks)
  }

  fn full_res(self) -> Result<Vec<Self::Ok>, Vec<Self::Err>> {
    let (oks, errs) = self.partition_res();
    if !errs.is_empty() {
      return Err(errs);
    }
    Ok(oks)
  }
}
