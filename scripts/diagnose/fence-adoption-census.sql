-- #6650: read-only census of failed fact-fence adoptions in the writer table.
--
-- Answers: how many failed adoption requests exist, which gbrain builds
-- admitted them, whether any are still being minted, and how many of their
-- pages still hold legacy (unfenced) facts. It writes nothing.
--
-- Run on the brain host against the brain's database, for example:
--   psql "$GBRAIN_DATABASE_URL" -v source=default -f scripts/diagnose/fence-adoption-census.sql
--
-- Compacted receipts (older than the receipt retention window) keep their
-- code but lose their message and intent; they are counted as `compacted`
-- and grouped by code only. The refusal sub-reason (missing / struck / empty /
-- visibility / text) was never stored on the row, so this census cannot
-- reconstruct it; re-run the facts backfill on the current build and read
-- `gbrain doctor` fence_integrity for today's reasons.

BEGIN READ ONLY;

\echo 'Failed adoptions by build, code and message'
SELECT r.admitter_version,
       r.error_code,
       CASE WHEN r.compacted THEN '(compacted)' ELSE r.error_message END AS message,
       count(*)                                                        AS failed_requests,
       count(DISTINCT r.slug)                                          AS distinct_pages,
       min(r.completed_at)                                             AS first_seen,
       max(r.completed_at)                                             AS last_seen,
       count(*) FILTER (WHERE r.completed_at > now() - interval '24 hours') AS last_24h
  FROM persistence_requests r
 WHERE r.source_id = :'source'
   AND r.state = 'failed'
   AND (r.intent->>'kind' = 'managed_maintenance_adopt_fact_fence'
        OR r.error_message = 'The adopted fence row does not render its legacy fact.'
        OR r.error_code = 'fence_unrenderable')
 GROUP BY 1, 2, 3
 ORDER BY last_seen DESC;

\echo 'Pages with failed adoptions: how many still hold legacy (unfenced) facts'
WITH failed AS (
  SELECT DISTINCT r.slug
    FROM persistence_requests r
   WHERE r.source_id = :'source'
     AND r.state = 'failed'
     AND (r.intent->>'kind' = 'managed_maintenance_adopt_fact_fence'
          OR r.error_message = 'The adopted fence row does not render its legacy fact.'
          OR r.error_code = 'fence_unrenderable')
)
SELECT count(*)                                                        AS pages_with_failures,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM facts f
          WHERE f.source_id = :'source' AND f.entity_slug = failed.slug
            AND f.row_num IS NULL AND f.expired_at IS NULL AND f.dimension IS NULL)) AS pages_still_holding_legacy_facts
  FROM failed;

ROLLBACK;
