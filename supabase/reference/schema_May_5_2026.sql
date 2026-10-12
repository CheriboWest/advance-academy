


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.users (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_auth_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_bullets"("query_embedding" "public"."vector", "match_user_id" "uuid", "match_threshold" double precision, "match_count" integer) RETURNS TABLE("id" "uuid", "bullet_text" "text", "section_path" "text", "similarity" double precision, "gap_count" integer, "answered_gap_count" integer)
    LANGUAGE "sql" STABLE
    AS $$
  select
    b.id,
    b.bullet_text,
    b.section_path,
    1 - (b.bullet_embedding <=> query_embedding) as similarity,
    coalesce(g.total, 0)::int as gap_count,
    coalesce(g.answered, 0)::int as answered_gap_count
  from cv_bullets b
  left join lateral (
    select
      count(*)::int as total,
      count(*) filter (where status = 'answered')::int as answered
    from bullet_gaps
    where bullet_id = b.id
  ) g on true
  where b.user_id = match_user_id
    and b.bullet_embedding is not null
    and 1 - (b.bullet_embedding <=> query_embedding) >= match_threshold
  order by b.bullet_embedding <=> query_embedding asc
  limit match_count;
$$;


ALTER FUNCTION "public"."match_bullets"("query_embedding" "public"."vector", "match_user_id" "uuid", "match_threshold" double precision, "match_count" integer) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."answer_assessments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "question_id" "uuid" NOT NULL,
    "transcript_turn_id" "uuid",
    "candidate_answer" "text",
    "integrity_score" numeric NOT NULL,
    "relevance_score" numeric NOT NULL,
    "substance_score" numeric NOT NULL,
    "overall_score" numeric NOT NULL,
    "rationale_json" "jsonb",
    "evidence_json" "jsonb",
    "missing_signals_json" "jsonb",
    "confidence" numeric DEFAULT 1.0,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."answer_assessments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."answer_coaching" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "assessment_id" "uuid" NOT NULL,
    "original_answer" "text",
    "critique_json" "jsonb",
    "improved_answer" "text",
    "best_sample_answer" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."answer_coaching" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bullet_artifacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "gap_id" "uuid" NOT NULL,
    "source_type" "text" NOT NULL,
    "content_text" "text",
    "source_url" "text",
    "source_file_path" "text",
    "summary_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bullet_artifacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bullet_gaps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bullet_id" "uuid" NOT NULL,
    "question" "text" NOT NULL,
    "rationale" "text",
    "ordinal" integer NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bullet_gaps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."candidate_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "full_name" "text",
    "headline" "text",
    "summary" "text",
    "parsed_cv_json" "jsonb",
    "cv_file_path" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."candidate_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coach_understanding_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "report_md" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."coach_understanding_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."companies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "canonical_domain" "text",
    "website_url" "text",
    "linkedin_url" "text",
    "description" "text",
    "industry" "text",
    "company_size" "text",
    "headquarters" "text",
    "research_status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."companies" OWNER TO "postgres";


-- NOTE: This table post-dates the original dump — it was added by migration 008 after
-- this file was generated, so it was missing from this reference entirely. (The Critical
-- RLS alert actually named cv_analysis_jobs, but this table has the same exposure shape
-- and is fixed by the same 011 sweep.) The shape,
-- constraints, RLS, read policy and grants below mirror 008_company_additional_urls.sql
-- (kept as one adjacent block rather than fragmented across the dump's sections, so this
-- reference stays self-contained). The ≤30-URLs-per-company enforcement trigger
-- (enforce_company_additional_url_limit) is NOT reproduced here — see migration 008 for it.
-- RLS + read policy are reasserted by 011_rls_hardening_sweep.sql.
CREATE TABLE IF NOT EXISTS "public"."company_additional_url" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" NOT NULL,
    "url" "text" NOT NULL,
    "ordinal" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "company_additional_url_unique_per_company" UNIQUE ("company_id", "url"),
    CONSTRAINT "company_additional_url_url_length" CHECK (("char_length"("url") <= 2048)),
    CONSTRAINT "company_additional_url_url_scheme" CHECK (("url" ~* '^https?://'::"text"))
);


