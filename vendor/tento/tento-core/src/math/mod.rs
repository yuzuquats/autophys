pub trait FloorMod {
  fn floor_mod(self, modulus: Self) -> Self;
}

impl FloorMod for i32 {
  fn floor_mod(self, modulus: Self) -> Self {
    if self >= 0 {
      self % modulus
    } else {
      (modulus - (-self % modulus)) % modulus
    }
  }
}

pub trait FloorDiv {
  fn floor_div(self, divisor: Self) -> Self;
}

impl FloorDiv for i32 {
  fn floor_div(self, divisor: Self) -> Self {
    let quotient = self / divisor;
    let remainder = self % divisor;
    if remainder < 0 {
      quotient - 1
    } else {
      quotient
    }
  }
}
