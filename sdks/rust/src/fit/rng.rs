//! NumPy SeedSequence / PCG64 and ziggurat normals, for reproducible synthetic cases.
use super::ziggurat::*;
#[derive(Clone, Debug)]
pub struct NumpyRng {
    state: u128,
    increment: u128,
    cached: Option<u32>,
}
fn hashmix(mut value: u32, c: &mut u32) -> u32 {
    value ^= *c;
    *c = c.wrapping_mul(0x931e8875);
    value = value.wrapping_mul(*c);
    value ^ (value >> 16)
}
fn mix(a: u32, b: u32) -> u32 {
    let v = 0xca01f9dd_u32
        .wrapping_mul(a)
        .wrapping_sub(0x4973f715_u32.wrapping_mul(b));
    v ^ (v >> 16)
}
impl NumpyRng {
    pub fn new(seed: u64) -> Self {
        Self::from_entropy(&[seed])
    }
    pub fn from_entropy(entropy: &[u64]) -> Self {
        let mut words = vec![];
        for n in entropy {
            words.push(*n as u32);
            if *n >> 32 != 0 {
                words.push((*n >> 32) as u32);
            }
        }
        Self::seed_words(&words)
    }
    fn seed_words(words: &[u32]) -> Self {
        let mut pool = [0u32; 4];
        let mut hc = 0x43b0d7e5;
        for (i, v) in pool.iter_mut().enumerate() {
            *v = hashmix(words.get(i).copied().unwrap_or(0), &mut hc);
        }
        for src in 0..4 {
            for dest in 0..4 {
                if src != dest {
                    pool[dest] = mix(pool[dest], hashmix(pool[src], &mut hc));
                }
            }
        }
        for word in words.iter().skip(4) {
            for v in &mut pool {
                *v = mix(*v, hashmix(*word, &mut hc));
            }
        }
        let mut hc = 0x8b51f9dd_u32;
        let state: Vec<_> = (0..8)
            .map(|i| {
                let mut v = pool[i % 4] ^ hc;
                hc = hc.wrapping_mul(0x58f38ded);
                v = v.wrapping_mul(hc);
                v ^ (v >> 16)
            })
            .collect();
        let u: Vec<_> = state
            .chunks(2)
            .map(|v| v[0] as u64 | ((v[1] as u64) << 32))
            .collect();
        let initial = ((u[0] as u128) << 64) | u[1] as u128;
        let sequence = ((u[2] as u128) << 64) | u[3] as u128;
        let mut r = Self {
            state: 0,
            increment: (sequence << 1) | 1,
            cached: None,
        };
        r.step();
        r.state = r.state.wrapping_add(initial);
        r.step();
        r
    }
    fn step(&mut self) {
        self.state = self
            .state
            .wrapping_mul(0x2360ed051fc65da44385df649fccf645)
            .wrapping_add(self.increment);
    }
    pub fn next_u64(&mut self) -> u64 {
        self.step();
        ((self.state >> 64) as u64 ^ self.state as u64).rotate_right((self.state >> 122) as u32)
    }
    pub fn next_u32(&mut self) -> u32 {
        if let Some(v) = self.cached.take() {
            return v;
        }
        let n = self.next_u64();
        self.cached = Some((n >> 32) as u32);
        n as u32
    }
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / 9007199254740992.0)
    }
    pub fn shuffle<T>(&mut self, a: &mut [T]) {
        for i in (1..a.len()).rev() {
            let mut mask = i as u64;
            mask |= mask >> 1;
            mask |= mask >> 2;
            mask |= mask >> 4;
            mask |= mask >> 8;
            mask |= mask >> 16;
            mask |= mask >> 32;
            let j = loop {
                let v = if i <= u32::MAX as usize {
                    self.next_u32() as u64
                } else {
                    self.next_u64()
                } & mask;
                if v <= i as u64 {
                    break v as usize;
                }
            };
            a.swap(i, j);
        }
    }
    pub fn normal(&mut self) -> f64 {
        loop {
            let r = self.next_u64();
            let idx = (r & 255) as usize;
            let r = r >> 8;
            let sign = r & 1;
            let rabs = (r >> 1) & 0x000fffffffffffff;
            let mut x = rabs as f64 * WI[idx];
            if sign != 0 {
                x = -x;
            }
            if rabs < KI[idx] {
                return x;
            }
            if idx == 0 {
                loop {
                    let xx = -NOR_INV_R * (-self.uniform()).ln_1p();
                    let yy = -(-self.uniform()).ln_1p();
                    if yy + yy > xx * xx {
                        return if (rabs >> 8) & 1 != 0 {
                            -(NOR_R + xx)
                        } else {
                            NOR_R + xx
                        };
                    }
                }
            } else if (FI[idx - 1] - FI[idx]) * self.uniform() + FI[idx] < (-0.5 * x * x).exp() {
                return x;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numpy_stream() {
        let mut r = NumpyRng::new(0);
        assert_eq!(r.state, 35399562948360463058890781895381311971);
        assert_eq!(r.increment, 87136372517582989555478159403783844777);
        assert_eq!(r.next_u64(), 11749869230777074271);
        assert_eq!(r.next_u64(), 4976686463289251617);
        let mut r = NumpyRng::new(0);
        for v in [
            0.1257302210933933,
            -0.1321048632913019,
            0.6404226504432821,
            0.10490011715303971,
            -0.535669373161111,
        ] {
            assert_eq!(r.normal(), v);
        }
    }
}

#[cfg(test)]
mod long_stream {
    use super::*;
    #[test]
    fn numpy_tail_rejection_paths() {
        use sha2::{Digest, Sha256};
        let mut r = NumpyRng::new(42);
        let mut h = Sha256::new();
        for _ in 0..10000 {
            h.update(r.normal().to_le_bytes());
        }
        assert_eq!(
            format!("{:x}", h.finalize()),
            "18510110199a0ab7f28508b21a092e5b625229648e34719c04400e4feffbbe5a"
        );
    }
}
