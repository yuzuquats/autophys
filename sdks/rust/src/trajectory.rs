//! One simulation result: the time/output channels (`y`, which holds the
//! time vector under `"t"`) and the stimulus input channels (`u`).
//!
//! Serialised as `{"y": {...}, "u": {...}}`, the shape of the Python worker
//! protocol v1 `result` (DM-RS-1a). No workbook record or canonical hash
//! serialises a `Trajectory`: fit curves and worker replies build their JSON
//! explicitly, so this shape is public API only.
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// Named channels, each a vector of samples in time order.
pub type Channels = IndexMap<String, Vec<f64>>;

/// The name of the time channel among a trajectory's outputs.
pub const TIME: &str = "t";

/// Whether a channel is an output (`y`) or a stimulus input (`u`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChannelRole {
    Output,
    Input,
}
impl std::fmt::Display for ChannelRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ChannelRole::Output => "output",
            ChannelRole::Input => "input",
        })
    }
}

/// A channel lookup that found no channel of that name. Converts into a
/// [`SimulationError::Simulation`](crate::simulator::SimulationError) (so a
/// simulator can use `?`) and into [`crate::Error::BadRequest`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("missing {role} channel {channel}")]
pub struct ChannelError {
    pub role: ChannelRole,
    pub channel: String,
}
impl From<ChannelError> for crate::simulator::SimulationError {
    fn from(e: ChannelError) -> Self {
        crate::simulator::SimulationError::Simulation(e.to_string())
    }
}
impl From<ChannelError> for crate::Error {
    fn from(e: ChannelError) -> Self {
        crate::Error::BadRequest(e.to_string())
    }
}

/// A simulation result. Equality compares outputs and inputs.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Trajectory {
    y: Channels,
    #[serde(default)]
    u: Channels,
}
impl Trajectory {
    pub fn new() -> Self {
        Self::default()
    }
    /// A trajectory from its outputs (including `"t"`) and inputs.
    pub fn from_parts(outputs: Channels, inputs: Channels) -> Self {
        Self {
            y: outputs,
            u: inputs,
        }
    }
    /// The outputs and inputs, in that order.
    pub fn into_parts(self) -> (Channels, Channels) {
        (self.y, self.u)
    }
    /// The time/output channels, `"t"` first by convention.
    pub fn outputs(&self) -> &Channels {
        &self.y
    }
    pub fn outputs_mut(&mut self) -> &mut Channels {
        &mut self.y
    }
    /// The stimulus input channels.
    pub fn inputs(&self) -> &Channels {
        &self.u
    }
    pub fn inputs_mut(&mut self) -> &mut Channels {
        &mut self.u
    }
    /// The time vector: the output channel `"t"`.
    pub fn t(&self) -> Result<&[f64], ChannelError> {
        self.output(TIME)
    }
    /// One output channel, or an error naming it.
    pub fn output(&self, name: &str) -> Result<&[f64], ChannelError> {
        lookup(&self.y, ChannelRole::Output, name)
    }
    /// One input channel, or an error naming it.
    pub fn input(&self, name: &str) -> Result<&[f64], ChannelError> {
        lookup(&self.u, ChannelRole::Input, name)
    }
    /// The output channel names other than `"t"`.
    pub fn output_names(&self) -> impl Iterator<Item = &str> {
        self.y.keys().map(String::as_str).filter(|k| *k != TIME)
    }
    /// Set (or replace) an output channel.
    pub fn insert_output(&mut self, name: impl Into<String>, values: Vec<f64>) -> Option<Vec<f64>> {
        self.y.insert(name.into(), values)
    }
    /// Set (or replace) an input channel.
    pub fn insert_input(&mut self, name: impl Into<String>, values: Vec<f64>) -> Option<Vec<f64>> {
        self.u.insert(name.into(), values)
    }
    /// Builder form of [`Self::insert_output`].
    pub fn with_output(mut self, name: impl Into<String>, values: Vec<f64>) -> Self {
        self.insert_output(name, values);
        self
    }
    /// Builder form of [`Self::insert_input`].
    pub fn with_input(mut self, name: impl Into<String>, values: Vec<f64>) -> Self {
        self.insert_input(name, values);
        self
    }
}
fn lookup<'a>(map: &'a Channels, role: ChannelRole, name: &str) -> Result<&'a [f64], ChannelError> {
    map.get(name)
        .map(Vec::as_slice)
        .ok_or_else(|| ChannelError {
            role,
            channel: name.to_string(),
        })
}

/// Outputs only (the time vector under `"t"`); a simulator that builds its
/// own map returns `map.into()`.
impl From<Channels> for Trajectory {
    fn from(y: Channels) -> Self {
        Self {
            y,
            u: Channels::new(),
        }
    }
}
/// Collects `(name, samples)` pairs as outputs.
impl FromIterator<(String, Vec<f64>)> for Trajectory {
    fn from_iter<T: IntoIterator<Item = (String, Vec<f64>)>>(iter: T) -> Self {
        Self::from(iter.into_iter().collect::<Channels>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lookups_name_the_missing_channel() {
        let traj = Trajectory::new()
            .with_output("t", vec![0., 1.])
            .with_output("v", vec![1., 2.])
            .with_input("i", vec![3., 4.]);
        assert_eq!(traj.t().unwrap(), [0., 1.]);
        assert_eq!(traj.output("v").unwrap(), [1., 2.]);
        assert_eq!(traj.input("i").unwrap(), [3., 4.]);
        assert_eq!(traj.output_names().collect::<Vec<_>>(), ["v"]);
        let e = traj.output("voltage").unwrap_err();
        assert_eq!(e.to_string(), "missing output channel voltage");
        assert_eq!(e.channel, "voltage");
        assert_eq!(
            traj.input("v").unwrap_err().to_string(),
            "missing input channel v"
        );
        let sim: crate::simulator::SimulationError = e.into();
        assert!(
            matches!(sim, crate::simulator::SimulationError::Simulation(m) if m.contains("voltage"))
        );
    }

    #[test]
    fn serde_keeps_inputs_and_equality_compares_them() {
        let traj = Trajectory::new()
            .with_output("t", vec![0., 1.])
            .with_input("i", vec![3., 4.]);
        let wire = serde_json::to_value(&traj).unwrap();
        assert_eq!(wire, json!({"y":{"t":[0.,1.]},"u":{"i":[3.,4.]}}));
        let back: Trajectory = serde_json::from_value(wire).unwrap();
        assert_eq!(back, traj);
        let mut other = traj.clone();
        other.inputs_mut().insert("i".into(), vec![3., 5.]);
        assert_ne!(other, traj);
        // `u` is optional on the wire, as in the worker protocol.
        let outputs_only: Trajectory = serde_json::from_value(json!({"y":{"t":[0.]}})).unwrap();
        assert!(outputs_only.inputs().is_empty());
    }
}
