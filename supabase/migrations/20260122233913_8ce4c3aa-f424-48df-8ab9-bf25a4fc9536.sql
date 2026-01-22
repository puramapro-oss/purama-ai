-- Add unique constraint for user_connections to enable upsert
ALTER TABLE public.user_connections 
ADD CONSTRAINT user_connections_user_provider_unique UNIQUE (user_id, provider);