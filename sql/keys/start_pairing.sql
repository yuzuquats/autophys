INSERT INTO pairings
               (device_code_sha256, user_code, device, client, state, created, expires)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)
