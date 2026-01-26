-- Add webhook_slug column to agents table
ALTER TABLE public.agents 
ADD COLUMN webhook_slug text;