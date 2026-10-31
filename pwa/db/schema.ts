import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  priceCents: integer('price_cents').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
  approvedAt: integer('approved_at'),
  approvedBy: text('approved_by'),
  bankReference: text('bank_reference'),
  rejectionReason: text('rejection_reason'),
}, table => [
  index('orders_email_created').on(table.email, table.createdAt),
  index('orders_status_created').on(table.status, table.createdAt),
  uniqueIndex('orders_bank_reference_unique').on(table.bankReference),
]);

export const licenses = sqliteTable('licenses', {
  tokenHash: text('token_hash').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  createdAt: integer('created_at').notNull(),
}, table => [index('licenses_order').on(table.orderId)]);
