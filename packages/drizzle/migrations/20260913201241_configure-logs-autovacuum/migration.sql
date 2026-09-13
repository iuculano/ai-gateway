-- Vacuum logs more frequently, we were seemingly getting killed by this and
-- the logs/count query was brutally expensive if it scanned anything.
ALTER TABLE public.logs SET (
  autovacuum_vacuum_scale_factor        = 0.01,
  autovacuum_vacuum_threshold           = 1000,
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold    = 1000
);
