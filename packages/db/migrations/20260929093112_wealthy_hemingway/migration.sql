CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`customerNumber` integer,
	`firstName` text,
	`lastName` text,
	`address` text,
	`city` text,
	`province` text,
	`postalCode` text,
	`homePhone` text,
	`email` text,
	`stock` integer DEFAULT 0,
	`balance` real DEFAULT 0,
	`previousBalance` real DEFAULT 0,
	`donate` integer,
	`comments` text
);
