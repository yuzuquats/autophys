//! Bench declarations copied from the Python reference (acf3c33), outside hashed sources.
use crate::{display::Display, simulator::*};
use serde_json::{Value, json};
use std::sync::Arc;
fn declaration(value: Value, channel: &str, drive: fn(&Settings, f64) -> Result<f64>) -> Display {
    let mut display = Display {
        channels: value["channels"].as_object().unwrap().clone(),
        settings: value["settings"].as_object().unwrap().clone(),
        experiments: value["experiments"].as_object().unwrap().clone(),
        default_view: value["default_view"].as_str().map(str::to_owned),
        ..Default::default()
    };
    display.inputs.insert(
        channel.into(),
        Arc::new(move |e, t| t.iter().map(|t| drive(e, *t)).collect()),
    );
    display
}
pub(super) fn battery() -> Display {
    declaration(
        json!({"channels": {"v": {"label": "Terminal voltage", "unit": "V", "role": "output"}, "i": {"label": "Current", "unit": "A", "role": "input"}}, "settings": {"current": {"label": "Current", "unit": "A", "role": "drive"}, "on": {"label": "On", "unit": "s", "role": "drive"}, "off": {"label": "Off", "unit": "s", "role": "drive"}, "duration": {"label": "Duration", "unit": "s", "role": "sampling"}, "rate": {"label": "Rate", "unit": "Hz", "role": "sampling"}, "capacity_ah": {"label": "Capacity", "unit": "Ah", "role": "known"}, "soc0": {"label": "SOC₀", "unit": "", "role": "known"}}, "experiments": {"discharge_1A": {"label": "Discharge at 1 A", "description": "", "views": []}, "pulse_2A": {"label": "Pulse at 2 A", "description": "", "views": ["edges"]}, "pulse_train": {"label": "Pulse train", "description": "", "views": ["edges"]}}, "default_view": "fit"}),
        "i",
        super::battery::current,
    )
}
pub(super) fn oscillator() -> Display {
    declaration(
        json!({"channels": {"x": {"label": "Displacement", "unit": "m", "role": "output"}, "force": {"label": "Force", "unit": "N", "role": "input"}}, "settings": {"amplitude": {"label": "Amplitude", "unit": "", "role": "drive"}, "freq": {"label": "Frequency", "unit": "Hz", "role": "drive"}, "x0": {"label": "Initial displacement", "unit": "m", "role": "known"}, "v0": {"label": "Initial velocity", "unit": "m/s", "role": "known"}, "duration": {"label": "Duration", "unit": "s", "role": "sampling"}, "rate": {"label": "Rate", "unit": "Hz", "role": "sampling"}}, "experiments": {"free": {"label": "Free response", "description": "", "views": ["envelope", "spectrum"]}, "step_2N": {"label": "Step at 2 N", "description": "", "views": ["envelope", "spectrum"]}, "impulse": {"label": "Impulse", "description": "Amplitude is momentum in N s, applied as initial velocity; the force channel is zero.", "views": ["envelope", "spectrum"]}, "sine_0.1Hz": {"label": "Sine at 0.1 Hz", "description": "", "views": ["spectrum"]}, "sine_0.44Hz": {"label": "Sine at 0.44 Hz", "description": "", "views": ["spectrum"]}, "sine_2Hz": {"label": "Sine at 2 Hz", "description": "", "views": ["spectrum"]}}, "default_view": "landscape"}),
        "force",
        super::oscillator::force,
    )
}
pub(super) fn thermal() -> Display {
    declaration(
        json!({"channels": {"T": {"label": "Temperature", "unit": "°C", "role": "output"}, "power": {"label": "Power", "unit": "W", "role": "input"}}, "settings": {"power": {"label": "Power", "unit": "W", "role": "drive"}, "on": {"label": "On", "unit": "s", "role": "drive"}, "period": {"label": "Period", "unit": "s", "role": "drive"}, "duration": {"label": "Duration", "unit": "s", "role": "sampling"}, "rate": {"label": "Rate", "unit": "Hz", "role": "sampling"}}, "experiments": {"step_short": {"label": "Short step", "description": "", "views": []}, "step_long": {"label": "Long step", "description": "", "views": []}, "pulse": {"label": "Power pulse", "description": "", "views": ["edges"]}, "sine_slow": {"label": "Slow sine", "description": "", "views": ["spectrum"]}, "sine_fast": {"label": "Fast sine", "description": "", "views": ["spectrum"]}}, "default_view": "fit"}),
        "power",
        super::thermal::power,
    )
}
