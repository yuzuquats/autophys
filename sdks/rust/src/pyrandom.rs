//! CPython's `random.Random` (MT19937) for the draws the research loop
//! makes: `Random(seed)` with a non-negative integer seed and
//! `randrange(n)`. The paired bootstrap resamples with it, so a Rust run
//! accepts or rejects exactly the edits the Python reference does.

const N: usize = 624;
const M: usize = 397;

#[derive(Clone)]
pub struct PyRandom {
    mt: [u32; N],
    index: usize,
}

impl PyRandom {
    /// `random.Random(seed)` for an integer seed (CPython seeds with the
    /// 32-bit words of `abs(seed)`, least significant first).
    pub fn new(seed: u64) -> Self {
        let mut key = vec![seed as u32];
        if seed >> 32 != 0 {
            key.push((seed >> 32) as u32);
        }
        let mut r = Self {
            mt: [0; N],
            index: N,
        };
        r.init_by_array(&key);
        r
    }

    fn init_genrand(&mut self, s: u32) {
        self.mt[0] = s;
        for i in 1..N {
            let prev = self.mt[i - 1];
            self.mt[i] = 1812433253u32
                .wrapping_mul(prev ^ (prev >> 30))
                .wrapping_add(i as u32);
        }
        self.index = N;
    }

    fn init_by_array(&mut self, key: &[u32]) {
        self.init_genrand(19650218);
        let (mut i, mut j) = (1usize, 0usize);
        for _ in 0..N.max(key.len()) {
            let prev = self.mt[i - 1];
            self.mt[i] = (self.mt[i] ^ (prev ^ (prev >> 30)).wrapping_mul(1664525))
                .wrapping_add(key[j])
                .wrapping_add(j as u32);
            i += 1;
            j += 1;
            if i >= N {
                self.mt[0] = self.mt[N - 1];
                i = 1;
            }
            if j >= key.len() {
                j = 0;
            }
        }
        for _ in 0..N - 1 {
            let prev = self.mt[i - 1];
            self.mt[i] = (self.mt[i] ^ (prev ^ (prev >> 30)).wrapping_mul(1566083941))
                .wrapping_sub(i as u32);
            i += 1;
            if i >= N {
                self.mt[0] = self.mt[N - 1];
                i = 1;
            }
        }
        self.mt[0] = 0x8000_0000;
        self.index = N;
    }

    pub fn next_u32(&mut self) -> u32 {
        if self.index >= N {
            for k in 0..N {
                let y = (self.mt[k] & 0x8000_0000) | (self.mt[(k + 1) % N] & 0x7fff_ffff);
                let mut v = self.mt[(k + M) % N] ^ (y >> 1);
                if y & 1 != 0 {
                    v ^= 0x9908_b0df;
                }
                self.mt[k] = v;
            }
            self.index = 0;
        }
        let mut y = self.mt[self.index];
        self.index += 1;
        y ^= y >> 11;
        y ^= (y << 7) & 0x9d2c_5680;
        y ^= (y << 15) & 0xefc6_0000;
        y ^ (y >> 18)
    }

    /// `getrandbits(k)` for `1 <= k <= 32`.
    fn getrandbits(&mut self, k: u32) -> u32 {
        self.next_u32() >> (32 - k)
    }

    /// `randrange(n)` for `1 <= n < 2**32`: rejection sampling on
    /// `n.bit_length()` bits, as CPython's `_randbelow_with_getrandbits`.
    pub fn randrange(&mut self, n: u32) -> u32 {
        assert!(n >= 1, "randrange needs a positive bound");
        let k = 32 - n.leading_zeros();
        loop {
            let r = self.getrandbits(k);
            if r < n {
                return r;
            }
        }
    }

    /// `random()`: 53-bit float in `[0, 1)`.
    pub fn random(&mut self) -> f64 {
        let a = (self.next_u32() >> 5) as f64;
        let b = (self.next_u32() >> 6) as f64;
        (a * 67108864.0 + b) * (1.0 / 9007199254740992.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_cpython() {
        // python3 -c 'import random; r=random.Random(0); print([r.randrange(7) for _ in range(12)])'
        let mut r = PyRandom::new(0);
        let got: Vec<u32> = (0..12).map(|_| r.randrange(7)).collect();
        assert_eq!(got, [6, 3, 6, 3, 0, 2, 4, 3, 3, 6, 6, 2]);
        // python3 -c 'import random; r=random.Random(5); print([r.randrange(100) for _ in range(6)], r.random())'
        let mut r = PyRandom::new(5);
        let got: Vec<u32> = (0..6).map(|_| r.randrange(100)).collect();
        assert_eq!(got, [79, 32, 94, 45, 88, 94]);
        assert_eq!(r.random(), 0.6520316967541351);
        // python3 -c 'import random; r=random.Random(2**40+3); print([r.randrange(9) for _ in range(5)])'
        let mut r = PyRandom::new((1 << 40) + 3);
        let got: Vec<u32> = (0..5).map(|_| r.randrange(9)).collect();
        assert_eq!(got, [3, 0, 8, 1, 4]);
    }
}
