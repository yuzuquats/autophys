//! Historical time/output mapping, with stimulus channels kept separately.
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::ops::{Deref, DerefMut};

pub type Channels = IndexMap<String, Vec<f64>>;
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Trajectory {
    y: Channels,
    #[serde(skip)]
    pub u: Channels,
}
impl Trajectory {
    pub fn new() -> Self {
        Self::default()
    }
}
impl Deref for Trajectory {
    type Target = Channels;
    fn deref(&self) -> &Channels {
        &self.y
    }
}
impl DerefMut for Trajectory {
    fn deref_mut(&mut self) -> &mut Channels {
        &mut self.y
    }
}
impl FromIterator<(String, Vec<f64>)> for Trajectory {
    fn from_iter<T: IntoIterator<Item = (String, Vec<f64>)>>(iter: T) -> Self {
        Self {
            y: iter.into_iter().collect(),
            u: Channels::new(),
        }
    }
}
impl IntoIterator for Trajectory {
    type Item = (String, Vec<f64>);
    type IntoIter = indexmap::map::IntoIter<String, Vec<f64>>;
    fn into_iter(self) -> Self::IntoIter {
        self.y.into_iter()
    }
}
impl<'a> IntoIterator for &'a Trajectory {
    type Item = (&'a String, &'a Vec<f64>);
    type IntoIter = indexmap::map::Iter<'a, String, Vec<f64>>;
    fn into_iter(self) -> Self::IntoIter {
        self.y.iter()
    }
}

impl From<Channels> for Trajectory {
    fn from(y: Channels) -> Self {
        Self {
            y,
            u: Channels::new(),
        }
    }
}
impl From<Trajectory> for Channels {
    fn from(value: Trajectory) -> Self {
        value.y
    }
}
impl Extend<(String, Vec<f64>)> for Trajectory {
    fn extend<T: IntoIterator<Item = (String, Vec<f64>)>>(&mut self, iter: T) {
        self.y.extend(iter);
    }
}
impl<'a> IntoIterator for &'a mut Trajectory {
    type Item = (&'a String, &'a mut Vec<f64>);
    type IntoIter = indexmap::map::IterMut<'a, String, Vec<f64>>;
    fn into_iter(self) -> Self::IntoIter {
        self.y.iter_mut()
    }
}