ALTER TABLE "public"."company_additional_url" OWNER TO "postgres";


ALTER TABLE ONLY "public"."company_additional_url"
    ADD CONSTRAINT "company_additional_url_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."company_additional_url"
    ADD CONSTRAINT "company_additional_url_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


CREATE INDEX "idx_company_additional_url_company" ON "public"."company_additional_url" USING "btree" ("company_id");


ALTER TABLE "public"."company_additional_url" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "Anyone can read company additional URLs" ON "public"."company_additional_url" FOR SELECT USING (true);


GRANT ALL ON TABLE "public"."company_additional_url" TO "anon";
GRANT ALL ON TABLE "public"."company_additional_url" TO "authenticated";
GRANT ALL ON TABLE "public"."company_additional_url" TO "service_role";


CREATE TABLE IF NOT EXISTS "public"."company_research_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" NOT NULL,
    "source_inputs_json" "jsonb",
    "summary_json" "jsonb",
    "recent_activity_json" "jsonb",
    "products_services_json" "jsonb",
    "raw_sources_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."company_research_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cv_analysis_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "status" "text" NOT NULL,
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "result_json" "jsonb",
    "error_json" "jsonb",
    CONSTRAINT "cv_analysis_jobs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."cv_analysis_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cv_bullets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cv_version_id" "uuid",
    "section_path" "text",
    "bullet_text" "text" NOT NULL,
    "ordinal" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "bullet_embedding" "public"."vector"(1024)
);


ALTER TABLE "public"."cv_bullets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cv_version_bullets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cv_version_id" "uuid" NOT NULL,
    "bullet_id" "uuid" NOT NULL,
    "ordinal" integer NOT NULL,
    "section_path" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cv_version_bullets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cv_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "source_file_path" "text",
    "raw_text" "text" NOT NULL,
    "detected_field" "text",
    "is_active" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cv_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."interview_packs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_target_id" "uuid" NOT NULL,
    "candidate_profile_id" "uuid" NOT NULL,
    "persona_id" "text" NOT NULL,
    "company_research_report_id" "uuid",
    "plan_json" "jsonb",
    "question_set_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."interview_packs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."interview_questions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "competency_id" "text",
    "question_text" "text" NOT NULL,
    "question_type" "text",
    "source" "text" DEFAULT 'generated'::"text" NOT NULL,
    "asked_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."interview_questions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."interview_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "candidate_profile_id" "uuid",
    "job_target_id" "uuid",
    "interview_pack_id" "uuid",
    "persona_id" "text" NOT NULL,
    "mode" "text" DEFAULT 'live_ai'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "final_score_json" "jsonb",
    "final_report_json" "jsonb",
    "context_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cv_version_id" "uuid"
);


ALTER TABLE "public"."interview_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_rubrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_target_id" "uuid" NOT NULL,
    "rubric_template_id" "uuid" NOT NULL,
    "competencies_json" "jsonb",
    "weights_json" "jsonb",
    "generated_from_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_rubrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_targets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "company_id" "uuid",
    "title" "text" NOT NULL,
    "location" "text",
    "seniority" "text",
    "jd_text" "text",
    "parsed_jd_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_targets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personas" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "title" "text",
    "description" "text",
    "config_json" "jsonb",
    "is_active" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."personas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."question_bank_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid",
    "company_name" "text",
    "country" "text" DEFAULT 'UK'::"text",
    "role_family" "text",
    "job_title" "text",
    "seniority" "text",
    "question_text" "text" NOT NULL,
    "question_type" "text",
    "source_type" "text" DEFAULT 'curated'::"text" NOT NULL,
    "source_url" "text",
    "confidence" numeric DEFAULT 0.8,
    "tags" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."question_bank_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rubric_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "rubric_type" "text" DEFAULT 'IRS'::"text" NOT NULL,
    "schema_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."rubric_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."session_media" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "media_type" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "duration_seconds" numeric,
    "transcription_status" "text" DEFAULT 'pending'::"text",
    "diarization_status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."session_media" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."transcript_turns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "speaker" "text" NOT NULL,
    "turn_index" integer NOT NULL,
    "start_ms" integer,
    "end_ms" integer,
    "content" "text" NOT NULL,
    "derived_question_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."transcript_turns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."users" OWNER TO "postgres";


