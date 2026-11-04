SELECT device_code_sha256, device, client, expires FROM pairings
              WHERE user_code = ?1 AND state = 'pending' AND expires >= ?2
