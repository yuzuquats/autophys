//! Server-owned profile, workspace and credential bindings. No browser chooses a path.
use crate::{
    accounts::User,
    error::{ApiError, Result},
    http::Caller,
    keys::KeyStore,
};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub read: bool,
    pub create_project: bool,
    pub start_investigation: bool,
    pub approve_proposal: bool,
    pub manage_devices: bool,
}
impl Capabilities {
    fn new(read: bool, write: bool) -> Self {
        Self {
            read,
            create_project: write,
            start_investigation: write,
            approve_proposal: write,
            manage_devices: write,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthOptions {
    pub can_sign_in: bool,
    pub can_sign_out: bool,
    pub allow_demo: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceRef {
    pub id: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct AppContext {
    pub principal: Option<Profile>,
    pub workspace: Option<WorkspaceRef>,
    pub capabilities: Capabilities,
    pub auth: AuthOptions,
}
pub(crate) struct Resolved {
    pub context: AppContext,
    pub root: PathBuf,
    pub owner: String,
    pub writable: bool,
}
fn disk_error(e: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(format!("workspace: {e}"))
}
fn canonical(path: &Path) -> Result<PathBuf> {
    std::fs::canonicalize(path).map_err(disk_error)
}

impl KeyStore {
    pub fn provision_workspace(&self, user: &User) -> Result<()> {
        let root = self
            .path()
            .parent()
            .unwrap_or(Path::new("."))
            .join("workspaces")
            .join(&user.id);
        std::fs::create_dir_all(&root).map_err(disk_error)?;
        let root = canonical(&root)?;
        let id = format!("ws_{}", user.id);
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO workspaces (id, root) VALUES (?1, ?2)",
            params![id, root.to_string_lossy()],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO memberships (user_id, workspace_id) VALUES (?1, ?2)",
            params![user.id, id],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn profile(&self, id: &str, email: Option<&str>) -> Result<Profile> {
        let fallback = email
            .and_then(|e| e.split('@').next())
            .map(str::to_owned)
            .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "You".into()));
        let conn = self.conn()?;
        conn.execute(
            "INSERT OR IGNORE INTO profiles (id, display_name) VALUES (?1, ?2)",
            params![id, fallback],
        )?;
        Ok(conn.query_row(
            "SELECT display_name, avatar_url FROM profiles WHERE id = ?1",
            [id],
            |r| {
                Ok(Profile {
                    id: id.into(),
                    display_name: r.get(0)?,
                    avatar_url: r.get(1)?,
                    email: email.map(str::to_owned),
                })
            },
        )?)
    }

    pub fn anonymous_context(&self) -> Result<AppContext> {
        Ok(AppContext {
            principal: None,
            workspace: None,
            capabilities: Capabilities::new(false, false),
            auth: AuthOptions {
                can_sign_in: self.options().login,
                can_sign_out: false,
                allow_demo: self.options().login && self.users_demo()?.is_some(),
            },
        })
    }

    pub(crate) fn resolve_workspace(&self, caller: &Caller, local_root: &Path) -> Result<Resolved> {
        let (owner, email, writable, binding) = match caller {
            Caller::Browser => ("local".to_string(), None, true, None),
            Caller::Member(user) => (
                user.id.clone(),
                Some(user.email.clone()),
                !user.read_only && !user.demo,
                None,
            ),
            Caller::Key(key) => {
                let binding: Option<(String, String, bool)> = self.conn()?.query_row(
                    "SELECT owner_id, workspace_id, can_write FROM key_access WHERE key_id = ?1", [&key.id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                ).optional()?;
                match binding {
                    Some((owner, workspace, grant))
                        if owner == "local" && !self.options().login =>
                    {
                        (owner, None, grant, Some(workspace))
                    }
                    Some((owner, workspace, grant)) if owner != "local" => {
                        let user = self
                            .users_list()?
                            .into_iter()
                            .find(|u| u.id == owner && u.active)
                            .ok_or(ApiError::Unauthorized)?;
                        (
                            owner,
                            Some(user.email),
                            grant && !user.read_only && !user.demo,
                            Some(workspace),
                        )
                    }
                    None if !self.options().login => ("local".to_string(), None, true, None),
                    _ => {
                        return Err(ApiError::Forbidden(
                            "This key needs an explicit workspace binding.".into(),
                        ));
                    }
                }
            }
        };
        let (workspace, root) = if owner == "local" {
            std::fs::create_dir_all(local_root).map_err(disk_error)?;
            let root = canonical(local_root)?;
            let conn = self.conn()?;
            conn.execute(
                "INSERT OR IGNORE INTO workspaces (id, root) VALUES ('local', ?1)",
                [root.to_string_lossy().as_ref()],
            )?;
            let registered: String =
                conn.query_row("SELECT root FROM workspaces WHERE id = 'local'", [], |r| {
                    r.get(0)
                })?;
            if Path::new(&registered) != root || binding.as_deref().is_some_and(|b| b != "local") {
                return Err(ApiError::Forbidden("Local collection differs from its registered workspace. Use a separate server database.".into()));
            }
            ("local".to_string(), root)
        } else {
            let row: Option<(String, String)> = self.conn()?.query_row(
                "SELECT w.id, w.root FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ?1",
                [&owner], |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional()?;
            let (id, root) = row.ok_or_else(|| {
                ApiError::Forbidden(
                    "This account needs a workspace assignment. Contact the operator.".into(),
                )
            })?;
            if binding.as_ref().is_some_and(|b| b != &id) {
                return Err(ApiError::Forbidden(
                    "The key's workspace assignment has changed.".into(),
                ));
            }
            let path = canonical(Path::new(&root))?;
            if path != Path::new(&root) {
                return Err(ApiError::Forbidden(
                    "Workspace path changed; operator review is required.".into(),
                ));
            }
            (id, path)
        };
        let profile = self.profile(&owner, email.as_deref())?;
        Ok(Resolved {
            context: AppContext {
                principal: Some(profile),
                workspace: Some(WorkspaceRef { id: workspace }),
                capabilities: Capabilities::new(true, writable),
                auth: AuthOptions {
                    can_sign_in: false,
                    can_sign_out: self.options().login && !matches!(caller, Caller::Key(_)),
                    allow_demo: false,
                },
            },
            root,
            owner,
            writable,
        })
    }

    pub(crate) fn scoped_pair_decide(
        &self,
        code: &str,
        approve: bool,
        owner: &str,
        workspace: &str,
    ) -> Result<crate::keys::Pairing> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let pair = crate::keys::pair_decide(&tx, code, approve, chrono::Utc::now())?;
        tx.execute("UPDATE pairings SET owner_id = ?1, workspace_id = ?2 WHERE user_code = ?3 AND state IN ('approved','denied')", params![owner, workspace, pair.user_code])?;
        tx.commit()?;
        Ok(pair)
    }

    pub(crate) fn scoped_pairings(
        &self,
        owner: &str,
        code: Option<&str>,
    ) -> Result<Vec<crate::keys::Pairing>> {
        if !self.options().login {
            return self.pairings_pending();
        }
        // Pending device flows have no owner until approved. In cloud mode a
        // person must supply the exact code; never enumerate strangers' devices.
        let Some(code) = code else {
            return Ok(vec![]);
        };
        let code = crate::keys::normalize_user_code(code);
        let conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT user_code, device, client, expires FROM pairings WHERE user_code = ?1 AND state = 'pending' AND expires >= ?2 AND (owner_id IS NULL OR owner_id = ?3)")?;
        let rows = stmt.query_map(
            params![code, crate::keys::now_text(chrono::Utc::now()), owner],
            |r| {
                Ok(crate::keys::Pairing {
                    user_code: r.get(0)?,
                    device_name: r.get(1)?,
                    client: r.get(2)?,
                    expires: r.get(3)?,
                })
            },
        )?;
        rows.map(|r| r.map_err(ApiError::from)).collect()
    }

    /// An inspectable migration report. No credentials or account tokens.
    pub fn workspace_inventory(&self) -> Result<Value> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT u.email, u.id, m.workspace_id, w.root FROM users u LEFT JOIN memberships m ON m.user_id = u.id LEFT JOIN workspaces w ON w.id = m.workspace_id ORDER BY u.email")?;
        let users = stmt.query_map([], |r| Ok(json!({"email":r.get::<_,String>(0)?,"id":r.get::<_,String>(1)?,"workspace":r.get::<_,Option<String>>(2)?,"collection":r.get::<_,Option<String>>(3)?})))?.collect::<std::result::Result<Vec<_>, _>>()?;
        let mut stmt = conn.prepare("SELECT k.id, k.device, a.owner_id, a.workspace_id, a.can_write FROM keys k LEFT JOIN key_access a ON a.key_id = k.id WHERE k.revoked IS NULL ORDER BY k.id")?;
        let keys = stmt.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"device":r.get::<_,String>(1)?,"owner":r.get::<_,Option<String>>(2)?,"workspace":r.get::<_,Option<String>>(3)?,"can_write":r.get::<_,Option<bool>>(4)?})))?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(json!({"accounts": users, "keys":keys}))
    }

