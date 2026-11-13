//! Project overviews (OV-5): one Markdown note per project, kept as an
//! append-only history in the project's workbook (format 3).
use super::*;

/// A body may escape every character of the largest overview as `\uXXXX`
/// (six bytes each); the workbook refuses anything over
/// [`autophys::MAX_OVERVIEW_BYTES`] once decoded.
const OVERVIEW_BODY_LIMIT: usize = 6 * autophys::MAX_OVERVIEW_BYTES + 64 * 1024;

fn text(v: &Value, key: &str, message: &str) -> Result<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ApiError::invalid(key, message))
}

/// `PUT /projects/{pid}/overview` with `{"markdown", "author"}`: 201 with the
/// new version, or 200 when the body's digest is already the latest.
/// Unknown investigations and insert attributes come back as `warnings`.
pub(super) async fn put(
    _: Keyed,
    api: Data,
    pid: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let bytes = match body.to_bytes_limited(OVERVIEW_BODY_LIMIT).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => return Err(ApiError::bad_request(format!("reading the body: {e}"))),
        Err(_) => return Err(ApiError::too_large(autophys::MAX_OVERVIEW_BYTES)),
    };
    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::bad_request(format!("the body is not JSON: {e}")))?;
    let markdown = text(&v, "markdown", "required non-empty Markdown")?;
    let author = text(&v, "author", "required string of 1 to 200 characters")?;
    let wb = workbook(&api, &pid).await?;
    let (stored, changed, warnings) =
        blocking(move || Ok(wb.put_overview(&markdown, &author)?)).await?;
    if changed {
        api.woke(&pid);
    }
    Ok(created(
        changed,
        json!({
            "project_id": pid.as_str(),
            "overview": meta(&stored),
            "changed": changed,
            "warnings": warnings,
        }),
    ))
}

/// `GET /projects/{pid}/overview/versions`: every version, oldest first.
pub(super) async fn versions(_: Keyed, api: Data, pid: web::Path<String>) -> Result<HttpResponse> {
    let wb = workbook(&api, &pid).await?;
    let versions = blocking(move || Ok(wb.overview_versions()?)).await?;
    Ok(ok(json!({ "versions": versions })))
}

/// A version without its Markdown: `overview_meta` in `/workspace`, and a
/// write's `overview`.
pub(super) fn meta(o: &autophys::StoredOverview) -> Value {
    json!({"seq": o.seq, "digest": o.digest, "author": o.author, "created": o.created})
}
