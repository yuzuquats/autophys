//! FC-1: recorded output curves are data, never simulated by the store.
use super::*;

const MAX_POINTS: usize = 2000;
const MAX_CURVE_PAYLOAD: usize = 256 * 1024;

pub(super) fn shape(payload: &Value) -> Result<()> {
    let Some(curves) = payload.get("curves") else {
        return Ok(());
    };
    let Some(curves) = curves.as_object() else {
        return Err(Error::invalid("payload.curves", "must be an object"));
    };
    for (measurement, entry) in curves {
        let at = format!("payload.curves.{measurement}");
        check_id(&at, measurement)?;
        let Some(entry) = entry.as_object() else {
            return Err(Error::invalid(at, "must be an object"));
        };
        let mut expected = None;
        let mut array = |value: Option<&Value>, path: String| -> Result<()> {
            let n = finite_array(value, &path)?;
            if n > MAX_POINTS {
                return Err(Error::invalid(path, "at most 2000 curve points"));
            }
            if expected.is_some_and(|length| n != length) {
                return Err(Error::invalid(path, "curve arrays must have equal length"));
            }
            expected = Some(n);
            Ok(())
        };
        for label in ["fit", "initial"] {
            let path = format!("{at}.{label}");
            let channels = entry
                .get(label)
                .and_then(Value::as_object)
                .ok_or_else(|| Error::invalid(&path, "required object"))?;
            for (channel, values) in channels {
                array(Some(values), format!("{path}.{channel}"))?;
            }
        }
        if let Some(t) = entry.get("t") {
            array(Some(t), format!("{at}.t"))?;
        }
    }
    if crate::canonical(payload).len() > MAX_CURVE_PAYLOAD {
        return Err(Error::TooLarge(MAX_CURVE_PAYLOAD));
    }
    Ok(())
}