    pub fn bind_workspace(&self, email: &str, collection: &Path, apply: bool) -> Result<Value> {
        let user = self
            .users_list()?
            .into_iter()
            .find(|u| u.email == email.trim().to_lowercase())
            .ok_or_else(|| ApiError::not_found("account"))?;
        let root = canonical(collection)?;
        if !root.is_dir() {
            return Err(ApiError::bad_request(
                "A workspace must be a collection directory.",
            ));
        }
        let client = autophys::connect(root.to_str())?;
        let mut projects = Vec::new();
        for path in client.paths()? {
            let workbook = rusqlite::Connection::open_with_flags(
                &path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let mut stmt = workbook.prepare("SELECT id, name FROM projects ORDER BY id")?;
            for row in stmt.query_map([], |r| {
                Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?}))
            })? {
                projects.push(row?);
            }
        }
        let id = format!("ws_{}", user.id);
        let mut conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT id, root FROM workspaces")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (existing_id, existing_root) = row?;
            let other = Path::new(&existing_root);
            if existing_id != id && (root.starts_with(other) || other.starts_with(&root)) {
                return Err(ApiError::bad_request(
                    "Collection overlaps another registered workspace.",
                ));
            }
        }
        drop(stmt);
        let previous: Option<String> = conn
            .query_row("SELECT root FROM workspaces WHERE id = ?1", [&id], |r| {
                r.get(0)
            })
            .optional()?;
        let mut report = json!({"apply":apply,"account":user.email,"workspace":id,"collection":root,"previous_collection":previous,"projects":projects,"credentials":"Keys require an explicit workspace key binding; membership changes revoke prior delegated keys and sessions."});
        if apply {
            let backup = self
                .path()
                .with_extension(format!("mapping-{}.backup", crate::keys::random_hex(8)?));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(&backup).map_err(disk_error)?;
            drop(file);
            let mut recovery = rusqlite::Connection::open(&backup)?;
            rusqlite::backup::Backup::new(&conn, &mut recovery)?.run_to_completion(
                128,
                std::time::Duration::from_millis(10),
                None,
            )?;
            report["server_database_backup"] = json!(backup);
            let tx = conn.transaction()?;
            if previous.as_deref() != root.to_str() {
                tx.execute("DELETE FROM sessions WHERE user_id = ?1", [&user.id])?;
                tx.execute("UPDATE keys SET revoked = ?1 WHERE id IN (SELECT key_id FROM key_access WHERE owner_id = ?2)", params![crate::keys::now_text(chrono::Utc::now()),user.id])?;
            }
            tx.execute("INSERT INTO workspaces (id, root) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET root = excluded.root", params![id,root.to_string_lossy()])?;
            tx.execute("INSERT INTO memberships (user_id, workspace_id) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET workspace_id = excluded.workspace_id", params![user.id,id])?;
            tx.commit()?;
        }
        Ok(report)
    }

    pub fn bind_key(&self, key: &str, account: &str, write: bool, apply: bool) -> Result<Value> {
        let (owner, workspace) = if account == "local" {
            ("local".to_string(), "local".to_string())
        } else {
            let user = self
                .users_list()?
                .into_iter()
                .find(|u| u.email == account.trim().to_lowercase())
                .ok_or_else(|| ApiError::not_found("account"))?;
            if write && (user.read_only || user.demo) {
                return Err(ApiError::Forbidden("This account is read-only.".into()));
            }
            let workspace: String = self
                .conn()?
                .query_row(
                    "SELECT workspace_id FROM memberships WHERE user_id = ?1",
                    [&user.id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| ApiError::bad_request("Assign the account's workspace first."))?;
            (user.id, workspace)
        };
        let conn = self.conn()?;
        if !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM keys WHERE id = ?1 AND revoked IS NULL)",
            [key],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(ApiError::not_found("live key"));
        }
        if apply {
            conn.execute("INSERT INTO key_access (key_id, owner_id, workspace_id, can_write) VALUES (?1,?2,?3,?4) ON CONFLICT(key_id) DO UPDATE SET owner_id=excluded.owner_id,workspace_id=excluded.workspace_id,can_write=excluded.can_write", params![key,owner,workspace,write])?;
        }
        Ok(
            json!({"apply":apply,"key_id":key,"owner":owner,"workspace":workspace,"can_write":write}),
        )
    }

    /// Import a versioned server-side seed into an empty demo workspace. SQLite
    /// backup includes live WAL pages; no browser fixture or numeric data is embedded.
    pub fn seed_workspace(
        &self,
        email: &str,
        source: &Path,
        version: &str,
        apply: bool,
    ) -> Result<Value> {
        if version.is_empty()
            || !version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(ApiError::bad_request(
                "Seed version must use letters, numbers, dash or underscore.",
            ));
        }
        let user = self
            .users_list()?
            .into_iter()
            .find(|u| u.email == email.trim().to_lowercase() && u.demo && u.read_only)
            .ok_or_else(|| {
                ApiError::bad_request("Seed imports require the configured read-only demo account.")
            })?;
        let (workspace, root): (String,String) = self.conn()?.query_row("SELECT w.id,w.root FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ?1", [&user.id], |r| Ok((r.get(0)?,r.get(1)?)))?;
        let already: bool = self.conn()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_seeds WHERE workspace_id = ?1 AND version = ?2)",
            params![workspace, version],
            |r| r.get(0),
        )?;
        if already {
            return Ok(
                json!({"applied":false,"already_applied":true,"workspace":workspace,"version":version}),
            );
        }
        let target = canonical(Path::new(&root))?;
        let source = canonical(source)?;
        if target.starts_with(&source) || source.starts_with(&target) {
            return Err(ApiError::bad_request(
                "Seed source and target must be separate collections.",
            ));
        }
        if std::fs::read_dir(&target)
            .map_err(disk_error)?
            .next()
            .is_some()
        {
            return Err(ApiError::bad_request(
                "Seed target must be empty. Resetting or replacing recorded data requires a separate explicit operation.",
            ));
        }
        let mut files = Vec::new();
        for entry in std::fs::read_dir(&source).map_err(disk_error)? {
            let entry = entry.map_err(disk_error)?;
            if entry.file_type().map_err(disk_error)?.is_file()
                && entry.path().extension().is_some_and(|e| e == "ap-workbook")
            {
                files.push(entry.path());
            }
        }
        files.sort();
        if files.is_empty() {
            return Err(ApiError::bad_request(
                "Seed source contains no workbook files.",
            ));
        }
        if apply {
            let stage = target.with_file_name(format!(".seed-{}", crate::keys::random_hex(8)?));
            std::fs::create_dir(&stage).map_err(disk_error)?;
            for path in &files {
                let src = rusqlite::Connection::open_with_flags(
                    path,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )?;
                let mut dst = rusqlite::Connection::open(stage.join(path.file_name().unwrap()))?;
                rusqlite::backup::Backup::new(&src, &mut dst)?.run_to_completion(
                    128,
                    std::time::Duration::from_millis(10),
                    None,
                )?;
            }
            // Rename replaces only an empty directory. Failure retains the stage
            // for inspection; it never deletes or overwrites existing records.
            std::fs::rename(&stage, &target).map_err(disk_error)?;
            self.conn()?.execute(
                "INSERT INTO workspace_seeds (workspace_id, version) VALUES (?1,?2)",
                params![workspace, version],
            )?;
        }
        Ok(
            json!({"apply":apply,"workspace":workspace,"version":version,"source":source,"collection":target,"workbooks":files.len()}),
        )
    }

    pub fn set_profile(
        &self,
        account: &str,
        name: &str,
        avatar: Option<&str>,
        apply: bool,
    ) -> Result<Value> {
        if name.trim().is_empty() || name.chars().count() > 100 {
            return Err(ApiError::bad_request(
                "Profile name must have 1–100 characters.",
            ));
        }
        if let Some(url) = avatar.filter(|s| !s.is_empty()) {
            let same_origin =
                url.starts_with('/') && !url.starts_with("//") && !url.starts_with("/\\");
            let https = url.starts_with("https://")
                && url[8..]
                    .split('/')
                    .next()
                    .is_some_and(|host| !host.is_empty() && !host.contains('@'));
            if (!same_origin && !https)
                || url
                    .chars()
                    .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
            {
                return Err(ApiError::bad_request(
                    "Avatar must be an HTTPS or same-origin image URL.",
                ));
            }
        }
        let id = if account == "local" {
            "local".to_string()
        } else {
            self.users_list()?
                .into_iter()
                .find(|u| u.email == account.trim().to_lowercase())
                .ok_or_else(|| ApiError::not_found("account"))?
                .id
        };
        if apply {
            self.conn()?.execute("INSERT INTO profiles (id,display_name,avatar_url) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,avatar_url=excluded.avatar_url", params![id,name.trim(),avatar.filter(|s| !s.is_empty())])?;
        }
        Ok(json!({"apply":apply,"profile_id":id,"display_name":name.trim(),"avatar_url":avatar}))
    }
}

