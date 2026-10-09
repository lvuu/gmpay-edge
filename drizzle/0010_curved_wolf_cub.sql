CREATE TABLE `dhru_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gmpay_order_id` text NOT NULL,
	FOREIGN KEY (`gmpay_order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dhru_orders_gmpay_order_id_unique` ON `dhru_orders` (`gmpay_order_id`);