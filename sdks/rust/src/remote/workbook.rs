//! Workbook adapters; the public record and agent APIs do not change with transport.
use super::{Remote, decode, encode};
use crate::{workbook::StoredDisplay, *};
use serde_json::{Value, json};
use std::collections::BTreeMap;

impl Remote {
    /// `POST /investigations/{inv}/records`: the batch in one transaction.
    pub(crate) async fn append_batch(&self, inv: &str, records: &[BatchRecord]) -> Result<Vec<Appended>> {
        crate::workbook::check_batch(records)?;
        let (_, mut out) = self
            .json(
                "POST",
                &format!("/investigations/{}/records", encode(inv)),
                Some(&json!({"records": records})),
                None,
                self.timeout,
            )
            .await
            .map_err(|e| super::daemon_too_old(e, "batch record appends"))?;
        let bad = || Error::Io("invalid daemon batch response".into());
        let items = out["records"].as_array_mut().ok_or_else(bad)?;
        if items.len() != records.len() {
            return Err(bad());
        }
        let appended = items
            .iter_mut()
            .map(|item| {
                Ok(Appended {
                    record: decode(item["record"].take())?,
                    gseq: item["gseq"].as_i64().ok_or_else(bad)?,
                    created: item["created"].as_bool().ok_or_else(bad)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        if let Some(gseq) = appended.iter().map(|a| a.gseq).max() {
            self.see(inv, gseq);
        }
        Ok(appended)
    }

    pub(crate) async fn config_versions(&self, pid: &str) -> Result<Vec<ConfigVersion>> {
        decode(
            self.json(
                "GET",
                &format!("/projects/{}/config_versions", encode(pid)),
                None,
                None,
                self.timeout,
            ).await?
            .1["config_versions"]
                .take(),
        )
    }
    pub(crate) async fn put_config_version(
        &self,
        pid: &str,
        version: &str,
        bytes: &[u8],
    ) -> Result<bool> {
        let (status, _) = self.bytes(
            "PUT",
            &format!(
                "/projects/{}/config_versions/{}",
                encode(pid),
                encode(version)
            ),
            Some(bytes),
            "application/json",
            None,
            self.timeout,
        ).await?;
        Ok(status == 201)
    }
    /// Create an investigation in project `project_id`; returns its id.
    pub(crate) async fn create(
        &self,
        project_id: &str,
        mut meta: Value,
        id: Option<&str>,
    ) -> Result<(String, bool)> {
        if meta.is_null() {
            meta = json!({});
        }
        let m = meta
            .as_object_mut()
            .ok_or_else(|| Error::invalid("meta", "must be an object"))?;
        if m.get("project_id").is_none_or(Value::is_null) {
            m.insert("project_id".into(), json!(project_id));
        }
        if m["project_id"].as_str() != Some(project_id) {
            return Err(Error::NotFound("project"));
        }
        if m.get("overrides").is_none_or(Value::is_null) {
            m.insert("overrides".into(), json!({}));
        }
        let key = id
            .map(str::to_owned)
            .map(Ok)
            .unwrap_or_else(|| crate::workbook::random_hex(16))?;
        let body = json!({"project_id":meta["project_id"],"config_version":meta["config_version"],"overrides":meta["overrides"],"meta":meta});
        let (status, j) = self.json(
            "POST",
            "/investigations",
            Some(&body),
            Some(&key),
            self.timeout,
        ).await?;
        let inv = j["id"]
            .as_str()
            .ok_or_else(|| Error::Io("invalid investigation response".into()))?;
        if let Some(g) = j["gseq"].as_i64() {
            self.see(inv, g);
        }
        Ok((inv.to_owned(), status == 201))
    }
    pub(crate) async fn snapshot(&self, pid: &str) -> Result<Snapshot> {
        let (_, mut j) = self.json(
            "GET",
            &format!("/workspace?project={}", encode(pid)),
            None,
            None,
            self.timeout,
        ).await?;
        let project = j["projects"]
            .as_array_mut()
            .and_then(|a| a.first_mut())
            .ok_or(Error::NotFound("project"))?;
        let display = if project["display"].is_null() {
            None
        } else {
            let body = project["display"].take();
            Some(StoredDisplay {
                digest: sha256_hex([canonical(&body).as_bytes()]),
                body,
                created: 0.0,
            })
        };
        Ok(Snapshot {
            project: decode(project.clone())?,
            cursor: j["cursor"]
                .as_i64()
                .ok_or_else(|| Error::Io("invalid scoped cursor".into()))?,
            config_versions: decode(j["config_versions"].take())?,
            display,
            investigations: decode(j["investigations"].take())?,
            proposals: decode(j["proposals"].take())?,
            records: decode(j["records"].take())?,
        })
    }
    pub(crate) async fn put_display(&self, pid: &str, body: &[u8]) -> Result<(StoredDisplay, bool)> {
        let (status, j) = self.bytes(
            "PUT",
            &format!("/projects/{}/display", encode(pid)),
            Some(body),
            "application/json",
            None,
            self.timeout,
        ).await.map_err(|e| super::daemon_too_old(e, "display manifests"))?;
        Ok((
            StoredDisplay {
                digest: j["digest"]
                    .as_str()
                    .ok_or_else(|| Error::Io("invalid display response".into()))?
                    .into(),
                body: serde_json::from_slice(body)
                    .map_err(|_| Error::Io("invalid display JSON".into()))?,
                created: 0.0,
            },
            status == 201,
        ))
    }
    pub(crate) async fn put_blob(&self, pid: &str, data: &[u8], media_type: &str) -> Result<String> {
        if data.len() > 16 * 1024 * 1024 {
            return Err(Error::BadRequest("blob exceeds 16 MiB limit".into()));
        }
        if media_type.trim().is_empty() {
            return Err(Error::BadRequest("blob requires Content-Type".into()));
        }
        let hash = sha256_hex([data]);
        match self.bytes(
            "PUT",
            &format!("/projects/{}/blobs/{hash}", encode(pid)),
            Some(data),
            media_type,
            None,
            self.timeout,
        ).await {
            Ok(_) => Ok(format!("sha256:{hash}")),
            Err(Error::Http(e)) if e.status == 413 => {
                Err(Error::BadRequest("blob exceeds 16 MiB limit".into()))
            }
            Err(Error::Http(e)) if e.status == 422 => Err(Error::BadRequest(
                if e.error == "hash_mismatch" {
                    "blob hash mismatch"
                } else if e.path.as_deref() == Some("Content-Type") {
                    "blob requires Content-Type"
                } else {
                    "blob rejected (HTTP 422)"
                }
                .into(),
            )),
            Err(Error::Http(e)) => {
                Err(super::HttpError::new(e.status, "blob_upload_failed", "").into())
            }
            Err(e) => Err(e),
        }
    }
    pub(crate) async fn get_blob(&self, pid: &str, hash: &str) -> Result<(Vec<u8>, String)> {
        let hash = hash.strip_prefix("sha256:").unwrap_or(hash);
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(Error::BadRequest("invalid blob hash".into()));
        }
        let resp = match self.response(
            "GET",
            &format!("/projects/{}/blobs/{hash}", encode(pid)),
            None,
            "",
            None,
            self.timeout,
            false,
        ).await {
            Err(Error::Http(e)) => {
                return Err(super::HttpError::new(e.status, "blob_read_failed", "").into());
            }
            other => other?,
        };
        let media = resp
            .headers()
            .get("Content-Type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .into();
        let data = super::read_limited(resp, 16 * 1024 * 1024)
            .await
            .map_err(|_| Error::Io("cannot read daemon blob".into()))?;
        Ok((data, media))
    }
    /// Exact gseq values from scoped SSE, bounded by a snapshot's last record.
    pub(crate) async fn records_after(
        &self,
        pid: &str,
        after: i64,
        limit: i64,
        inv: Option<&str>,
    ) -> Result<Vec<Logged>> {
        if limit <= 0 {
            return Ok(vec![]);
        }
        let snap = self.snapshot(pid).await?;
        if snap.cursor <= after {
            return Ok(vec![]);
        }
        // The API returns record bodies without gseq. For each chain, read
        // the SSE backlog only up to the record in this bounded snapshot.
        let mut out = vec![];
        for i in snap
            .investigations
            .iter()
            .filter(|i| inv.is_none_or(|id| id == i.id))
        {
            let Some(last) = snap.records.iter().rev().find(|r| r.investigation == i.id) else {
                continue;
            };
            // No backlog can exist after the snapshot when this chain's
            // last record predates 'after'; its exact gseq is read via SSE
            // from zero so an empty selection cannot wait on a live tail.
            let mut backlog = self.backlog_stream(&i.id, 0).await?;
            while let Some(l) = backlog.next().await {
                let l = l?;
                let done = l.record.id == last.id;
                if l.gseq > after && l.gseq <= snap.cursor {
                    out.push(l);
                }
                if done {
                    break;
                }
            }
        }
        out.sort_by_key(|l| l.gseq);
        out.truncate(limit.try_into().unwrap_or(usize::MAX));
        // Internal scans can read beyond this page. Only delivered records
        // advance the public resume cursor.
        for l in &out {
            self.see(&l.record.investigation, l.gseq);
        }
        Ok(out)
    }
}

impl Workbook {
    pub(crate) fn remote_heads(&self) -> Result<BTreeMap<String, Head>> {
        let mut heads = BTreeMap::new();
        for r in self.snapshot()?.records {
            heads.insert(
                r.investigation,
                Head {
                    seq: r.seq,
                    hash: r.hash,
                },
            );
        }
        Ok(heads)
    }
    pub(crate) fn remote_projection_rows(&self) -> Result<Value> {
        let snap = self.snapshot()?;
        let mut conn = rusqlite::Connection::open_in_memory()?;
        crate::schema::migrate(&mut conn, "remote projections")?;
        for r in &snap.records {
            crate::records::insert(&conn, r, &canonical(&r.payload))?;
            crate::projections::apply(&conn, r)?;
        }
        crate::projections::rows(&conn)
    }
    pub(crate) fn remote_verify(&self) -> Result<VerifyReport> {
        let snap = self.snapshot()?;
        let mut conn = rusqlite::Connection::open_in_memory()?;
        crate::schema::migrate(&mut conn, "remote verification")?;
        // Metadata projections read records for usage; create a read-only
        // verification copy in memory. It never creates local workbook files.
        let mut heads: BTreeMap<String, (i64, String)> = BTreeMap::new();
        let mut errors = vec![];
        for r in &snap.records {
            let (seq, prev) = heads
                .get(&r.investigation)
                .cloned()
                .unwrap_or((-1, GENESIS.into()));
            if r.seq != seq + 1
                || r.prev_hash != prev
                || chain_hash(&prev, &r.id, &r.kind, &r.payload) != r.hash
            {
                errors.push(ChainError {
                    investigation: r.investigation.clone(),
                    seq: r.seq,
                    id: r.id.clone(),
                    problem: "seq, previous hash or content hash mismatch".into(),
                });
            }
            crate::records::insert(&conn, r, &canonical(&r.payload))?;
            crate::projections::apply(&conn, r)?;
            heads.insert(r.investigation.clone(), (r.seq, r.hash.clone()));
        }
        let mut invs = crate::projections::investigations(&conn)?;
        let mut actual = snap.investigations;
        invs.sort_by(|a, b| a.id.cmp(&b.id));
        actual.sort_by(|a, b| a.id.cmp(&b.id));
        let mut props = crate::projections::proposals(&conn, None)?;
        let mut expected = snap.proposals;
        props.sort_by(|a, b| {
            (&a.investigation, &a.proposal_id).cmp(&(&b.investigation, &b.proposal_id))
        });
        expected.sort_by(|a, b| {
            (&a.investigation, &a.proposal_id).cmp(&(&b.investigation, &b.proposal_id))
        });
        let projections_match = invs == actual && props == expected;
        Ok(VerifyReport {
            ok: errors.is_empty() && projections_match,
            records: snap.records.len(),
            investigations: heads.len(),
            chain_errors: errors,
            projections_match,
        })
    }
}
