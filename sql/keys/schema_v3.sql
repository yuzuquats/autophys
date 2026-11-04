-- An account that may read but not change anything (`autophys users set EMAIL --read-only`).
ALTER TABLE users ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
