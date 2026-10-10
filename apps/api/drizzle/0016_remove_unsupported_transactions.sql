DELETE FROM `transaction_request`
WHERE `tool_name` NOT IN ('solana_transfer', 'jupiter_swap');
