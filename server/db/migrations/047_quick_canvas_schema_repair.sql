-- Early installations recorded 046 before asset pinning and sync conflicts were
-- added. The migration runner conditionally adds those columns, so both early
-- databases and fresh databases using the complete 046 schema upgrade safely.
SELECT 1;
