CREATE TABLE keys (
      id        TEXT PRIMARY KEY,
      device    TEXT NOT NULL,
      sha256    TEXT NOT NULL UNIQUE,         -- never the key itself
      created   TEXT NOT NULL,
      last_used TEXT,
      revoked   TEXT
    );
    CREATE TABLE pairings (
      device_code_sha256 TEXT PRIMARY KEY,    -- never the device code itself
      user_code    TEXT NOT NULL,
      device       TEXT NOT NULL,
      client       TEXT NOT NULL,
      state        TEXT NOT NULL,             -- pending | approved | denied | issued
      created      TEXT NOT NULL,
      expires      TEXT NOT NULL,
      last_poll_ms INTEGER,
      key_id       TEXT
    );
    CREATE UNIQUE INDEX pairings_open_user_code ON pairings(user_code)
      WHERE state IN ('pending', 'approved');