COMMENT ON TABLE "public"."users" IS 'Core user identity table.';



ALTER TABLE ONLY "public"."answer_assessments"
    ADD CONSTRAINT "answer_assessments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."answer_coaching"
    ADD CONSTRAINT "answer_coaching_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bullet_artifacts"
    ADD CONSTRAINT "bullet_artifacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bullet_gaps"
    ADD CONSTRAINT "bullet_gaps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."candidate_profiles"
    ADD CONSTRAINT "candidate_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coach_understanding_reports"
    ADD CONSTRAINT "coach_understanding_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_research_reports"
    ADD CONSTRAINT "company_research_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cv_analysis_jobs"
    ADD CONSTRAINT "cv_analysis_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cv_bullets"
    ADD CONSTRAINT "cv_bullets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cv_version_bullets"
    ADD CONSTRAINT "cv_version_bullets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cv_versions"
    ADD CONSTRAINT "cv_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."interview_packs"
    ADD CONSTRAINT "interview_packs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."interview_questions"
    ADD CONSTRAINT "interview_questions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."interview_sessions"
    ADD CONSTRAINT "interview_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_rubrics"
    ADD CONSTRAINT "job_rubrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_targets"
    ADD CONSTRAINT "job_targets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personas"
    ADD CONSTRAINT "personas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."question_bank_entries"
    ADD CONSTRAINT "question_bank_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rubric_templates"
    ADD CONSTRAINT "rubric_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."session_media"
    ADD CONSTRAINT "session_media_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."transcript_turns"
    ADD CONSTRAINT "transcript_turns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_assessments_question" ON "public"."answer_assessments" USING "btree" ("question_id");



CREATE INDEX "idx_assessments_session" ON "public"."answer_assessments" USING "btree" ("session_id");



CREATE INDEX "idx_bullet_artifacts_gap" ON "public"."bullet_artifacts" USING "btree" ("gap_id");



CREATE INDEX "idx_bullet_gaps_bullet" ON "public"."bullet_gaps" USING "btree" ("bullet_id");



CREATE UNIQUE INDEX "idx_bullet_gaps_unique_ordinal" ON "public"."bullet_gaps" USING "btree" ("bullet_id", "ordinal");



CREATE INDEX "idx_candidate_profiles_user" ON "public"."candidate_profiles" USING "btree" ("user_id");



CREATE INDEX "idx_coach_reports_user" ON "public"."coach_understanding_reports" USING "btree" ("user_id");



CREATE INDEX "idx_coaching_assessment" ON "public"."answer_coaching" USING "btree" ("assessment_id");



CREATE INDEX "idx_companies_domain" ON "public"."companies" USING "btree" ("canonical_domain");



CREATE INDEX "idx_companies_name" ON "public"."companies" USING "btree" ("name");



CREATE INDEX "idx_company_research_company" ON "public"."company_research_reports" USING "btree" ("company_id");



CREATE INDEX "idx_cv_analysis_jobs_updated_at" ON "public"."cv_analysis_jobs" USING "btree" ("updated_at" DESC);



CREATE INDEX "idx_cv_analysis_jobs_user" ON "public"."cv_analysis_jobs" USING "btree" ("user_id");



CREATE INDEX "idx_cv_bullets_embedding_hnsw" ON "public"."cv_bullets" USING "hnsw" ("bullet_embedding" "public"."vector_cosine_ops");



CREATE INDEX "idx_cv_bullets_user" ON "public"."cv_bullets" USING "btree" ("user_id");



CREATE INDEX "idx_cv_bullets_version" ON "public"."cv_bullets" USING "btree" ("cv_version_id");



CREATE UNIQUE INDEX "idx_cv_versions_one_active_per_user" ON "public"."cv_versions" USING "btree" ("user_id") WHERE ("is_active" = true);



CREATE INDEX "idx_cv_versions_user" ON "public"."cv_versions" USING "btree" ("user_id");



