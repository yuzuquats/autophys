pub trait SetLike: Sized {
  fn complement(&self, other: &Self) -> Vec<Self>;
  fn union(&self, other: &Self) -> Self;
  fn intersect(&self, other: &Self) -> Option<Self>;
  fn overlaps(&self, other: &Self) -> bool;
}

impl<Idx> SetLike for std::ops::Range<Idx>
where
  Idx: PartialOrd + Clone,
{
  fn complement(&self, other: &Self) -> Vec<Self> {
    let mut complements = Vec::new();
    if self.start < other.start {
      complements.push(self.start.clone()..other.start.clone());
    }
    if self.end > other.end {
      complements.push(other.end.clone()..self.end.clone());
    }
    complements
  }

  fn union(&self, other: &Self) -> Self {
    let start = if self.start < other.start {
      &self.start
    } else {
      &other.start
    };
    let end = if self.end < other.end {
      &other.end
    } else {
      &self.end
    };
    start.clone()..end.clone()
  }

  fn intersect(&self, other: &Self) -> Option<Self> {
    if other.start < self.end {
      return Some(other.start.clone()..self.end.clone());
    }
    if self.start < other.end {
      return Some(self.start.clone()..other.end.clone());
    }
    None
  }

  fn overlaps(&self, other: &Self) -> bool {
    self.start < other.end && other.start < self.end
  }
}

#[cfg(test)]
mod test {
  use super::*;

  #[test]
  fn test_range() {
    let range = 10..20;
    let complement = range.complement(&(15..25));
    println!("{complement:#?}");

    let union = range.union(&(15..25));
    println!("{union:#?}");

    {
      let union = &range.union(&(15..25));
      println!("{union:#?}");
    }
    {
      let intersect = &range.intersect(&(15..25));
      println!("{intersect:#?}");
    }
  }
}
