ALTER TABLE customers ADD COLUMN revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE UNIQUE INDEX customers_customer_number_unique ON customers(customerNumber);
--> statement-breakpoint
CREATE TRIGGER customers_revision AFTER UPDATE ON customers
WHEN NEW.revision = OLD.revision
BEGIN
 UPDATE customers SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