/// Dry-run by default; only --apply writes mapping/profile changes.
pub fn admin(args: Vec<String>) -> Result<Value> {
    let mut words = Vec::new();
    let mut db = None;
    let mut collection = None;
    let mut name = None;
    let mut source = None;
    let mut version = None;
    let mut avatar = None;
    let mut apply = false;
    let mut write = false;
    let mut it = args.into_iter();
    while let Some(word) = it.next() {
        match word.as_str() {
            "--apply" => apply = true,
            "--write" => write = true,
            "--server-db" | "--collection" | "--name" | "--avatar" | "--from" | "--version" => {
                let value = it
                    .next()
                    .ok_or_else(|| ApiError::bad_request(format!("{word} needs a value")))?;
                match word.as_str() {
                    "--server-db" => db = Some(PathBuf::from(value)),
                    "--collection" => collection = Some(PathBuf::from(value)),
                    "--name" => name = Some(value),
                    "--from" => source = Some(PathBuf::from(value)),
                    "--version" => version = Some(value),
                    _ => avatar = Some(value),
                }
            }
            _ if word.starts_with('-') => {
                return Err(ApiError::bad_request(format!("Unknown flag {word}")));
            }
            _ => words.push(word),
        }
    }
    let db = db
        .or_else(|| std::env::var_os("AUTOPHYS_SERVER_DB").map(PathBuf::from))
        .map(Ok)
        .unwrap_or_else(|| crate::default_server_db().map_err(disk_error))?;
    let keys = KeyStore::open(db)?;
    match words
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["list"] => keys.workspace_inventory(),
        ["bind", email] => keys.bind_workspace(
            email,
            &collection.ok_or_else(|| ApiError::bad_request("--collection is required"))?,
            apply,
        ),
        ["key", key, email] => keys.bind_key(key, email, write, apply),
        ["seed", email] => keys.seed_workspace(
            email,
            &source.ok_or_else(|| ApiError::bad_request("--from is required"))?,
            &version.ok_or_else(|| ApiError::bad_request("--version is required"))?,
            apply,
        ),
        ["profile", account] => keys.set_profile(
            account,
            &name.ok_or_else(|| ApiError::bad_request("--name is required"))?,
            avatar.as_deref(),
            apply,
        ),
        _ => Err(ApiError::bad_request(
            "workspace list | bind EMAIL --collection DIR | key KEY_ID EMAIL [--write] | profile local/EMAIL --name NAME [--avatar URL] | seed EMAIL --from DIR --version V; --server-db FILE; dry-run unless --apply",
        )),
    }
}
