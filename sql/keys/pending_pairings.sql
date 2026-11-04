SELECT user_code, device, client, expires FROM pairings
          WHERE state = 'pending' AND expires >= ?1 ORDER BY created, user_code
