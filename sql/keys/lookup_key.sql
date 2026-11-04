SELECT id, device, created, last_used, revoked FROM keys
              WHERE sha256 = ?1 AND revoked IS NULL
