ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '';

UPDATE users
   SET name = substr(email, 1, instr(email, '@') - 1)
 WHERE name = '';
