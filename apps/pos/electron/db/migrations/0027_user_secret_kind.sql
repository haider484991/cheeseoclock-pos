-- 0027_user_secret_kind.sql
-- A user signs in with a number PIN (4-12 digits) or a password (6-64
-- characters with at least one letter). The kind sits next to the hash:
--
--   * the Users page shows how each person signs in, and opens "change" on
--     the right kind (an argon2 hash cannot tell you);
--   * sign-in only checks the hashes of the kind that was typed (digits only
--     is a PIN, a password always has a letter), so a password does not wait
--     for every PIN user's argon2, and the reverse.
--
-- Like pin_hash, it never leaves this till (sync-core LOCAL_ONLY_COLUMNS):
-- the other till has the user but not their hash, and a kind that travelled
-- could say "password" on a till that holds a PIN hash, locking them out.
-- Both are only ever written together, by user-repo.
--
-- Every secret stored before this version is a 4-8 digit PIN, hence the default.
ALTER TABLE users ADD COLUMN secret_kind TEXT NOT NULL DEFAULT 'pin'
  CHECK (secret_kind IN ('pin', 'password'));
