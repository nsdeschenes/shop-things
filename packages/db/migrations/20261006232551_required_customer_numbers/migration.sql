CREATE TABLE `__new_customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`customerNumber` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`firstName` text,
	`lastName` text,
	`address` text,
	`city` text,
	`province` text,
	`postalCode` text,
	`phone` text,
	`email` text,
	`stock` integer DEFAULT 0,
	`balance` real DEFAULT 0,
	`previousBalance` real DEFAULT 0,
	`donate` integer,
	`comments` text,
	CONSTRAINT "customers_customer_number_valid" CHECK(typeof("customerNumber") = 'integer' and "customerNumber" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE __customer_sequence (seq integer);
--> statement-breakpoint
INSERT INTO __customer_sequence SELECT seq FROM sqlite_sequence WHERE name = 'customers';
--> statement-breakpoint
WITH candidates AS (
 SELECT row_number() OVER (ORDER BY id) AS number FROM customers
 UNION ALL SELECT count(*) + 1 FROM customers
), available AS (
 SELECT number, row_number() OVER (ORDER BY number) AS position FROM candidates
 WHERE number NOT IN (SELECT customerNumber FROM customers WHERE customerNumber IS NOT NULL)
), missing AS (
 SELECT id, row_number() OVER (ORDER BY id) AS position FROM customers WHERE customerNumber IS NULL
)
INSERT INTO `__new_customers`(`id`, `customerNumber`, `revision`, `firstName`, `lastName`, `address`, `city`, `province`, `postalCode`, `phone`, `email`, `stock`, `balance`, `previousBalance`, `donate`, `comments`) SELECT `id`, coalesce(`customerNumber`, (SELECT available.number FROM available JOIN missing USING (position) WHERE missing.id = customers.id)), `revision` + CASE WHEN customerNumber IS NULL THEN 1 ELSE 0 END, `firstName`, `lastName`, `address`, `city`, `province`, `postalCode`, `phone`, `email`, `stock`, `balance`, `previousBalance`, `donate`, `comments` FROM `customers`;--> statement-breakpoint
DROP TABLE `customers`;--> statement-breakpoint
ALTER TABLE `__new_customers` RENAME TO `customers`;--> statement-breakpoint
UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM __customer_sequence), 0)) WHERE name = 'customers';
--> statement-breakpoint
DROP TABLE __customer_sequence;
--> statement-breakpoint
CREATE TRIGGER customers_revision AFTER UPDATE ON customers
WHEN NEW.revision = OLD.revision
BEGIN
 UPDATE customers SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_customer_number_unique` ON `customers` (`customerNumber`);