-- The demo account: anyone may continue as it from the sign-in page, without a password
-- (`autophys users set EMAIL --demo`). At most one; it never has a password.
ALTER TABLE users ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
