CREATE TABLE `customer_name_grams` (
	`gram` text NOT NULL,
	`customerId` integer NOT NULL,
	CONSTRAINT `customer_name_grams_pk` PRIMARY KEY(`gram`, `customerId`)
);
--> statement-breakpoint
CREATE TABLE `customer_name_positions` (
	`position` integer PRIMARY KEY
);
--> statement-breakpoint
CREATE INDEX customer_name_grams_customer_id ON customer_name_grams(customerId);

--> statement-breakpoint
INSERT INTO customer_name_positions (position) SELECT value FROM generate_series(1, 256);

--> statement-breakpoint
INSERT OR IGNORE INTO customer_name_grams (gram, customerId)
SELECT DISTINCT lower(substr(customers.firstName, position, 2)), customers.id
FROM customers CROSS JOIN customer_name_positions
WHERE position < length(customers.firstName) AND length(customers.firstName) <= 256
  AND length(CAST(customers.firstName AS BLOB)) = length(customers.firstName)
UNION
SELECT DISTINCT lower(substr(customers.lastName, position, 2)), customers.id
FROM customers CROSS JOIN customer_name_positions
WHERE position < length(customers.lastName) AND length(customers.lastName) <= 256
  AND length(CAST(customers.lastName AS BLOB)) = length(customers.lastName);
--> statement-breakpoint
INSERT OR IGNORE INTO customer_name_grams (gram, customerId)
SELECT '', customers.id FROM customers
WHERE length(customers.firstName) > 256 OR length(customers.lastName) > 256
   OR length(CAST(customers.firstName AS BLOB)) != length(customers.firstName)
   OR length(CAST(customers.lastName AS BLOB)) != length(customers.lastName);

--> statement-breakpoint
CREATE TRIGGER customer_name_insert AFTER INSERT ON customers BEGIN
INSERT OR IGNORE INTO customer_name_grams (gram, customerId)
SELECT DISTINCT lower(substr(NEW.firstName, position, 2)), NEW.id
FROM customer_name_positions
WHERE position < length(NEW.firstName) AND length(NEW.firstName) <= 256
  AND length(CAST(NEW.firstName AS BLOB)) = length(NEW.firstName)
UNION
SELECT DISTINCT lower(substr(NEW.lastName, position, 2)), NEW.id
FROM customer_name_positions
WHERE position < length(NEW.lastName) AND length(NEW.lastName) <= 256
  AND length(CAST(NEW.lastName AS BLOB)) = length(NEW.lastName);
INSERT OR IGNORE INTO customer_name_grams (gram, customerId)
SELECT '', NEW.id
WHERE length(NEW.firstName) > 256 OR length(NEW.lastName) > 256
   OR length(CAST(NEW.firstName AS BLOB)) != length(NEW.firstName)
   OR length(CAST(NEW.lastName AS BLOB)) != length(NEW.lastName);
END;

--> statement-breakpoint
CREATE TRIGGER customer_name_update AFTER UPDATE OF firstName, lastName, id ON customers BEGIN
DELETE FROM customer_name_grams WHERE customerId = OLD.id;
INSERT OR IGNORE INTO customer_name_grams (gram, customerId)
SELECT DISTINCT lower(substr(NEW.firstName, position, 2)), NEW.id
FROM customer_name_positions
WHERE position < length(NEW.firstName) AND length(NEW.firstName) <= 256
  AND length(CAST(NEW.firstName AS BLOB)) = length(NEW.firstName)
UNION
SELECT DISTINCT lower(substr(NEW.lastName, position, 2)), NEW.id
FROM customer_name_positions
WHERE position < length(NEW.lastName) AND length(NEW.lastName) <= 256
  AND length(CAST(NEW.lastName AS BLOB)) = length(NEW.lastName);
INSERT OR IGNORE INTO customer_name_grams (gram, customerId)
SELECT '', NEW.id
WHERE length(NEW.firstName) > 256 OR length(NEW.lastName) > 256
   OR length(CAST(NEW.firstName AS BLOB)) != length(NEW.firstName)
   OR length(CAST(NEW.lastName AS BLOB)) != length(NEW.lastName);
END;

--> statement-breakpoint
CREATE TRIGGER customer_name_delete AFTER DELETE ON customers BEGIN
DELETE FROM customer_name_grams WHERE customerId = OLD.id;
END;
