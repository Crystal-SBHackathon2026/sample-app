-- Apply explicitly as a DB owner before starting the application.
-- The application role requires SELECT and INSERT only, not table ownership.
CREATE TABLE IF NOT EXISTS public.migration_demo (
    request_id uuid PRIMARY KEY,
    run_id text NOT NULL,
    phase text NOT NULL,
    request_no bigint NOT NULL,
    payload text NOT NULL,
    created_at timestamptz NOT NULL
);
