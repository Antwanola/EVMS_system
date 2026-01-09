-- Test query to check if idTag exists and its status
SELECT 
    it.id_tag as "idTag",
    it.status,
    it.expiry_date as "expiryDate",
    u.username,
    u.email,
    u.is_active as "isActive"
FROM id_tags it
LEFT JOIN users u ON it.id = u.id_tag_id
WHERE it.id_tag = '0816BD';

-- If no results, you can create the idTag with:
-- INSERT INTO id_tags (id, id_tag, status, created_at, updated_at) 
-- VALUES (gen_random_uuid(), '0816BD', 'ACCEPTED', NOW(), NOW());