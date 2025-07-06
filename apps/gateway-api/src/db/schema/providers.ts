import { 
    pgTable,
    uuid,
    text,
    jsonb,
    timestamp,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/*
export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  type: text('type').notNull(),
  endpoint: text('endpoint'),
  description: text('description'),
  config: jsonb('config'),
  created_at: timestamp('created_at', { withTimezone: false, mode: 'string' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: false, mode: 'string' }).notNull().defaultNow(),
});
*/