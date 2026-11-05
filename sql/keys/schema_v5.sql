-- Identity, collection ownership and delegated access are separate from workbooks.
CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar_url TEXT);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE);
CREATE TABLE memberships (user_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
CREATE TABLE key_access (key_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, can_write INTEGER NOT NULL DEFAULT 0);
ALTER TABLE pairings ADD COLUMN owner_id TEXT;
ALTER TABLE pairings ADD COLUMN workspace_id TEXT;
UPDATE users SET read_only = 1 WHERE demo = 1;
CREATE TABLE workspace_seeds (workspace_id TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(workspace_id, version));
