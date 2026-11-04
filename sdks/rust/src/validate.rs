//! Envelope parsing and payload validation. Pure functions: nothing here
//! touches the database. Every refusal is a 422 naming the field path
//! (`payload.outlook.axes[0].values[3]`), so the SDK can say which field.

mod trace;
use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// The largest canonical payload accepted inline (blobs are deferred, D3).
pub const MAX_PAYLOAD_BYTES: usize = 1 << 20;
/// The largest client-chosen id (record ids, proposal ids).
pub const MAX_ID_LEN: usize = 128;

/// A record kind. The SDK's six, in its order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Investigation,
    Measurement,
    Run,
    Step,
    Proposal,
    Outcome,
}

impl Kind {
    pub const ALL: [Kind; 6] = [
        Kind::Investigation,
        Kind::Measurement,
        Kind::Run,
        Kind::Step,
        Kind::Proposal,
        Kind::Outcome,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Investigation => "investigation",
            Kind::Measurement => "measurement",
            Kind::Run => "run",
            Kind::Step => "step",
            Kind::Proposal => "proposal",
            Kind::Outcome => "outcome",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

/// A proposal's lifecycle event (`payload.event` of a `proposal` record).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Proposed,
    Approved,
    Edited,
    Rejected,
    Withdrawn,
    DataAttached,
}

impl Event {
    pub const ALL: [Event; 6] = [
        Event::Proposed,
        Event::Approved,
        Event::Edited,
        Event::Rejected,
        Event::Withdrawn,
        Event::DataAttached,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Event::Proposed => "proposed",
            Event::Approved => "approved",
            Event::Edited => "edited",
            Event::Rejected => "rejected",
            Event::Withdrawn => "withdrawn",
            Event::DataAttached => "data_attached",
        }
    }

    pub fn parse(s: &str) -> Option<Event> {
        Event::ALL.into_iter().find(|e| e.as_str() == s)
    }
}

/// What a client posts: `{id, kind, payload}`. `id` is the client's
/// idempotency key; `payload` is always a JSON object.
#[derive(Clone, Debug, PartialEq)]
pub struct Envelope {
    pub id: String,
    pub kind: Kind,
    pub payload: Value,
}

impl Envelope {
    /// Parse and validate a posted body (shape, id, kind, payload).
    pub fn from_value(body: Value) -> Result<Envelope> {
        let Value::Object(mut body) = body else {
            return Err(Error::invalid("$", "the body must be a JSON object"));
        };
        let id = match body.remove("id") {
            Some(Value::String(s)) => s,
            _ => return Err(Error::invalid("id", "required string")),
        };
        check_id("id", &id)?;
        let kind = match body.remove("kind") {
            Some(Value::String(s)) => Kind::parse(&s)
                .ok_or_else(|| Error::invalid("kind", format!("unknown kind {s:?}")))?,
            _ => return Err(Error::invalid("kind", "required string")),
        };
        let payload = body.remove("payload").unwrap_or(Value::Null);
        let env = Envelope { id, kind, payload };
        payload_shape(env.kind, &env.payload)?;
        Ok(env)
    }

    /// The proposal id and event of a `proposal` envelope (already validated).
    pub fn proposal(&self) -> Option<(&str, Event)> {
        if self.kind != Kind::Proposal {
            return None;
        }
        let pid = self.payload.get("proposal_id")?.as_str()?;
        let ev = Event::parse(self.payload.get("event")?.as_str()?)?;
        Some((pid, ev))
    }
}

/// Client-chosen ids: 1–128 characters of `[A-Za-z0-9_.:-]`, so they are safe
/// in paths, SSE ids and logs without escaping.
pub fn check_id(path: &str, id: &str) -> Result<()> {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return Err(Error::invalid(
            path,
            format!("must be 1 to {MAX_ID_LEN} characters"),
        ));
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
    {
        return Err(Error::invalid(path, "may contain only A-Z a-z 0-9 _ - . :"));
    }
    Ok(())
}

