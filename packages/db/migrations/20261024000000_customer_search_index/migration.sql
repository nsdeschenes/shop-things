CREATE VIRTUAL TABLE customers_search USING fts5(
  firstName,
  lastName,
  content='customers',
  content_rowid='id',
  tokenize='trigram'
);
--> statement-breakpoint
INSERT INTO customers_search(rowid, firstName, lastName)
  SELECT id, coalesce(firstName, ''), coalesce(lastName, '') FROM customers;
--> statement-breakpoint
CREATE TRIGGER customers_search_ai AFTER INSERT ON customers BEGIN
  INSERT INTO customers_search(rowid, firstName, lastName)
    VALUES (new.id, coalesce(new.firstName, ''), coalesce(new.lastName, ''));
END;
--> statement-breakpoint
CREATE TRIGGER customers_search_au AFTER UPDATE ON customers BEGIN
  INSERT INTO customers_search(customers_search, rowid, firstName, lastName)
    VALUES ('delete', old.id, coalesce(old.firstName, ''), coalesce(old.lastName, ''));
  INSERT INTO customers_search(rowid, firstName, lastName)
    VALUES (new.id, coalesce(new.firstName, ''), coalesce(new.lastName, ''));
END;
--> statement-breakpoint
CREATE TRIGGER customers_search_ad AFTER DELETE ON customers BEGIN
  INSERT INTO customers_search(customers_search, rowid, firstName, lastName)
    VALUES ('delete', old.id, coalesce(old.firstName, ''), coalesce(old.lastName, ''));
END;