CREATE INDEX "idx_cvb_bullet" ON "public"."cv_version_bullets" USING "btree" ("bullet_id");



CREATE UNIQUE INDEX "idx_cvb_unique" ON "public"."cv_version_bullets" USING "btree" ("cv_version_id", "bullet_id");



CREATE INDEX "idx_cvb_version" ON "public"."cv_version_bullets" USING "btree" ("cv_version_id");



CREATE INDEX "idx_interview_packs_target" ON "public"."interview_packs" USING "btree" ("job_target_id");



CREATE INDEX "idx_job_rubrics_target" ON "public"."job_rubrics" USING "btree" ("job_target_id");



CREATE INDEX "idx_job_targets_company" ON "public"."job_targets" USING "btree" ("company_id");



CREATE INDEX "idx_job_targets_user" ON "public"."job_targets" USING "btree" ("user_id");



CREATE INDEX "idx_question_bank_company" ON "public"."question_bank_entries" USING "btree" ("company_id");



CREATE INDEX "idx_question_bank_company_name" ON "public"."question_bank_entries" USING "btree" ("company_name");



CREATE INDEX "idx_question_bank_role" ON "public"."question_bank_entries" USING "btree" ("role_family");



CREATE INDEX "idx_question_bank_type" ON "public"."question_bank_entries" USING "btree" ("question_type");



CREATE INDEX "idx_questions_session" ON "public"."interview_questions" USING "btree" ("session_id");



CREATE INDEX "idx_session_media_session" ON "public"."session_media" USING "btree" ("session_id");



CREATE INDEX "idx_sessions_cv_version" ON "public"."interview_sessions" USING "btree" ("cv_version_id");



CREATE INDEX "idx_sessions_status" ON "public"."interview_sessions" USING "btree" ("status");



CREATE INDEX "idx_sessions_user" ON "public"."interview_sessions" USING "btree" ("user_id");



CREATE INDEX "idx_transcript_turns_session" ON "public"."transcript_turns" USING "btree" ("session_id");



