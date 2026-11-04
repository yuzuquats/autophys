//! Display manifests travel beside configs, never in the record log.
use super::*;

pub(super) async fn put(
    _: Keyed,
    api: Data,
    pid: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let bytes = match body.to_bytes_limited(autophys::MAX_DISPLAY_BYTES).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => return Err(ApiError::bad_request(format!("reading the body: {e}"))),
        Err(_) => return Err(ApiError::too_large(autophys::MAX_DISPLAY_BYTES)),
    };
    let wb = workbook(&api, &pid).await?;
    let (display, changed) = blocking(move || Ok(wb.put_display(&bytes)?)).await?;
    if changed {
        api.woke(&pid);
    }
    Ok(created(
        changed,
        json!({"project_id": pid.as_str(), "digest": display.digest}),
    ))
}
