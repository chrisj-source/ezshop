-- A deleted vendor is hidden everywhere, including admin, but the row stays so
-- every part line that names it still reads the name. One ADD COLUMN per
-- statement (see CLAUDE.md, schema drift).
ALTER TABLE vendors ADD COLUMN deleted_at DATETIME NULL;
