-- Persistent prompt bindings. Entity IDs, not labels, are the source of truth.
ALTER TABLE scenes ADD COLUMN prompt_document_json TEXT;
ALTER TABLE scenes ADD COLUMN context_documents_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE quick_sessions ADD COLUMN prompt_document_json TEXT;
ALTER TABLE generations ADD COLUMN prompt_document_json TEXT;
ALTER TABLE generations ADD COLUMN entity_references_json TEXT;
ALTER TABLE generations ADD COLUMN logo_overlays_json TEXT;