ALTER TABLE ONLY "public"."answer_assessments"
    ADD CONSTRAINT "answer_assessments_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."interview_questions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."answer_assessments"
    ADD CONSTRAINT "answer_assessments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."answer_assessments"
    ADD CONSTRAINT "answer_assessments_transcript_turn_id_fkey" FOREIGN KEY ("transcript_turn_id") REFERENCES "public"."transcript_turns"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."answer_coaching"
    ADD CONSTRAINT "answer_coaching_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "public"."answer_assessments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bullet_artifacts"
    ADD CONSTRAINT "bullet_artifacts_gap_id_fkey" FOREIGN KEY ("gap_id") REFERENCES "public"."bullet_gaps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bullet_gaps"
    ADD CONSTRAINT "bullet_gaps_bullet_id_fkey" FOREIGN KEY ("bullet_id") REFERENCES "public"."cv_bullets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."candidate_profiles"
    ADD CONSTRAINT "candidate_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coach_understanding_reports"
    ADD CONSTRAINT "coach_understanding_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."company_research_reports"
    ADD CONSTRAINT "company_research_reports_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cv_analysis_jobs"
    ADD CONSTRAINT "cv_analysis_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cv_bullets"
    ADD CONSTRAINT "cv_bullets_cv_version_id_fkey" FOREIGN KEY ("cv_version_id") REFERENCES "public"."cv_versions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cv_bullets"
    ADD CONSTRAINT "cv_bullets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cv_version_bullets"
    ADD CONSTRAINT "cv_version_bullets_bullet_id_fkey" FOREIGN KEY ("bullet_id") REFERENCES "public"."cv_bullets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cv_version_bullets"
    ADD CONSTRAINT "cv_version_bullets_cv_version_id_fkey" FOREIGN KEY ("cv_version_id") REFERENCES "public"."cv_versions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cv_versions"
    ADD CONSTRAINT "cv_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."interview_packs"
    ADD CONSTRAINT "interview_packs_candidate_profile_id_fkey" FOREIGN KEY ("candidate_profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."interview_packs"
    ADD CONSTRAINT "interview_packs_company_research_report_id_fkey" FOREIGN KEY ("company_research_report_id") REFERENCES "public"."company_research_reports"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."interview_packs"
    ADD CONSTRAINT "interview_packs_job_target_id_fkey" FOREIGN KEY ("job_target_id") REFERENCES "public"."job_targets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."interview_packs"
    ADD CONSTRAINT "interview_packs_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."interview_questions"
    ADD CONSTRAINT "interview_questions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."interview_sessions"
    ADD CONSTRAINT "interview_sessions_candidate_profile_id_fkey" FOREIGN KEY ("candidate_profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."interview_sessions"
    ADD CONSTRAINT "interview_sessions_cv_version_id_fkey" FOREIGN KEY ("cv_version_id") REFERENCES "public"."cv_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."interview_sessions"
    ADD CONSTRAINT "interview_sessions_interview_pack_id_fkey" FOREIGN KEY ("interview_pack_id") REFERENCES "public"."interview_packs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."interview_sessions"
    ADD CONSTRAINT "interview_sessions_job_target_id_fkey" FOREIGN KEY ("job_target_id") REFERENCES "public"."job_targets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."interview_sessions"
    ADD CONSTRAINT "interview_sessions_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."interview_sessions"
    ADD CONSTRAINT "interview_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_rubrics"
    ADD CONSTRAINT "job_rubrics_job_target_id_fkey" FOREIGN KEY ("job_target_id") REFERENCES "public"."job_targets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_rubrics"
    ADD CONSTRAINT "job_rubrics_rubric_template_id_fkey" FOREIGN KEY ("rubric_template_id") REFERENCES "public"."rubric_templates"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."job_targets"
    ADD CONSTRAINT "job_targets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_targets"
    ADD CONSTRAINT "job_targets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."question_bank_entries"
    ADD CONSTRAINT "question_bank_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."session_media"
    ADD CONSTRAINT "session_media_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transcript_turns"
    ADD CONSTRAINT "transcript_turns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE CASCADE;



CREATE POLICY "Anyone can read companies" ON "public"."companies" FOR SELECT USING (true);



CREATE POLICY "Anyone can read personas" ON "public"."personas" FOR SELECT USING (true);



CREATE POLICY "Anyone can read question bank" ON "public"."question_bank_entries" FOR SELECT USING (true);



CREATE POLICY "Anyone can read rubric templates" ON "public"."rubric_templates" FOR SELECT USING (true);



CREATE POLICY "Users can insert own candidate profiles" ON "public"."candidate_profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own job targets" ON "public"."job_targets" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own sessions" ON "public"."interview_sessions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can read own candidate profiles" ON "public"."candidate_profiles" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can read own job targets" ON "public"."job_targets" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can read own profile" ON "public"."users" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can read own sessions" ON "public"."interview_sessions" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own candidate profiles" ON "public"."candidate_profiles" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own sessions" ON "public"."interview_sessions" FOR UPDATE USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."answer_assessments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."answer_coaching" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bullet_artifacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bullet_gaps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."candidate_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coach_understanding_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."company_research_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cv_analysis_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cv_bullets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cv_version_bullets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cv_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."interview_packs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."interview_questions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."interview_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_rubrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_targets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."personas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."question_bank_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rubric_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."session_media" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."transcript_turns" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."match_bullets"("query_embedding" "public"."vector", "match_user_id" "uuid", "match_threshold" double precision, "match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_bullets"("query_embedding" "public"."vector", "match_user_id" "uuid", "match_threshold" double precision, "match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_bullets"("query_embedding" "public"."vector", "match_user_id" "uuid", "match_threshold" double precision, "match_count" integer) TO "service_role";



GRANT ALL ON TABLE "public"."answer_assessments" TO "anon";
GRANT ALL ON TABLE "public"."answer_assessments" TO "authenticated";
GRANT ALL ON TABLE "public"."answer_assessments" TO "service_role";



GRANT ALL ON TABLE "public"."answer_coaching" TO "anon";
GRANT ALL ON TABLE "public"."answer_coaching" TO "authenticated";
GRANT ALL ON TABLE "public"."answer_coaching" TO "service_role";



GRANT ALL ON TABLE "public"."bullet_artifacts" TO "anon";
GRANT ALL ON TABLE "public"."bullet_artifacts" TO "authenticated";
GRANT ALL ON TABLE "public"."bullet_artifacts" TO "service_role";



GRANT ALL ON TABLE "public"."bullet_gaps" TO "anon";
GRANT ALL ON TABLE "public"."bullet_gaps" TO "authenticated";
GRANT ALL ON TABLE "public"."bullet_gaps" TO "service_role";



GRANT ALL ON TABLE "public"."candidate_profiles" TO "anon";
GRANT ALL ON TABLE "public"."candidate_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."candidate_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."coach_understanding_reports" TO "anon";
GRANT ALL ON TABLE "public"."coach_understanding_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."coach_understanding_reports" TO "service_role";



GRANT ALL ON TABLE "public"."companies" TO "anon";
GRANT ALL ON TABLE "public"."companies" TO "authenticated";
GRANT ALL ON TABLE "public"."companies" TO "service_role";



GRANT ALL ON TABLE "public"."company_research_reports" TO "anon";
GRANT ALL ON TABLE "public"."company_research_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."company_research_reports" TO "service_role";



GRANT ALL ON TABLE "public"."cv_analysis_jobs" TO "anon";
GRANT ALL ON TABLE "public"."cv_analysis_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."cv_analysis_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."cv_bullets" TO "anon";
GRANT ALL ON TABLE "public"."cv_bullets" TO "authenticated";
GRANT ALL ON TABLE "public"."cv_bullets" TO "service_role";



GRANT ALL ON TABLE "public"."cv_version_bullets" TO "anon";
GRANT ALL ON TABLE "public"."cv_version_bullets" TO "authenticated";
GRANT ALL ON TABLE "public"."cv_version_bullets" TO "service_role";



GRANT ALL ON TABLE "public"."cv_versions" TO "anon";
GRANT ALL ON TABLE "public"."cv_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."cv_versions" TO "service_role";



GRANT ALL ON TABLE "public"."interview_packs" TO "anon";
GRANT ALL ON TABLE "public"."interview_packs" TO "authenticated";
GRANT ALL ON TABLE "public"."interview_packs" TO "service_role";



GRANT ALL ON TABLE "public"."interview_questions" TO "anon";
GRANT ALL ON TABLE "public"."interview_questions" TO "authenticated";
GRANT ALL ON TABLE "public"."interview_questions" TO "service_role";



GRANT ALL ON TABLE "public"."interview_sessions" TO "anon";
GRANT ALL ON TABLE "public"."interview_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."interview_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."job_rubrics" TO "anon";
GRANT ALL ON TABLE "public"."job_rubrics" TO "authenticated";
GRANT ALL ON TABLE "public"."job_rubrics" TO "service_role";



GRANT ALL ON TABLE "public"."job_targets" TO "anon";
GRANT ALL ON TABLE "public"."job_targets" TO "authenticated";
GRANT ALL ON TABLE "public"."job_targets" TO "service_role";



GRANT ALL ON TABLE "public"."personas" TO "anon";
GRANT ALL ON TABLE "public"."personas" TO "authenticated";
GRANT ALL ON TABLE "public"."personas" TO "service_role";



GRANT ALL ON TABLE "public"."question_bank_entries" TO "anon";
GRANT ALL ON TABLE "public"."question_bank_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."question_bank_entries" TO "service_role";



GRANT ALL ON TABLE "public"."rubric_templates" TO "anon";
GRANT ALL ON TABLE "public"."rubric_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."rubric_templates" TO "service_role";



GRANT ALL ON TABLE "public"."session_media" TO "anon";
GRANT ALL ON TABLE "public"."session_media" TO "authenticated";
GRANT ALL ON TABLE "public"."session_media" TO "service_role";



GRANT ALL ON TABLE "public"."transcript_turns" TO "anon";
GRANT ALL ON TABLE "public"."transcript_turns" TO "authenticated";
GRANT ALL ON TABLE "public"."transcript_turns" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







