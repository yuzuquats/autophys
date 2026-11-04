-- People who sign in to the browser app when `serve --login` is on.
CREATE TABLE users (
      id             TEXT PRIMARY KEY,
      email          TEXT NOT NULL UNIQUE,  -- lowercased
      password       TEXT,                  -- argon2id PHC string; NULL until an invite is accepted
      created        TEXT NOT NULL,
      invite_sha256  TEXT UNIQUE,           -- never the invite token itself
      invite_expires TEXT
    );
    CREATE TABLE sessions (
      sha256   TEXT PRIMARY KEY,            -- never the session token itself
      user_id  TEXT NOT NULL,
      created  TEXT NOT NULL,
      expires  TEXT NOT NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);
