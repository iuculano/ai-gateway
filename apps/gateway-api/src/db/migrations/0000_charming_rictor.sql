CREATE TABLE "logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"response_time_ms" integer,
	"cost" numeric(10, 4) DEFAULT '0' NOT NULL,
	"tags" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"cost_input" numeric(10, 4) DEFAULT '0' NOT NULL,
	"cost_output" numeric(10, 4) DEFAULT '0' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"tags" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_check" CHECK ("models"."provider" IN ('openai', 'anthropic', 'azure', 'local'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