/// Validate a payload for its kind. Only the fields the daemon's projections
/// read, plus E-1's `outlook`, are checked; everything else passes through.
pub fn payload_shape(kind: Kind, payload: &Value) -> Result<()> {
    let Some(obj) = payload.as_object() else {
        return Err(Error::invalid("payload", "must be a JSON object"));
    };
    trace::shape(kind, obj)?;
    match kind {
        Kind::Investigation => {
            string_field(obj, "payload", "project_id")?;
            string_field(obj, "payload", "config_version")?;
        }
        Kind::Measurement => {
            if !obj.get("observation").is_some_and(Value::is_object) {
                return Err(Error::invalid("payload.observation", "required object"));
            }
        }
        Kind::Run | Kind::Step => {}
        Kind::Outcome => {
            string_field(obj, "payload", "status")?;
        }
        Kind::Proposal => proposal_shape(obj)?,
    }
    Ok(())
}

fn proposal_shape(obj: &Map<String, Value>) -> Result<()> {
    let pid = string_field(obj, "payload", "proposal_id")?;
    check_id("payload.proposal_id", pid)?;
    let ev = string_field(obj, "payload", "event")?;
    let ev = Event::parse(ev).ok_or_else(|| {
        let all: Vec<_> = Event::ALL.iter().map(|e| e.as_str()).collect();
        Error::invalid(
            "payload.event",
            format!("must be one of {}", all.join(", ")),
        )
    })?;
    match ev {
        Event::Proposed => {
            string_field(obj, "payload", "experiment")?;
            optional_object(obj, "payload.settings", "settings")?;
            if let Some(outlook) = obj.get("outlook") {
                outlook_shape(outlook)?;
            }
        }
        Event::Edited => {
            if !obj.get("settings").is_some_and(Value::is_object) {
                return Err(Error::invalid(
                    "payload.settings",
                    "required object for edited",
                ));
            }
        }
        Event::DataAttached => {
            if obj.get("measurement_version").is_none_or(Value::is_null) {
                return Err(Error::invalid(
                    "payload.measurement_version",
                    "required for data_attached",
                ));
            }
        }
        Event::Approved | Event::Rejected | Event::Withdrawn => {}
    }
    Ok(())
}

/// The largest grid an outlook may describe (E-1).
pub const MAX_OUTLOOK_AXES: usize = 3;

/// E-1: `outlook = {axes: [{name, values}], score, after: {param: values}}`,
/// row-major over the axes. Every array is finite numbers and `score` and each
/// `after` array have exactly the product of the axis lengths. It is stored
/// untouched; the daemon never computes from it.
pub fn outlook_shape(outlook: &Value) -> Result<()> {
    const AT: &str = "payload.outlook";
    let Some(o) = outlook.as_object() else {
        return Err(Error::invalid(AT, "must be an object"));
    };
    let Some(axes) = o.get("axes").and_then(Value::as_array) else {
        return Err(Error::invalid(format!("{AT}.axes"), "required array"));
    };
    if axes.len() > MAX_OUTLOOK_AXES {
        return Err(Error::invalid(
            format!("{AT}.axes"),
            format!("at most {MAX_OUTLOOK_AXES} axes, got {}", axes.len()),
        ));
    }
    let mut cells: usize = 1;
    for (i, axis) in axes.iter().enumerate() {
        let at = format!("{AT}.axes[{i}]");
        let Some(axis) = axis.as_object() else {
            return Err(Error::invalid(at, "must be an object"));
        };
        string_field(axis, &at, "name")?;
        let n = finite_array(axis.get("values"), &format!("{at}.values"))?;
        if n == 0 {
            return Err(Error::invalid(format!("{at}.values"), "must not be empty"));
        }
        cells = cells.saturating_mul(n);
    }
    let n = finite_array(o.get("score"), &format!("{AT}.score"))?;
    expect_len(n, cells, &format!("{AT}.score"))?;
    let Some(after) = o.get("after").and_then(Value::as_object) else {
        return Err(Error::invalid(format!("{AT}.after"), "required object"));
    };
    for (param, values) in after {
        let at = format!("{AT}.after.{param}");
        let n = finite_array(Some(values), &at)?;
        expect_len(n, cells, &at)?;
    }
    Ok(())
}

