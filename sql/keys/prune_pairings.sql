DELETE FROM pairings WHERE expires < ?1 OR state IN ('denied', 'issued')
