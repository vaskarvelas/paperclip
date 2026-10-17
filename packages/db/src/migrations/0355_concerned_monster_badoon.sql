CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid,
	"agent_id" uuid NOT NULL,
	"kind" text DEFAULT 'result' NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"file_path" text,
	"inline_html" text,
	"external_url" text,
	"content_token" text NOT NULL,
	"lavish_enabled" boolean DEFAULT false NOT NULL,
	"lavish_session_url" text,
	"lavish_ended_at" timestamp with time zone,
	"lavish_ended_by" text,
	"lavish_last_polled_at" timestamp with time zone,
	"lavish_last_error" text,
	"created_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"source" text DEFAULT 'paperclip' NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb,
	"lavish_delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_messages" ADD CONSTRAINT "review_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_messages" ADD CONSTRAINT "review_messages_review_id_review_items_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."review_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_messages" ADD CONSTRAINT "review_messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_items_company_status_idx" ON "review_items" USING btree ("company_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_items_content_token_idx" ON "review_items" USING btree ("content_token");--> statement-breakpoint
CREATE INDEX "review_items_issue_idx" ON "review_items" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "review_messages_review_created_idx" ON "review_messages" USING btree ("review_id","created_at");