fn expect_len(n: usize, cells: usize, at: &str) -> Result<()> {
    if n != cells {
        return Err(Error::invalid(
            at,
            format!("has {n} values; the axes describe {cells} cells (row-major)"),
        ));
    }
    Ok(())
}

/// Length of an array whose every element is a finite number.
fn finite_array(v: Option<&Value>, at: &str) -> Result<usize> {
    let Some(items) = v.and_then(Value::as_array) else {
        return Err(Error::invalid(at, "required array of numbers"));
    };
    for (i, item) in items.iter().enumerate() {
        if !item.as_f64().is_some_and(f64::is_finite) {
            return Err(Error::invalid(
                format!("{at}[{i}]"),
                "must be a finite number",
            ));
        }
    }
    Ok(items.len())
}

fn string_field<'a>(obj: &'a Map<String, Value>, at: &str, key: &str) -> Result<&'a str> {
    match obj.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Ok(s),
        _ => Err(Error::invalid(
            format!("{at}.{key}"),
            "required non-empty string",
        )),
    }
}

fn optional_object(obj: &Map<String, Value>, at: &str, key: &str) -> Result<()> {
    match obj.get(key) {
        None | Some(Value::Null) | Some(Value::Object(_)) => Ok(()),
        _ => Err(Error::invalid(at, "must be an object")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn path_of(r: Result<()>) -> String {
        match r {
            Err(Error::Invalid { path, .. }) => path,
            other => panic!("expected 422, got {other:?}"),
        }
    }

    #[test]
    fn outlook_accepts_a_row_major_grid() {
        let o = json!({"axes": [{"name": "f", "values": [0.1, 0.2]}, {"name": "a", "values": [1, 2, 3]}],
                       "score": [1, 2, 3, 4, 5, 6], "after": {"C": [0, 0, 0, 0, 0, 0.5]}});
        outlook_shape(&o).unwrap();
        outlook_shape(&json!({"axes": [], "score": [1.0], "after": {}})).unwrap();
    }

    #[test]
    fn outlook_refusals_name_the_field() {
        let base = |score: Value, after: Value| json!({"axes": [{"name": "f", "values": [1, 2]}], "score": score, "after": after});
        assert_eq!(
            path_of(outlook_shape(&base(json!([1]), json!({})))),
            "payload.outlook.score"
        );
        assert_eq!(
            path_of(outlook_shape(&base(json!([1, null]), json!({})))),
            "payload.outlook.score[1]"
        );
        assert_eq!(
            path_of(outlook_shape(&base(json!([1, 2]), json!({"k": [1]})))),
            "payload.outlook.after.k"
        );
        let four = json!({"axes": [{"name":"a","values":[1]},{"name":"b","values":[1]},{"name":"c","values":[1]},{"name":"d","values":[1]}], "score": [1], "after": {}});
        assert_eq!(path_of(outlook_shape(&four)), "payload.outlook.axes");
        let empty = json!({"axes": [{"name": "f", "values": []}], "score": [], "after": {}});
        assert_eq!(
            path_of(outlook_shape(&empty)),
            "payload.outlook.axes[0].values"
        );
    }

    #[test]
    fn envelope_paths() {
        assert_eq!(
            path_of(Envelope::from_value(json!({"kind": "run", "payload": {}})).map(|_| ())),
            "id"
        );
        assert_eq!(
            path_of(
                Envelope::from_value(json!({"id": "a b", "kind": "run", "payload": {}}))
                    .map(|_| ())
            ),
            "id"
        );
        assert_eq!(
            path_of(
                Envelope::from_value(json!({"id": "a", "kind": "nope", "payload": {}})).map(|_| ())
            ),
            "kind"
        );
        assert_eq!(
            path_of(
                Envelope::from_value(json!({"id": "a", "kind": "run", "payload": []})).map(|_| ())
            ),
            "payload"
        );
        let p = json!({"id": "a", "kind": "proposal", "payload": {"proposal_id": "p", "event": "edited"}});
        assert_eq!(
            path_of(Envelope::from_value(p).map(|_| ())),
            "payload.settings"
        );
    }
}
